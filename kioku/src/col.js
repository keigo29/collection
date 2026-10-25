// すべてのデータ（デッキ・ノート・カード・記録）を持つところ。
// 変更はメモリに入れてから少しまとめて IndexedDB に書く。transact でまとめた変更は元に戻せる。
import * as db from './db.js';
import { STOCK_TYPES, STOCK_ORDER, defaultPreset, defaultConf } from './stock.js';
import { cardOrds } from './template.js';
import { newId, guid, dayNumber, dayStartMs, debounce, mimeOf, stripHtml } from './util.js';
import { Q_SIB_BURIED, Q_BURIED, Q_NEW, Q_LRN, Q_REV, Q_DAYLRN } from './sched/answer.js';

const MAP_STORES = ['decks', 'presets', 'notetypes', 'notes', 'cards', 'revlog', 'graves', 'mediaMeta', 'meta'];
const keyOf = (store, id) => `${store}\u0000${id}`;
const idKey = (store) => (store === 'mediaMeta' ? 'name' : 'id');

export class Collection {
  constructor() {
    for (const s of MAP_STORES) this[s] = new Map();
    this.conf = defaultConf();
    this.undoStack = [];
    this.tx = null;
    this.dirty = new Map();
    this.version = 0;
    this.listeners = new Set();
    this.caches = new Map();
    this.flushSoon = debounce(() => this.flush(), 400);
  }

  async load() {
    for (const s of MAP_STORES) {
      const rows = await db.getAll(s);
      const m = this[s];
      m.clear();
      for (const r of rows) m.set(r[idKey(s)], r);
    }
    const conf = this.meta.get('conf');
    this.conf = { ...defaultConf(), ...(conf || {}) };
    if (!this.decks.size) this.init();
    this.checkDay();
    this.version++;
  }

  /** はじめて開いたとき */
  init() {
    this.transact(null, () => {
      const pid = 1;
      this.put('presets', { id: pid, ...defaultPreset() });
      this.put('decks', { id: 1, name: 'デフォルト', presetId: pid, desc: '' });
      let t = 1;
      for (const k of STOCK_ORDER) this.put('notetypes', { id: t++, stock: k, ...STOCK_TYPES[k]() });
      this.conf.addType = 1;
      this.conf.addDeck = 1;
      this.saveConf();
    });
    this.undoStack = [];
  }

