// デッキの一覧と、デッキを開いたときの画面
import { col } from '../col.js';
import { el, icon, esc, menu, toast, confirmDialog, promptDialog } from '../ui/dom.js';
import { deckTree, deckCounts, studiedToday } from '../sched/queue.js';
import { buildFiltered, emptyFiltered, deleteDeck } from '../ops.js';
import { fmtDuration, plural, keyLabel } from '../util.js';
import { nav } from '../nav.js';
import { openDeckOptions } from './deckOptions.js';
import { openFilteredDialog } from './filtered.js';
import { openCustomStudy } from './customStudy.js';
import { openImport, openExport } from './io.js';
import { addSampleDeck } from './sample.js';

export function side(root, { arg }) {
  const cur = Number(arg) || null;
  const { roots } = deckTree(col);
  const sec = el(`<div class="side-sec"><div class="side-h"><span>デッキ</span><button class="icon-btn" data-a="new" title="デッキを作る">${icon('plus')}</button></div></div>`);
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const total = n.new + n.lrn + n.rev;
      const b = el(
        `<a class="nav-item ${cur === n.deck.id ? 'on' : ''}" href="#/deck/${n.deck.id}" style="padding-left:${10 + depth * 14}px">${icon(n.deck.filtered ? 'funnel' : depth ? 'folder' : 'layers')}<span class="label">${esc(n.deck.name.split('::').pop())}</span>${total ? `<span class="count">${total}</span>` : ''}</a>`
      );
      sec.appendChild(b);
      if (!n.deck.collapsed) walk(n.kids, depth + 1);
    }
  };
  walk(roots, 0);
  root.appendChild(sec);
  const st = studiedToday(col).all;
  root.appendChild(
    el(`<div class="side-sec"><div class="side-h"><span>今日</span></div>
      <div class="nav-item" style="cursor:default">${icon('check')}<span class="label">学んだカード</span><span class="count">${st.count}</span></div>
      <div class="nav-item" style="cursor:default">${icon('clock')}<span class="label">かかった時間</span><span class="count">${fmtDuration(st.time)}</span></div>
    </div>`)
  );
  sec.querySelector('[data-a=new]').onclick = newDeck;
}

async function newDeck() {
  const name = await promptDialog('デッキを作る', { label: '名前', placeholder: '例：英単語', help: '「英語::動詞」のように :: で区切ると、下のデッキになります' });
  if (!name?.trim()) return;
  if (col.deckByName(name)) return toast('同じ名前のデッキがあります', { warn: true });
  let d;
  col.transact('デッキを作る', () => (d = col.ensureDeck(name)));
  toast(`「${d.name}」を作りました`);
  nav.rerender();
}

export function deckMenu(anchor, d) {
  const f = !!d.filtered;
  menu(anchor, [
    { label: '学習する', icon: 'play', fn: () => nav.go(`/study/${d.id}`) },
    f && { label: '作り直す', icon: 'refresh-cw', fn: () => (buildFiltered(col, d.id), toast('作り直しました'), nav.rerender()) },
    f && { label: '空にする', icon: 'eye-off', fn: () => (emptyFiltered(col, d.id), toast('カードを元のデッキに戻しました'), nav.rerender()) },
    f && { label: '条件を変える', icon: 'funnel', fn: () => openFilteredDialog(d.id) },
    !f && { label: '名前を変える', icon: 'pencil', fn: () => renameDeck(d) },
    !f && { label: '設定', icon: 'sliders-horizontal', fn: () => openDeckOptions(d.id) },
    !f && { label: 'カスタム学習', icon: 'sparkles', fn: () => openCustomStudy(d.id) },
    !f && { label: '下にデッキを作る', icon: 'folder-plus', fn: () => subDeck(d) },
    { label: '一覧で見る', icon: 'search', fn: () => nav.go(`/browse?q=${encodeURIComponent(`deck:"${d.name}"`)}`) },
    !f && { label: '書き出す', icon: 'download', fn: () => openExport({ did: d.id }) },
    { sep: true },
    { label: '削除', icon: 'trash', danger: true, fn: () => removeDeck(d) },
  ]);
}

async function renameDeck(d) {
  const name = await promptDialog('名前を変える', { label: '名前', value: d.name, help: ':: で区切ると、下のデッキになります' });
  if (!name?.trim() || name === d.name) return;
  try {
    col.renameDeck(d.id, name);
    nav.rerender();
  } catch (e) {
    toast(e.message, { warn: true });
  }
}

async function subDeck(d) {
  const name = await promptDialog('下にデッキを作る', { label: '名前', placeholder: '例：動詞' });
  if (!name?.trim()) return;
  col.transact('デッキを作る', () => col.ensureDeck(`${d.name}::${name}`));
  nav.rerender();
}

