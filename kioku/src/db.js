// IndexedDB をうすく包む

export const STORES = ['decks', 'presets', 'notetypes', 'notes', 'cards', 'revlog', 'graves', 'mediaMeta', 'meta'];
const EXTRA = ['mediaBlobs', 'backups'];

let dbp = null;

export function openDb(name = 'kioku') {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of [...STORES, ...EXTRA]) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'mediaBlobs' ? 'name' : s === 'mediaMeta' ? 'name' : 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function get(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** writes: [{store, key, value|null}] — value が null なら消す */
export async function writeMany(writes) {
  if (!writes.length) return;
  const db = await openDb();
  const stores = [...new Set(writes.map((w) => w.store))];
  const tx = db.transaction(stores, 'readwrite');
  for (const w of writes) {
    const os = tx.objectStore(w.store);
    if (w.value == null) os.delete(w.key);
    else os.put(w.value);
  }
  return done(tx);
}

export async function clearStores(stores) {
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  return done(tx);
}
