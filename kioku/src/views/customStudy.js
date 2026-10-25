// カスタム学習（今日の上限をふやす・先取り・忘れたものだけ など）
import { col } from '../col.js';
import { dialog, el, esc, toast } from '../ui/dom.js';
import { customStudy } from '../ops.js';
import { nav } from '../nav.js';

const KINDS = [
  ['newLimit', '今日の新しいカードをふやす', '何枚ふやす？', 10],
  ['revLimit', '今日の復習をふやす', '何枚ふやす？', 50],
  ['forgot', '忘れたカードをもう一度', '何日前までに忘れたもの？', 1],
  ['ahead', '先の分を学ぶ', '何日先までの分？', 1],
  ['previewNew', '新しく足したカードをためしに見る', '何日前までに足したもの？', 1],
  ['tags', 'タグや状態で選ぶ', 'いちばん多い数', 100],
];

export async function openCustomStudy(did) {
  const d = col.decks.get(did);
  let kind = 'newLimit';
  const tags = col.allTags();
  const body = el(`<div class="stack">
    <div class="stack tight">${KINDS.map(([k, label]) => `<button class="nav-item ${k === kind ? 'on' : ''}" data-k="${k}">${esc(label)}</button>`).join('')}</div>
    <div class="field"><label id="nlabel"></label><input class="input" type="number" id="n" min="1"></div>
    <div class="stack tight hidden" id="tagBox">
      <div class="field"><label>状態</label><select class="input" id="state"><option value="due">今日の分だけ</option><option value="new">新しいカードだけ</option><option value="all">すべて</option></select></div>
      <div class="field"><label>タグ（どれかが付いているもの。選ばなければすべて）</label><div class="row wrap" id="tagList">${tags.length ? tags.map((t) => `<button class="chip" data-t="${esc(t)}">${esc(t)}</button>`).join('') : '<span class="sub small">タグはまだありません</span>'}</div></div>
    </div>
  </div>`);
  const sync = () => {
    const k = KINDS.find((x) => x[0] === kind);
    body.querySelector('#nlabel').textContent = k[2];
    body.querySelector('#n').value = k[3];
    body.querySelector('#tagBox').classList.toggle('hidden', kind !== 'tags');
    body.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
  };
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (b) {
      kind = b.dataset.k;
      sync();
    }
    const t = e.target.closest('[data-t]');
    if (t) t.classList.toggle('on');
  });
  sync();
  const v = await dialog({
    title: `カスタム学習：${d.name.split('::').pop()}`,
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '始める', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return;
  const n = Math.max(1, Number(body.querySelector('#n').value) || 1);
  const opts = { n, limit: n, state: body.querySelector('#state').value, tags: [...body.querySelectorAll('[data-t].on')].map((x) => x.dataset.t) };
  const fid = customStudy(col, did, kind, opts);
  if (fid) {
    const count = [...col.cards.values()].filter((c) => c.did === fid).length;
    if (!count) return toast('当てはまるカードがありませんでした', { warn: true });
    toast(`${count} 枚を集めました`);
    nav.go(`/study/${fid}`);
  } else {
    toast('今日の上限をふやしました');
    nav.go(`/study/${did}`);
  }
}
