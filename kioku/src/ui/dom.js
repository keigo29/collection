// 画面づくりの小さな道具：ダイアログ・トースト・メニュー
import { icon } from './icons.js';
import { esc, keyLabel } from '../util.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 文字列の HTML から要素を作る */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export { icon, esc };

// ---- トースト
let toastHost;
export function toast(msg, { warn = false, action = null, ms = 2600 } = {}) {
  if (!toastHost) {
    toastHost = el('<div class="toasts" role="status" aria-live="polite"></div>');
    document.body.appendChild(toastHost);
  }
  const t = el(`<div class="toast ${warn ? 'warn' : ''}"><span>${esc(msg)}</span></div>`);
  if (action) {
    const b = el(`<button>${esc(action.label)}</button>`);
    b.onclick = () => {
      action.fn();
      t.remove();
    };
    t.appendChild(b);
  }
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), action ? Math.max(ms, 5000) : ms);
}

// ---- ダイアログ
const openDialogs = [];
export function dialogOpen() {
  return openDialogs.length > 0;
}

/**
 * @param o.title 見出し
 * @param o.body 本文の HTML か要素
 * @param o.buttons [{label, kind:'primary'|'danger'|'', value, left:true}]
 * @param o.onOpen(root, close)
 * @returns Promise<value>（閉じたら null）
 */
export function dialog({ title, body = '', buttons = [{ label: '閉じる', value: null }], wide = false, xwide = false, onOpen, beforeClose } = {}) {
  return new Promise((resolve) => {
    const bd = el('<div class="backdrop"></div>');
    const dg = el(`<div class="dialog ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''}" role="dialog" aria-modal="true"></div>`);
    if (title) dg.appendChild(el(`<h3>${esc(title)}</h3>`));
    const b = el('<div class="body"></div>');
    if (typeof body === 'string') b.innerHTML = body;
    else if (body) b.appendChild(body);
    dg.appendChild(b);
    if (buttons.length) {
      const foot = el('<div class="foot"></div>');
      const left = buttons.filter((x) => x.left);
      const right = buttons.filter((x) => !x.left);
      for (const x of left) foot.appendChild(mkBtn(x));
      foot.appendChild(el('<div class="grow"></div>'));
      for (const x of right) foot.appendChild(mkBtn(x));
      dg.appendChild(foot);
    }
    bd.appendChild(dg);
    let done = false;
    const close = async (v) => {
      if (done) return;
      if (beforeClose && v !== null && (await beforeClose(v, dg)) === false) return;
      done = true;
      bd.remove();
      openDialogs.splice(openDialogs.indexOf(close), 1);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    function mkBtn(x) {
      const btn = el(`<button class="btn ${x.kind || ''}">${x.icon ? icon(x.icon) : ''}${esc(x.label)}</button>`);
      btn.onclick = () => close(x.value === undefined ? x.label : x.value);
      return btn;
    }
    const onKey = (e) => {
      if (openDialogs.at(-1) !== close) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && !e.target.closest('.tags-input')))) {
        const primary = buttons.find((x) => x.kind === 'primary');
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(primary.value === undefined ? primary.label : primary.value);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    bd.addEventListener('mousedown', (e) => {
      if (e.target === bd) close(null);
    });
    openDialogs.push(close);
    document.body.appendChild(bd);
    onOpen?.(dg, close);
    const f = dg.querySelector('[autofocus], input:not([type=checkbox]), textarea, select');
    if (f && !matchMedia('(pointer: coarse)').matches) f.focus();
  });
}

export async function confirmDialog(title, message, { ok = 'はい', danger = false } = {}) {
  const v = await dialog({
    title,
    body: `<p style="margin:0;line-height:1.6">${message}</p>`,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: ok, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

export async function promptDialog(title, { label = '', value = '', placeholder = '', ok = '決定', help = '' } = {}) {
  let input;
  const v = await dialog({
    title,
    body: `<div class="field">${label ? `<label>${esc(label)}</label>` : ''}<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}">${help ? `<div class="help">${help}</div>` : ''}</div>`,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: ok, value: 'ok', kind: 'primary' },
    ],
    onOpen: (d) => {
      input = d.querySelector('input');
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    },
  });
  return v === 'ok' ? input.value : null;
}

// ---- メニュー
let curMenu = null;
export function closeMenu() {
  curMenu?.remove();
  curMenu = null;
}
/**
 * @param anchor 要素か {x,y}
 * @param items [{label, icon, key, fn, danger, sep, disabled}]
 */
export function menu(anchor, items) {
  closeMenu();
  const m = el('<div class="menu" role="menu"></div>');
  for (const it of items) {
    if (!it) continue;
    if (it.sep) {
      m.appendChild(el('<hr>'));
      continue;
    }
    const b = el(
      `<button role="menuitem" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled style="opacity:.4"' : ''}>${it.dot ? `<span class="dot" style="--c:${it.dot}"></span>` : icon(it.icon || 'chevron-right', it.icon ? '' : 'hidden')}<span>${esc(it.label)}</span>${it.key ? `<span class="key">${esc(keyLabel(it.key))}</span>` : ''}</button>`
    );
    b.onclick = (e) => {
      e.stopPropagation();
      closeMenu();
      it.fn?.();
    };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let x = Math.min(r.left, innerWidth - mw - 8);
  if (anchor instanceof Element && r.right - mw > 8 && r.left + mw > innerWidth - 8) x = r.right - mw;
  let y = r.bottom + 6;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  m.style.left = `${Math.max(8, x)}px`;
  m.style.top = `${y}px`;
  curMenu = m;
  setTimeout(() => {
    const off = (e) => {
      if (!m.contains(e.target)) {
        closeMenu();
        document.removeEventListener('pointerdown', off, true);
      }
    };
    document.addEventListener('pointerdown', off, true);
  }, 0);
  m.querySelector('button')?.focus({ preventScroll: true });
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('button')];
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') bs[(i + 1) % bs.length].focus(), e.preventDefault();
    if (e.key === 'ArrowUp') bs[(i - 1 + bs.length) % bs.length].focus(), e.preventDefault();
    if (e.key === 'Escape') closeMenu();
  });
}

export function seg(name, options, value) {
  return `<div class="seg" data-seg="${esc(name)}">${options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
}

/** .seg の切りかえを有効にする */
export function wireSeg(root, name, fn) {
  const s = root.querySelector(`[data-seg="${name}"]`);
  if (!s) return;
  s.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    fn(b.dataset.v);
  });
}

export function switchHtml(id, checked) {
  return `<label class="switch"><input type="checkbox" id="${esc(id)}" ${checked ? 'checked' : ''}><span></span></label>`;
}

export function options(list, value) {
  return list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

export function busy(msg) {
  const bd = el(`<div class="backdrop"><div class="dialog" style="width:min(360px,100vw - 40px)"><div class="row"><b class="grow" id="busyMsg">${esc(msg)}</b></div><div class="progress"><i style="width:30%"></i></div></div></div>`);
  document.body.appendChild(bd);
  let p = 30;
  const t = setInterval(() => {
    p = Math.min(95, p + (95 - p) * 0.08);
    bd.querySelector('.progress i').style.width = `${p}%`;
  }, 200);
  return {
    set: (m) => (bd.querySelector('#busyMsg').textContent = m),
    done: () => {
      clearInterval(t);
      bd.remove();
    },
  };
}
