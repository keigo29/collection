// GitHub の Gist（ひみつのメモ置き場）を使った同期。サーバーを持たないので費用はかからない。
// データは gzip して1つのファイルに、画像や音は 16 個のファイルに分けて置く。
import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { blobToBase64, base64ToBytes } from './util.js';
import * as db from './db.js';

const MAIN = 'kioku-collection.json.gz.b64';
const BUCKETS = 16;
const API = 'https://api.github.com';
const KEY = 'kioku.sync';

const keyField = (store) => (store === 'mediaMeta' ? 'name' : 'id');

export function syncSettings() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveSyncSettings(patch) {
  const s = { ...syncSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 保存できない環境 */
  }
  return s;
}

/** 2つの書き出しをまぜる。新しいほうが勝ち、消した記録（graves）より古いものは消す */
export function mergeSnapshots(a, b) {
  const out = { v: 1 };
  const stores = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => Array.isArray(a[k]) || Array.isArray(b[k])));
  const graves = new Map();
  for (const g of [...(a.graves || []), ...(b.graves || [])]) {
    const ex = graves.get(g.id);
    if (!ex || g.at > ex.at) graves.set(g.id, g);
  }
  out.graves = [...graves.values()];
  for (const s of stores) {
    if (s === 'graves') continue;
    const kf = keyField(s);
    const m = new Map();
    for (const r of a[s] || []) m.set(r[kf], r);
    for (const r of b[s] || []) {
      const ex = m.get(r[kf]);
      if (!ex || (s !== 'revlog' && (r.mod || 0) > (ex.mod || 0))) m.set(r[kf], r);
    }
    for (const [k, r] of m) {
      const g = graves.get(`${s}:${k}`);
      if (g && g.at >= (r.mod || 0)) m.delete(k);
    }
    out[s] = [...m.values()];
  }
  return out;
}

function bucketOf(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `kioku-media-${h % BUCKETS}.json`;
}

async function gh(token, path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (r.status === 401) throw new Error('鍵（トークン）が正しくありません');
  if (r.status === 404) throw new Error('Gist が見つかりません。鍵に gist の権限があるか確かめてください');
  if (!r.ok) throw new Error(`GitHub から ${r.status} が返りました`);
  return r.json();
}

async function fileText(token, file) {
  if (!file) return null;
  if (!file.truncated) return file.content;
  const r = await fetch(file.raw_url);
  if (!r.ok) throw new Error('大きなファイルを読めませんでした');
  return r.text();
}

const pack = (obj) => {
  const bytes = gzipSync(strToU8(JSON.stringify(obj)), { level: 6 });
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unpack = (text) => JSON.parse(strFromU8(gunzipSync(base64ToBytes(text.trim()))));

/** 鍵を確かめて、Gist がなければ作る */
export async function connect(token) {
  const user = await gh(token, '/user');
  let gistId = null;
  // 前に作ったものがあれば使う
  for (let page = 1; page <= 5 && !gistId; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[MAIN]);
    if (hit) gistId = hit.id;
    if (list.length < 100) break;
  }
  if (!gistId) {
    const g = await gh(token, '/gists', {
      method: 'POST',
      body: JSON.stringify({ public: false, description: 'KIOKU（暗記アプリ）の同期データ', files: { [MAIN]: { content: pack({ v: 1 }) } } }),
    });
    gistId = g.id;
  }
  return saveSyncSettings({ token, gistId, login: user.login });
}

let running = null;

/**
 * @param mode 'merge' | 'upload'（この端末で上書き） | 'download'（Gist で上書き）
 */
export function sync(col, mode = 'merge', onStep = () => {}) {
  if (running) return running;
  running = doSync(col, mode, onStep).finally(() => (running = null));
  return running;
}

