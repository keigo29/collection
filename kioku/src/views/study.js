// 学習の画面
import { col } from '../col.js';
import { el, icon, esc, menu, toast, confirmDialog, dialogOpen } from '../ui/dom.js';
import { Session, deckCounts } from '../sched/queue.js';
import { renderCard } from '../template.js';
import { renderInto, playSounds, stopAudio, isNight } from '../ui/cardview.js';
import { suspend, bury, buryNote, setFlag, toggleMark } from '../ops.js';
import { fmtSpan, keyLabel, plural, fmtDuration } from '../util.js';
import { FLAGS } from '../stock.js';
import { nav } from '../nav.js';
import { editNoteDialog } from './editNote.js';
import { openCardInfo } from './cardInfo.js';
import { openCustomStudy } from './customStudy.js';
import { openDeckOptions } from './deckOptions.js';
import { syncSettings } from '../sync.js';

let state = null;

export function render(main, { arg }) {
  const did = Number(arg);
  const deck = col.decks.get(did);
  if (!deck) return nav.go('/decks');
  col.setConf({ curDeck: did });
  const root = el(`<div class="study" style="--mode:var(--focus)">
    <div class="study-top">
      <button class="icon-btn" data-a="close" title="やめる（Esc）">${icon('x')}</button>
      <svg class="ring" viewBox="0 0 30 30"><circle class="bg" cx="15" cy="15" r="12"/><circle class="fg" cx="15" cy="15" r="12" stroke-dasharray="75.4" stroke-dashoffset="75.4"/></svg>
      <div class="title">${esc(deck.name.split('::').pop())}</div>
      <div class="grow"></div>
      <span class="timer hidden" id="timer"></span>
      <div class="counts" id="counts"></div>
      <button class="icon-btn" data-a="undo" title="元に戻す（${keyLabel('⌘Z')}）">${icon('undo-2')}</button>
      <button class="icon-btn" data-a="edit" title="編集（E）">${icon('pencil')}</button>
      <button class="icon-btn" data-a="more" title="ほかの操作">${icon('ellipsis')}</button>
    </div>
    <div class="study-stage" id="stage"></div>
    <div class="study-bar"><div class="inner" id="bar"></div></div>
  </div>`);
  main.appendChild(root);
  state = {
    root,
    did,
    session: new Session(col, did),
    card: null,
    side: 'q',
    shownAt: 0,
    done: 0,
    timers: [],
    forced: null,
    view: null,
    typed: '',
    startedAt: Date.now(),
  };
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  showNext();
}

export async function leave() {
  if (!state) return true;
  document.removeEventListener('keydown', onKey);
  clearTimers();
  stopAudio();
  const answered = state.done;
  state = null;
  const st = syncSettings();
  if (answered && st.token && st.auto !== false) nav.runSync('merge', { quiet: true });
  return true;
}

export function undo() {
  doUndo();
}

function clearTimers() {
  if (!state) return;
  state.timers.forEach(clearTimeout);
  state.timers = [];
  clearInterval(state.tick);
}

function updateTop() {
  const s = state;
  const c = s.session.counts();
  const cur = s.card;
  const which = !cur ? '' : cur.queue === 0 ? 'n' : cur.queue === 1 || cur.queue === 3 && cur.type !== 2 ? 'l' : 'r';
  s.root.querySelector('#counts').innerHTML = `<span class="n ${which === 'n' ? 'cur' : ''}" title="新規"><span class="dot"></span>${c.new}</span><span class="l ${which === 'l' ? 'cur' : ''}" title="学習中"><span class="dot"></span>${c.lrn}</span><span class="r ${which === 'r' ? 'cur' : ''}" title="復習"><span class="dot"></span>${c.rev}</span>`;
  const remaining = c.new + c.lrn + c.rev;
  const frac = s.done + remaining ? s.done / (s.done + remaining) : 1;
  s.root.querySelector('.ring .fg').setAttribute('stroke-dashoffset', String(75.4 * (1 - frac)));
}

