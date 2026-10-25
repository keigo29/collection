// フィルターのデッキ（検索で集めたカードだけで学ぶ）
import { col } from '../col.js';
import { dialog, el, esc, options, switchHtml, toast } from '../ui/dom.js';
import { buildFiltered, FILTER_ORDERS } from '../ops.js';
import { newId } from '../util.js';
import { nav } from '../nav.js';

export async function openFilteredDialog(did, preset = {}) {
  const d = did ? col.decks.get(did) : null;
  const f = d?.filtered || { terms: [{ search: preset.search ?? 'is:due', limit: 100, order: 'random' }], reschedule: true };
  const t1 = f.terms[0] || { search: '', limit: 100, order: 'random' };
  const t2 = f.terms[1];
  let n = 1;
  while (!d && col.deckByName(`フィルター ${n}`)) n++;
  const body = el(`<div class="stack">
    <div class="field"><label>名前</label><input class="input" id="fname" value="${esc(d?.name || `フィルター ${n}`)}"></div>
    <div class="field"><label>集める条件（一覧の検索と同じ書き方）</label><input class="input" id="s1" value="${esc(t1.search)}" placeholder="例：deck:英語 is:due"><div class="help">例：<code>is:due</code>（今日の分）・<code>rated:1:1</code>（今日忘れた）・<code>tag:苦手</code>・<code>prop:due&lt;=3</code>（3日先まで）</div></div>
    <div class="row"><div class="field grow"><label>いちばん多い数</label><input class="input" id="l1" type="number" min="1" value="${t1.limit}"></div><div class="field grow"><label>並べ方</label><select class="input" id="o1">${options(FILTER_ORDERS, t1.order)}</select></div></div>
    <details ${t2 ? 'open' : ''}><summary class="label" style="cursor:pointer">2つ目の条件</summary><div class="stack" style="margin-top:10px">
      <input class="input" id="s2" value="${esc(t2?.search || '')}" placeholder="空なら使いません">
      <div class="row"><input class="input grow" id="l2" type="number" min="1" value="${t2?.limit ?? 20}"><select class="input grow" id="o2">${options(FILTER_ORDERS, t2?.order || 'random')}</select></div></div></details>
    <div class="setting"><div class="txt"><b>答えで次の期日を変える</b><span>切ると、ためしに見るだけになります（期日は変わりません）</span></div><div class="ctl auto">${switchHtml('resched', f.reschedule !== false)}</div></div>
  </div>`);
  const v = await dialog({
    title: d ? 'フィルターのデッキを直す' : 'フィルターのデッキを作る',
    body,
    wide: true,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: d ? '作り直す' : '作る', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return null;
  const g = (id) => body.querySelector(`#${id}`);
  const terms = [{ search: g('s1').value, limit: Number(g('l1').value) || 100, order: g('o1').value }];
  if (g('s2').value.trim()) terms.push({ search: g('s2').value, limit: Number(g('l2').value) || 20, order: g('o2').value });
  const name = g('fname').value.trim() || 'フィルター';
  const ex = col.deckByName(name);
  if (ex && ex.id !== did) {
    toast('同じ名前のデッキがあります', { warn: true });
    return null;
  }
  let id = did;
  col.transact('フィルターのデッキ', () => {
    if (!id) id = newId();
    col.put('decks', { ...(d || { id, desc: '' }), id, name, filtered: { terms, reschedule: g('resched').checked } });
  });
  const count = buildFiltered(col, id);
  toast(count ? `${count} 枚を集めました` : '当てはまるカードがありませんでした', { warn: !count });
  nav.go(`/deck/${id}`);
  return id;
}
