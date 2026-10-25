// Anki と同じ書き方の検索。例： deck:英語 tag:動詞 -is:suspended "be動詞" OR prop:ivl>=21
import { stripHtml, DAY } from './util.js';
import { Q_NEW, Q_LRN, Q_REV, Q_DAYLRN, Q_SUSPENDED, Q_BURIED, Q_SIB_BURIED } from './sched/answer.js';

export function tokenize(q) {
  const out = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ t: ch });
      i++;
      continue;
    }
    let neg = false;
    if (ch === '-' && i + 1 < q.length && !/\s/.test(q[i + 1])) {
      neg = true;
      i++;
      if (q[i] === '(') {
        out.push({ t: 'NEG' });
        continue;
      }
    }
    let s = '';
    let quoted = false;
    let inQ = false;
    while (i < q.length) {
      const c = q[i];
      if (c === '\\' && i + 1 < q.length) {
        s += c + q[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        inQ = !inQ;
        quoted = true;
        i++;
        continue;
      }
      if (!inQ && (/\s/.test(c) || c === '(' || c === ')')) break;
      s += c;
      i++;
    }
    if (!quoted && !neg && (s === 'OR' || s === 'or')) out.push({ t: 'OR' });
    else if (!quoted && !neg && (s === 'AND' || s === 'and')) continue;
    else out.push({ t: 'TERM', v: s, neg });
  }
  return out;
}

