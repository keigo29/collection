// 一覧（Anki のブラウザ）
import { col } from '../col.js';
import { el, icon, esc, menu, toast, confirmDialog, promptDialog, dialog, options, switchHtml } from '../ui/dom.js';
import { search } from '../search.js';
import { createEditor } from '../ui/editor.js';
import { renderCard } from '../template.js';
import * as ops from '../ops.js';
import { fmtDate, fmtSpan, stripHtml, debounce, keyLabel, plural, download } from '../util.js';
import { FLAGS } from '../stock.js';
import { nav } from '../nav.js';
import { dueText, openCardInfo } from './cardInfo.js';
import { editNoteDialog } from './editNote.js';
import { previewNote } from './preview.js';
import { openExport } from './io.js';
import { openFilteredDialog } from './filtered.js';
import { toCsv } from '../io/text.js';

const LS = 'kioku.browse';
const prefs = (() => {
  try {
    return { mode: 'cards', sort: 'created', desc: true, cols: null, ...JSON.parse(localStorage.getItem(LS) || '{}') };
  } catch {
    return { mode: 'cards', sort: 'created', desc: true, cols: null };
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(LS, JSON.stringify(prefs));
  } catch {
    /* 保存できない環境 */
  }
};

const ROW_H = 38;

// 列の定義： [key, 名前, 値(row) => 文字, 並べかえ(row) => 値]
function columns(mode) {
  const today = col.today();
  const c = [
    ['sfld', '並び替えの項目', (r) => col.sortField(r.note), (r) => col.sortField(r.note).toLowerCase()],
    ['question', '表', (r) => q(r), (r) => q(r)],
    ['answer', '裏', (r) => a(r), (r) => a(r)],
    ['notetype', 'ノートの種類', (r) => col.notetypes.get(r.note.ntid)?.name, (r) => col.notetypes.get(r.note.ntid)?.name],
    ['tags', 'タグ', (r) => r.note.tags.join(' '), (r) => r.note.tags.join(' ')],
    ['created', '作った日', (r) => fmtDate(created(r)), (r) => created(r)],
    ['edited', '直した日', (r) => fmtDate(r.note.mod || 0), (r) => r.note.mod || 0],
  ];
  if (mode === 'cards') {
    c.splice(
      3,
      0,
      ['template', 'カード', (r) => tmplName(r), (r) => tmplName(r)],
      ['deck', 'デッキ', (r) => deckName(r), (r) => deckName(r)],
      ['due', '期日', (r) => dueText(r.card, today), (r) => dueSort(r.card, today)],
      ['ivl', '間隔', (r) => (r.card.type === 2 || r.card.type === 3 ? fmtSpan(r.card.ivl * 86400) : r.card.type === 0 ? '（新規）' : '（学習中）'), (r) => r.card.ivl],
      ['ease', '易しさ', (r) => (r.card.factor ? `${Math.round(r.card.factor / 10)}%` : '—'), (r) => r.card.factor],
      ['reps', '答えた回数', (r) => r.card.reps, (r) => r.card.reps],
      ['lapses', '忘れた回数', (r) => r.card.lapses, (r) => r.card.lapses]
    );
    if (col.conf.fsrs) c.push(['stability', '強さ', (r) => (r.card.s ? `${r.card.s.toFixed(1)}日` : '—'), (r) => r.card.s || 0], ['difficulty', '難しさ', (r) => (r.card.d ? `${Math.round(((r.card.d - 1) / 9) * 100)}%` : '—'), (r) => r.card.d || 0]);
  } else {
    c.splice(4, 0, ['cards', 'カードの数', (r) => col.cardsOfNote(r.note.id).length, (r) => col.cardsOfNote(r.note.id).length]);
  }
  return c;
}
const DEFAULT_COLS = { cards: ['sfld', 'template', 'deck', 'due'], notes: ['sfld', 'notetype', 'cards', 'tags', 'created'] };

const created = (r) => (r.card ? r.card.created ?? r.note.created ?? r.card.id / 1000 : r.note.created ?? r.note.id / 1000);
const deckName = (r) => col.decks.get(r.card.did)?.name + (r.card.odid ? `（${col.decks.get(r.card.odid)?.name || ''}）` : '');
const tmplName = (r) => {
  const nt = col.notetypes.get(r.note.ntid);
  return nt.kind === 'std' ? nt.templates[r.card.ord]?.name || '' : `穴 ${r.card.ord + 1}`;
};
const dueSort = (c, today) => {
  if (c.queue < 0) return 1e12 + c.queue;
  if (c.type === 0) return 1e10 + (c.odue || c.due);
  if (c.queue === 1) return Math.floor((c.due - Date.now()) / 86400000) + today;
  return c.odid && c.odue ? c.odue : c.due;
};
const qaCache = new Map();
function qa(r) {
  const card = r.card || col.cardsOfNote(r.note.id)[0];
  if (!card) return ['', ''];
  const key = `${card.id}:${r.note.mod}`;
  if (!qaCache.has(key)) {
    const nt = col.notetypes.get(r.note.ntid);
    const x = renderCard({ card, note: r.note, nt, deckName: '' });
    let ans = x.a;
    const i = ans.indexOf('<hr id=answer>');
    if (i >= 0) ans = ans.slice(i + 14);
    qaCache.set(key, [stripHtml(x.q).slice(0, 200), stripHtml(ans).slice(0, 200)]);
  }
  return qaCache.get(key);
}
const q = (r) => qa(r)[0];
const a = (r) => qa(r)[1];

let st = null;

export function side(root) {
  const item = (query, ic, label, extra = '') => `<button class="nav-item" data-q="${esc(query)}">${ic.startsWith('#') ? `<span class="dot" style="--c:${ic}"></span>` : icon(ic)}<span class="label">${esc(label)}</span>${extra}</button>`;
  const saved = col.conf.savedSearches || {};
  const decks = col.sortedDecks();
  const types = [...col.notetypes.values()].sort((x, y) => x.name.localeCompare(y.name, 'ja'));
  const tags = col.allTags();
  const html = `
    <div class="side-sec"><div class="side-h"><span>保存した検索</span><button class="icon-btn" data-a="saveSearch" title="いまの検索を保存">${icon('plus')}</button></div>
      ${Object.keys(saved).length ? Object.entries(saved).map(([k, v]) => `<div class="row" style="gap:0">${item(v, 'search', k)}<button class="icon-btn" data-del-saved="${esc(k)}" title="消す">${icon('x')}</button></div>`).join('') : '<div class="sub small" style="padding:0 10px">まだありません</div>'}</div>
    <div class="side-sec"><div class="side-h"><span>今日</span></div>
      ${item('', 'layers', 'すべてのカード')}${item('deck:current', 'folder', 'いまのデッキ')}${item('added:1', 'plus', '今日足したもの')}${item('rated:1', 'check', '今日答えたもの')}${item('rated:1:1', 'rotate-ccw', '今日忘れたもの')}${item('edited:1', 'pencil', '今日直したもの')}</div>
    <div class="side-sec"><div class="side-h"><span>状態</span></div>
      ${item('is:new', 'sparkles', '新規')}${item('is:learn', 'book-open', '学習中')}${item('is:review', 'refresh-cw', '復習')}${item('is:due', 'calendar', '期日が来たもの')}${item('is:suspended', 'circle-pause', '保留')}${item('is:buried', 'eye-off', 'あとまわし')}</div>
    <div class="side-sec"><div class="side-h"><span>目印</span></div>
      ${FLAGS.map((f) => item(`flag:${f.n}`, f.color, col.conf.flagNames?.[f.n] || f.name)).join('')}${item('tag:marked', 'star', '印')}${item('tag:leech', 'triangle-alert', '苦手')}</div>
    <div class="side-sec"><div class="side-h"><span>デッキ</span></div>
      ${decks.map((d) => `<button class="nav-item" data-q="${esc(`deck:"${d.name}"`)}" style="padding-left:${10 + (d.name.split('::').length - 1) * 14}px">${icon(d.filtered ? 'funnel' : 'layers')}<span class="label">${esc(d.name.split('::').pop())}</span></button>`).join('')}</div>
    <div class="side-sec"><div class="side-h"><span>ノートの種類</span></div>${types.map((t) => item(`note:"${t.name}"`, 'file-text', t.name)).join('')}</div>
    <div class="side-sec"><div class="side-h"><span>タグ</span></div>
      ${tags.length ? tags.map((t) => `<div class="row" style="gap:0"><button class="nav-item" data-q="${esc(`tag:"${t}"`)}" style="padding-left:${10 + (t.split('::').length - 1) * 14}px">${icon('tag')}<span class="label">${esc(t.split('::').pop())}</span></button><button class="icon-btn" data-tagm="${esc(t)}" title="タグの操作">${icon('ellipsis')}</button></div>`).join('') : '<div class="sub small" style="padding:0 10px">まだありません</div>'}</div>`;
  const wrap = el(`<div class="stack" style="gap:18px">${html}</div>`);
  wrap.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-q]');
    if (b) {
      let qv = b.dataset.q;
      if (st && (e.metaKey || e.ctrlKey) && st.query) qv = `${st.query} ${qv}`;
      else if (st && e.shiftKey && st.query) qv = `(${st.query}) OR ${qv}`;
      return setQuery(qv);
    }
    if (e.target.closest('[data-a=saveSearch]')) {
      const name = await promptDialog('検索を保存', { label: '名前', value: st?.query || '' });
      if (!name) return;
      col.setConf({ savedSearches: { ...(col.conf.savedSearches || {}), [name]: st?.query || '' } });
      nav.refreshSide();
    }
    const ds = e.target.closest('[data-del-saved]');
    if (ds) {
      const s2 = { ...(col.conf.savedSearches || {}) };
      delete s2[ds.dataset.delSaved];
      col.setConf({ savedSearches: s2 });
      nav.refreshSide();
    }
    const tm = e.target.closest('[data-tagm]');
    if (tm) {
      const t = tm.dataset.tagm;
      menu(tm, [
        {
          label: '名前を変える',
          icon: 'pencil',
          fn: async () => {
            const v = await promptDialog('タグの名前を変える', { label: '名前', value: t });
            if (!v || v === t) return;
            ops.renameTag(col, t, v.trim().replace(/\s+/g, '_'));
            nav.refreshSide();
            refresh();
          },
        },
        {
          label: 'すべてのノートから外す',
          icon: 'trash',
          danger: true,
          fn: async () => {
            const nids = search(col, `tag:"${t}"`, { cards: false });
            if (!(await confirmDialog('タグを外す', `${nids.length} 件のノートから「${esc(t)}」を外します。`, { ok: '外す', danger: true }))) return;
            ops.removeTags(col, nids, [t]);
            nav.refreshSide();
            refresh();
          },
        },
      ]);
    }
  });
  root.appendChild(wrap);
}

