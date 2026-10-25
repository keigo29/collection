// 今日出すカードを選ぶ・数える・答えを記録する
import { answer, nextIntervals, Q_NEW, Q_LRN, Q_REV, Q_DAYLRN, Q_SUSPENDED, Q_SIB_BURIED, Q_BURIED, NEW, REV, RELRN } from './answer.js';
import { shuffle, seeded } from '../util.js';
import { normTags } from '../col.js';

/** 今日すでに学んだ数（デッキごと） */
export function studiedToday(col) {
  return col.cache('studiedToday', () => {
    const start = col.dayStart();
    const byDeck = new Map();
    const all = { new: 0, rev: 0, count: 0, time: 0, again: 0, lrn: 0, relrn: 0, cram: 0, correctMature: 0, mature: 0 };
    for (const r of col.revlog.values()) {
      if (r.at < start) continue;
      all.count++;
      all.time += r.time || 0;
      if (r.ease === 1) all.again++;
      if (r.type === 0) all.lrn++;
      if (r.type === 2) all.relrn++;
      if (r.type === 3) all.cram++;
      if (r.type === 1) all.rev++;
      if (r.type === 1 && r.lastIvl >= 21) {
        all.mature++;
        if (r.ease > 1) all.correctMature++;
      }
      if (r.type === 4) continue;
      const did = r.did;
      if (!byDeck.has(did)) byDeck.set(did, { new: 0, rev: 0 });
      const b = byDeck.get(did);
      if (r.newCard) {
        b.new++;
        all.new++;
      } else if (r.type === 1) b.rev++;
    }
    return { byDeck, all };
  });
}

function extendFor(col, did) {
  const e = col.conf.extend;
  if (!e || e.day !== col.today()) return { new: 0, rev: 0 };
  return e.decks?.[did] || { new: 0, rev: 0 };
}

/** デッキの残りの上限（今日の分） */
export function limitsLeft(col, did) {
  const p = col.presetFor(did);
  const by = studiedToday(col).byDeck;
  const st = { new: 0, rev: 0 };
  for (const id of col.deckTreeIds(did)) {
    const b = by.get(id);
    if (b) {
      st.new += b.new;
      st.rev += b.rev;
    }
  }
  const ex = extendFor(col, did);
  return {
    new: Math.max(0, (p.newPerDay ?? 20) + ex.new - st.new),
    rev: Math.max(0, (p.revPerDay ?? 200) + ex.rev - st.rev),
  };
}

/** デッキごとに今日のカードを分ける */
function bucketCards(col) {
  return col.cache('buckets', () => {
    const today = col.today();
    const cutoff = col.dayCutoff();
    const m = new Map();
    const get = (did) => {
      if (!m.has(did)) m.set(did, { new: [], rev: [], lrn: [], daylrn: [] });
      return m.get(did);
    };
    for (const c of col.cards.values()) {
      if (c.queue === Q_NEW) get(c.did).new.push(c);
      else if (c.queue === Q_REV && c.due <= today) get(c.did).rev.push(c);
      else if (c.queue === Q_LRN && c.due < cutoff) get(c.did).lrn.push(c);
      else if (c.queue === Q_DAYLRN && c.due <= today) get(c.did).daylrn.push(c);
    }
    return m;
  });
}

/** デッキの木と、それぞれの「新規・学習中・復習」の数 */
export function deckTree(col) {
  return col.cache('deckTree', () => {
    const buckets = bucketCards(col);
    const decks = col.sortedDecks();
    const nodes = new Map();
    const roots = [];
    for (const d of decks) {
      const node = { deck: d, kids: [], new: 0, lrn: 0, rev: 0, total: 0 };
      nodes.set(d.name.toLowerCase(), node);
      const parts = d.name.split('::');
      const parent = parts.length > 1 ? nodes.get(parts.slice(0, -1).join('::').toLowerCase()) : null;
      if (parent) parent.kids.push(node);
      else roots.push(node);
    }
    const calc = (node) => {
      const b = buckets.get(node.deck.id) || { new: [], rev: [], lrn: [], daylrn: [] };
      let n = b.new.length;
      let r = b.rev.length + b.daylrn.length;
      let l = b.lrn.length;
      for (const k of node.kids) {
        calc(k);
        n += k.new;
        r += k.rev;
        l += k.lrn;
      }
      if (node.deck.filtered) {
        node.new = n;
        node.rev = r;
      } else {
        const lim = limitsLeft(col, node.deck.id);
        node.rev = Math.min(r, lim.rev);
        node.new = Math.min(n, lim.new);
      }
      node.lrn = l;
    };
    roots.forEach(calc);
    return { roots, nodes };
  });
}