async function doSync(col, mode, onStep) {
  const st = syncSettings();
  if (!st.token || !st.gistId) throw new Error('まだ同期の設定をしていません');
  await col.flush();
  onStep('Gist を読んでいます');
  const gist = await gh(st.token, `/gists/${st.gistId}`);
  const text = await fileText(st.token, gist.files[MAIN]);
  const remote = text ? unpack(text) : { v: 1 };
  const remoteIndex = remote.mediaIndex || {};
  delete remote.mediaIndex;
  const local = col.snapshot();
  let merged;
  if (mode === 'upload') merged = local;
  else if (mode === 'download') merged = remote.decks?.length ? remote : local;
  else merged = mergeSnapshots(local, remote);

  onStep('この端末に入れています');
  if (mode === 'download') await col.replaceAll(merged);
  else applyMerged(col, local, merged);

  // ---- 画像や音
  const files = {};
  const bucketCache = new Map();
  const loadBucket = async (b) => {
    if (!bucketCache.has(b)) {
      const t = await fileText(st.token, gist.files[b]);
      bucketCache.set(b, t ? JSON.parse(t) : {});
    }
    return bucketCache.get(b);
  };
  const names = new Set((merged.mediaMeta || []).map((m) => m.name));
  // ない画像をもらう
  for (const name of names) {
    if (!remoteIndex[name]) continue;
    const have = await db.get('mediaBlobs', name);
    if (have) continue;
    onStep(`画像や音をもらっています（${name}）`);
    const bucket = await loadBucket(remoteIndex[name]);
    const ent = bucket[name];
    if (ent) await db.writeMany([{ store: 'mediaBlobs', key: name, value: { name, blob: new Blob([base64ToBytes(ent.b64)], { type: ent.type }) } }]);
  }
  // Gist にない画像を送る・消したものを外す
  const newIndex = {};
  const touched = new Set();
  for (const name of names) {
    if (remoteIndex[name] && mode !== 'upload') {
      newIndex[name] = remoteIndex[name];
      continue;
    }
    const rec = await db.get('mediaBlobs', name);
    if (!rec) continue;
    const b = bucketOf(name);
    onStep(`画像や音を送っています（${name}）`);
    const bucket = await loadBucket(b);
    bucket[name] = { type: rec.blob.type, b64: await blobToBase64(rec.blob) };
    newIndex[name] = b;
    touched.add(b);
  }
  for (const [name, b] of Object.entries(remoteIndex)) {
    if (names.has(name)) continue;
    const bucket = await loadBucket(b);
    delete bucket[name];
    touched.add(b);
  }
  for (const b of touched) files[b] = { content: JSON.stringify(bucketCache.get(b)) };

  onStep('Gist に書いています');
  const out = { ...col.snapshot(), mediaIndex: newIndex };
  files[MAIN] = { content: pack(out) };
  await gh(st.token, `/gists/${st.gistId}`, { method: 'PATCH', body: JSON.stringify({ files }) });
  saveSyncSettings({ lastSync: Date.now() });
  return { ok: true };
}

/** まぜた結果と、この端末のちがうところだけ書きかえる */
function applyMerged(col, local, merged) {
  for (const s of Object.keys(merged)) {
    if (!Array.isArray(merged[s])) continue;
    const kf = keyField(s);
    const next = new Map(merged[s].map((r) => [r[kf], r]));
    const cur = col[s];
    if (!cur) continue;
    for (const [k, r] of next) {
      const ex = cur.get(k);
      if (!ex || (ex.mod || 0) !== (r.mod || 0)) {
        cur.set(k, r);
        col.dirty.set(`${s}\u0000${k}`, { store: s, id: k });
      }
    }
    for (const k of [...cur.keys()]) {
      if (!next.has(k)) {
        cur.delete(k);
        col.dirty.set(`${s}\u0000${k}`, { store: s, id: k });
      }
    }
  }
  const conf = col.meta.get('conf');
  if (conf) col.conf = { ...col.conf, ...conf };
  col.undoStack = [];
  col.checkDay();
  col.changed();
}