export function render(main, { params }) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  st = {
    query: params.q ?? (prefs.lastQuery || ''),
    rows: [],
    sel: new Set(),
    anchor: null,
    editor: null,
    editingNid: null,
    selectMode: false,
    coarse,
  };
  const page = el(`<div class="browse">
    <div class="b-list">
      <div class="toolbar" style="gap:8px">
        <div class="row grow" style="min-width:200px;position:relative">
          <input class="input" id="searchInput" placeholder="検索（例：deck:英語 tag:動詞 is:due）" value="${esc(st.query)}" autocomplete="off" autocapitalize="off" style="padding-left:38px">
          <span style="position:absolute;left:14px;top:15px;color:var(--sub)">${icon('search')}</span>
        </div>
        <div class="seg" data-seg="mode"><button data-v="cards" class="${prefs.mode === 'cards' ? 'on' : ''}">カード</button><button data-v="notes" class="${prefs.mode === 'notes' ? 'on' : ''}">ノート</button></div>
        <button class="icon-btn" data-a="help" title="検索の書き方">${icon('circle-question-mark')}</button>
        <button class="icon-btn" data-a="cols" title="列を選ぶ">${icon('sliders-horizontal')}</button>
        ${coarse ? `<button class="btn sm" data-a="selmode">${icon('check')}選ぶ</button>` : ''}
        <button class="btn sm" data-a="acts">${icon('ellipsis')}操作</button>
      </div>
      <div class="card b-table" id="tbl"></div>
      <div class="b-foot"><span id="count"></span><span class="hide-sm">${esc(keyLabel('⌘A'))} ですべて選ぶ・${esc(keyLabel('⌘⌫'))} で削除</span></div>
    </div>
    <div class="b-edit" id="edit"></div>
  </div>`);
  main.appendChild(page);
  st.page = page;
  const input = page.querySelector('#searchInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setQuery(input.value);
    }
  });
  input.addEventListener('input', debounce(() => setQuery(input.value, false), 350));
  page.querySelector('[data-seg=mode]').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    page.querySelectorAll('[data-seg=mode] button').forEach((x) => x.classList.toggle('on', x === b));
    prefs.mode = b.dataset.v;
    if (!columns(prefs.mode).some((c) => c[0] === prefs.sort)) prefs.sort = 'created';
    savePrefs();
    st.sel.clear();
    refresh();
  });
  page.addEventListener('click', (e) => {
    const a2 = e.target.closest('[data-a]')?.dataset.a;
    if (a2 === 'acts') actionsMenu(e.target.closest('[data-a]'));
    if (a2 === 'cols') colsMenu(e.target.closest('[data-a]'));
    if (a2 === 'help') searchHelp();
    if (a2 === 'selmode') {
      st.selectMode = !st.selectMode;
      e.target.closest('[data-a]').classList.toggle('primary', st.selectMode);
      if (!st.selectMode) st.sel.clear();
      drawRows();
    }
  });
  page.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onDocKey);
  refresh();
}

