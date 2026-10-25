import { describe, it, expect, beforeEach } from 'vitest';
import { Collection } from '../src/col.js';
import { answer, fuzzRange, isLeech, NEW, LRN, REV, RELRN, Q_LRN, Q_REV, Q_DAYLRN } from '../src/sched/answer.js';
import { Session, deckCounts } from '../src/sched/queue.js';
import { defaultPreset } from '../src/stock.js';
import { renderCard, cardOrds, parseCloze, clozeAnswers, compareAnswer, furigana, parseOcclusions } from '../src/template.js';
import { search, parse } from '../src/search.js';
import { setDueDate, suspend, buildFiltered, emptyFiltered, customStudy, forget, reposition } from '../src/ops.js';
import { mergeSnapshots } from '../src/sync.js';
import { parseDelimited } from '../src/io/text.js';

function mkCol() {
  const col = new Collection();
  col.flushSoon = () => {};
  col.init();
  col.checkDay();
  return col;
}

const base = (o = {}) => ({ id: 1000, nid: 1, did: 1, ord: 0, type: NEW, queue: 0, due: 1, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, flags: 0, ...o });
const opts = (o = {}) => ({ preset: defaultPreset(), now: 1_700_000_000_000, today: 19000, fsrs: false, rollover: 4, ...o });

describe('SM-2', () => {
  it('新しいカードは学習のステップを進む', () => {
    let { card } = answer(base(), 3, opts());
    expect(card.type).toBe(LRN);
    expect(card.queue).toBe(Q_LRN);
    expect(card.left).toBe(1);
    expect(card.due - opts().now).toBe(10 * 60000);
    ({ card } = answer(card, 3, opts()));
    expect(card.type).toBe(REV);
    expect(card.ivl).toBe(1);
    expect(card.due).toBe(19001);
    expect(card.factor).toBe(2500);
  });
  it('もう一度は最初のステップへ、簡単はすぐ卒業', () => {
    const a = answer(base(), 1, opts()).card;
    expect(a.due - opts().now).toBe(60000);
    const e = answer(base(), 4, opts()).card;
    expect(e.type).toBe(REV);
    expect(e.ivl).toBe(4);
  });
  it('難しい（最初のステップ）は2つのステップの平均', () => {
    const h = answer(base(), 2, opts()).card;
    expect(h.due - opts().now).toBe(5.5 * 60000);
  });
  it('復習の間隔は 難しい < 正解 < 簡単', () => {
    const c = base({ type: REV, queue: Q_REV, ivl: 10, due: 19000, factor: 2500, reps: 5 });
    const ivls = [2, 3, 4].map((g) => answer(c, g, opts()).card.ivl);
    expect(ivls[0]).toBeLessThan(ivls[1]);
    expect(ivls[1]).toBeLessThan(ivls[2]);
    expect(ivls[1]).toBeGreaterThanOrEqual(22);
    expect(ivls[1]).toBeLessThanOrEqual(28);
  });
  it('忘れたら再学習になり、易しさが下がる', () => {
    const c = base({ type: REV, queue: Q_REV, ivl: 10, due: 19000, factor: 2500, reps: 5 });
    const r = answer(c, 1, opts()).card;
    expect(r.type).toBe(RELRN);
    expect(r.lapses).toBe(1);
    expect(r.factor).toBe(2300);
    const back = answer(r, 3, opts()).card;
    expect(back.type).toBe(REV);
    expect(back.ivl).toBe(1);
  });
  it('1日を超えるステップは日をまたぐ学習になる', () => {
    const p = { ...defaultPreset(), learnSteps: [1, 1440, 4320] };
    let c = answer(base(), 3, opts({ preset: p })).card;
    expect(c.queue).toBe(Q_DAYLRN);
    expect(c.due).toBe(19001);
  });
  it('ゆらぎの幅と苦手の判定', () => {
    expect(fuzzRange(1)).toEqual([1, 1]);
    const [lo, hi] = fuzzRange(100);
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(100);
    expect(isLeech(8, 8)).toBe(true);
    expect(isLeech(9, 8)).toBe(false);
    expect(isLeech(12, 8)).toBe(true);
  });
});

