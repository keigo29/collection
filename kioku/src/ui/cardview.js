// カードの中身を影の DOM（ほかの CSS と混ざらない箱）に出す
import { col } from '../col.js';
import katexCssUrl from 'katex/dist/katex.min.css?url';

const urlCache = new Map();
export async function mediaUrl(name) {
  if (urlCache.has(name)) return urlCache.get(name);
  const blob = await col.mediaBlob(name);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urlCache.set(name, u);
  return u;
}

const BASE_CSS = `
:host { display:block; color: var(--text); }
.card { font-family: var(--font); color: inherit; background: transparent; overflow-wrap: anywhere; }
.card.nightMode, .nightMode .card { color: var(--text) !important; background: transparent !important; }
img { max-width: 100%; height: auto; border-radius: 6px; }
hr#answer, hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
.cloze { font-weight: 700; color: var(--cloze); }
.cloze-inactive { }
details.hint { display:inline-block; }
details.hint summary { cursor:pointer; color: var(--sub); font-size: 14px; list-style: none; text-decoration: underline; }
#typeans { font-family: var(--mono); font-size: 18px; }
input#typeans { width: min(100%, 460px); height: 46px; border-radius: 14px; border: 2px solid transparent; background: var(--soft); padding: 0 14px; outline: none; color: var(--text); margin-top: 12px; text-align: center; }
input#typeans:focus { border-color: var(--accent); }
code#typeans { display:inline-block; text-align:center; line-height: 1.6; }
.typeGood { background: var(--ok-soft); color: var(--ok-text); }
.typeBad { background: var(--danger-soft); color: var(--danger); }
.typeMissed { background: var(--soft); color: var(--sub); }
.replay { display:inline-grid; place-items:center; width:34px; height:34px; border-radius:999px; border:0; background: var(--soft); color: var(--text); cursor:pointer; vertical-align: middle; margin: 2px 4px; }
.replay svg { width:16px; height:16px; }
.tts-text { }
.tmpl-missing { color: var(--danger); font-size: 13px; }
.io-wrap { position: relative; display: inline-block; max-width: 100%; line-height: 0; }
.io-wrap img { display:block; max-width:100%; border-radius: 0; }
.io-svg { position:absolute; inset:0; width:100%; height:100%; }
.io-shape { stroke-width: 2px; }
.io-active { fill: var(--focus, #ff5a00); stroke: #fff; }
.io-inactive { fill: #ffeba2; stroke: #212121; }
.io-revealed { fill: transparent; stroke: var(--focus, #ff5a00); stroke-dasharray: 6 4; }
ruby rt { font-size: .5em; }
table { border-collapse: collapse; margin: 0 auto; }
td, th { border: 1px solid var(--line); padding: 4px 8px; }
pre, code { font-family: var(--mono); }
`;

const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

/** 動いてしまう書き方（script・on〜 など）を取り除く */
export function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const walk = (node) => {
    for (const ch of [...node.children]) {
      const tag = ch.tagName.toLowerCase();
      if (['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'].includes(tag)) {
        ch.remove();
        continue;
      }
      for (const a of [...ch.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on')) ch.removeAttribute(a.name);
        else if ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action') && /^\s*javascript:/i.test(a.value)) ch.removeAttribute(a.name);
      }
      walk(ch);
    }
  };
  walk(t.content);
  return t.innerHTML;
}

function soundsToButtons(html, list) {
  return html
    .replace(/\[sound:([^\]]+)\]/g, (_, name) => {
      list.push({ kind: 'file', name });
      return `<button class="replay" data-i="${list.length - 1}" title="もう一度聞く">${PLAY_SVG}</button>`;
    })
    .replace(/\[anki:tts lang=([^\s\]]+) speed=([\d.]+)\]([\s\S]*?)\[\/anki:tts\]/g, (_, lang, speed, text) => {
      list.push({ kind: 'tts', lang, speed: Number(speed), text: text.replace(/<[^>]+>/g, '') });
      return `<span class="tts-text">${text}</span><button class="replay" data-i="${list.length - 1}" title="読み上げる">${PLAY_SVG}</button>`;
    });
}

let katexMod = null;
async function renderMath(root) {
  const html = root.innerHTML;
  if (!/\\\(|\\\[/.test(html)) return;
  if (!katexMod) {
    katexMod = (await import('katex')).default;
    if (!document.querySelector('link[data-katex]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = katexCssUrl;
      l.dataset.katex = '1';
      document.head.appendChild(l);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) if (/\\\(|\\\[/.test(walker.currentNode.nodeValue)) texts.push(walker.currentNode);
  // 区切りがまたがることもあるので、要素の中身ごと処理する
  const parents = new Set(texts.map((t) => t.parentElement));
  for (const p of parents) {
    p.innerHTML = p.innerHTML.replace(/\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g, (m, inl, disp) => {
      try {
        const src = (inl ?? disp).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<br\s*\/?>/g, ' ');
        return katexMod.renderToString(src, { displayMode: disp != null, throwOnError: false });
      } catch {
        return m;
      }
    });
  }
}

let audio = null;
let playToken = 0;
export function stopAudio() {
  playToken++;
  if (audio) {
    audio.pause();
    audio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

async function playOne(s) {
  if (s.kind === 'tts') {
    if (!('speechSynthesis' in window)) return;
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(s.text);
      u.lang = s.lang;
      u.rate = s.speed || 1;
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
    });
    return;
  }
  const url = await mediaUrl(s.name);
  if (!url) return;
  await new Promise((resolve) => {
    audio = new Audio(url);
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
}

export async function playSounds(list) {
  stopAudio();
  const token = playToken;
  for (const s of list) {
    if (token !== playToken) return;
    await playOne(s);
  }
}

/**
 * host に描く
 * @returns {{root, sounds, typeInput, ready:Promise}}
 */
export function renderInto(host, html, css = '', { night = false } = {}) {
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const sounds = [];
  const body = sanitize(soundsToButtons(html, sounds));
  root.innerHTML = `<link rel="stylesheet" href="${katexCssUrl}"><style>${BASE_CSS}\n${css}</style><div class="card ${night ? 'nightMode night_mode' : ''}">${body}</div>`;
  const wrap = root.querySelector('.card');
  root.onclick = (e) => {
    const b = e.target.closest('.replay');
    if (b) {
      e.stopPropagation();
      playSounds([sounds[Number(b.dataset.i)]]);
    }
  };
  const ready = (async () => {
    const imgs = [...root.querySelectorAll('img[src]')];
    await Promise.all(
      imgs.map(async (img) => {
        const src = img.getAttribute('src');
        if (/^(https?:|data:|blob:)/i.test(src)) return;
        const u = await mediaUrl(decodeURIComponent(src));
        if (u) img.src = u;
      })
    );
    try {
      await renderMath(wrap);
    } catch (e) {
      console.warn(e);
    }
  })();
  return { root, sounds, typeInput: root.querySelector('#typeans'), ready };
}

export function isNight() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
