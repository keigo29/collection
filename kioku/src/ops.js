// カードやノートへのまとめての操作
import { Q_NEW, Q_LRN, Q_REV, Q_DAYLRN, Q_SUSPENDED, Q_BURIED, Q_SIB_BURIED, NEW, REV } from './sched/answer.js';
import { restoreFromFiltered } from './sched/queue.js';
import { normTags } from './col.js';
import { search } from './search.js';
import { cardOrds, renderCard } from './template.js';
import { newId, shuffle, stripHtml } from './util.js';

const cardsOf = (col, cids) => cids.map((id) => col.cards.get(id)).filter(Boolean);

export function suspend(col, cids, on) {
  col.transact(on ? '保留' : '保留をやめる', () => {
    for (const c of cardsOf(col, cids)) {
      if (on && c.queue !== Q_SUSPENDED) col.put('cards', { ...c, queue: Q_SUSPENDED });
      if (!on && c.queue === Q_SUSPENDED) col.restoreQueue({ ...c });
    }
  });
}

export function bury(col, cids, on = true) {
  const today = col.today();
  col.transact(on ? 'あとまわし' : 'あとまわしをやめる', () => {
    for (const c of cardsOf(col, cids)) {
      if (on && c.queue >= 0) col.put('cards', { ...c, queue: Q_BURIED, buriedDay: today });
      if (!on && (c.queue === Q_BURIED || c.queue === Q_SIB_BURIED)) col.restoreQueue({ ...c });
    }
  });
}

export function buryNote(col, nid) {
  bury(
    col,
    col.cardsOfNote(nid).map((c) => c.id)
  );
}

export function setFlag(col, cids, flag) {
  col.transact('目印', () => {
    for (const c of cardsOf(col, cids)) col.put('cards', { ...c, flags: c.flags === flag && cids.length === 1 ? 0 : flag });
  });
}

export function toggleMark(col, nid) {
  const n = col.notes.get(nid);
  if (!n) return false;
  const has = n.tags.some((t) => t.toLowerCase() === 'marked');
  col.transact('印', () => {
    col.put('notes', { ...n, tags: has ? n.tags.filter((t) => t.toLowerCase() !== 'marked') : [...n.tags, 'marked'] });
  });
  return !has;
}

export function setDeck(col, cids, did) {
  col.transact('デッキを変える', () => {
    for (const c of cardsOf(col, cids)) {
      if (c.odid) col.put('cards', { ...c, odid: did });
      else col.put('cards', { ...c, did });
    }
  });
}

export function addTags(col, nids, tags) {
  const add = normTags(tags);
  col.transact('タグを足す', () => {
    for (const nid of nids) {
      const n = col.notes.get(nid);
      if (n) col.put('notes', { ...n, tags: normTags([...n.tags, ...add]) });
    }
  });
}

export function removeTags(col, nids, tags) {
  const rm = new Set(normTags(tags).map((t) => t.toLowerCase()));
  col.transact('タグを外す', () => {
    for (const nid of nids) {
      const n = col.notes.get(nid);
      if (n) col.put('notes', { ...n, tags: n.tags.filter((t) => !rm.has(t.toLowerCase())) });
    }
  });
}

export function renameTag(col, from, to) {
  const f = from.toLowerCase();
  col.transact('タグの名前を変える', () => {
    for (const n of col.notes.values()) {
      if (!n.tags.some((t) => t.toLowerCase() === f || t.toLowerCase().startsWith(f + '::'))) continue;
      col.put('notes', {
        ...n,
        tags: normTags(n.tags.map((t) => (t.toLowerCase() === f ? to : t.toLowerCase().startsWith(f + '::') ? to + t.slice(from.length) : t))),
      });
    }
  });
}

/** 新しいカードに戻す */
export function forget(col, cids, { resetCounts = false } = {}) {
  col.transact('新しいカードに戻す', () => {
    for (const c of cardsOf(col, cids)) {
      const nc = { ...c, type: NEW, queue: Q_NEW, due: col.nextPos(), ivl: 0, factor: 0, left: 0, s: undefined, d: undefined, lastReview: undefined };
      if (resetCounts) Object.assign(nc, { reps: 0, lapses: 0 });
      col.put('cards', nc);
      col.addRevlog({ cid: c.id, did: c.did, type: 4, ease: 0, ivl: 0, lastIvl: c.ivl, factor: 0, time: 0 });
    }
  });
}