async function removeDeck(d) {
  const ids = col.deckTreeIds(d.id);
  let n = 0;
  for (const c of col.cards.values()) if (ids.has(c.did) || ids.has(c.odid)) n++;
  const msg = d.filtered
    ? 'フィルターのデッキを消します。カードは元のデッキに戻ります。'
    : `「${esc(d.name)}」と下のデッキ、そこにある <b>${plural(n)} 枚</b>のカードを消します。`;
  if (!(await confirmDialog('デッキを削除', msg, { ok: '削除', danger: true }))) return;
  deleteDeck(col, d.id);
  toast('削除しました', { action: { label: '元に戻す', fn: () => (col.undo(), nav.rerender()) } });
  nav.go('/decks');
}

const cnt = (v, cls) => `<span class="cnt ${cls} ${v ? '' : 'zero'}"><span class="dot"></span>${v}</span>`;

export function render(main, { name, arg }) {
  if (name === 'deck' && arg && col.decks.has(Number(arg))) return renderOverview(main, Number(arg));
  const page = el('<div class="page"></div>');
  const st = studiedToday(col).all;
  page.appendChild(
    el(`<div class="toolbar"><h1>デッキ</h1><span class="desc">${st.count ? `今日は ${plural(st.count)} 枚を ${fmtDuration(st.time)} で学びました` : '今日の学習をはじめましょう'}</span><div class="grow"></div>
      <button class="btn" data-a="filter">${icon('funnel')}<span class="hide-sm">フィルターのデッキ</span></button>
      <button class="btn" data-a="import">${icon('file-up')}<span class="hide-sm">読み込み</span></button>
      <button class="btn primary" data-a="new">${icon('plus')}デッキを作る</button></div>`)
  );
  const { roots } = deckTree(col);
  if (!col.cards.size) {
    page.appendChild(
      el(`<div class="card"><div class="empty">${icon('book-open')}<b>カードはまだありません</b><span>カードを足すか、Anki のファイル（.apkg）を読み込みましょう。</span>
        <div class="row wrap" style="justify-content:center"><a class="btn primary" href="#/add">${icon('plus')}カードを足す</a><button class="btn" data-a="import">${icon('file-up')}読み込む</button><button class="btn" data-a="sample">${icon('sparkles')}見本のデッキを入れる</button></div></div></div>`)
    );
  }
  const card = el('<div class="card decks"></div>');
  card.appendChild(el(`<div class="deck-row head"><span style="padding-left:30px">名前</span><span class="cnt">新規</span><span class="cnt">学習中</span><span class="cnt">復習</span><span></span></div>`));
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const d = n.deck;
      const row = el(`<div class="deck-row ${col.conf.curDeck === d.id ? 'cur' : ''}">
        <div class="deck-name" style="padding-left:${depth * 18}px">
          ${n.kids.length ? `<button class="tw ${d.collapsed ? 'closed' : ''}" data-tw title="開く・閉じる">${icon('chevron-down')}</button>` : '<span style="width:22px;flex:none"></span>'}
          <button class="open" title="開く">${d.filtered ? `<span class="sub">${icon('funnel')}</span> ` : ''}${esc(d.name.split('::').pop())}</button>
        </div>
        ${cnt(n.new, 'cnt-new')}${cnt(n.lrn, 'cnt-lrn')}${cnt(n.rev, 'cnt-rev')}
        <button class="icon-btn" data-m title="ほかの操作">${icon('ellipsis')}</button></div>`);
      row.querySelector('.open').onclick = () => {
        col.setConf({ curDeck: d.id });
        nav.go(`/deck/${d.id}`);
      };
      row.querySelector('[data-m]').onclick = (e) => deckMenu(e.currentTarget, d);
      row.querySelector('[data-tw]')?.addEventListener('click', () => {
        col.put('decks', { ...d, collapsed: !d.collapsed });
        nav.rerender();
      });
      card.appendChild(row);
      if (!d.collapsed) walk(n.kids, depth + 1);
    }
  };
  walk(roots, 0);
  page.appendChild(card);
  page.appendChild(
    el(`<div class="legend"><span><span class="dot" style="--c:var(--c-new)"></span>新規＝はじめて見るカード</span><span><span class="dot" style="--c:var(--c-lrn)"></span>学習中＝覚えている途中</span><span><span class="dot" style="--c:var(--c-rev)"></span>復習＝今日おさらいするカード</span><span class="hide-sm">${esc(keyLabel('⌘Z'))} で元に戻す</span></div>`)
  );
  page.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'new') newDeck();
    if (a === 'filter') openFilteredDialog(null);
    if (a === 'import') openImport();
    if (a === 'sample') {
      addSampleDeck(col);
      toast('見本のデッキを入れました');
      nav.rerender();
    }
  });
  main.appendChild(page);
}

