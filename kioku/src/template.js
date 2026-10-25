// カードの型（{{項目}} の書き方）を HTML にする。Anki と同じ書き方に合わせている
import { esc, stripHtml } from './util.js';

const TAG_RE = /\{\{([^{}]+?)\}\}/g;

function parse(fmt) {
  const root = { kids: [] };
  const stack = [root];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(fmt))) {
    if (m.index > last) stack.at(-1).kids.push(fmt.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const tag = m[1].trim();
    if (tag[0] === '#' || tag[0] === '^') {
      const node = { sec: tag.slice(1).trim(), neg: tag[0] === '^', kids: [] };
      stack.at(-1).kids.push(node);
      stack.push(node);
    } else if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      // 閉じ忘れがあっても壊れないように、同じ名前まで戻る
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].sec === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      stack.at(-1).kids.push({ tag });
    }
  }
  if (last < fmt.length) stack.at(-1).kids.push(fmt.slice(last));
  return root.kids;
}

function getField(ctx, name) {
  if (name in ctx.fields) return ctx.fields[name];
  const lower = name.toLowerCase();
  for (const k in ctx.fields) if (k.toLowerCase() === lower) return ctx.fields[k];
  return undefined;
}

function sectionOn(ctx, name) {
  const cm = /^c(\d+)$/i.exec(name);
  if (cm && ctx.clozeLike && getField(ctx, name) === undefined) return Number(cm[1]) === ctx.ord + 1;
  const v = getField(ctx, name);
  if (v === undefined) return false;
  return stripHtml(v) !== '' || /<img|\[sound:/i.test(v);
}

function walk(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') out += n;
    else if (n.sec !== undefined) {
      if (sectionOn(ctx, n.sec) !== n.neg) out += walk(n.kids, ctx);
    } else out += replaceTag(n.tag, ctx);
  }
  return out;
}

function replaceTag(tag, ctx) {
  if (tag.startsWith('tts ')) {
    // {{tts ja_JP:項目}}
    const i = tag.lastIndexOf(':');
    const opts = tag.slice(4, i).trim().split(/\s+/);
    const val = getField(ctx, tag.slice(i + 1).trim()) ?? '';
    const v = stripHtml(val);
    if (v) ctx.nonEmpty++;
    const lang = (opts[0] || 'ja_JP').replace('_', '-');
    const speed = /speed=([\d.]+)/.exec(tag)?.[1] || '1';
    return `[anki:tts lang=${lang} speed=${speed}]${esc(v)}[/anki:tts]`;
  }
  const parts = tag.split(':');
  const name = parts.pop().trim();
  const filters = parts.map((p) => p.trim()).reverse();
  switch (name) {
    case 'FrontSide':
      return ctx.frontSide ?? '';
    case 'Tags':
      return esc(ctx.tags.join(' '));
    case 'Deck':
      return esc(ctx.deckName);
    case 'Subdeck':
      return esc(ctx.deckName.split('::').pop());
    case 'Card':
      return esc(ctx.cardName);
    case 'Type':
      return esc(ctx.typeName);
    case 'CardFlag':
      return ctx.flag ? `flag${ctx.flag}` : '';
  }
  let val = getField(ctx, name);
  if (val === undefined) {
    return filters.length || /^[^\s]+$/.test(name) ? `<span class="tmpl-missing">{{${esc(name)}}} という項目はありません</span>` : '';
  }
  if (filters.includes('type')) return typeTag(ctx, val, filters);
  for (const f of filters) val = applyFilter(f, val, ctx, name);
  if (stripHtml(val) !== '' || /<img|\[sound:/i.test(val)) ctx.nonEmpty++;
  return val;
}

function applyFilter(f, val, ctx, fieldName) {
  switch (f) {
    case 'text':
      return esc(stripHtml(val));
    case 'cloze':
      return renderCloze(val, ctx.ord + 1, ctx.side);
    case 'cloze-only':
      return esc(clozeAnswers(val, ctx.ord + 1).join(', '));
    case 'hint': {
      if (!stripHtml(val) && !/<img/i.test(val)) return '';
      return `<details class="hint"><summary>${esc(fieldName)}を見る</summary>${val}</details>`;
    }
    case 'furigana':
      return furigana(val, 'both');
    case 'kana':
      return furigana(val, 'kana');
    case 'kanji':
      return furigana(val, 'kanji');
    case 'image-occlusion':
      return renderOcclusion(val, ctx);
    default:
      return val;
  }
}

function typeTag(ctx, val, filters) {
  const isCloze = filters.includes('cloze');
  const expected = isCloze ? clozeAnswers(val, ctx.ord + 1).join(', ') : stripHtml(val);
  if (expected) ctx.nonEmpty++;
  ctx.typeExpected = expected;
  if (ctx.side === 'q') return ctx.forFront ? '' : '<input id="typeans" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="答えを入力">';
  if (ctx.forFront) return '';
  return compareAnswer(expected, ctx.typed ?? '');
}

// ---- 振り仮名  漢字[かんじ]
export function furigana(s, mode) {
  return s.replace(/ ?([^ >\]]+?)\[(.+?)\]/g, (_, base, reading) => {
    if (reading.startsWith('sound:')) return _;
    if (mode === 'kana') return reading;
    if (mode === 'kanji') return base;
    return `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`;
  });
}