export function deckCounts(col, did) {
  const d = col.decks.get(did);
  if (!d) return { new: 0, lrn: 0, rev: 0 };
  const n = deckTree(col).nodes.get(d.name.toLowerCase());
  return n ? { new: n.new, lrn: n.lrn, rev: n.rev } : { new: 0, lrn: 0, rev: 0 };
}

// ---- 学習の流れ
const sortNew = (p, arr) => {
  if (p.newSort === 'random') return shuffle(arr);
  if (p.newSort === 'template') return arr.sort((a, b) => a.due - b.due || a.ord - b.ord || a.id - b.id);
  return arr.sort((a, b) => a.due - b.due || a.id - b.id);
};

function sortRev(p, arr, today, col) {
  switch (p.reviewSort) {
    case 'random':
      return shuffle(arr);
    case 'ascIvl':
      return arr.sort((a, b) => a.ivl - b.ivl);
    case 'descIvl':
      return arr.sort((a, b) => b.ivl - a.ivl);
    case 'descEase':
      return arr.sort((a, b) => (a.factor || 0) - (b.factor || 0));
    case 'overdue':
      return arr.sort((a, b) => (today - b.due) / Math.max(1, b.ivl) - (today - a.due) / Math.max(1, a.ivl));
    default: {
      // 期日の順。同じ日の中では混ぜる
      const r = seeded(today);
      const k = new Map(arr.map((c) => [c.id, r()]));
      return arr.sort((a, b) => a.due - b.due || k.get(a.id) - k.get(b.id));
    }
  }
}

export class Session {
  constructor(col, did) {
    this.col = col;
    this.did = did;
    this.deck = col.decks.get(did);
    this.preview = !!(this.deck?.filtered && this.deck.filtered.reschedule === false);
    this.history = [];
    this.build();
  }

  get preset() {
    return this.col.presetFor(this.did);
  }

  build() {
    const col = this.col;
    const today = col.today();
    const buckets = bucketCards(col);
    const tree = deckTree(col);
    const root = tree.nodes.get(this.deck.name.toLowerCase());
    const p = this.preset;
    // 木をたどって、それぞれのデッキの上限の中で集める
    const newOut = [];
    const revOut = [];
    const gather = (node, newLim, revLim) => {
      const own = node.deck.filtered ? { new: Infinity, rev: Infinity } : limitsLeft(col, node.deck.id);
      newLim = Math.min(newLim, own.new);
      revLim = Math.min(revLim, own.rev);
      const b = buckets.get(node.deck.id) || { new: [], rev: [], daylrn: [] };
      const np = col.presetFor(node.deck.id);
      const ns = sortNew(np, [...b.new]).slice(0, newLim);
      const rs = sortRev(np, [...b.rev, ...b.daylrn], today, col).slice(0, revLim);
      newOut.push(...ns);
      revOut.push(...rs);
      let usedN = ns.length;
      let usedR = rs.length;
      for (const k of node.kids) {
        const [a, b2] = gather(k, newLim - usedN, revLim - usedR);
        usedN += a;
        usedR += b2;
      }
      return [usedN, usedR];
    };
    if (root) gather(root, Infinity, Infinity);
    const nAll = this.deck.filtered ? newOut : newOut.slice(0, root?.new ?? 0);
    if (p.gatherOrder === 'random') shuffle(nAll);
    // 兄弟のカードは同じ日に出さないなら、1つだけ残す
    const seen = new Set();
    const dedupe = (arr, on) =>
      on
        ? arr.filter((c) => {
            if (seen.has(c.nid)) return false;
            seen.add(c.nid);
            return true;
          })
        : arr;
    this.revQ = dedupe(sortRev(p, revOut, today, col).slice(0, this.deck.filtered ? Infinity : root?.rev ?? 0), p.buryRev).map((c) => c.id);
    this.newQ = dedupe(nAll, p.buryNew).map((c) => c.id);
    this.answeredSinceNew = 0;
  }

  /** 学習中のカード（今すぐのもの、または先に出してよいもの） */
  learning(ahead = false) {
    const col = this.col;
    const ids = col.deckTreeIds(this.did);
    const limit = Date.now() + (ahead ? (col.conf.learnAheadMins ?? 20) * 60000 : 0);
    const out = [];
    for (const c of col.cards.values()) if (c.queue === Q_LRN && c.due <= limit && ids.has(c.did)) out.push(c);
    return out.sort((a, b) => a.due - b.due);
  }

  valid(id, queue) {
    const c = this.col.cards.get(id);
    if (!c || !this.col.deckTreeIds(this.did).has(c.did)) return null;
    if (queue === Q_NEW ? c.queue !== Q_NEW : c.queue !== Q_REV && c.queue !== Q_DAYLRN) return null;
    return c;
  }

  peek(arr, queue) {
    while (arr.length) {
      const c = this.valid(arr[0], queue);
      if (c) return c;
      arr.shift();
    }
    return null;
  }