export function parse(q) {
  const toks = tokenize(q);
  let p = 0;
  const orExpr = () => {
    const parts = [andExpr()];
    while (toks[p]?.t === 'OR') {
      p++;
      parts.push(andExpr());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  };
  const andExpr = () => {
    const parts = [];
    while (p < toks.length && toks[p].t !== ')' && toks[p].t !== 'OR') parts.push(unary());
    return parts.length === 1 ? parts[0] : { and: parts };
  };
  const unary = () => {
    const tk = toks[p++];
    if (tk.t === 'NEG') {
      p++; // (
      const e = orExpr();
      if (toks[p]?.t === ')') p++;
      return { not: e };
    }
    if (tk.t === '(') {
      const e = orExpr();
      if (toks[p]?.t === ')') p++;
      return e;
    }
    const term = { term: tk.v };
    return tk.neg ? { not: term } : term;
  };
  if (!toks.length) return { and: [] };
  const e = orExpr();
  while (p < toks.length) {
    // 閉じかっこが多すぎるときは読み飛ばす
    p++;
  }
  return e;
}

const unesc = (s) => s.replace(/\\(.)/g, '$1');

/** * と _ を使ったあいまいな文字 → 正規表現 */
export function globRe(s, whole = false) {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      r += s[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    } else if (c === '*') r += '.*';
    else if (c === '_') r += '.';
    else r += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(whole ? `^${r}$` : r, 'is');
}

function propPred(expr, ctx) {
  const m = /^([a-z]+)(<=|>=|!=|=|<|>)(-?[\d.]+)$/i.exec(expr);
  if (!m) return () => false;
  const [, key, op, vs] = m;
  const v = Number(vs);
  const cmp = (x) => (op === '<' ? x < v : op === '>' ? x > v : op === '<=' ? x <= v : op === '>=' ? x >= v : op === '!=' ? x !== v : x === v);
  return (c) => {
    switch (key.toLowerCase()) {
      case 'ivl':
        return c.type === 2 || c.type === 3 ? cmp(c.ivl) : false;
      case 'due':
        if (c.queue === Q_REV || c.queue === Q_DAYLRN) return cmp((c.odue || c.due) - ctx.today);
        if (c.queue === Q_LRN) return cmp(Math.floor((c.due - ctx.dayStart) / DAY));
        return false;
      case 'reps':
        return cmp(c.reps || 0);
      case 'lapses':
        return cmp(c.lapses || 0);
      case 'ease':
        return c.type === 0 ? false : cmp((c.factor || 0) / 1000);
      case 'pos':
        return c.type === 0 ? cmp(c.odue || c.due) : false;
      case 's':
      case 'stability':
        return c.s ? cmp(c.s) : false;
      case 'd':
      case 'difficulty':
        return c.d ? cmp(c.d) : false;
      case 'r':
      case 'retrievability': {
        if (!c.s || !c.lastReview) return false;
        const t = (ctx.now - c.lastReview) / DAY;
        return cmp(Math.pow(1 + ((19 / 81) * t) / c.s, -0.5));
      }
      default:
        return false;
    }
  };
}

function termPred(raw, ctx) {
  const ci = raw.indexOf(':');
  const key = ci > 0 ? raw.slice(0, ci).toLowerCase() : '';
  const val = ci > 0 ? raw.slice(ci + 1) : raw;
  const col = ctx.col;
  switch (key) {
    case 'deck': {
      if (val.toLowerCase() === 'current') {
        const ids = col.deckTreeIds(ctx.currentDeck);
        return (c) => ids.has(c.did) || ids.has(c.odid);
      }
      if (val.toLowerCase() === 'filtered') return (c) => !!c.odid;
      const re = globRe(val, true);
      const reKid = globRe(val + '::*', true);
      const ids = new Set([...col.decks.values()].filter((d) => re.test(d.name) || reKid.test(d.name)).map((d) => d.id));
      return (c) => ids.has(c.did) || ids.has(c.odid);
    }
    case 'note': {
      const re = globRe(val, true);
      const ids = new Set([...col.notetypes.values()].filter((t) => re.test(t.name)).map((t) => t.id));
      return (c, n) => ids.has(n.ntid);
    }
    case 'card': {
      if (/^\d+$/.test(val)) {
        const ord = Number(val) - 1;
        return (c) => c.ord === ord;
      }
      const re = globRe(val, true);
      return (c, n, nt) => (nt.kind === 'std' ? re.test(nt.templates[c.ord]?.name || '') : false);
    }
    case 'tag': {
      if (val.toLowerCase() === 'none') return (c, n) => n.tags.length === 0;
      const re = globRe(val, true);
      const reKid = globRe(val + '::*', true);
      return (c, n) => n.tags.some((t) => re.test(t) || reKid.test(t));
    }
    case 'is': {
      switch (val.toLowerCase()) {
        case 'due':
          return (c) => ((c.queue === Q_REV || c.queue === Q_DAYLRN) && c.due <= ctx.today) || (c.queue === Q_LRN && c.due < ctx.cutoff);
        case 'new':
          return (c) => c.type === 0;
        case 'learn':
          return (c) => c.type === 1 || c.type === 3;
        case 'review':
          return (c) => c.type === 2 || c.type === 3;
        case 'suspended':
          return (c) => c.queue === Q_SUSPENDED;
        case 'buried':
          return (c) => c.queue === Q_BURIED || c.queue === Q_SIB_BURIED;
        case 'marked':
          return (c, n) => n.tags.some((t) => t.toLowerCase() === 'marked');
        case 'leech':
          return (c, n) => n.tags.some((t) => t.toLowerCase() === 'leech');
        case 'flagged':
          return (c) => c.flags > 0;
        default:
          return () => false;
      }
    }
    case 'flag': {
      const f = Number(val);
      return (c) => (c.flags || 0) === f;
    }
    case 'added': {
      const since = ctx.dayStart - (Number(val) - 1) * DAY;
      return (c, n) => (c.created ?? n.created ?? c.id / 1000) >= since;
    }
    case 'edited': {
      const since = ctx.dayStart - (Number(val) - 1) * DAY;
      return (c, n) => (n.mod || 0) >= since;
    }
    case 'rated':
    case 'introduced': {
      const [days, ease] = val.split(':');
      const since = ctx.dayStart - (Math.min(365, Number(days) || 1) - 1) * DAY;
      const log = revIndex(col);
      if (key === 'introduced') return (c) => (log.get(c.id)?.[0]?.at ?? 0) >= since && log.get(c.id)[0].type !== 4;
      const e = ease ? Number(ease) : 0;
      return (c) => (log.get(c.id) || []).some((r) => r.at >= since && r.type !== 4 && (!e || r.ease === e));
    }
    case 'prop':
      return propPred(val, ctx);
    case 'nid': {
      const ids = new Set(val.split(',').map(Number));
      return (c, n) => ids.has(n.id);
    }
    case 'cid': {
      const ids = new Set(val.split(',').map(Number));
      return (c) => ids.has(c.id);
    }
    case 're': {
      let re;
      try {
        re = new RegExp(unesc(val), 'i');
      } catch {
        return () => false;
      }
      return (c, n) => n.fields.some((f) => re.test(stripHtml(f)));
    }
    case 'nc':
    case 'w':
    case '': {
      const re = globRe(val);
      return (c, n) => re.test(noteText(ctx, n));
    }
    default: {
      // 項目名:値
      const fre = globRe(raw.slice(0, ci), true);
      const vre = globRe(val, true);
      return (c, n, nt) => nt.fields.some((f, i) => fre.test(f.name) && vre.test(stripHtml(n.fields[i] || '')));
    }
  }
}

function noteText(ctx, n) {
  let t = ctx.textCache.get(n.id);
  if (t === undefined) {
    t = n.fields.map(stripHtml).join('\u001f');
    ctx.textCache.set(n.id, t);
  }
  return t;
}

function revIndex(col) {
  return col.cache('revIndex', () => {
    const m = new Map();
    for (const r of col.revlog.values()) {
      if (!m.has(r.cid)) m.set(r.cid, []);
      m.get(r.cid).push(r);
    }
    for (const a of m.values()) a.sort((x, y) => x.at - y.at);
    return m;
  });
}

function compile(node, ctx) {
  if (node.and) {
    const ps = node.and.map((x) => compile(x, ctx));
    return (...a) => ps.every((p) => p(...a));
  }
  if (node.or) {
    const ps = node.or.map((x) => compile(x, ctx));
    return (...a) => ps.some((p) => p(...a));
  }
  if (node.not) {
    const p = compile(node.not, ctx);
    return (...a) => !p(...a);
  }
  return termPred(node.term, ctx);
}

/**
 * @returns {number[]} カードの ID（cards:false ならノートの ID）
 */
export function search(col, query, { cards = true, currentDeck = col.conf.curDeck } = {}) {
  const now = Date.now();
  const ctx = {
    col,
    currentDeck,
    now,
    today: col.today(),
    dayStart: col.dayStart(),
    cutoff: col.dayCutoff(),
    textCache: new Map(),
  };
  const pred = compile(parse(query || ''), ctx);
  const out = [];
  const seen = new Set();
  for (const c of col.cards.values()) {
    const n = col.notes.get(c.nid);
    if (!n) continue;
    const nt = col.notetypes.get(n.ntid);
    if (!nt) continue;
    if (!pred(c, n, nt)) continue;
    if (cards) out.push(c.id);
    else if (!seen.has(n.id)) {
      seen.add(n.id);
      out.push(n.id);
    }
  }
  return out;
}