export function leave() {
  saveEditor();
  document.removeEventListener('keydown', onDocKey);
  st = null;
  return true;
}

function setQuery(qv, push = true) {
  if (!st) return;
  st.query = qv;
  prefs.lastQuery = qv;
  savePrefs();
  const inp = st.page.querySelector('#searchInput');
  if (inp.value !== qv) inp.value = qv;
  if (push) history.replaceState(null, '', `#/browse?q=${encodeURIComponent(qv)}`);
  st.sel.clear();
  refresh();
}

function refresh() {
  if (!st) return;
  const cards = prefs.mode === 'cards';
  let ids;
  try {
    ids = search(col, st.query, { cards });
  } catch (e) {
    ids = [];
    toast(`検索の書き方がまちがっています：${e.message}`, { warn: true });
  }
  st.rows = ids.map((id) => {
    if (cards) {
      const c = col.cards.get(id);
      return { id, card: c, note: col.notes.get(c.nid) };
    }
    return { id, note: col.notes.get(id) };
  });
  const colDef = columns(prefs.mode).find((c) => c[0] === prefs.sort) || columns(prefs.mode).find((c) => c[0] === 'created');
  const key = colDef[3];
  const vals = new Map(st.rows.map((r) => [r.id, key(r)]));
  st.rows.sort((x, y) => {
    const va = vals.get(x.id);
    const vb = vals.get(y.id);
    const d = typeof va === 'string' || typeof vb === 'string' ? String(va ?? '').localeCompare(String(vb ?? ''), 'ja', { numeric: true }) : (va ?? 0) - (vb ?? 0);
    return prefs.desc ? -d : d;
  });
  for (const id of [...st.sel]) if (!vals.has(id)) st.sel.delete(id);
  drawTable();
  drawEditor();
}

function visibleCols() {
  const all = columns(prefs.mode);
  const want = (prefs.cols?.[prefs.mode] || DEFAULT_COLS[prefs.mode]).filter((k) => all.some((c) => c[0] === k));
  return want.map((k) => all.find((c) => c[0] === k));
}