// ---- 穴うめ
/** {{c1::答え::ヒント}} を木にする（入れ子も読む） */
export function parseCloze(text) {
  const root = { kids: [] };
  const stack = [root];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) stack.at(-1).kids.push(buf);
    buf = '';
  };
  while (i < text.length) {
    const m = /^\{\{c(\d+)::/i.exec(text.slice(i, i + 12));
    if (m) {
      flush();
      const node = { n: Number(m[1]), kids: [] };
      stack.at(-1).kids.push(node);
      stack.push(node);
      i += m[0].length;
      continue;
    }
    if (text.startsWith('}}', i) && stack.length > 1) {
      flush();
      const node = stack.pop();
      // 最後の文字のかたまりに :: があればヒント
      const lastText = node.kids.at(-1);
      if (typeof lastText === 'string') {
        const k = lastText.lastIndexOf('::');
        if (k >= 0) {
          node.hint = lastText.slice(k + 2);
          node.kids[node.kids.length - 1] = lastText.slice(0, k);
        }
      }
      i += 2;
      continue;
    }
    buf += text[i++];
  }
  flush();
  // 閉じていないものはふつうの文字に戻す
  while (stack.length > 1) {
    const node = stack.pop();
    const parent = stack.at(-1);
    parent.kids.pop();
    parent.kids.push(`{{c${node.n}::`, ...node.kids);
  }
  return root.kids;
}

export function clozeNumbers(text) {
  const out = new Set();
  const re = /\{\{c(\d+)::/gi;
  let m;
  while ((m = re.exec(text))) out.add(Number(m[1]));
  return out;
}

function nodeText(kids) {
  return kids.map((k) => (typeof k === 'string' ? k : nodeText(k.kids))).join('');
}

export function clozeAnswers(text, n) {
  const out = [];
  const visit = (kids) => {
    for (const k of kids) {
      if (typeof k === 'string') continue;
      if (k.n === n) out.push(stripHtml(nodeText(k.kids)));
      else visit(k.kids);
    }
  };
  visit(parseCloze(text));
  return out;
}

function renderCloze(text, n, side) {
  const r = (kids) =>
    kids
      .map((k) => {
        if (typeof k === 'string') return k;
        if (k.n === n) {
          if (side === 'q') return `<span class="cloze" data-cloze="${esc(nodeText(k.kids))}">[${k.hint ? k.hint : '...'}]</span>`;
          return `<span class="cloze">${r(k.kids)}</span>`;
        }
        return `<span class="cloze-inactive">${r(k.kids)}</span>`;
      })
      .join('');
  return r(parseCloze(text));
}

// ---- 画像の穴うめ
/** {{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}} を読む */
export function parseOcclusions(text) {
  const out = [];
  const re = /\{\{c(\d+)::image-occlusion:([a-z]+):([^}]*)\}\}/gi;
  let m;
  while ((m = re.exec(text))) {
    const props = {};
    for (const kv of m[3].split(':')) {
      const j = kv.indexOf('=');
      if (j > 0) props[kv.slice(0, j)] = kv.slice(j + 1);
    }
    out.push({ n: Number(m[1]), shape: m[2], props });
  }
  return out;
}

export function occlusionsToText(shapes) {
  return shapes
    .map((s) => {
      const p = Object.entries(s.props)
        .map(([k, v]) => `${k}=${v}`)
        .join(':');
      return `{{c${s.n}::image-occlusion:${s.shape}:${p}}}`;
    })
    .join('<br>');
}

function renderOcclusion(val, ctx) {
  const shapes = parseOcclusions(val);
  const img = ctx.ioImage || '';
  const n = ctx.ord + 1;
  const svg = shapes
    .filter((s) => s.n === n || s.props.oi === '1' || (shapes.find((x) => x.n === n)?.props.oi === '1'))
    .map((s) => {
      const active = s.n === n;
      if (active && ctx.side === 'a') return shapeSvg(s, 'io-shape io-revealed');
      return shapeSvg(s, active ? 'io-shape io-active' : 'io-shape io-inactive');
    })
    .join('');
  if (shapes.some((s) => s.n === n)) ctx.nonEmpty++;
  return `<div class="io-wrap">${img}<svg class="io-svg" viewBox="0 0 1 1" preserveAspectRatio="none">${svg}</svg></div>`;
}

function shapeSvg(s, cls) {
  const p = s.props;
  const f = (v) => Number(v) || 0;
  if (s.shape === 'ellipse') {
    const rx = f(p.rx) || f(p.width) / 2;
    const ry = f(p.ry) || f(p.height) / 2;
    return `<ellipse class="${cls}" cx="${f(p.left) + rx}" cy="${f(p.top) + ry}" rx="${rx}" ry="${ry}" vector-effect="non-scaling-stroke"/>`;
  }
  if (s.shape === 'polygon') {
    return `<polygon class="${cls}" points="${esc((p.points || '').replace(/,/g, ' ').trim().split(/\s+/).reduce((a, v, i) => a + (i % 2 ? ',' : ' ') + v, ''))}" vector-effect="non-scaling-stroke"/>`;
  }
  return `<rect class="${cls}" x="${f(p.left)}" y="${f(p.top)}" width="${f(p.width)}" height="${f(p.height)}" vector-effect="non-scaling-stroke"/>`;
}

// ---- 入力した答えと正しい答えを比べる
export function compareAnswer(expected, typed) {
  const e = expected.trim();
  const t = typed.trim();
  if (!t) return `<code id="typeans">${esc(e)}</code>`;
  if (t === e) return `<code id="typeans"><span class="typeGood">${esc(t)}</span></code>`;
  // 1文字ずつ一番長い共通部分を探す
  const a = [...t];
  const b = [...e];
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0;
  let j = 0;
  let typedOut = '';
  let expOut = '';
  const span = (cls, s) => (s ? `<span class="${cls}">${esc(s)}</span>` : '');
  let run = { cls: '', s: '' };
  let erun = { cls: '', s: '' };
  const push = (r, cls, ch, side) => {
    if (r.cls !== cls) {
      if (side === 't') typedOut += span(r.cls, r.s);
      else expOut += span(r.cls, r.s);
      r.cls = cls;
      r.s = '';
    }
    r.s += ch;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(run, 'typeGood', a[i], 't');
      push(erun, 'typeGood', b[j], 'e');
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) {
      push(run, 'typeMissed', '-', 't');
      push(erun, 'typeMissed', b[j], 'e');
      j++;
    } else {
      push(run, 'typeBad', a[i], 't');
      i++;
    }
  }
  typedOut += span(run.cls, run.s);
  expOut += span(erun.cls, erun.s);
  return `<code id="typeans">${typedOut}<br><span id="typearrow">&darr;</span><br>${expOut}</code>`;
}

// ---- 全体
export function fieldMap(nt, note) {
  const f = {};
  nt.fields.forEach((fd, i) => (f[fd.name] = note.fields[i] ?? ''));
  return f;
}

/**
 * カードの表か裏を作る
 * @returns {{html:string, nonEmpty:number, typeExpected?:string}}
 */
export function renderSide(fmt, o) {
  const ctx = {
    fields: o.fields,
    ord: o.ord,
    side: o.side,
    tags: o.tags || [],
    deckName: o.deckName || '',
    cardName: o.cardName || '',
    typeName: o.typeName || '',
    flag: o.flag || 0,
    clozeLike: o.clozeLike,
    frontSide: o.frontSide,
    typed: o.typed,
    forFront: o.forFront,
    ioImage: o.ioImage,
    nonEmpty: 0,
  };
  const html = postProcess(walk(parse(fmt), ctx));
  return { html, nonEmpty: ctx.nonEmpty, typeExpected: ctx.typeExpected };
}

function postProcess(html) {
  return html
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_, m) => `\\[${m}\\]`)
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_, m) => `\\(${m}\\)`)
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/g, (_, m) => `\\[${m}\\]`);
}