/** 新しいカードの順番を入れかえる */
export function reposition(col, cids, start = 1, step = 1, { randomize = false, shift = false } = {}) {
  const cards = cardsOf(col, cids).filter((c) => c.type === NEW);
  const byNote = new Map();
  for (const c of cards.sort((a, b) => a.due - b.due)) {
    if (!byNote.has(c.nid)) byNote.set(c.nid, []);
    byNote.get(c.nid).push(c);
  }
  const groups = [...byNote.values()];
  if (randomize) shuffle(groups);
  col.transact('順番を変える', () => {
    if (shift) {
      const span = groups.length * step;
      const mine = new Set(cards.map((c) => c.id));
      for (const c of col.cards.values()) if (c.type === NEW && !mine.has(c.id) && c.due >= start) col.put('cards', { ...c, due: c.due + span });
    }
    groups.forEach((g, i) => {
      for (const c of g) col.put('cards', { ...c, due: start + i * step });
    });
    const max = Math.max(...[...col.cards.values()].filter((c) => c.type === NEW).map((c) => c.due), 0);
    if (max >= (col.conf.nextPos || 1)) col.setConf({ nextPos: max + 1 });
  });
}

/** 期日を決める。"0" は今日、"1-7" は 1〜7 日後のどれか、末尾に ! で間隔も変える */
export function setDueDate(col, cids, spec) {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*(!)?\s*$/.exec(spec);
  if (!m) throw new Error('「0」「1-7」「3!」のように書いてください');
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  const setIvl = !!m[3];
  const today = col.today();
  col.transact('期日を決める', () => {
    for (const c of cardsOf(col, cids)) {
      const days = lo + Math.floor(Math.random() * (hi - lo + 1));
      const nc = { ...c, type: REV, queue: c.queue === Q_SUSPENDED ? Q_SUSPENDED : Q_REV, due: today + days, left: 0 };
      if (!c.factor) nc.factor = Math.round((col.presetForCard(c).startEase || 2.5) * 1000);
      if (setIvl || !c.ivl) nc.ivl = Math.max(1, days);
      col.put('cards', nc);
      col.addRevlog({ cid: c.id, did: c.did, type: 4, ease: 0, ivl: nc.ivl, lastIvl: c.ivl, factor: nc.factor, time: 0 });
    }
  });
}

// ---- フィルターのデッキ
const ORDERS = {
  oldest: (a, b) => (a.lastReview || 0) - (b.lastReview || 0),
  random: null,
  ivlAsc: (a, b) => a.ivl - b.ivl,
  ivlDesc: (a, b) => b.ivl - a.ivl,
  lapses: (a, b) => b.lapses - a.lapses,
  added: (a, b) => a.nid - b.nid,
  addedDesc: (a, b) => b.nid - a.nid,
  due: (a, b) => (a.type === b.type ? a.due - b.due : a.type - b.type),
  overdue: null,
};

export const FILTER_ORDERS = [
  ['random', 'ばらばら'],
  ['due', '期日の順'],
  ['overdue', '遅れている順'],
  ['oldest', '最後に見たのが古い順'],
  ['ivlAsc', '間隔の短い順'],
  ['ivlDesc', '間隔の長い順'],
  ['lapses', 'よく忘れる順'],
  ['added', '追加した順'],
  ['addedDesc', '新しく追加した順'],
];

