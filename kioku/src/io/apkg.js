// Anki のファイル（.apkg / .colpkg）の読み込みと書き出し
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { unzipSync, zipSync } from 'fflate';
import { decompress as zstd } from 'fzstd';
import { newId, guid as mkGuid, dayNumber, stripHtml, mimeOf } from '../util.js';
import { normDeckName, normTags } from '../col.js';
import { defaultPreset, STOCK_TYPES } from '../stock.js';
import * as db from '../db.js';

let SQL = null;
async function sql() {
  if (!SQL) SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SQL;
}

// ---- 小さな protobuf の読み取り
function readVarint(buf, pos) {
  let x = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos++];
    x |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [x, pos];
}

function pb(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wt = Number(key & 7n);
    let v;
    if (wt === 0) {
      [v, pos] = readVarint(buf, pos);
      v = Number(v);
    } else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      v = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
    } else if (wt === 5) {
      v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
      pos += 4;
    } else if (wt === 1) {
      v = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true);
      pos += 8;
    } else break;
    (out[field] ||= []).push(v);
  }
  return out;
}
const td = new TextDecoder();
const pbStr = (m, f) => (m[f]?.[0] instanceof Uint8Array ? td.decode(m[f][0]) : '');
const pbNum = (m, f) => (typeof m[f]?.[0] === 'number' ? m[f][0] : 0);

const isZstd = (b) => b && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
const maybeZstd = (b) => (isZstd(b) ? zstd(b) : b);

