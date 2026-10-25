// まるごとのバックアップ（.kioku ファイル）と、自動で残す控え
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import * as db from '../db.js';
import { mimeOf } from '../util.js';

export async function makeBackup(col, { withMedia = true } = {}) {
  await col.flush();
  const files = { 'collection.json': strToU8(JSON.stringify(col.snapshot())) };
  if (withMedia) {
    for (const name of col.mediaMeta.keys()) {
      const blob = await col.mediaBlob(name);
      if (blob) files[`media/${name}`] = new Uint8Array(await blob.arrayBuffer());
    }
  }
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}

export async function restoreBackup(col, file) {
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!zip['collection.json']) throw new Error('KIOKU のバックアップではないようです');
  const data = JSON.parse(strFromU8(zip['collection.json']));
  const writes = [];
  for (const [path, bytes] of Object.entries(zip)) {
    if (!path.startsWith('media/') || path === 'media/') continue;
    const name = path.slice(6);
    writes.push({ store: 'mediaBlobs', key: name, value: { name, blob: new Blob([bytes], { type: mimeOf(name) }) } });
  }
  await db.clearStores(['mediaBlobs']);
  for (let i = 0; i < writes.length; i += 200) await db.writeMany(writes.slice(i, i + 200));
  await col.replaceAll(data);
}

const KEEP = 7;

/** 1日に1回、この端末の中に控えを残す（画像や音は入れない） */
export async function autoBackup(col) {
  const today = col.today();
  const list = (await db.getAll('backups')).sort((a, b) => b.at - a.at);
  if (list[0]?.day === today) return false;
  if (!col.cards.size && !col.notes.size) return false;
  await db.writeMany([{ store: 'backups', key: Date.now(), value: { id: Date.now(), at: Date.now(), day: today, cards: col.cards.size, notes: col.notes.size, data: JSON.stringify(col.snapshot()) } }]);
  const old = list.slice(KEEP - 1);
  await db.writeMany(old.map((b) => ({ store: 'backups', key: b.id, value: null })));
  return true;
}

export async function listBackups() {
  return (await db.getAll('backups')).sort((a, b) => b.at - a.at).map(({ id, at, cards, notes }) => ({ id, at, cards, notes }));
}

export async function restoreAuto(col, id) {
  const b = await db.get('backups', id);
  if (!b) throw new Error('控えが見つかりません');
  await col.replaceAll(JSON.parse(b.data));
}