export function buildFiltered(col, did) {
  const d = col.decks.get(did);
  if (!d?.filtered) return 0;
  emptyFiltered(col, did, true);
  const today = col.today();
  let total = 0;
  col.transact('フィルターのデッキを作る', () => {
    const taken = new Set();
    for (const term of d.filtered.terms || []) {
      if (!term.search && term.search !== '') continue;
      let cards = search(col, term.search, { cards: true, currentDeck: col.conf.curDeck })
        .map((id) => col.cards.get(id))
        .filter((c) => c && !c.odid && !taken.has(c.id) && c.queue !== Q_SUSPENDED && c.queue !== Q_BURIED && c.queue !== Q_SIB_BURIED && !col.decks.get(c.did)?.filtered);
      if (term.order === 'random') shuffle(cards);
      else if (term.order === 'overdue') cards.sort((a, b) => (today - b.due) / Math.max(1, b.ivl) - (today - a.due) / Math.max(1, a.ivl));
      else if (ORDERS[term.order]) cards.sort(ORDERS[term.order]);
      cards = cards.slice(0, term.limit ?? 100);
      cards.forEach((c, i) => {
        taken.add(c.id);
        const nc = { ...c, odid: c.did, did, oqueue: c.queue };
        if (c.queue === Q_REV || c.queue === Q_DAYLRN) {
          nc.odue = c.due;
          nc.due = today - 100000 + i;
          nc.queue = Q_REV;
        } else if (c.queue === Q_NEW) {
          nc.odue = c.due;
          nc.due = -100000 + total + i;
        }
        col.put('cards', nc);
      });
      total += cards.length;
    }
  });
  return total;
}

export function emptyFiltered(col, did, quiet = false) {
  col.transact(quiet ? null : 'フィルターのデッキを空にする', () => {
    for (const c of col.cards.values()) if (c.did === did && c.odid) col.put('cards', restoreFromFiltered({ ...c }));
  });
}

export function deleteDeck(col, did) {
  const d = col.decks.get(did);
  if (!d) return;
  col.transact('デッキの削除', () => {
    const ids = [...col.deckTreeIds(did)];
    for (const id of ids) if (col.decks.get(id)?.filtered) emptyFiltered(col, id, true);
    const set = new Set(ids);
    const cids = [];
    for (const c of col.cards.values()) {
      if (set.has(c.did)) cids.push(c.id);
      else if (c.odid && set.has(c.odid)) {
        // 別のフィルターに借りられているカードも消す
        cids.push(c.id);
      }
    }
    col.deleteCards(cids);
    for (const id of ids) col.remove('decks', id);
    if (!col.decks.size) col.put('decks', { id: 1, name: 'デフォルト', presetId: col.defaultPresetId(), desc: '' });
    if (!col.decks.has(col.conf.curDeck)) col.setConf({ curDeck: col.sortedDecks()[0]?.id });
  });
}

// ---- カスタム学習
export function customStudy(col, did, kind, opts) {
  const d = col.decks.get(did);
  const today = col.today();
  if (kind === 'newLimit' || kind === 'revLimit') {
    const ex = col.conf.extend?.day === today ? structuredClone(col.conf.extend) : { day: today, decks: {} };
    const cur = ex.decks[did] || { new: 0, rev: 0 };
    if (kind === 'newLimit') cur.new += opts.n;
    else cur.rev += opts.n;
    ex.decks[did] = cur;
    col.transact('今日の上限をふやす', () => col.setConf({ extend: ex }));
    return null;
  }
  const deckQ = `deck:"${d.name.replace(/"/g, '\\"')}"`;
  let term;
  let reschedule = true;
  switch (kind) {
    case 'forgot':
      term = { search: `${deckQ} rated:${opts.n}:1`, limit: 9999, order: 'random' };
      break;
    case 'ahead':
      term = { search: `${deckQ} prop:due<=${opts.n} -is:new`, limit: 9999, order: 'due' };
      break;
    case 'previewNew':
      term = { search: `${deckQ} is:new added:${opts.n}`, limit: 9999, order: 'added' };
      reschedule = false;
      break;
    case 'tags': {
      const tq = opts.tags?.length ? '(' + opts.tags.map((t) => `tag:"${t}"`).join(' OR ') + ')' : '';
      const st = opts.state === 'new' ? 'is:new' : opts.state === 'due' ? 'is:due' : '';
      term = { search: `${deckQ} ${tq} ${st}`.trim(), limit: opts.limit || 100, order: opts.state === 'new' ? 'added' : 'random' };
      break;
    }
    default:
      return null;
  }
  const name = 'カスタム学習';
  let fd = col.deckByName(name);
  col.transact('カスタム学習', () => {
    if (fd && !fd.filtered) fd = col.ensureDeck(`${name} ${Date.now() % 1000}`);
    if (!fd) fd = { id: newId(), name, desc: '' };
    col.put('decks', { ...fd, filtered: { terms: [term], reschedule } });
  });
  buildFiltered(col, fd.id);
  return fd.id;
}