function rows(dbh, q) {
  const res = dbh.exec(q);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/**
 * Anki のファイルを読み込む
 * @returns 読み込んだ数の報告
 */
export async function importApkg(col, file, onStep = () => {}) {
  onStep('ファイルを開いています');
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = zip['collection.anki21b'] ? zstd(zip['collection.anki21b']) : zip['collection.anki21'] || zip['collection.anki2'];
  if (!raw) throw new Error('Anki のファイルではないようです');
  const SQLm = await sql();
  const d = new SQLm.Database(raw);
  try {
    return await readCollection(col, d, zip, onStep);
  } finally {
    d.close();
  }
}

async function readCollection(col, d, zip, onStep) {
  const tables = new Set(rows(d, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  const colRow = rows(d, 'SELECT * FROM col')[0];
  const crt = Number(colRow.crt);
  const crtDay = dayNumber(crt * 1000 + 3600000, col.conf.rollover);
  const today = col.today();

  // ---- ノートの種類
  onStep('ノートの種類を読んでいます');
  const types = []; // {ankiId, name, kind, fields, templates, css, sortIdx, stockKind}
  if (tables.has('notetypes')) {
    for (const r of rows(d, 'SELECT id, name, config FROM notetypes')) {
      const c = pb(r.config);
      const fields = rows(d, `SELECT name FROM fields WHERE ntid=${r.id} ORDER BY ord`).map((f) => ({ name: f.name }));
      const templates = rows(d, `SELECT name, config FROM templates WHERE ntid=${r.id} ORDER BY ord`).map((t) => {
        const tc = pb(t.config);
        return { name: t.name, qfmt: pbStr(tc, 1), afmt: pbStr(tc, 2) };
      });
      types.push({ ankiId: Number(r.id), name: r.name, kind: pbNum(c, 1) === 1 ? 'cloze' : 'std', sortIdx: pbNum(c, 2), css: pbStr(c, 3), fields, templates, stockKind: pbNum(c, 9) });
    }
  } else {
    const models = JSON.parse(colRow.models || '{}');
    for (const m of Object.values(models)) {
      types.push({
        ankiId: Number(m.id),
        name: m.name,
        kind: m.type === 1 ? 'cloze' : 'std',
        sortIdx: m.sortf || 0,
        css: m.css || '',
        fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => ({ name: f.name, sticky: !!f.sticky })),
        templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
        stockKind: m.originalStockKind || 0,
      });
    }
  }

  // ---- デッキと設定
  onStep('デッキを読んでいます');
  const decks = new Map(); // ankiId -> {name, desc, filtered, conf}
  const presets = new Map();
  if (tables.has('decks') && !colRow.decks) {
    for (const r of rows(d, 'SELECT id, name, kind FROM decks')) {
      const k = pb(r.kind);
      const normal = k[1]?.[0] ? pb(k[1][0]) : null;
      decks.set(Number(r.id), { name: String(r.name).split('\u001f').join('::'), desc: normal ? pbStr(normal, 4) : '', filtered: !!k[2], conf: normal ? pbNum(normal, 1) : 1 });
    }
  } else {
    for (const dk of Object.values(JSON.parse(colRow.decks || '{}'))) decks.set(Number(dk.id), { name: dk.name, desc: dk.desc || '', filtered: !!dk.dyn, conf: dk.conf || 1 });
    for (const c of Object.values(JSON.parse(colRow.dconf || '{}'))) {
      const p = defaultPreset();
      p.name = c.name;
      if (c.new) {
        p.newPerDay = c.new.perDay ?? p.newPerDay;
        p.learnSteps = c.new.delays ?? p.learnSteps;
        p.graduatingIvl = c.new.ints?.[0] ?? p.graduatingIvl;
        p.easyIvl = c.new.ints?.[1] ?? p.easyIvl;
        p.startEase = (c.new.initialFactor ?? 2500) / 1000;
        p.buryNew = !!c.new.bury;
        p.insertOrder = c.new.order === 0 ? 'random' : 'due';
      }
      if (c.rev) {
        p.revPerDay = c.rev.perDay ?? p.revPerDay;
        p.easyBonus = c.rev.ease4 ?? p.easyBonus;
        p.maxIvl = c.rev.maxIvl ?? p.maxIvl;
        p.hardFactor = c.rev.hardFactor ?? p.hardFactor;
        p.ivlModifier = c.rev.ivlFct ?? p.ivlModifier;
        p.buryRev = !!c.rev.bury;
      }
      if (c.lapse) {
        p.relearnSteps = c.lapse.delays ?? p.relearnSteps;
        p.lapseMult = c.lapse.mult ?? p.lapseMult;
        p.minIvl = c.lapse.minInt ?? p.minIvl;
        p.leechThreshold = c.lapse.leechFails ?? p.leechThreshold;
        p.leechAction = c.lapse.leechAction === 0 ? 'suspend' : 'tag';
      }
      if (c.desiredRetention) p.desiredRetention = c.desiredRetention;
      if (Array.isArray(c.fsrsWeights) && c.fsrsWeights.length >= 19) p.fsrsWeights = c.fsrsWeights;
      presets.set(Number(c.id), p);
    }
  }

  const noteRows = rows(d, 'SELECT id, guid, mid, mod, tags, flds FROM notes');
  const cardRows = rows(d, 'SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards');
  const revRows = rows(d, 'SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog');

  // 古い Anki に「新しい Anki を使ってください」とだけ書いたファイル
  if (noteRows.length === 1 && cardRows.length <= 1 && /update|アップデート|新しいバージョン/i.test(noteRows[0].flds) && !zip['collection.anki21b']) {
    throw new Error('このファイルは新しい形式です。Anki で「旧形式の書き出し」を選んで作り直すか、別のファイルをお使いください');
  }

  // ---- 画像や音
  onStep('画像や音を読んでいます');
  let mediaMap = {};
  if (zip.media) {
    const m = zip.media;
    if (m[0] === 0x7b) mediaMap = JSON.parse(td.decode(m));
    else {
      const entries = pb(maybeZstd(m))[1] || [];
      entries.forEach((e, i) => {
        const me = pb(e);
        const key = me[255] ? String(pbNum(me, 255)) : String(i);
        mediaMap[key] = pbStr(me, 1);
      });
    }
  }
  const mediaRename = new Map();
  const blobWrites = [];
  for (const [k, name] of Object.entries(mediaMap)) {
    const bytes = zip[k];
    if (!bytes || !name) continue;
    const data = maybeZstd(bytes);
    const ex = col.mediaMeta.get(name);
    let finalName = name;
    if (ex && ex.size !== data.length) {
      const dot = name.lastIndexOf('.');
      finalName = dot > 0 ? `${name.slice(0, dot)}-${Date.now().toString(36)}${name.slice(dot)}` : `${name}-${Date.now().toString(36)}`;
      mediaRename.set(name, finalName);
    }
    if (ex && ex.size === data.length) continue;
    const type = mimeOf(finalName);
    blobWrites.push({ store: 'mediaBlobs', key: finalName, value: { name: finalName, blob: new Blob([data], { type }) } });
    col.put('mediaMeta', { name: finalName, type, size: data.length });
  }
  for (let i = 0; i < blobWrites.length; i += 200) await db.writeMany(blobWrites.slice(i, i + 200));
  const fixMedia = (s) => {
    if (!mediaRename.size) return s;
    for (const [a, b] of mediaRename) s = s.split(a).join(b);
    return s;
  };

  onStep('カードを入れています');
  const report = { notes: 0, cards: 0, updated: 0, skipped: 0, types: 0, decks: 0, media: blobWrites.length };
  col.transact('Anki のファイルの読み込み', () => {
    // ノートの種類を合わせる
    const ntMap = new Map();
    for (const t of types) {
      const isIo = t.stockKind === 6 || t.templates.some((x) => /image-occlusion/.test(x.qfmt));
      const found =
        [...col.notetypes.values()].find((x) => x.ankiId === t.ankiId) ||
        [...col.notetypes.values()].find(
          (x) => x.name === t.name && x.fields.map((f) => f.name).join('\u001f') === t.fields.map((f) => f.name).join('\u001f') && x.templates.length === t.templates.length
        );
      if (found) {
        ntMap.set(t.ankiId, found.id);
        continue;
      }
      let nt;
      if (isIo) {
        const io = STOCK_TYPES.io();
        const f = t.fields.map((x) => x.name);
        nt = {
          ...io,
          name: t.name,
          fields: t.fields,
          templates: [
            {
              name: t.templates[0]?.name || io.templates[0].name,
              qfmt: `{{#${f[2] || '見出し'}}}<div class="io-header">{{${f[2] || '見出し'}}}</div>{{/${f[2] || '見出し'}}}\n{{image-occlusion:${f[0]}}}`,
              afmt: `{{#${f[2] || '見出し'}}}<div class="io-header">{{${f[2] || '見出し'}}}</div>{{/${f[2] || '見出し'}}}\n{{image-occlusion:${f[0]}}}\n${f[3] ? `{{#${f[3]}}}<div class="io-extra">{{${f[3]}}}</div>{{/${f[3]}}}` : ''}`,
            },
          ],
        };
      } else {
        nt = { name: t.name, kind: t.kind, fields: t.fields, templates: t.templates, css: fixMedia(t.css), sortIdx: t.sortIdx };
      }
      let name = nt.name;
      let i = 2;
      while ([...col.notetypes.values()].some((x) => x.name === name)) name = `${nt.name} ${i++}`;
      const id = newId();
      col.put('notetypes', { ...nt, name, id, ankiId: t.ankiId });
      ntMap.set(t.ankiId, id);
      report.types++;
    }

    // デッキを合わせる
    const presetMap = new Map();
    const deckMap = new Map();
    const usedDecks = new Set(cardRows.map((c) => Number(c.odid) || Number(c.did)));
    for (const [aid, dk] of decks) {
      if (dk.filtered || !usedDecks.has(aid)) continue;
      const name = normDeckName(dk.name === 'Default' ? 'デフォルト' : dk.name);
      const existed = col.deckByName(name);
      let pid;
      if (presets.has(dk.conf)) {
        if (!presetMap.has(dk.conf)) {
          const p = presets.get(dk.conf);
          const same = [...col.presets.values()].find((x) => x.name === p.name);
          const id = same ? same.id : newId();
          if (!same) col.put('presets', { ...p, id });
          presetMap.set(dk.conf, id);
        }
        pid = presetMap.get(dk.conf);
      }
      const deck = col.ensureDeck(name, pid);
      if (!existed) {
        report.decks++;
        col.put('decks', { ...deck, desc: dk.desc || deck.desc, presetId: pid ?? deck.presetId });
      }
      deckMap.set(aid, deck.id);
    }
    const fallbackDeck = col.ensureDeck('デフォルト').id;

    // ノート
    const byGuid = new Map();
    for (const n of col.notes.values()) if (n.guid) byGuid.set(n.guid, n);
    const noteMap = new Map();
    for (const r of noteRows) {
      const ntid = ntMap.get(Number(r.mid));
      if (!ntid) continue;
      const fields = fixMedia(r.flds).split('\u001f');
      const tags = normTags(String(r.tags || '').trim());
      const ex = byGuid.get(r.guid);
      if (ex) {
        noteMap.set(Number(r.id), { id: ex.id, existing: true });
        if (ex.ntid === ntid && Number(r.mod) * 1000 > (ex.mod || 0) && ex.fields.join('\u001f') !== fields.join('\u001f')) {
          col.put('notes', { ...ex, fields, tags });
          report.updated++;
        } else report.skipped++;
        continue;
      }
      const id = newId();
      col.put('notes', { id, guid: r.guid || mkGuid(), ntid, fields, tags, created: Number(r.id) });
      noteMap.set(Number(r.id), { id, existing: false });
      report.notes++;
    }

    // 記録（カードの最後に答えた時刻のために先に読む）
    const lastRev = new Map();
    for (const r of revRows) {
      const at = Number(r.id);
      if (!lastRev.has(r.cid) || lastRev.get(r.cid) < at) lastRev.set(r.cid, at);
    }

    // カード
    const cardMap = new Map();
    let maxPos = col.conf.nextPos || 1;
    const posBase = maxPos;
    for (const r of cardRows) {
      const nm = noteMap.get(Number(r.nid));
      if (!nm || nm.existing) continue;
      const odid = Number(r.odid);
      const homeA = odid || Number(r.did);
      const did = deckMap.get(homeA) || fallbackDeck;
      let due = Number(r.odid && r.odue ? r.odue : r.due);
      let queue = Number(r.queue);
      const type = Number(r.type);
      if (type === 0) {
        due = posBase + Math.max(0, due);
        maxPos = Math.max(maxPos, due + 1);
      } else if (queue === 2 || queue === 3 || (queue < 0 && (type === 2 || (type !== 0 && due < 1e8)))) {
        due = crtDay + due;
      } else if (queue === 1 || (queue < 0 && due > 1e8)) {
        due = due * 1000;
      }
      if (queue === 4) queue = 1; // プレビュー
      let data = {};
      try {
        data = r.data ? JSON.parse(r.data) : {};
      } catch {
        data = {};
      }
      const c = {
        id: newId(),
        nid: nm.id,
        did,
        ord: Number(r.ord),
        type,
        queue,
        due,
        ivl: Math.max(0, Number(r.ivl)),
        factor: Number(r.factor),
        reps: Number(r.reps),
        lapses: Number(r.lapses),
        left: Number(r.left) % 1000,
        flags: Number(r.flags) & 7,
        odid: 0,
        odue: 0,
        created: Number(r.id),
      };
      if (queue === -2 || queue === -3) c.buriedDay = today;
      if (data.s) {
        c.s = data.s;
        c.d = data.d;
      }
      const lr = lastRev.get(r.id);
      if (lr) c.lastReview = lr;
      col.put('cards', c);
      cardMap.set(Number(r.id), c);
      report.cards++;
    }
    if (maxPos > (col.conf.nextPos || 1)) col.setConf({ nextPos: maxPos });

    // 記録
    const firstSeen = new Set();
    const sortedRev = [...revRows].sort((a, b) => Number(a.id) - Number(b.id));
    for (const r of sortedRev) {
      const c = cardMap.get(Number(r.cid));
      if (!c) continue;
      const type = Number(r.type) > 4 ? 4 : Number(r.type);
      const isFirst = !firstSeen.has(c.id) && type === 0;
      firstSeen.add(c.id);
      col.put(
        'revlog',
        {
          id: newId(),
          at: Number(r.id),
          cid: c.id,
          did: c.did,
          ease: Number(r.ease),
          ivl: Number(r.ivl),
          lastIvl: Number(r.lastIvl),
          factor: Number(r.factor),
          time: Number(r.time),
          type,
          newCard: isFirst,
        },
        { keepMod: true }
      );
    }
  });
  return report;
}

// ---- 書き出し（Anki 2.1 の古い形。今の Anki でも読める）
const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

function ankiDconf(id, p) {
  return {
    id,
    name: p.name,
    mod: 0,
    usn: -1,
    maxTaken: p.maxAnswerSecs || 60,
    autoplay: p.autoplay !== false,
    timer: p.showTimer ? 1 : 0,
    replayq: true,
    dyn: false,
    new: { bury: !!p.buryNew, delays: p.learnSteps, initialFactor: Math.round(p.startEase * 1000), ints: [p.graduatingIvl, p.easyIvl, 0], order: p.insertOrder === 'random' ? 0 : 1, perDay: p.newPerDay },
    rev: { bury: !!p.buryRev, ease4: p.easyBonus, ivlFct: p.ivlModifier, maxIvl: p.maxIvl, perDay: p.revPerDay, hardFactor: p.hardFactor },
    lapse: { delays: p.relearnSteps, leechAction: p.leechAction === 'suspend' ? 0 : 1, leechFails: p.leechThreshold, minInt: p.minIvl, mult: p.lapseMult },
  };
}

async function sha1Int(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

/** cids のカード（とそのノート）を .apkg にする */
export async function exportApkg(col, cids, { withSched = true, withMedia = true } = {}, onStep = () => {}) {
  const SQLm = await sql();
  const d = new SQLm.Database();
  d.run(SCHEMA);
  const cards = cids.map((id) => col.cards.get(id)).filter(Boolean);
  const nids = [...new Set(cards.map((c) => c.nid))];
  const notes = nids.map((id) => col.notes.get(id)).filter(Boolean);
  // ID をミリ秒に（重ならないように）
  const used = new Set();
  const msId = (id, base) => {
    let v = Math.floor((base ?? id / 1000) || Date.now());
    while (used.has(v)) v++;
    used.add(v);
    return v;
  };
  const ntIds = new Map();
  const deckIds = new Map([[null, 1]]);
  const models = {};
  const decksJson = {};
  const dconf = {};
  const now = Math.floor(Date.now() / 1000);
  const deckEntry = (id, name, conf, desc = '') => ({
    id, name, mod: now, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc, dyn: 0, conf, extendNew: 0, extendRev: 0,
  });
  decksJson[1] = deckEntry(1, 'Default', 1);
  dconf[1] = ankiDconf(1, defaultPreset());
  const presetIds = new Map();
  const deckIdFor = (did) => {
    if (deckIds.has(did)) return deckIds.get(did);
    const dk = col.decks.get(did);
    const parts = (dk?.name || 'デフォルト').split('::');
    let id = 1;
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('::');
      const local = col.deckByName(name);
      const key = local?.id ?? name;
      if (deckIds.has(key)) {
        id = deckIds.get(key);
        continue;
      }
      id = msId(local?.id ?? Date.now() * 1000);
      let confId = 1;
      if (local && !local.filtered) {
        const p = col.presetFor(local.id);
        if (!presetIds.has(p.id)) {
          const cid = msId(p.id > 1e12 ? p.id : Date.now() * 1000);
          presetIds.set(p.id, cid);
          dconf[cid] = ankiDconf(cid, p);
        }
        confId = presetIds.get(p.id);
      }
      decksJson[id] = deckEntry(id, name, confId, local?.desc || '');
      deckIds.set(key, id);
    }
    deckIds.set(did, id);
    return id;
  };
  for (const n of notes) {
    if (ntIds.has(n.ntid)) continue;
    const nt = col.notetypes.get(n.ntid);
    const id = nt.ankiId || msId(nt.id > 1e12 ? nt.id : Date.now() * 1000);
    ntIds.set(n.ntid, id);
    models[id] = {
      id, name: nt.name, type: nt.kind === 'std' ? 0 : 1, mod: now, usn: -1, sortf: nt.sortIdx || 0, did: null,
      tmpls: nt.templates.map((t, i) => ({ name: t.name, ord: i, qfmt: t.qfmt, afmt: t.afmt, bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0 })),
      flds: nt.fields.map((f, i) => ({ name: f.name, ord: i, sticky: !!f.sticky, rtl: false, font: 'Arial', size: 20, description: '', plainText: false, collapsed: false, excludeFromSearch: false })),
      css: nt.css || '', latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n', latexPost: '\\end{document}', latexsvg: false,
      req: nt.templates.map((_, i) => [i, 'any', [0]]), tags: [], vers: [],
      ...(nt.kind === 'io' ? { originalStockKind: 6 } : {}),
    };
  }
  onStep('ノートを書いています');
  const nidMap = new Map();
  const stmtN = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const n of notes) {
    const id = msId(n.id, n.created);
    nidMap.set(n.id, id);
    const nt = col.notetypes.get(n.ntid);
    const sfld = stripHtml(n.fields[nt.sortIdx || 0] || '');
    stmtN.run([id, n.guid || mkGuid(), ntIds.get(n.ntid), Math.floor((n.mod || Date.now()) / 1000), -1, n.tags.length ? ` ${n.tags.join(' ')} ` : '', n.fields.join('\u001f'), sfld, await sha1Int(stripHtml(n.fields[0] || '')), 0, '']);
  }
  stmtN.free();
  onStep('カードを書いています');
  const cidMap = new Map();
  const stmtC = d.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const today = col.today();
  for (const c of cards) {
    const id = msId(c.id, c.created);
    cidMap.set(c.id, id);
    const home = c.odid || c.did;
    let { type, queue, due, ivl, factor, reps, lapses, left } = c;
    if (c.odid && c.odue) due = c.odue;
    if (c.oqueue != null && c.odid) queue = c.oqueue;
    if (!withSched) {
      type = 0;
      queue = 0;
      due = c.type === 0 ? due : 0;
      ivl = 0;
      factor = 0;
      reps = 0;
      lapses = 0;
      left = 0;
    }
    let ankiDue = due;
    if (queue === 1 || (queue < 0 && due > 1e9)) ankiDue = Math.floor(due / 1000);
    if (queue === 2 || queue === 3 || (queue < 0 && type === 2)) ankiDue = due; // 日の番号はそのまま（crt を 0 日にする）
    if (type === 0 && withSched === false) ankiDue = c.type === 0 ? c.due : 0;
    const data = c.s ? JSON.stringify({ s: c.s, d: c.d }) : '';
    stmtC.run([id, nidMap.get(c.nid), deckIdFor(home), c.ord, Math.floor((c.mod || Date.now()) / 1000), -1, type, queue, ankiDue, ivl, factor, reps, lapses, left ? left + left * 1000 : 0, 0, 0, c.flags || 0, data]);
  }
  stmtC.free();
  if (withSched) {
    const stmtR = d.prepare('INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)');
    const revUsed = new Set();
    for (const r of [...col.revlog.values()].sort((a, b) => a.at - b.at)) {
      const cid = cidMap.get(r.cid);
      if (!cid) continue;
      let id = r.at;
      while (revUsed.has(id)) id++;
      revUsed.add(id);
      stmtR.run([id, cid, -1, r.ease, r.ivl, r.lastIvl, r.factor || 0, r.time || 0, r.type]);
    }
    stmtR.free();
  }
  // crt は 1970-01-01（日の番号をそのまま使うため）
  const crt = Math.floor(new Date(1970, 0, 1, col.conf.rollover).getTime() / 1000);
  d.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [crt, now * 1000, now * 1000, JSON.stringify({ nextPos: col.conf.nextPos || 1, sortType: 'noteFld', sortBackwards: false, activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: null, addToCur: true, schedVer: 2 }), JSON.stringify(models), JSON.stringify(decksJson), JSON.stringify(dconf), '{}']);
  const bytes = d.export();
  d.close();

  const files = { 'collection.anki2': bytes };
  const media = {};
  if (withMedia) {
    onStep('画像や音を入れています');
    const used = new Set();
    const re = /<img[^>]+src=["']?([^"' >]+)|\[sound:([^\]]+)\]/gi;
    for (const n of notes)
      for (const f of n.fields) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(f))) used.add(decodeURIComponent(m[1] || m[2]));
      }
    let i = 0;
    for (const name of used) {
      const blob = await col.mediaBlob(name);
      if (!blob) continue;
      files[String(i)] = new Uint8Array(await blob.arrayBuffer());
      media[String(i)] = name;
      i++;
    }
  }
  files.media = new TextEncoder().encode(JSON.stringify(media));
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/octet-stream' });
}