function showNext() {
  const s = state;
  clearTimers();
  stopAudio();
  let card = null;
  if (s.forced) {
    card = col.cards.get(s.forced);
    s.forced = null;
  }
  card = card || s.session.next();
  s.card = card;
  updateTop();
  if (!card) return showDone();
  s.side = 'q';
  s.typed = '';
  drawFace();
  drawBar();
  s.shownAt = Date.now();
  const p = col.presetForCard(card);
  if (p.autoplay !== false) playSounds(s.view.sounds);
  const timer = s.root.querySelector('#timer');
  timer.classList.toggle('hidden', !p.showTimer);
  if (p.showTimer) {
    const upd = () => (timer.textContent = fmtClock(Math.min(Date.now() - s.shownAt, (p.maxAnswerSecs || 60) * 1000)));
    upd();
    s.tick = setInterval(upd, 1000);
  }
  if (p.autoAdvanceQ > 0) s.timers.push(setTimeout(() => state?.side === 'q' && reveal(), p.autoAdvanceQ * 1000));
}

const fmtClock = (ms) => {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function cardParts(typed) {
  const c = state.card;
  const note = col.notes.get(c.nid);
  const nt = col.notetypes.get(note.ntid);
  return { r: renderCard({ card: c, note, nt, deckName: col.decks.get(c.odid || c.did)?.name || '', typed }), note, nt };
}

function drawFace() {
  const s = state;
  const stage = s.root.querySelector('#stage');
  const { r, note } = cardParts(s.typed);
  const flag = FLAGS.find((f) => f.n === s.card.flags);
  const marked = note.tags.some((t) => t.toLowerCase() === 'marked');
  stage.innerHTML = `<div class="face" id="face">${flag ? `<div class="flagbar" style="--c:${flag.color}"></div>` : ''}${marked ? `<span class="marked" title="印">${icon('star')}</span>` : ''}<div class="cardhost"></div></div>`;
  const host = stage.querySelector('.cardhost');
  s.view = renderInto(host, s.side === 'q' ? r.q : r.a, r.css, { night: isNight() });
  if (s.side === 'q' && s.view.typeInput) {
    const inp = s.view.typeInput;
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        reveal();
      }
    });
    setTimeout(() => inp.focus(), 30);
  }
  if (s.side === 'a') {
    s.view.ready.then(() => {
      const hr = s.view.root.querySelector('#answer');
      if (hr && stage.scrollHeight > stage.clientHeight) hr.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }
  wireSwipe(stage.querySelector('#face'));
}

function drawBar() {
  const s = state;
  const bar = s.root.querySelector('#bar');
  if (s.side === 'q') {
    bar.innerHTML = `<button class="btn primary show" data-a="show">答えを見る <span class="kbd hide-sm" style="background:transparent;color:inherit;opacity:.6">Space</span></button>`;
    return;
  }
  const ivls = s.session.intervals(s.card);
  const show = col.conf.showIntervals !== false;
  const labels = s.session.preview ? ['もう一度', '難しい', '次へ', '簡単'] : ['もう一度', '難しい', '正解', '簡単'];
  const kinds = ['again', 'hard', 'good', 'easy'];
  const fmt = (v) => (v <= 0 ? '終わり' : v < 60 ? '<1分' : fmtSpan(v));
  const btns = [1, 2, 3, 4].filter((g) => !s.session.preview || g !== 4);
  bar.innerHTML = btns
    .map(
      (g) =>
        `<button class="btn ease ${kinds[g - 1]}" data-g="${g}">${show ? `<span class="ivl">${s.session.preview && g === 3 ? '' : fmt(ivls[g - 1])}</span>` : ''}<span class="lbl">${labels[g - 1]}</span><span class="k">${g}</span></button>`
    )
    .join('');
}

function reveal() {
  const s = state;
  if (!s?.card || s.side !== 'q') return;
  s.typed = s.view.typeInput?.value ?? '';
  s.side = 'a';
  clearTimeout(s.timers.shift());
  const qSounds = s.view.sounds.length;
  drawFace();
  drawBar();
  const p = col.presetForCard(s.card);
  if (p.autoplay !== false) playSounds(p.replayQuestion === false ? s.view.sounds.slice(qSounds) : s.view.sounds);
  if (p.autoAdvanceA > 0) s.timers.push(setTimeout(() => state?.side === 'a' && answerWith(3), p.autoAdvanceA * 1000));
}

function answerWith(g) {
  const s = state;
  if (!s?.card || s.side !== 'a') return;
  if (s.session.preview && g === 4) g = 3;
  const took = Date.now() - s.shownAt;
  const res = s.session.answer(s.card, g, took);
  s.done++;
  if (res?.leech) toast(col.presetForCard(s.card).leechAction === 'suspend' ? '苦手なカードなので保留にしました' : '苦手なカードです（leech のタグを付けました）', { warn: true });
  showNext();
}

function doUndo() {
  const s = state;
  const label = col.undoLabel;
  if (!label) return toast('元に戻せるものはありません');
  col.undo();
  if (label === '答え' && s.session.history.length) {
    s.forced = s.session.history.pop();
    s.done = Math.max(0, s.done - 1);
  } else if (s.prev && col.cards.has(s.prev)) {
    s.forced = s.prev;
    s.prev = null;
  } else if (s.card && col.cards.has(s.card.id)) s.forced = s.card.id;
  else {
    // 消したカードを戻したとき
    s.session.build();
  }
  toast(`「${label}」を元に戻しました`);
  showNext();
}

function showDone() {
  const s = state;
  clearTimers();
  s.root.querySelector('#bar').innerHTML = '';
  const c = deckCounts(col, s.did);
  const later = s.session.learning(false).length === 0 && c.lrn > 0;
  const mins = Math.round((Date.now() - s.startedAt) / 60000);
  s.root.querySelector('#stage').innerHTML = `<div class="done">
    <div class="logo" style="width:48px;height:48px;border-radius:14px">${icon('check')}</div>
    <div class="big">おつかれさまでした</div>
    <div class="sub">${s.done ? `${plural(s.done)} 枚に答えました（${mins ? `${mins}分` : '1分未満'}）。` : ''}${later ? '学習中のカードは、少し時間をおいてまた出てきます。' : '今日の分はおしまいです。'}</div>
    <div class="row wrap" style="justify-content:center">
      <button class="btn primary" data-a="close">${icon('layers')}デッキへ</button>
      ${col.decks.get(s.did)?.filtered ? '' : `<button class="btn" data-a="custom">${icon('sparkles')}カスタム学習</button>`}
      ${later ? `<button class="btn" data-a="again">${icon('refresh-cw')}もう一度見る</button>` : ''}
    </div></div>`;
}

async function moreMenu(anchor) {
  const s = state;
  const c = s.card;
  const items = [];
  if (c) {
    const note = col.notes.get(c.nid);
    const marked = note.tags.some((t) => t.toLowerCase() === 'marked');
    items.push(
      { label: '編集', icon: 'pencil', key: 'E', fn: () => edit() },
      { label: marked ? '印を外す' : '印をつける', icon: 'star', key: '*', fn: () => mark() },
      ...FLAGS.map((f) => ({ label: `目印：${col.conf.flagNames?.[f.n] || f.name}`, dot: f.color, key: `⌘${f.n}`, fn: () => flag(f.n) })),
      { label: '目印を外す', icon: 'flag', fn: () => flag(0), disabled: !c.flags },
      { sep: true },
      { label: 'このカードは今日出さない', icon: 'eye-off', key: '-', fn: () => doBury(false) },
      { label: 'このノートは今日出さない', icon: 'eye-off', key: '=', fn: () => doBury(true) },
      { label: 'カードを保留にする', icon: 'circle-pause', key: '@', fn: () => doSuspend(false) },
      { label: 'ノートを保留にする', icon: 'circle-pause', key: '!', fn: () => doSuspend(true) },
      { sep: true },
      { label: '音をもう一度', icon: 'volume-2', key: 'R', fn: () => playSounds(s.view.sounds) },
      { label: 'カードの情報', icon: 'info', key: 'I', fn: () => openCardInfo(c.id) },
      { label: 'デッキの設定', icon: 'sliders-horizontal', key: 'O', fn: () => openDeckOptions(c.odid || c.did) },
      { sep: true },
      { label: 'ノートを削除', icon: 'trash', key: '⌘⌫', danger: true, fn: () => delNote() }
    );
  }
  menu(anchor, items);
}

async function edit() {
  const s = state;
  if (!s.card) return;
  const saved = await editNoteDialog(s.card.nid);
  if (!state) return;
  if (saved && col.cards.has(s.card.id)) {
    s.card = col.cards.get(s.card.id);
    drawFace();
    drawBar();
  } else if (!col.cards.has(s.card.id)) showNext();
}

function mark() {
  const on = toggleMark(col, state.card.nid);
  toast(on ? '印をつけました' : '印を外しました');
  drawFace();
}

function flag(n) {
  setFlag(col, [state.card.id], n);
  state.card = col.cards.get(state.card.id);
  drawFace();
}

function doBury(note) {
  const c = state.card;
  state.prev = c.id;
  if (note) buryNote(col, c.nid);
  else bury(col, [c.id]);
  toast(note ? 'このノートは明日また出ます' : 'このカードは明日また出ます', { action: { label: '元に戻す', fn: doUndo } });
  showNext();
}

function doSuspend(note) {
  const c = state.card;
  state.prev = c.id;
  suspend(col, note ? col.cardsOfNote(c.nid).map((x) => x.id) : [c.id], true);
  toast('保留にしました（一覧から戻せます）', { action: { label: '元に戻す', fn: doUndo } });
  showNext();
}

async function delNote() {
  const c = state.card;
  const n = col.cardsOfNote(c.nid).length;
  if (!(await confirmDialog('ノートを削除', `このノートと、そこからできた ${n} 枚のカードを消します。`, { ok: '削除', danger: true }))) return;
  col.deleteNotes([c.nid]);
  state.prev = c.id;
  toast('削除しました', { action: { label: '元に戻す', fn: doUndo } });
  showNext();
}

function close() {
  nav.go(`/deck/${state?.did ?? ''}`);
}

function onClick(e) {
  const s = state;
  if (!s) return;
  const g = e.target.closest('[data-g]');
  if (g) return answerWith(Number(g.dataset.g));
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'show') return reveal();
  if (a === 'close') return close();
  if (a === 'undo') return doUndo();
  if (a === 'edit') return edit();
  if (a === 'more') return moreMenu(e.target.closest('[data-a]'));
  if (a === 'custom') return openCustomStudy(s.did);
  if (a === 'again') {
    s.session.build();
    return showNext();
  }
  // カードをさわったら答えを見る（入力欄や音のボタンは除く）
  if (s.side === 'q' && e.target.closest('#face') && !e.composedPath().some((n) => n.tagName === 'INPUT' || n.tagName === 'BUTTON' || n.tagName === 'SUMMARY' || n.tagName === 'A')) reveal();
}