describe('FSRS', () => {
  it('強さと難しさが入り、正解のほうが間隔が長い', () => {
    const o = opts({ fsrs: true, preset: { ...defaultPreset(), learnSteps: [] } });
    const g = answer(base(), 3, o).card;
    expect(g.s).toBeGreaterThan(0);
    expect(g.d).toBeGreaterThanOrEqual(1);
    const rev = { ...g, due: g.due, lastReview: o.now };
    const later = { ...o, now: o.now + g.ivl * 86400000, today: o.today + g.ivl };
    const ivls = [2, 3, 4].map((x) => answer(rev, x, later).card.ivl);
    expect(ivls[0]).toBeLessThan(ivls[1]);
    expect(ivls[1]).toBeLessThan(ivls[2]);
    const again = answer(rev, 1, later).card;
    expect(again.s).toBeLessThan(rev.s);
  });
});

describe('カードの型', () => {
  it('項目と条件', () => {
    const nt = { kind: 'std', fields: [{ name: '表' }, { name: '裏' }, { name: 'メモ' }], templates: [{ name: 'c', qfmt: '{{表}}{{#メモ}}[{{メモ}}]{{/メモ}}{{^メモ}}なし{{/メモ}}', afmt: '{{FrontSide}}<hr id=answer>{{裏}}' }] };
    const r = renderCard({ card: { ord: 0 }, note: { fields: ['A', 'B', ''], tags: [] }, nt, deckName: 'x' });
    expect(r.q).toBe('Aなし');
    expect(r.a).toBe('Aなし<hr id=answer>B');
    expect(cardOrds(nt, ['', 'B', ''])).toEqual([]);
  });
  it('穴うめ（ヒント・入れ子）', () => {
    const nt = { kind: 'cloze', fields: [{ name: '本文' }], templates: [{ name: '穴', qfmt: '{{cloze:本文}}', afmt: '{{cloze:本文}}' }] };
    const text = '{{c1::東京::首都}}は{{c2::日本}}の{{c1::都::み}}';
    expect(cardOrds(nt, [text])).toEqual([0, 1]);
    const r = renderCard({ card: { ord: 0 }, note: { fields: [text], tags: [] }, nt, deckName: '' });
    expect(r.q).toContain('[首都]');
    expect(r.q).toContain('<span class="cloze-inactive">日本</span>');
    expect(r.a).toContain('<span class="cloze">東京</span>');
    const nested = parseCloze('{{c1::a {{c2::b}} c}}');
    expect(nested[0].n).toBe(1);
    expect(clozeAnswers('{{c1::a {{c2::b}} c}}', 2)).toEqual(['b']);
  });
  it('答えの入力', () => {
    const nt = { kind: 'std', fields: [{ name: '表' }, { name: '裏' }], templates: [{ name: 'c', qfmt: '{{表}} {{type:裏}}', afmt: '{{FrontSide}}<hr id=answer>{{type:裏}}' }] };
    const r = renderCard({ card: { ord: 0 }, note: { fields: ['Q', 'apple'], tags: [] }, nt, deckName: '', typed: 'aple' });
    expect(r.q).toContain('<input id="typeans"');
    expect(r.a).not.toContain('<input');
    expect(r.a).toContain('typeMissed');
    expect(compareAnswer('apple', 'apple')).toContain('typeGood');
  });
  it('振り仮名と画像の穴うめ', () => {
    expect(furigana('日本[にほん]', 'both')).toBe('<ruby><rb>日本</rb><rt>にほん</rt></ruby>');
    expect(furigana('日本[にほん]', 'kana')).toBe('にほん');
    const s = parseOcclusions('{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}<br>{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.1}}');
    expect(s.length).toBe(2);
    expect(s[0].props.left).toBe('.1');
  });
});