  // ---- 変更の受け口
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn();
  }

  track(store, id) {
    if (!this.tx) return;
    const k = keyOf(store, id);
    if (this.tx.before.has(k)) return;
    const cur = this[store].get(id);
    this.tx.before.set(k, { store, id, val: cur ? structuredClone(cur) : null });
  }

  put(store, obj, { keepMod = false } = {}) {
    const id = obj[idKey(store)];
    this.track(store, id);
    if (!keepMod) obj.mod = Date.now();
    this[store].set(id, obj);
    this.dirty.set(keyOf(store, id), { store, id });
    this.caches.clear();
    if (store !== 'graves' && store !== 'revlog') {
      const gk = `${store}:${id}`;
      if (this.graves.has(gk)) this.delRaw('graves', gk);
    }
    if (!this.tx) this.changed();
    return obj;
  }

  delRaw(store, id) {
    this.track(store, id);
    this[store].delete(id);
    this.dirty.set(keyOf(store, id), { store, id });
    this.caches.clear();
  }

  remove(store, id) {
    if (!this[store].has(id)) return;
    this.delRaw(store, id);
    const gk = `${store}:${id}`;
    this.track('graves', gk);
    this.graves.set(gk, { id: gk, store, rid: id, at: Date.now() });
    this.dirty.set(keyOf('graves', gk), { store: 'graves', id: gk });
    if (!this.tx) this.changed();
  }

  changed() {
    this.version++;
    this.caches.clear();
    this.flushSoon();
    this.emit();
  }

  /** まとめて変更する。label を付けると「元に戻す」で戻せる */
  transact(label, fn) {
    if (this.tx) return fn();
    this.tx = { label, before: new Map() };
    let r;
    try {
      r = fn();
    } finally {
      const tx = this.tx;
      this.tx = null;
      if (label && tx.before.size) {
        this.undoStack.push(tx);
        if (this.undoStack.length > 40) this.undoStack.shift();
      }
      if (tx.before.size) this.changed();
    }
    return r;
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label || null;
  }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    for (const { store, id, val } of tx.before.values()) {
      // 同期でほかの端末に負けないよう、戻したものは新しい時刻にする
      if (val && store !== 'revlog' && store !== 'graves') val.mod = Date.now();
      if (val) this[store].set(id, val);
      else this[store].delete(id);
      this.dirty.set(keyOf(store, id), { store, id });
    }
    if (tx.before.has(keyOf('meta', 'conf'))) this.conf = { ...defaultConf(), ...this.meta.get('conf') };
    this.changed();
    return tx.label;
  }

  async flush() {
    if (!this.dirty.size) return;
    const writes = [];
    for (const { store, id } of this.dirty.values()) writes.push({ store, key: id, value: this[store].get(id) ?? null });
    this.dirty.clear();
    try {
      await db.writeMany(writes);
    } catch (e) {
      console.error(e);
      for (const w of writes) this.dirty.set(keyOf(w.store, w.key), { store: w.store, id: w.key });
    }
  }

  saveConf() {
    this.conf.id = 'conf';
    this.put('meta', this.conf);
  }

  setConf(patch) {
    Object.assign(this.conf, patch);
    this.saveConf();
  }

  cache(name, fn) {
    if (!this.caches.has(name)) this.caches.set(name, fn());
    return this.caches.get(name);
  }

  // ---- 日付
  today(now = Date.now()) {
    return dayNumber(now, this.conf.rollover);
  }
  dayStart(day = this.today()) {
    return dayStartMs(day, this.conf.rollover);
  }
  dayCutoff() {
    return this.dayStart(this.today() + 1);
  }

  /** 日がかわったら、あとまわしにしたカードを戻す */
  checkDay() {
    const today = this.today();
    if (this.conf.lastDay === today) return false;
    this.transact(null, () => {
      for (const c of this.cards.values()) {
        if ((c.queue === Q_SIB_BURIED || c.queue === Q_BURIED) && (c.buriedDay ?? 0) < today) this.restoreQueue(c);
      }
      this.conf.lastDay = today;
      if (this.conf.extend && this.conf.extend.day !== today) this.conf.extend = null;
      this.saveConf();
    });
    return true;
  }

  restoreQueue(c) {
    delete c.buriedDay;
    if (c.type === 0) c.queue = Q_NEW;
    else if (c.type === 2) c.queue = Q_REV;
    else c.queue = c.due < 1e9 ? Q_DAYLRN : Q_LRN;
    this.put('cards', c);
  }

  // ---- デッキ
  sortedDecks() {
    return this.cache('sortedDecks', () =>
      [...this.decks.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
    );
  }

  deckByName(name) {
    const n = name.trim().toLowerCase();
    for (const d of this.decks.values()) if (d.name.toLowerCase() === n) return d;
    return null;
  }

  /** 名前のデッキがなければ作る（A::B なら A も） */
  ensureDeck(name, presetId) {
    name = normDeckName(name);
    let d = this.deckByName(name);
    if (d) return d;
    const parts = name.split('::');
    let parent = null;
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('::');
      d = this.deckByName(sub);
      if (!d) {
        d = { id: newId(), name: sub, presetId: presetId ?? parent?.presetId ?? this.defaultPresetId(), desc: '' };
        this.put('decks', d);
      }
      parent = d;
    }
    return d;
  }

  defaultPresetId() {
    return this.presets.has(1) ? 1 : [...this.presets.keys()][0];
  }

  /** 自分と下のデッキの ID */
  deckTreeIds(did) {
    return this.cache(`tree:${did}`, () => {
      const d = this.decks.get(did);
      if (!d) return new Set();
      const pre = d.name.toLowerCase() + '::';
      const out = new Set([did]);
      for (const x of this.decks.values()) if (x.name.toLowerCase().startsWith(pre)) out.add(x.id);
      return out;
    });
  }

  childDecks(did) {
    const d = this.decks.get(did);
    const depth = d ? d.name.split('::').length : 0;
    const pre = d ? d.name.toLowerCase() + '::' : '';
    return this.sortedDecks().filter((x) => {
      const parts = x.name.split('::');
      return parts.length === depth + 1 && (!d || x.name.toLowerCase().startsWith(pre));
    });
  }

  parentDeck(d) {
    const parts = d.name.split('::');
    if (parts.length < 2) return null;
    return this.deckByName(parts.slice(0, -1).join('::'));
  }

  renameDeck(did, newName) {
    newName = normDeckName(newName);
    const d = this.decks.get(did);
    if (!d || !newName) return;
    const clash = this.deckByName(newName);
    if (clash && clash.id !== did) throw new Error('同じ名前のデッキがあります');
    const old = d.name;
    this.transact('デッキの名前を変える', () => {
      const parts = newName.split('::');
      if (parts.length > 1) this.ensureDeck(parts.slice(0, -1).join('::'));
      for (const x of [...this.decks.values()]) {
        if (x.id === did) this.put('decks', { ...x, name: newName });
        else if (x.name.toLowerCase().startsWith(old.toLowerCase() + '::')) this.put('decks', { ...x, name: newName + x.name.slice(old.length) });
      }
    });
  }

  presetFor(did) {
    let d = this.decks.get(did);
    if (d?.filtered) d = null;
    return this.presets.get(d?.presetId) || this.presets.get(this.defaultPresetId()) || { id: 0, ...defaultPreset() };
  }

  /** フィルターのデッキに入っているカードは元のデッキの設定を使う */
  presetForCard(c) {
    return this.presetFor(c.odid || c.did);
  }

  // ---- ノートとカード
  cardsOfNote(nid) {
    return this.cache('cardsByNote', () => {
      const m = new Map();
      for (const c of this.cards.values()) {
        if (!m.has(c.nid)) m.set(c.nid, []);
        m.get(c.nid).push(c);
      }
      return m;
    }).get(nid) || [];
  }

  allTags() {
    return this.cache('tags', () => {
      const m = new Map();
      for (const n of this.notes.values()) for (const t of n.tags) m.set(t.toLowerCase(), t);
      return [...m.values()].sort((a, b) => a.localeCompare(b, 'ja'));
    });
  }

  nextPos() {
    const p = this.conf.nextPos || 1;
    this.conf.nextPos = p + 1;
    this.saveConf();
    return p;
  }

  newCard(nid, did, ord, due) {
    return { id: newId(), nid, did, ord, type: 0, queue: Q_NEW, due, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, flags: 0, odid: 0, odue: 0 };
  }

  /** ノートを足す。できたカードの数を返す */
  addNote(ntid, did, fields, tags = []) {
    const nt = this.notetypes.get(ntid);
    const ords = cardOrds(nt, fields);
    if (!ords.length) throw new Error(nt.kind === 'cloze' ? '{{c1::…}} の穴うめがありません' : '表になる項目が空です');
    return this.transact('ノートの追加', () => {
      const now = Date.now();
      const note = { id: newId(), guid: guid(), ntid, fields: [...fields], tags: normTags(tags), created: now };
      this.put('notes', note);
      const preset = this.presetFor(did);
      const due = preset.insertOrder === 'random' ? Math.floor(Math.random() * 1e6) : this.nextPos();
      for (const ord of ords) {
        const tdid = nt.kind === 'std' && nt.templates[ord]?.deck && this.decks.has(nt.templates[ord].deck) ? nt.templates[ord].deck : did;
        this.put('cards', this.newCard(note.id, tdid, ord, due));
      }
      return { note, count: ords.length };
    });
  }

  /** ノートを書きかえ、新しくできるカードを足す */
  updateNote(note) {
    this.transact('ノートの編集', () => {
      note.tags = normTags(note.tags);
      this.put('notes', note);
      this.genCards(note);
    });
  }

  genCards(note, did) {
    const nt = this.notetypes.get(note.ntid);
    const have = new Set(this.cardsOfNote(note.id).map((c) => c.ord));
    const ords = cardOrds(nt, note.fields).filter((o) => !have.has(o));
    if (!ords.length) return 0;
    const sib = this.cardsOfNote(note.id)[0];
    const home = did ?? (sib ? sib.odid || sib.did : this.conf.addDeck || 1);
    const due = sib && sib.type === 0 ? sib.due : this.nextPos();
    for (const ord of ords) this.put('cards', this.newCard(note.id, home, ord, due));
    return ords.length;
  }

  deleteNotes(nids) {
    this.transact('ノートの削除', () => {
      for (const nid of nids) {
        for (const c of this.cardsOfNote(nid)) this.remove('cards', c.id);
        this.remove('notes', nid);
      }
    });
  }

  deleteCards(cids) {
    this.transact('カードの削除', () => {
      const touched = new Set();
      for (const cid of cids) {
        const c = this.cards.get(cid);
        if (!c) continue;
        touched.add(c.nid);
        this.remove('cards', cid);
      }
      for (const nid of touched) if (!this.cardsOfNote(nid).length) this.remove('notes', nid);
    });
  }

  sortField(note) {
    const nt = this.notetypes.get(note.ntid);
    return stripHtml(note.fields[nt?.sortIdx ?? 0] ?? '').replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1');
  }

  // ---- 記録
  addRevlog(entry) {
    const e = { id: newId(), at: Date.now(), ...entry };
    this.put('revlog', e, { keepMod: true });
    return e;
  }

  revlogOf(cid) {
    return [...this.revlog.values()].filter((r) => r.cid === cid).sort((a, b) => a.at - b.at);
  }

  // ---- 画像や音
  async addMedia(file, preferName) {
    let name = (preferName || file.name || 'file').replace(/[\\/:*?"<>|#]/g, '_');
    if (!/\.[a-z0-9]+$/i.test(name)) {
      const ext = (file.type || '').split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'bin';
      name += '.' + ext;
    }
    const ex = this.mediaMeta.get(name);
    if (ex) {
      if (ex.size === file.size) return name;
      const dot = name.lastIndexOf('.');
      name = `${name.slice(0, dot)}-${Date.now().toString(36)}${name.slice(dot)}`;
    }
    const type = file.type || mimeOf(name);
    await db.writeMany([{ store: 'mediaBlobs', key: name, value: { name, blob: file instanceof Blob ? file : new Blob([file], { type }) } }]);
    this.put('mediaMeta', { name, type, size: file.size });
    return name;
  }

  async mediaBlob(name) {
    const r = await db.get('mediaBlobs', name);
    return r?.blob || null;
  }

  async removeMedia(name) {
    this.remove('mediaMeta', name);
    await db.writeMany([{ store: 'mediaBlobs', key: name, value: null }]);
  }

  // ---- 書き出しと読み込み（同期・バックアップで使う）
  snapshot() {
    const out = { v: 1 };
    for (const s of MAP_STORES) out[s] = [...this[s].values()];
    return out;
  }

  /** 全部入れかえる */
  async replaceAll(data) {
    await this.flush();
    await db.clearStores(MAP_STORES);
    for (const s of MAP_STORES) {
      this[s].clear();
      for (const r of data[s] || []) this[s].set(r[idKey(s)], r);
    }
    this.conf = { ...defaultConf(), ...(this.meta.get('conf') || {}) };
    if (!this.decks.size) this.init();
    const writes = [];
    for (const s of MAP_STORES) for (const r of this[s].values()) writes.push({ store: s, key: r[idKey(s)], value: r });
    for (let i = 0; i < writes.length; i += 5000) await db.writeMany(writes.slice(i, i + 5000));
    this.undoStack = [];
    this.dirty.clear();
    this.checkDay();
    this.changed();
  }
}

export function normDeckName(name) {
  return String(name)
    .split('::')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('::');
}

export function normTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of (Array.isArray(tags) ? tags : String(tags).split(/\s+/)).map((x) => x.trim().replace(/\s+/g, '_')).filter(Boolean)) {
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

export const col = new Collection();