  counts() {
    const col = this.col;
    const ids = col.deckTreeIds(this.did);
    const cutoff = col.dayCutoff();
    let lrn = 0;
    for (const c of col.cards.values()) if (c.queue === Q_LRN && c.due < cutoff && ids.has(c.did)) lrn++;
    const n = this.newQ.filter((id) => this.valid(id, Q_NEW)).length;
    const r = this.revQ.filter((id) => this.valid(id, Q_REV)).length;
    return { new: n, lrn, rev: r };
  }

  /** 次に出すカード */
  next() {
    const lrnNow = this.learning(false);
    if (lrnNow.length) return lrnNow[0];
    const p = this.preset;
    const nc = this.peek(this.newQ, Q_NEW);
    const rc = this.peek(this.revQ, Q_REV);
    if (nc && rc) {
      if (p.newMix === 'before') return nc;
      if (p.newMix === 'after') return rc;
      // 混ぜる：復習の数に合わせて新規をはさむ
      const every = Math.max(1, Math.floor((this.revQ.length + 1) / (this.newQ.length + 1)));
      return this.answeredSinceNew >= every ? nc : rc;
    }
    if (nc || rc) return nc || rc;
    const ahead = this.learning(true);
    return ahead[0] || null;
  }

  opts(card) {
    const col = this.col;
    return {
      preset: col.presetForCard(card),
      now: Date.now(),
      today: col.today(),
      fsrs: col.conf.fsrs,
      rollover: col.conf.rollover,
      cramming: !!this.deck.filtered && card.odid,
    };
  }

  intervals(card) {
    if (this.preview) return [60, 600, 0, 0];
    return nextIntervals(realDue(card), this.opts(card));
  }

  answer(card, grade, timeMs) {
    const col = this.col;
    const o = this.opts(card);
    const p = o.preset;
    let result;
    col.transact('答え', () => {
      if (this.preview) {
        result = previewAnswer(col, card, grade, o.now);
        return;
      }
      const r = answer(realDue(card), grade, o);
      const c = r.card;
      c.odue = 0;
      delete c.oqueue;
      const homeDid = card.odid || card.did;
      if (r.leech) {
        const note = col.notes.get(c.nid);
        if (note) col.put('notes', { ...note, tags: normTags([...note.tags, 'leech']) });
        if (p.leechAction === 'suspend') c.queue = Q_SUSPENDED;
      }
      // フィルターのデッキから卒業したら元のデッキへ
      if (card.odid && (c.queue === Q_REV || c.queue === Q_DAYLRN || c.queue === Q_SUSPENDED)) {
        c.did = card.odid;
        c.odid = 0;
        c.odue = 0;
      }
      col.put('cards', c);
      col.addRevlog({ cid: c.id, did: homeDid, ...r.log, time: Math.min(timeMs, (p.maxAnswerSecs || 60) * 1000) });
      buryAfter(col, c, p);
      result = { card: c, leech: r.leech };
    });
    if (card.type === NEW) this.answeredSinceNew = 0;
    else this.answeredSinceNew++;
    this.history.push(card.id);
    return result;
  }
}

/** フィルターのデッキでは期日を入れかえているので、計算には元の期日を使う */
const realDue = (card) => (card.odid && card.odue ? { ...card, due: card.odue } : card);

function previewAnswer(col, card, grade, now) {
  const c = { ...card };
  if (grade <= 2) {
    c.queue = Q_LRN;
    c.due = now + (grade === 1 ? 60000 : 600000);
    c.previewing = true;
  } else {
    // 元のデッキに戻す
    restoreFromFiltered(c);
  }
  col.put('cards', c);
  return { card: c, leech: false };
}

export function restoreFromFiltered(c) {
  if (!c.odid) return c;
  c.did = c.odid;
  c.odid = 0;
  if (c.previewing || c.odue) {
    // プレビューで学習中にしたものはもとに戻す
    if (c.odue) c.due = c.odue;
    c.queue = c.type === NEW ? Q_NEW : c.type === REV ? Q_REV : c.type === RELRN || c.type === 1 ? Q_LRN : Q_NEW;
    if (c.oqueue != null) c.queue = c.oqueue;
  }
  delete c.previewing;
  delete c.oqueue;
  c.odue = 0;
  return c;
}

function buryAfter(col, card, p) {
  const today = col.today();
  for (const s of col.cardsOfNote(card.nid)) {
    if (s.id === card.id) continue;
    const bury =
      (s.queue === Q_NEW && p.buryNew) || (s.queue === Q_REV && s.due <= today && p.buryRev) || (s.queue === Q_DAYLRN && s.due <= today && p.buryInterday);
    if (bury) col.put('cards', { ...s, queue: Q_SIB_BURIED, buriedDay: today });
  }
}

export { Q_BURIED };