describe('検索', () => {
  let col;
  beforeEach(() => {
    col = mkCol();
    const d = col.ensureDeck('英語::動詞');
    col.addNote(1, d.id, ['run', '走る'], ['動詞', 'verb::basic']);
    col.addNote(1, 1, ['apple', 'りんご'], ['名詞']);
    col.addNote(2, 1, ['cat', 'ねこ'], []);
  });
  it('いろいろな書き方', () => {
    expect(search(col, 'deck:英語').length).toBe(1);
    expect(search(col, 'tag:verb').length).toBe(1);
    expect(search(col, 'tag:none').length).toBe(2);
    expect(search(col, '-tag:none').length).toBe(2);
    expect(search(col, 'りんご OR ねこ').length).toBe(3);
    expect(search(col, 'card:2').length).toBe(1);
    expect(search(col, '表:a*').length).toBe(1);
    expect(search(col, 'is:new', { cards: false }).length).toBe(3);
    expect(search(col, '(apple OR run) -deck:英語*').length).toBe(1);
    expect(search(col, '"走る"').length).toBe(1);
    expect(parse('a OR b c').or.length).toBe(2);
  });
});

describe('学習の流れ', () => {
  it('上限・出す順・元に戻す', () => {
    const col = mkCol();
    col.put('presets', { ...col.presets.get(1), newPerDay: 2 });
    for (let i = 0; i < 5; i++) col.addNote(1, 1, [`q${i}`, `a${i}`], []);
    expect(deckCounts(col, 1).new).toBe(2);
    const s = new Session(col, 1);
    const c = s.next();
    expect(c).toBeTruthy();
    s.answer(c, 3, 1000);
    expect(col.cards.get(c.id).queue).toBe(Q_LRN);
    expect(deckCounts(col, 1).new).toBe(1);
    expect(col.undo()).toBe('答え');
    expect(col.cards.get(c.id).queue).toBe(0);
    expect(deckCounts(col, 1).new).toBe(2);
  });
  it('期日を決める・保留・フィルターのデッキ', () => {
    const col = mkCol();
    for (let i = 0; i < 3; i++) col.addNote(1, 1, [`q${i}`, `a${i}`], []);
    const ids = [...col.cards.keys()];
    setDueDate(col, ids, '0');
    expect(deckCounts(col, 1).rev).toBe(3);
    suspend(col, [ids[0]], true);
    expect(deckCounts(col, 1).rev).toBe(2);
    const fid = customStudy(col, 1, 'ahead', { n: 5 });
    expect([...col.cards.values()].filter((c) => c.did === fid).length).toBe(2);
    emptyFiltered(col, fid);
    expect([...col.cards.values()].filter((c) => c.did === fid).length).toBe(0);
    expect(deckCounts(col, 1).rev).toBe(2);
    forget(col, [ids[1]]);
    expect(col.cards.get(ids[1]).type).toBe(0);
    reposition(col, [ids[1]], 1, 1, { shift: true });
    expect(col.cards.get(ids[1]).due).toBe(1);
  });
});

describe('同期のまぜ合わせ', () => {
  it('新しいほうが勝ち、消したものは消える', () => {
    const a = { v: 1, cards: [{ id: 1, mod: 10, x: 'a' }, { id: 2, mod: 5 }], graves: [], revlog: [{ id: 7, at: 1 }] };
    const b = { v: 1, cards: [{ id: 1, mod: 20, x: 'b' }], graves: [{ id: 'cards:2', store: 'cards', rid: 2, at: 6 }], revlog: [{ id: 8, at: 2 }] };
    const m = mergeSnapshots(a, b);
    expect(m.cards).toEqual([{ id: 1, mod: 20, x: 'b' }]);
    expect(m.revlog.length).toBe(2);
  });
});

describe('文字のファイル', () => {
  it('タブ区切りと引用符', () => {
    const rows = parseDelimited('a\tb\n"x\ty"\t"z ""q"""\n', '\t');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x\ty', 'z "q"'],
    ]);
  });
});