function drawTable() {
  const tbl = st.page.querySelector('#tbl');
  const cols = visibleCols();
  st.page.querySelector('#count').textContent = `${plural(st.rows.length)} ${prefs.mode === 'cards' ? '枚' : '件'}${st.sel.size ? `（${plural(st.sel.size)} 選択）` : ''}`;
  if (!st.rows.length) {
    tbl.innerHTML = `<div class="empty">${icon('search')}<b>見つかりませんでした</b><span>条件を変えてみてください</span></div>`;
    return;
  }
  tbl.innerHTML = `<table class="list"><thead><tr>${cols.map((c) => `<th data-sort="${c[0]}">${esc(c[1])}${prefs.sort === c[0] ? icon(prefs.desc ? 'arrow-down' : 'arrow-up') : ''}</th>`).join('')}</tr></thead><tbody></tbody></table>`;
  tbl.querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    if (prefs.sort === th.dataset.sort) prefs.desc = !prefs.desc;
    else {
      prefs.sort = th.dataset.sort;
      prefs.desc = false;
    }
    savePrefs();
    refresh();
  });
  const tbody = tbl.querySelector('tbody');
  tbody.addEventListener('click', onRowClick);
  tbody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr.r');
    if (tr) openEdit(st.rows[Number(tr.dataset.i)]);
  });
  tbl.onscroll = () => drawRows();
  drawRows();
}

function drawRows() {
  if (!st) return;
  const tbl = st.page.querySelector('#tbl');
  const tbody = tbl.querySelector('tbody');
  if (!tbody) return;
  const cols = visibleCols();
  const top = Math.max(0, Math.floor((tbl.scrollTop - 40) / ROW_H) - 10);
  const count = Math.ceil((tbl.clientHeight || 800) / ROW_H) + 20;
  const end = Math.min(st.rows.length, top + count);
  let h = `<tr style="height:${top * ROW_H}px"></tr>`;
  for (let i = top; i < end; i++) {
    const r = st.rows[i];
    const c = r.card;
    const flag = c ? FLAGS.find((f) => f.n === c.flags) : null;
    const marked = r.note.tags.some((t) => t.toLowerCase() === 'marked');
    const cls = ['r', st.sel.has(r.id) ? 'sel' : '', c?.queue === -1 ? 'susp' : '', c && c.queue <= -2 ? 'bur' : '', flag ? 'f' : ''].join(' ');
    h += `<tr class="${cls}" data-i="${i}" ${flag ? `style="--c:${flag.color}"` : ''}>${cols.map((cd, j) => `<td>${j === 0 && marked ? `<span style="color:var(--warn)">★</span> ` : ''}${esc(cd[2](r) ?? '')}</td>`).join('')}</tr>`;
  }
  h += `<tr style="height:${(st.rows.length - end) * ROW_H}px"></tr>`;
  tbody.innerHTML = h;
  st.page.querySelector('#count').textContent = `${plural(st.rows.length)} ${prefs.mode === 'cards' ? '枚' : '件'}${st.sel.size ? `（${plural(st.sel.size)} 選択）` : ''}`;
}

function onRowClick(e) {
  const tr = e.target.closest('tr.r');
  if (!tr) return;
  const i = Number(tr.dataset.i);
  const r = st.rows[i];
  if (e.shiftKey && st.anchor != null) {
    const [lo, hi] = [Math.min(st.anchor, i), Math.max(st.anchor, i)];
    if (!(e.metaKey || e.ctrlKey)) st.sel.clear();
    for (let k = lo; k <= hi; k++) st.sel.add(st.rows[k].id);
  } else if (e.metaKey || e.ctrlKey || st.selectMode) {
    if (st.sel.has(r.id)) st.sel.delete(r.id);
    else st.sel.add(r.id);
    st.anchor = i;
  } else {
    st.sel = new Set([r.id]);
    st.anchor = i;
    if (st.coarse || getComputedStyle(st.page.querySelector('#edit')).display === 'none') {
      drawRows();
      openEdit(r);
      return;
    }
  }
  drawRows();
  drawEditor();
}

async function openEdit(r) {
  if (!r) return;
  await editNoteDialog(r.note.id);
  refresh();
}

const saveEditor = () => {
  if (!st?.editor || !st.editingNid) return;
  const n = col.notes.get(st.editingNid);
  if (!n) return;
  const d = st.editor.getData();
  if (d.fields.join('\u001f') === n.fields.join('\u001f') && d.tags.join(' ') === n.tags.join(' ')) return;
  col.updateNote({ ...n, fields: d.fields, tags: d.tags });
  qaCache.clear();
};
const saveSoon = debounce(() => {
  saveEditor();
  drawRows();
}, 700);