function renderOverview(main, did) {
  const d = col.decks.get(did);
  col.setConf({ curDeck: did });
  const c = deckCounts(col, did);
  const total = c.new + c.lrn + c.rev;
  const page = el('<div class="page" style="max-width:720px"></div>');
  page.appendChild(
    el(`<div class="toolbar"><a class="icon-btn" href="#/decks" title="デッキの一覧">${icon('arrow-left')}</a><h1 style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</h1><div class="grow"></div><button class="icon-btn" data-m title="ほかの操作">${icon('ellipsis')}</button></div>`)
  );
  const body = el(`<div class="card stack" style="padding:24px"></div>`);
  if (total) {
    body.appendChild(
      el(`<div class="stat-row">
        <div class="stat"><span class="k"><span class="dot" style="--c:var(--c-new)"></span> 新規</span><span class="v">${c.new}</span></div>
        <div class="stat"><span class="k"><span class="dot" style="--c:var(--c-lrn)"></span> 学習中</span><span class="v">${c.lrn}</span></div>
        <div class="stat"><span class="k"><span class="dot" style="--c:var(--c-rev)"></span> 復習</span><span class="v">${c.rev}</span></div>
      </div>`)
    );
    body.appendChild(el(`<a class="btn primary block" style="height:52px;font-size:15px" href="#/study/${did}">${icon('play')}学習を始める<span class="kbd" style="background:transparent;color:inherit;opacity:.6">Space</span></a>`));
  } else {
    body.appendChild(
      el(`<div class="empty" style="padding:20px 0">${icon('check')}<b>今日はこのデッキの学習はおしまいです</b><span>もっと続けたいときは「カスタム学習」で、上限をふやしたり先の分を学んだりできます。</span></div>`)
    );
  }
  const row = el('<div class="row wrap"></div>');
  if (d.filtered) {
    row.appendChild(el(`<button class="btn" data-a="rebuild">${icon('refresh-cw')}作り直す</button>`));
    row.appendChild(el(`<button class="btn" data-a="empty">${icon('eye-off')}空にする</button>`));
    row.appendChild(el(`<button class="btn" data-a="cond">${icon('funnel')}条件を変える</button>`));
  } else {
    row.appendChild(el(`<button class="btn" data-a="custom">${icon('sparkles')}カスタム学習</button>`));
    row.appendChild(el(`<button class="btn" data-a="opts">${icon('sliders-horizontal')}設定</button>`));
    row.appendChild(el(`<a class="btn" href="#/add?deck=${did}">${icon('plus')}カードを足す</a>`));
  }
  body.appendChild(row);
  if (d.desc) {
    const desc = el('<div class="sub" style="line-height:1.7;border-top:1px solid var(--line);padding-top:14px"></div>');
    desc.innerHTML = d.desc.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+=/gi, ' data-x=');
    body.appendChild(desc);
  }
  page.appendChild(body);
  // デッキの中の数
  const ids = col.deckTreeIds(did);
  let all = 0;
  let susp = 0;
  let newAll = 0;
  for (const x of col.cards.values()) {
    if (!ids.has(x.did)) continue;
    all++;
    if (x.queue === -1) susp++;
    if (x.type === 0) newAll++;
  }
  page.appendChild(el(`<div class="legend"><span>全部で ${plural(all)} 枚</span><span>まだ見ていない ${plural(newAll)} 枚</span>${susp ? `<span>保留 ${plural(susp)} 枚</span>` : ''}</div>`));
  page.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'custom') openCustomStudy(did);
    if (a === 'opts') openDeckOptions(did);
    if (a === 'rebuild') {
      const n = buildFiltered(col, did);
      toast(`${n} 枚を集めました`);
      nav.rerender();
    }
    if (a === 'empty') {
      emptyFiltered(col, did);
      nav.rerender();
    }
    if (a === 'cond') openFilteredDialog(did);
  });
  page.querySelector('[data-m]').onclick = (e) => deckMenu(e.currentTarget, d);
  main.appendChild(page);
  const onKey = (e) => {
    if (!document.body.contains(page)) return document.removeEventListener('keydown', onKey);
    if (e.target.closest('input,textarea,[contenteditable]') || document.querySelector('.backdrop')) return;
    if ((e.key === ' ' || e.key === 'Enter') && total) {
      e.preventDefault();
      nav.go(`/study/${did}`);
    }
    if (e.key === 'c' || e.key === 'C') openCustomStudy(did);
    if (e.key === 'o' || e.key === 'O') openDeckOptions(did);
  };
  document.addEventListener('keydown', onKey);
}
