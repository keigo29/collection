import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './style.css';
import { col } from './col.js';
import { $, el, icon, toast, dialogOpen, closeMenu } from './ui/dom.js';
import { syncSettings, sync } from './sync.js';
import { autoBackup } from './io/backup.js';
import { deckCounts } from './sched/queue.js';
import * as decksView from './views/decks.js';
import * as studyView from './views/study.js';
import * as addView from './views/add.js';
import * as browseView from './views/browse.js';
import * as statsView from './views/stats.js';
import * as settingsView from './views/settings.js';
import { applyTheme } from './views/settings.js';
import { nav } from './nav.js';

const VIEWS = {
  decks: decksView,
  deck: decksView,
  study: studyView,
  add: addView,
  browse: browseView,
  stats: statsView,
  settings: settingsView,
};

const RAIL = [
  ['decks', 'layers', 'デッキ', 'D'],
  ['add', 'plus', '追加', 'A'],
  ['browse', 'search', '一覧', 'B'],
  ['stats', 'chart-column', '記録', 'T'],
  ['settings', 'settings', '設定', ''],
];

let current = null;
let currentName = '';
let lastHash = '';
let ignoreHash = false;

function shell() {
  const app = el(`<div class="app">
    <nav class="rail" aria-label="アプリ">
      <div class="logo" title="KIOKU">${icon('grid-2x2')}</div>
      <button class="rail-btn rail-menu" data-act="side"><span class="box">${icon('menu')}</span><span class="name">メニュー</span></button>
      ${RAIL.map(([k, ic, name, key]) => `<a class="rail-btn" href="#/${k}" data-r="${k}" title="${name}${key ? `（${key}）` : ''}"><span class="box">${icon(ic)}${k === 'decks' ? '<span class="badge hidden" id="dueBadge"></span>' : ''}</span><span class="name">${name}</span></a>`).join('')}
      <div class="grow"></div>
      <button class="rail-btn hide-sm" data-act="sync" id="syncBtn" title="同期（Y）"><span class="box">${icon('refresh-cw')}</span><span class="name">同期</span></button>
    </nav>
    <aside class="side" id="side"></aside>
    <main class="main" id="main"></main>
  </div>`);
  document.body.appendChild(app);
  app.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'side') {
      app.classList.toggle('side-open');
      e.stopPropagation();
    } else if (a?.dataset.act === 'sync') runSync();
    else if (app.classList.contains('side-open') && !e.target.closest('.side')) app.classList.remove('side-open');
    else if (e.target.closest('.side .nav-item, .side a')) app.classList.remove('side-open');
  });
  return app;
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  return { name: parts[0] || 'decks', arg: parts[1], params };
}

export function go(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

async function route() {
  if (ignoreHash) {
    ignoreHash = false;
    return;
  }
  closeMenu();
  const { name, arg, params } = parseHash();
  const view = VIEWS[name] || decksView;
  const app = $('.app');
  if (current?.leave) {
    const ok = await current.leave();
    if (ok === false) {
      if (location.hash !== lastHash) {
        ignoreHash = true;
        location.hash = lastHash;
      }
      return;
    }
  }
  lastHash = location.hash;
  current = view;
  currentName = name;
  for (const b of app.querySelectorAll('.rail-btn[data-r]')) b.classList.toggle('on', b.dataset.r === name || (name === 'deck' && b.dataset.r === 'decks'));
  const main = $('#main');
  const side = $('#side');
  main.scrollTop = 0;
  app.classList.toggle('no-side', !view.side);
  app.classList.remove('side-open');
  side.innerHTML = '';
  main.innerHTML = '';
  if (view.side) {
    side.appendChild(el('<div class="wordmark">KIOKU</div>'));
    view.side(side, { name, arg, params });
  }
  view.render(main, { name, arg, params });
  updateBadge();
}

export function refreshSide() {
  const { name, arg, params } = parseHash();
  const view = VIEWS[name];
  const side = $('#side');
  if (view?.side && side) {
    const st = side.scrollTop;
    side.innerHTML = '<div class="wordmark">KIOKU</div>';
    view.side(side, { name, arg, params });
    side.scrollTop = st;
  }
}

function updateBadge() {
  const b = $('#dueBadge');
  if (!b) return;
  let total = 0;
  for (const d of col.childDecks(null)) {
    const c = deckCounts(col, d.id);
    total += c.new + c.lrn + c.rev;
  }
  b.textContent = total > 999 ? '999+' : total;
  b.classList.toggle('hidden', !total);
}

let syncing = false;
export async function runSync(mode = 'merge', { quiet = false } = {}) {
  const st = syncSettings();
  if (!st.token) {
    if (!quiet) go('/settings/sync');
    return;
  }
  if (syncing) return;
  syncing = true;
  const btn = $('#syncBtn');
  btn?.querySelector('.icon')?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity });
  try {
    await sync(col, mode);
    if (!quiet) toast('同期しました');
    if (currentName !== 'study') route();
  } catch (e) {
    console.error(e);
    toast(`同期できませんでした：${e.message}`, { warn: true });
  } finally {
    syncing = false;
    btn?.querySelector('.icon')?.getAnimations().forEach((a) => a.cancel());
  }
}

function keys(e) {
  if (dialogOpen()) return;
  const t = e.target;
  const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) {
    e.preventDefault();
    if (current?.undo) return current.undo();
    const label = col.undo();
    toast(label ? `「${label}」を元に戻しました` : '元に戻せるものはありません');
    if (label) route();
    return;
  }
  if (typing || mod || e.altKey) return;
  if (currentName === 'study') return;
  const k = e.key.toLowerCase();
  if (k === 'd') go('/decks');
  else if (k === 'a') go('/add');
  else if (k === 'b') go('/browse');
  else if (k === 't') go('/stats');
  else if (k === 'y') runSync();
  else if (k === '/') {
    const s = document.querySelector('#searchInput');
    if (s) {
      e.preventDefault();
      s.focus();
    }
  }
}

async function start() {
  applyTheme();
  try {
    await col.load();
  } catch (e) {
    document.body.innerHTML = `<div class="empty" style="height:100dvh;justify-content:center"><b>データを開けませんでした</b><span>${String(e.message || e)}</span><span class="small">ブラウザの「プライベート」モードでは保存できないことがあります。</span></div>`;
    return;
  }
  shell();
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', keys);
  col.on(() => {
    updateBadge();
  });
  // 閉じる前に書く
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') col.flush();
    else if (col.checkDay() && currentName !== 'study') route();
  });
  window.addEventListener('pagehide', () => col.flush());
  Object.assign(nav, { go, refreshSide, runSync, rerender: route });
  route();
  autoBackup(col).catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const st = syncSettings();
  if (st.token && st.auto !== false) setTimeout(() => runSync('merge', { quiet: true }), 600);
  // 日がかわったら数を新しくする
  setInterval(() => {
    if (col.checkDay() && currentName !== 'study') route();
  }, 60000);
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();