export function renderCard({ card, note, nt, deckName, typed }) {
  const clozeLike = nt.kind === 'cloze' || nt.kind === 'io';
  const tmpl = clozeLike ? nt.templates[0] : nt.templates[card.ord] || nt.templates[0];
  const fields = fieldMap(nt, note);
  const base = {
    fields,
    ord: card.ord,
    tags: note.tags,
    deckName,
    cardName: clozeLike ? `${tmpl.name} ${card.ord + 1}` : tmpl.name,
    typeName: nt.name,
    flag: card.flags,
    clozeLike,
    typed,
    ioImage: nt.kind === 'io' ? note.fields[1] || '' : undefined,
  };
  const q = renderSide(tmpl.qfmt, { ...base, side: 'q' });
  const front = renderSide(tmpl.qfmt, { ...base, side: 'q', forFront: true });
  const a = renderSide(tmpl.afmt, { ...base, side: 'a', frontSide: front.html });
  return { q: q.html, a: a.html, css: nt.css || '', typeExpected: q.typeExpected ?? a.typeExpected };
}

/** このノートからできるカードの番号（ord）の一覧 */
export function cardOrds(nt, fieldsArr) {
  const note = { fields: fieldsArr, tags: [] };
  const fields = fieldMap(nt, note);
  if (nt.kind === 'cloze' || nt.kind === 'io') {
    const nums = new Set();
    const tmpl = nt.templates[0];
    const refs = [...(tmpl.qfmt + tmpl.afmt).matchAll(/\{\{[^}]*?(?:cloze|image-occlusion):([^}]+?)\}\}/g)].map((m) => m[1].trim());
    const names = refs.length ? refs : nt.fields.map((f) => f.name);
    for (const n of names) for (const c of clozeNumbers(fields[n] ?? '')) nums.add(c);
    return [...nums].sort((a, b) => a - b).map((n) => n - 1);
  }
  const ords = [];
  nt.templates.forEach((t, i) => {
    const r = renderSide(t.qfmt, { fields, ord: i, side: 'q', tags: [], forFront: true });
    if (r.nonEmpty > 0) ords.push(i);
  });
  return ords;
}