// ---- 調べものと片付け
export function findReplace(col, nids, find, repl, { field = null, regex = false, matchCase = false } = {}) {
  const re = regex ? new RegExp(find, matchCase ? 'g' : 'gi') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
  let changed = 0;
  col.transact('探して置きかえる', () => {
    for (const nid of nids) {
      const n = col.notes.get(nid);
      if (!n) continue;
      const nt = col.notes && col.notetypes.get(n.ntid);
      let hit = false;
      const fields = n.fields.map((v, i) => {
        if (field === '__tags') return v;
        if (field && nt.fields[i]?.name !== field) return v;
        const nv = v.replace(re, repl);
        if (nv !== v) hit = true;
        return nv;
      });
      let tags = n.tags;
      if (field === '__tags') {
        const nt2 = n.tags.map((t) => t.replace(re, repl));
        if (nt2.join(' ') !== n.tags.join(' ')) {
          hit = true;
          tags = normTags(nt2);
        }
      }
      if (hit) {
        changed++;
        col.put('notes', { ...n, fields, tags });
      }
    }
  });
  return changed;
}

export function findDupes(col, ntid, fieldIdx, nids = null) {
  const m = new Map();
  for (const n of col.notes.values()) {
    if (n.ntid !== ntid) continue;
    if (nids && !nids.has(n.id)) continue;
    const k = stripHtml(n.fields[fieldIdx] || '').toLowerCase();
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(n.id);
  }
  return [...m.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, nids: v }));
}

export function isDupe(col, ntid, first, selfId) {
  const k = stripHtml(first || '').toLowerCase();
  if (!k) return false;
  for (const n of col.notes.values()) if (n.ntid === ntid && n.id !== selfId && stripHtml(n.fields[0] || '').toLowerCase() === k) return true;
  return false;
}

/** 表が空になったカード */
export function emptyCards(col) {
  const out = [];
  for (const n of col.notes.values()) {
    const nt = col.notetypes.get(n.ntid);
    if (!nt) continue;
    const ok = new Set(cardOrds(nt, n.fields));
    for (const c of col.cardsOfNote(n.id)) if (!ok.has(c.ord)) out.push(c.id);
  }
  return out;
}

/** データを点検して直す */
export function checkDatabase(col) {
  const report = [];
  col.transact('データの点検', () => {
    // カードのないノート / ノートのないカード
    let orphanCards = 0;
    for (const c of [...col.cards.values()]) {
      if (!col.notes.has(c.nid)) {
        col.remove('cards', c.id);
        orphanCards++;
      }
    }
    if (orphanCards) report.push(`ノートのないカードを ${orphanCards} 枚消しました`);
    let noCards = 0;
    for (const n of [...col.notes.values()]) {
      if (!col.notetypes.has(n.ntid)) {
        for (const c of col.cardsOfNote(n.id)) col.remove('cards', c.id);
        col.remove('notes', n.id);
        noCards++;
        continue;
      }
      if (!col.cardsOfNote(n.id).length) {
        if (col.genCards(n, col.conf.addDeck || col.sortedDecks()[0].id) === 0) {
          col.remove('notes', n.id);
          noCards++;
        }
      }
    }
    if (noCards) report.push(`カードのないノートを ${noCards} 件直しました`);
    // デッキがないカード
    let noDeck = 0;
    const fallback = col.ensureDeck('デフォルト');
    for (const c of col.cards.values()) {
      if (!col.decks.has(c.did) || (c.odid && !col.decks.has(c.odid))) {
        col.put('cards', { ...c, did: col.decks.has(c.odid) ? c.odid : fallback.id, odid: 0, odue: 0 });
        noDeck++;
      }
      // 項目の数をそろえる
    }
    if (noDeck) report.push(`デッキがないカード ${noDeck} 枚を「デフォルト」に移しました`);
    let fieldFix = 0;
    for (const n of col.notes.values()) {
      const nt = col.notetypes.get(n.ntid);
      if (nt && n.fields.length !== nt.fields.length) {
        const f = nt.fields.map((_, i) => n.fields[i] ?? '');
        if (n.fields.length > nt.fields.length) f[f.length - 1] += n.fields.slice(nt.fields.length).join('');
        col.put('notes', { ...n, fields: f });
        fieldFix++;
      }
    }
    if (fieldFix) report.push(`項目の数がちがうノート ${fieldFix} 件を直しました`);
    // 期日がおかしいもの
    let badDue = 0;
    const today = col.today();
    for (const c of col.cards.values()) {
      if (c.queue === Q_REV && (c.due > today + 365 * 100 || !Number.isFinite(c.due))) {
        col.put('cards', { ...c, due: today });
        badDue++;
      }
      if (c.queue === Q_LRN && c.due < 1e9) {
        col.put('cards', { ...c, queue: Q_DAYLRN });
        badDue++;
      }
    }
    if (badDue) report.push(`期日がおかしいカード ${badDue} 枚を直しました`);
  });
  if (!report.length) report.push('問題は見つかりませんでした');
  return report;
}

