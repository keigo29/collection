// 小さな共通の道具

let lastId = 0;
/** 端末をまたいでもほぼ重ならない数値の ID（ミリ秒 × 1000 + 乱数） */
export function newId() {
  let id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  if (id <= lastId) id = lastId + 1;
  lastId = id;
  return id;
}

export function guid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 10);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** HTML を文字だけにする */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/div>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[sound:[^\]]+\]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export const DAY = 86400000;

/** 日付の番号（1970-01-01 からの日数）。切り替えの時刻（rollover 時）をまたいで次の日になる */
export function dayNumber(ms, rollover = 4) {
  const d = new Date(ms - rollover * 3600000);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/** その日が始まる時刻（ミリ秒） */
export function dayStartMs(day, rollover = 4) {
  const d = new Date(day * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), rollover).getTime();
}

export function dayToDate(day) {
  const d = new Date(day * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDay(day) {
  return fmtDate(dayToDate(day).getTime());
}

/** 秒を「10分」「3日」「1.5か月」のような短い言葉にする */
export function fmtSpan(secs, { short = true } = {}) {
  secs = Math.max(0, secs);
  const u = [
    [60, '秒', 1],
    [3600, '分', 60],
    [86400, '時間', 3600],
    [86400 * 30, '日', 86400],
    [86400 * 365, 'か月', 86400 * 30],
    [Infinity, '年', 86400 * 365],
  ];
  for (const [lim, name, div] of u) {
    if (secs < lim) {
      const v = secs / div;
      const s = v >= 10 || Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : Math.round(v * 10) / 10;
      return short ? `${s}${name}` : `${s} ${name}`;
    }
  }
  return '';
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}

export function debounce(fn, ms) {
  let t;
  const f = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  f.flush = () => {
    clearTimeout(t);
    fn();
  };
  return f;
}

export function shuffle(arr, rnd = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 同じ種からは同じ乱数（間隔のゆらぎを予告と本番でそろえるため） */
export function seeded(seed) {
  let s = (Math.abs(Math.floor(seed)) % 2147483647) || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** ⌘⇧⌥ を Windows では Ctrl・Shift・Alt に読みかえる */
export function keyLabel(s) {
  if (isMac()) return s;
  return s.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+');
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    i.onchange = () => resolve(multiple ? [...i.files] : i.files[0] || null);
    i.click();
  });
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function mimeOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return (
    {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
      mp4: 'video/mp4', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    }[ext] || 'application/octet-stream'
  );
}

export function plural(n) {
  return n.toLocaleString('ja-JP');
}
