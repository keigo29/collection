// カードを足す画面
import { col } from '../col.js';
import { el, icon, esc, toast, options } from '../ui/dom.js';
import { createEditor } from '../ui/editor.js';
import { cardOrds } from '../template.js';
import { keyLabel, stripHtml } from '../util.js';
import { nav } from '../nav.js';
import { previewNote } from './preview.js';

const history = [];
let editor = null;
let page = null;
let dirty = false;

export function side(root) {
  const sec = el(`<div class="side-sec"><div class="side-h"><span>さっき足したもの</span></div></div>`);
  if (!history.length) sec.appendChild(el('<div class="sub small" style="padding:0 10px">まだありません</div>'));
  for (const h of history.slice(0, 20)) {
    if (!col.notes.has(h.id)) continue;
    sec.appendChild(el(`<a class="nav-item" href="#/browse?q=${encodeURIComponent(`nid:${h.id}`)}">${icon('file-text')}<span class="label">${esc(h.label || '（空）')}</span></a>`));
  }
  root.appendChild(sec);
}

export function render(main, { params }) {
  const types = [...col.notetypes.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  let ntid = col.notetypes.has(col.conf.addType) ? col.conf.addType : types[0].id;
  if (params.type && col.notetypes.has(Number(params.type))) ntid = Number(params.type);
  let did = Number(params.deck) || col.conf.lastAddedNotetypeDeck?.[ntid] || col.conf.addDeck || col.conf.curDeck;
  if (!col.decks.has(did) || col.decks.get(did).filtered) did = col.sortedDecks().find((d) => !d.filtered)?.id;
  const decks = col.sortedDecks().filter((d) => !d.filtered);
  page = el(`<div class="page" style="max-width:820px">
    <div class="toolbar"><h1>カードを足す</h1><span class="desc">${esc(keyLabel('⌘Enter'))} で追加</span><div class="grow"></div>
      <button class="btn" data-a="preview">${icon('eye-off')}<span class="hide-sm">見え方</span></button>
      <button class="btn primary" data-a="add">${icon('plus')}追加</button></div>
    <div class="card stack">
      <div class="row wrap">
        <div class="field grow" style="min-width:180px"><label>ノートの種類</label><select class="input" id="ntSel">${options(types.map((t) => [t.id, t.name]), ntid)}</select></div>
        <div class="field grow" style="min-width:180px"><label>デッキ</label><select class="input" id="deckSel">${options(decks.map((d) => [d.id, d.name]), did)}</select></div>
      </div>
      <div id="edHost"></div>
      <div class="row"><span class="sub small grow" id="cardsInfo"></span><button class="btn primary" data-a="add">${icon('plus')}追加</button></div>
    </div>
  </div>`);
  const host = page.querySelector('#edHost');
  const info = page.querySelector('#cardsInfo');
  const updateInfo = () => {
    const d = editor.getData();
    const n = cardOrds(editor.notetype, d.fields).length;
    info.textContent = n ? `${n} 枚のカードができます` : editor.notetype.kind === 'std' ? '表になる項目を書いてください' : '{{c1::…}} で隠すところを決めてください';
  };
  dirty = false;
  editor = createEditor({ ntid, mode: 'add', onChange: () => ((dirty = true), updateInfo()) });
  host.appendChild(editor.el);
  updateInfo();
  page.querySelector('#ntSel').onchange = (e) => {
    ntid = Number(e.target.value);
    editor.setNotetype(ntid);
    col.setConf({ addType: ntid });
    const last = col.conf.lastAddedNotetypeDeck?.[ntid];
    if (last && col.decks.has(last)) page.querySelector('#deckSel').value = last;
    updateInfo();
  };
  page.querySelector('#deckSel').onchange = (e) => col.setConf({ addDeck: Number(e.target.value) });
  page.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'add') add();
    if (a === 'preview') {
      const d = editor.getData();
      previewNote(editor.notetype, d.fields, d.tags, Number(page.querySelector('#deckSel').value));
    }
  });
  page.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  main.appendChild(page);
  setTimeout(() => editor.focusFirst(), 0);
}

function add() {
  const d = editor.getData();
  const ntid = editor.notetype.id;
  const did = Number(page.querySelector('#deckSel').value);
  try {
    const { note, count } = col.addNote(ntid, did, d.fields, d.tags);
    col.setConf({ addType: ntid, addDeck: did, lastAddedNotetypeDeck: { ...(col.conf.lastAddedNotetypeDeck || {}), [ntid]: did } });
    history.unshift({ id: note.id, label: stripHtml(d.fields.find((f) => stripHtml(f)) || '').slice(0, 40) });
    toast(`${count} 枚のカードを足しました`, { action: { label: '元に戻す', fn: () => (col.undo(), nav.refreshSide()) } });
    editor.reset();
    dirty = false;
    nav.refreshSide();
  } catch (e) {
    toast(e.message, { warn: true });
  }
}

export function leave() {
  if (dirty && editor?.hasContent() && !confirm('書きかけの中身があります。この画面を離れますか？')) return false;
  editor = null;
  return true;
}