function drawEditor() {
  const box = st.page.querySelector('#edit');
  if (getComputedStyle(box).display === 'none') return;
  const ids = [...st.sel];
  const nid = ids.length === 1 ? (prefs.mode === 'cards' ? col.cards.get(ids[0])?.nid : ids[0]) : null;
  if (nid && nid === st.editingNid && box.childElementCount) return;
  saveSoon.flush?.();
  saveEditor();
  st.editor = null;
  st.editingNid = null;
  box.innerHTML = '';
  if (!nid) {
    box.appendChild(el(`<div class="card"><div class="empty">${icon('pencil')}<b>${ids.length ? `${plural(ids.length)} 個を選んでいます` : '直したいものを選んでください'}</b><span>${ids.length ? '「操作」からまとめて変えられます' : '1つ選ぶと、ここで直せます'}</span></div></div>`));
    return;
  }
  const note = col.notes.get(nid);
  const nt = col.notetypes.get(note.ntid);
  const card = prefs.mode === 'cards' ? col.cards.get(ids[0]) : col.cardsOfNote(nid)[0];
  st.editingNid = nid;
  const wrap = el(`<div class="card stack"><div class="row"><b class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nt.name)}</b>
    <button class="btn sm" data-e="preview">${icon('eye-off')}見え方</button><button class="btn sm" data-e="info">${icon('info')}情報</button></div></div>`);
  st.editor = createEditor({ note: structuredClone(note), mode: 'edit', onChange: saveSoon });
  wrap.appendChild(st.editor.el);
  wrap.addEventListener('click', (e) => {
    const a2 = e.target.closest('[data-e]')?.dataset.e;
    if (a2 === 'preview') {
      const d = st.editor.getData();
      previewNote(nt, d.fields, d.tags, card?.did, card?.ord);
    }
    if (a2 === 'info' && card) openCardInfo(card.id);
  });
  box.appendChild(wrap);
}

function selected() {
  const ids = st.sel.size ? [...st.sel] : [];
  const cards = prefs.mode === 'cards';
  const cids = cards ? ids : ids.flatMap((nid) => col.cardsOfNote(nid).map((c) => c.id));
  const nids = cards ? [...new Set(ids.map((id) => col.cards.get(id)?.nid).filter(Boolean))] : ids;
  return { cids, nids };
}

function actionsMenu(anchor) {
  const { cids } = selected();
  const none = !cids.length;
  const allSusp = cids.length && cids.every((id) => col.cards.get(id)?.queue === -1);
  menu(anchor, [
    { label: 'すべて選ぶ', icon: 'check', key: '⌘A', fn: selectAll },
    { label: '選ぶのをやめる', icon: 'x', fn: () => (st.sel.clear(), drawRows(), drawEditor()), disabled: none },
    { sep: true },
    { label: 'デッキを変える', icon: 'folder', key: '⌘D', fn: changeDeck, disabled: none },
    { label: 'タグを足す', icon: 'tag', key: '⌘⇧A', fn: addTags, disabled: none },
    { label: 'タグを外す', icon: 'tag', key: '⌘⌥⇧A', fn: removeTags, disabled: none },
    { label: 'ノートの種類を変える', icon: 'arrow-right-left', fn: changeType, disabled: none },
    { sep: true },
    { label: allSusp ? '保留をやめる' : '保留にする', icon: 'circle-pause', key: '⌘J', fn: toggleSuspend, disabled: none },
    { label: 'あとまわしにする・やめる', icon: 'eye-off', fn: toggleBury, disabled: none },
    { label: '印をつける・外す', icon: 'star', key: '⌘K', fn: toggleMarkSel, disabled: none },
    ...FLAGS.map((f) => ({ label: `目印：${col.conf.flagNames?.[f.n] || f.name}`, dot: f.color, key: `⌘${f.n}`, fn: () => flag(f.n), disabled: none })),
    { label: '目印を外す', icon: 'flag', fn: () => flag(0), disabled: none },
    { sep: true },
    { label: '期日を決める', icon: 'calendar', key: '⌘⇧D', fn: setDue, disabled: none },
    { label: '新しいカードに戻す', icon: 'rotate-ccw', key: '⌘⌥N', fn: forget, disabled: none },
    { label: '新しいカードの順番を変える', icon: 'list-ordered', key: '⌘⇧S', fn: reposition, disabled: none },
    { sep: true },
    { label: '探して置きかえる', icon: 'search', key: '⌘⌥F', fn: findReplace },
    { label: '同じものを探す', icon: 'copy', fn: findDupes },
    { label: 'フィルターのデッキにする', icon: 'funnel', fn: () => openFilteredDialog(null, { search: st.query }) },
    { label: '書き出す', icon: 'download', fn: () => openExport({ cids: none ? search(col, st.query, { cards: true }) : cids }) },
    { label: '表を CSV で保存', icon: 'file-down', fn: exportCsv },
    { label: 'カードの情報', icon: 'info', key: '⌘⇧I', fn: () => cids[0] && openCardInfo(cids[0]), disabled: cids.length !== 1 },
    { sep: true },
    { label: '削除', icon: 'trash', key: '⌘⌫', danger: true, fn: del, disabled: none },
  ]);
}

function colsMenu(anchor) {
  const all = columns(prefs.mode);
  const cur = new Set(visibleCols().map((c) => c[0]));
  menu(
    anchor,
    all.map((c) => ({
      label: c[1],
      icon: cur.has(c[0]) ? 'check' : null,
      fn: () => {
        if (cur.has(c[0])) cur.delete(c[0]);
        else cur.add(c[0]);
        if (!cur.size) cur.add('sfld');
        prefs.cols = { ...(prefs.cols || {}), [prefs.mode]: all.map((x) => x[0]).filter((k) => cur.has(k)) };
        savePrefs();
        drawTable();
      },
    }))
  );
}