function onKey(e) {
  const s = state;
  if (!s || dialogOpen() || document.querySelector('.menu')) return;
  const inInput = e.composedPath().some((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return doUndo();
  }
  if (inInput) return;
  if (mod && /^[1-7]$/.test(e.key)) {
    e.preventDefault();
    return s.card && flag(Number(e.key));
  }
  if (mod && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault();
    return s.card && delNote();
  }
  if (mod || e.altKey) return;
  const k = e.key;
  if (k === 'Escape') return close();
  if (!s.card) return;
  if (k === ' ' || k === 'Enter') {
    e.preventDefault();
    if (s.side === 'q') reveal();
    else answerWith(3);
    return;
  }
  if (/^[1-4]$/.test(k) && s.side === 'a') return answerWith(Number(k));
  switch (k.toLowerCase()) {
    case 'e':
      return edit();
    case '*':
      return mark();
    case '-':
      return doBury(false);
    case '=':
      return doBury(true);
    case '@':
      return doSuspend(false);
    case '!':
      return doSuspend(true);
    case 'r':
    case 'f5':
      e.preventDefault();
      return playSounds(s.view.sounds);
    case 'i':
      return openCardInfo(s.card.id);
    case 'o':
      return openDeckOptions(s.card.odid || s.card.did);
    case 'z':
      return doUndo();
  }
}

/** 答えの面で右へすべらせると「正解」、左へすべらせると「もう一度」 */
function wireSwipe(face) {
  let x0 = null;
  let y0 = 0;
  let dx = 0;
  face.addEventListener(
    'touchstart',
    (e) => {
      if (state?.side !== 'a' || e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      dx = 0;
    },
    { passive: true }
  );
  face.addEventListener(
    'touchmove',
    (e) => {
      if (x0 == null) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (Math.abs(dy) > Math.abs(dx)) {
        dx = 0;
        face.style.transform = '';
        return;
      }
      face.style.transition = 'none';
      face.style.transform = `translateX(${dx * 0.6}px) rotate(${dx * 0.02}deg)`;
      face.style.boxShadow = Math.abs(dx) > 80 ? `inset 0 0 0 3px ${dx > 0 ? 'var(--ok)' : 'var(--danger)'}` : '';
    },
    { passive: true }
  );
  face.addEventListener('touchend', () => {
    if (x0 == null) return;
    face.style.transition = 'transform .15s';
    face.style.transform = '';
    face.style.boxShadow = '';
    const d = dx;
    x0 = null;
    if (d > 80) answerWith(3);
    else if (d < -80) answerWith(1);
  });
}

export { fmtDuration };