/** 使っていない画像や音、なくなっている画像や音 */
export function checkMedia(col) {
  const used = new Set();
  const re = /<img[^>]+src=["']?([^"' >]+)|\[sound:([^\]]+)\]|url\(["']?([^"')]+)/gi;
  const scan = (s) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) used.add(decodeURIComponent(m[1] || m[2] || m[3]));
  };
  for (const n of col.notes.values()) n.fields.forEach(scan);
  for (const nt of col.notetypes.values()) {
    scan(nt.css || '');
    nt.templates.forEach((t) => scan(t.qfmt + t.afmt));
  }
  const unused = [...col.mediaMeta.keys()].filter((k) => !used.has(k) && !k.startsWith('_'));
  const missing = [...used].filter((k) => !col.mediaMeta.has(k) && !/^(https?:|data:|blob:)/.test(k));
  return { unused, missing };
}

/** ノートの種類を変える。fieldMap[新しい項目] = 古い項目の番号 or -1、cardMap[古い ord] = 新しい ord or -1 */
export function changeNotetype(col, nids, newNtid, fieldMap, cardMap) {
  const nt = col.notetypes.get(newNtid);
  col.transact('ノートの種類を変える', () => {
    for (const nid of nids) {
      const n = col.notes.get(nid);
      if (!n) continue;
      const fields = fieldMap.map((old) => (old >= 0 ? n.fields[old] ?? '' : ''));
      col.put('notes', { ...n, ntid: newNtid, fields });
      for (const c of col.cardsOfNote(nid)) {
        const to = nt.kind === 'std' ? cardMap?.[c.ord] ?? -1 : c.ord;
        if (to < 0) col.remove('cards', c.id);
        else col.put('cards', { ...c, ord: to });
      }
      col.genCards(col.notes.get(nid));
    }
  });
}

/** カードの型が変わったあと、増えた型のカードを作り、消えた型のカードを消す */
export function syncTemplates(col, ntid, removedOrds = [], ordMap = null) {
  const nt = col.notetypes.get(ntid);
  col.transact(null, () => {
    for (const n of col.notes.values()) {
      if (n.ntid !== ntid) continue;
      for (const c of col.cardsOfNote(n.id)) {
        if (removedOrds.includes(c.ord)) col.remove('cards', c.id);
        else if (ordMap && ordMap[c.ord] !== c.ord) col.put('cards', { ...c, ord: ordMap[c.ord] });
      }
      if (nt.kind === 'std') col.genCards(n);
    }
  });
}

/** 項目の並びが変わったとき、ノートの中身を並べかえる。order[新しい番号] = 古い番号 or -1 */
export function remapFields(col, ntid, order) {
  col.transact(null, () => {
    for (const n of col.notes.values()) {
      if (n.ntid !== ntid) continue;
      col.put('notes', { ...n, fields: order.map((o) => (o >= 0 ? n.fields[o] ?? '' : '')) });
    }
  });
}

export function previewHtml(col, cid) {
  const c = col.cards.get(cid);
  const n = col.notes.get(c.nid);
  const nt = col.notetypes.get(n.ntid);
  return renderCard({ card: c, note: n, nt, deckName: col.decks.get(c.odid || c.did)?.name || '' });
}

export { Q_LRN, Q_DAYLRN, REV };