function searchHelp() {
  const rows = [
    ['ねこ', 'どこかに「ねこ」があるもの'],
    ['"ねこ いぬ"', '続けて「ねこ いぬ」'],
    ['ねこ いぬ', '両方あるもの'],
    ['ねこ OR いぬ', 'どちらかあるもの'],
    ['-ねこ', '「ねこ」がないもの'],
    ['ね*', '* はなんでも、_ は1文字'],
    ['表:ねこ', '「表」の項目がちょうど「ねこ」'],
    ['deck:英語', 'デッキ（下のデッキも）'],
    ['note:基本', 'ノートの種類'],
    ['card:1', '1つ目のカードの型'],
    ['tag:動詞 / tag:none', 'タグ / タグなし'],
    ['is:new is:due is:suspended', '新規・期日・保留 など'],
    ['flag:1', '赤の目印'],
    ['added:7', '7日以内に足した'],
    ['rated:1:1', '今日「もう一度」を押した'],
    ['prop:ivl>=21', '間隔が21日以上（due reps lapses ease も）'],
    ['re:^a.c', '正規表現'],
    ['nid:123 cid:456', 'ID で探す'],
  ];
  dialog({ title: '検索の書き方', wide: true, body: `<table class="simple-table">${rows.map(([k, v]) => `<tr><td class="code">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` });
}

function selectAll() {
  st.sel = new Set(st.rows.map((r) => r.id));
  drawRows();
  drawEditor();
}

const after = (msg) => {
  qaCache.clear();
  refresh();
  nav.refreshSide();
  if (msg) toast(msg, { action: { label: '元に戻す', fn: () => (col.undo(), refresh(), nav.refreshSide()) } });
};

async function changeDeck() {
  const { cids } = selected();
  const decks = col.sortedDecks().filter((d) => !d.filtered);
  let s;
  const v = await dialog({
    title: 'デッキを変える',
    body: `<div class="field"><label>${cids.length} 枚のカードを移すデッキ</label><select class="input" id="d">${options(decks.map((d) => [d.id, d.name]), col.conf.curDeck)}</select></div><button class="btn sm" data-new>${icon('plus')}新しいデッキ</button>`,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '移す', kind: 'primary', value: 'ok' },
    ],
    onOpen: (d) => {
      s = d.querySelector('#d');
      d.querySelector('[data-new]').onclick = async () => {
        const name = await promptDialog('新しいデッキ', { label: '名前' });
        if (!name) return;
        let nd;
        col.transact('デッキを作る', () => (nd = col.ensureDeck(name)));
        s.insertAdjacentHTML('beforeend', `<option value="${nd.id}">${esc(nd.name)}</option>`);
        s.value = nd.id;
      };
    },
  });
  if (v !== 'ok') return;
  ops.setDeck(col, cids, Number(s.value));
  after('デッキを変えました');
}

async function addTags() {
  const { nids } = selected();
  const v = await promptDialog('タグを足す', { label: `${nids.length} 件のノートに足すタグ（スペースで区切る）` });
  if (!v?.trim()) return;
  ops.addTags(col, nids, v);
  after('タグを足しました');
}

async function removeTags() {
  const { nids } = selected();
  const v = await promptDialog('タグを外す', { label: `${nids.length} 件のノートから外すタグ` });
  if (!v?.trim()) return;
  ops.removeTags(col, nids, v);
  after('タグを外しました');
}

function toggleSuspend() {
  const { cids } = selected();
  const allSusp = cids.every((id) => col.cards.get(id)?.queue === -1);
  ops.suspend(col, cids, !allSusp);
  after(allSusp ? '保留をやめました' : '保留にしました');
}

function toggleBury() {
  const { cids } = selected();
  const allB = cids.every((id) => col.cards.get(id)?.queue <= -2);
  ops.bury(col, cids, !allB);
  after(allB ? 'あとまわしをやめました' : '今日はあとまわしにしました');
}

function toggleMarkSel() {
  const { nids } = selected();
  const allM = nids.every((id) => col.notes.get(id)?.tags.some((t) => t.toLowerCase() === 'marked'));
  if (allM) ops.removeTags(col, nids, ['marked']);
  else ops.addTags(col, nids, ['marked']);
  after(allM ? '印を外しました' : '印をつけました');
}

function flag(n) {
  const { cids } = selected();
  col.transact('目印', () => {
    for (const id of cids) col.put('cards', { ...col.cards.get(id), flags: n });
  });
  after();
}

async function setDue() {
  const { cids } = selected();
  const v = await promptDialog('期日を決める', { label: `${cids.length} 枚のカードの期日（今日から何日後）`, value: '0', help: '「0」は今日、「1-7」は1〜7日後のどれか、「3!」は間隔も3日にします' });
  if (v == null) return;
  try {
    ops.setDueDate(col, cids, v);
    after('期日を決めました');
  } catch (e) {
    toast(e.message, { warn: true });
  }
}

async function forget() {
  const { cids } = selected();
  const body = el(`<div class="stack"><p style="margin:0">${cids.length} 枚のカードを、まだ見ていない新しいカードに戻します。</p><div class="setting"><div class="txt"><b>答えた回数と忘れた回数も 0 にする</b></div><div class="ctl auto">${switchHtml('rc', false)}</div></div></div>`);
  const v = await dialog({
    title: '新しいカードに戻す',
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '戻す', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return;
  ops.forget(col, cids, { resetCounts: body.querySelector('#rc').checked });
  after('新しいカードに戻しました');
}

async function reposition() {
  const { cids } = selected();
  const newOnes = cids.filter((id) => col.cards.get(id)?.type === 0);
  if (!newOnes.length) return toast('新しいカードを選んでください', { warn: true });
  const body = el(`<div class="stack"><div class="row"><div class="field grow"><label>はじめの番号</label><input class="input" type="number" id="start" value="1" min="0"></div><div class="field grow"><label>ふやす数</label><input class="input" type="number" id="step" value="1" min="1"></div></div>
    <div class="setting"><div class="txt"><b>ばらばらにする</b></div><div class="ctl auto">${switchHtml('rand', false)}</div></div>
    <div class="setting"><div class="txt"><b>ほかのカードを後ろにずらす</b></div><div class="ctl auto">${switchHtml('shift', false)}</div></div></div>`);
  const v = await dialog({
    title: '新しいカードの順番',
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '変える', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return;
  ops.reposition(col, newOnes, Number(body.querySelector('#start').value) || 0, Number(body.querySelector('#step').value) || 1, { randomize: body.querySelector('#rand').checked, shift: body.querySelector('#shift').checked });
  after('順番を変えました');
}

async function changeType() {
  const { nids } = selected();
  const first = col.notes.get(nids[0]);
  if (nids.some((id) => col.notes.get(id).ntid !== first.ntid)) return toast('同じ種類のノートだけを選んでください', { warn: true });
  const from = col.notetypes.get(first.ntid);
  const types = [...col.notetypes.values()];
  const body = el(`<div class="stack"><div class="field"><label>新しい種類</label><select class="input" id="to">${options(types.map((t) => [t.id, t.name]), from.id)}</select></div><div id="maps" class="stack tight"></div></div>`);
  const drawMaps = () => {
    const to = col.notetypes.get(Number(body.querySelector('#to').value));
    const fOpts = [[-1, '（何も入れない）'], ...from.fields.map((f, i) => [i, f.name])];
    let h = '<div class="label">項目の入れ先</div>';
    to.fields.forEach((f, i) => (h += `<div class="row"><span class="grow">${esc(f.name)}</span><select class="input sm" style="width:55%" data-f="${i}">${options(fOpts, i < from.fields.length ? i : -1)}</select></div>`));
    if (to.kind === 'std' && from.kind === 'std') {
      const tOpts = [[-1, '（消す）'], ...to.templates.map((t, i) => [i, t.name])];
      h += '<div class="label" style="margin-top:8px">カードの型の入れ先</div>';
      from.templates.forEach((t, i) => (h += `<div class="row"><span class="grow">${esc(t.name)}</span><select class="input sm" style="width:55%" data-t="${i}">${options(tOpts, i < to.templates.length ? i : -1)}</select></div>`));
    }
    body.querySelector('#maps').innerHTML = h;
  };
  body.querySelector('#to').onchange = drawMaps;
  drawMaps();
  const v = await dialog({
    title: 'ノートの種類を変える',
    body,
    wide: true,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '変える', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return;
  const toId = Number(body.querySelector('#to').value);
  const fieldMap = [...body.querySelectorAll('[data-f]')].map((s) => Number(s.value));
  const cardMap = Object.fromEntries([...body.querySelectorAll('[data-t]')].map((s) => [Number(s.dataset.t), Number(s.value)]));
  ops.changeNotetype(col, nids, toId, fieldMap, cardMap);
  after('ノートの種類を変えました');
}

async function findReplace() {
  const { nids } = selected();
  const all = nids.length ? nids : search(col, st.query, { cards: false });
  const fieldNames = [...new Set(all.flatMap((id) => col.notetypes.get(col.notes.get(id)?.ntid)?.fields.map((f) => f.name) || []))];
  const body = el(`<div class="stack">
    <div class="field"><label>探す文字</label><input class="input" id="f"></div>
    <div class="field"><label>置きかえる文字</label><input class="input" id="r"></div>
    <div class="field"><label>場所</label><select class="input" id="in">${options([['', 'すべての項目'], ['__tags', 'タグ'], ...fieldNames.map((n) => [n, n])], '')}</select></div>
    <div class="setting"><div class="txt"><b>正規表現を使う</b></div><div class="ctl auto">${switchHtml('re', false)}</div></div>
    <div class="setting"><div class="txt"><b>大文字と小文字を分ける</b></div><div class="ctl auto">${switchHtml('mc', false)}</div></div>
    <div class="sub small">${nids.length ? `選んだ ${nids.length} 件` : `いまの検索の ${all.length} 件`}のノートが対象です</div></div>`);
  const v = await dialog({
    title: '探して置きかえる',
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '置きかえる', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return;
  const g = (id) => body.querySelector(`#${id}`);
  if (!g('f').value) return;
  try {
    const n = ops.findReplace(col, all, g('f').value, g('r').value, { field: g('in').value || null, regex: g('re').checked, matchCase: g('mc').checked });
    after(`${n} 件のノートを書きかえました`);
  } catch (e) {
    toast(e.message, { warn: true });
  }
}

async function findDupes() {
  const types = [...col.notetypes.values()];
  const body = el(`<div class="stack"><div class="field"><label>ノートの種類</label><select class="input" id="t">${options(types.map((t) => [t.id, t.name]), types[0].id)}</select></div><div class="field"><label>比べる項目</label><select class="input" id="f"></select></div><div id="res"></div></div>`);
  const fill = () => {
    const t = col.notetypes.get(Number(body.querySelector('#t').value));
    body.querySelector('#f').innerHTML = options(t.fields.map((f, i) => [i, f.name]), 0);
  };
  body.querySelector('#t').onchange = fill;
  fill();
  const v = await dialog({
    title: '同じものを探す',
    body,
    buttons: [
      { label: '閉じる', value: null },
      { label: '探す', kind: 'primary', value: 'ok' },
    ],
    beforeClose: (val, d) => {
      if (val !== 'ok') return true;
      const res = ops.findDupes(col, Number(body.querySelector('#t').value), Number(body.querySelector('#f').value));
      const box = d.querySelector('#res');
      box.innerHTML = res.length
        ? `<div class="label">${res.length} 組みつかりました</div>${res
            .slice(0, 100)
            .map((r) => `<button class="nav-item" data-nids="${r.nids.join(',')}">${icon('copy')}<span class="label">${esc(r.key)}</span><span class="count">${r.nids.length}</span></button>`)
            .join('')}<button class="btn sm" data-tagall>${icon('tag')}全部に「duplicate」タグを付ける</button>`
        : '<div class="sub">同じものはありませんでした</div>';
      box.onclick = (e) => {
        const b = e.target.closest('[data-nids]');
        if (b) {
          setQuery(`nid:${b.dataset.nids}`);
          d.closest('.backdrop').remove();
        }
        if (e.target.closest('[data-tagall]')) {
          ops.addTags(col, res.flatMap((r) => r.nids), ['duplicate']);
          toast('タグを付けました');
        }
      };
      return false;
    },
  });
  return v;
}

function exportCsv() {
  const cols = visibleCols();
  const rows = (st.sel.size ? st.rows.filter((r) => st.sel.has(r.id)) : st.rows).map((r) => cols.map((c) => c[2](r)));
  download(`kioku-一覧-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(cols.map((c) => c[1]), rows), 'text/csv');
}

async function del() {
  const { nids } = selected();
  const cards = prefs.mode === 'cards';
  const { cids } = selected();
  const msg = cards ? `選んだ ${cids.length} 枚のカードのノート（${nids.length} 件）と、そのすべてのカードを消します。` : `${nids.length} 件のノートと、そのカードを消します。`;
  if (!(await confirmDialog('削除', msg, { ok: '削除', danger: true }))) return;
  col.deleteNotes(nids);
  st.sel.clear();
  after('削除しました');
}

function moveSel(d) {
  if (!st.rows.length) return;
  const cur = st.anchor ?? -1;
  const i = Math.max(0, Math.min(st.rows.length - 1, cur + d));
  st.sel = new Set([st.rows[i].id]);
  st.anchor = i;
  const tbl = st.page.querySelector('#tbl');
  const y = i * ROW_H;
  if (y < tbl.scrollTop + 40) tbl.scrollTop = y - 40;
  if (y > tbl.scrollTop + tbl.clientHeight - ROW_H * 2) tbl.scrollTop = y - tbl.clientHeight + ROW_H * 2;
  drawRows();
  drawEditor();
}

function onKey(e) {
  if (!st) return;
  const typing = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if (typing) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSel(1);
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSel(-1);
  }
  if (e.key === 'Enter' && st.sel.size === 1) {
    const r = st.rows.find((x) => st.sel.has(x.id));
    openEdit(r);
  }
}

function onDocKey(e) {
  if (!st || document.querySelector('.backdrop')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) {
    const typing = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !st.page.contains(e.target)) onKey(e);
    return;
  }
  const typing = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  const k = e.key.toLowerCase();
  const has = st.sel.size > 0;
  let fn = null;
  if (k === 'a' && !e.shiftKey && !typing) fn = selectAll;
  else if (k === 'a' && e.shiftKey && e.altKey) fn = removeTags;
  else if (k === 'a' && e.shiftKey) fn = addTags;
  else if (k === 'd' && e.shiftKey) fn = setDue;
  else if (k === 'd') fn = changeDeck;
  else if (k === 'j') fn = toggleSuspend;
  else if (k === 'k') fn = toggleMarkSel;
  else if (k === 'f' && e.altKey) fn = findReplace;
  else if (k === 'f') fn = () => st.page.querySelector('#searchInput').focus();
  else if (k === 's' && e.shiftKey) fn = reposition;
  else if (k === 'n' && e.altKey) fn = forget;
  else if (k === 'i' && e.shiftKey) fn = () => selected().cids[0] && openCardInfo(selected().cids[0]);
  else if ((e.key === 'Backspace' || e.key === 'Delete') && !typing) fn = del;
  else if (/^[1-7]$/.test(e.key)) fn = () => flag(Number(e.key));
  if (!fn) return;
  if (fn !== selectAll && fn !== findReplace && !has && !(k === 'f' && !e.altKey)) return;
  e.preventDefault();
  fn();
}
