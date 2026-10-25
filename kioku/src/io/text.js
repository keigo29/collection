// 文字のファイル（CSV・タブ区切り）の読み込みと書き出し
import { esc, stripHtml } from '../util.js';
import { normTags } from '../col.js';

/** 引用符つきの区切り文字のファイルを読む */
export function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        q = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      q = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 先頭の「#separator:tab」などを読み、区切り文字を決める */
export function readTextFile(text) {
  text = text.replace(/^﻿/, '');
  const meta = {};
  const lines = text.split(/\r?\n/);
  let skip = 0;
  for (const l of lines) {
    const m = /^#([a-z ]+):(.*)$/i.exec(l);
    if (!m) break;
    meta[m[1].trim().toLowerCase()] = m[2].trim();
    skip++;
  }
  const body = lines.slice(skip).join('\n');
  const sepName = (meta.separator || '').toLowerCase();
  const seps = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ', colon: ':' };
  let sep = seps[sepName] || meta.separator;
  if (!sep) {
    const first = body.split('\n').slice(0, 5).join('\n');
    const count = (c) => first.split(c).length;
    sep = count('\t') > 1 ? '\t' : count(';') > count(',') ? ';' : ',';
  }
  const rows = parseDelimited(body, sep);
  const col = (k) => (meta[k] ? Number(meta[k]) - 1 : -1);
  return {
    rows,
    sep,
    html: meta.html ? meta.html === 'true' : null,
    tagsCol: col('tags column'),
    deckCol: col('deck column'),
    notetypeCol: col('notetype column'),
    guidCol: col('guid column'),
    tags: meta.tags ? meta.tags.split(/\s+/) : [],
  };
}

/**
 * 行をノートとして入れる
 * @param mapping 列ごとに 項目の番号 / 'tags' / null
 * @param dupe 'skip' | 'update' | 'add'
 */
export function importRows(col, rows, { ntid, did, mapping, dupe = 'skip', html = true, tags = [], deckCol = -1 }) {
  const nt = col.notetypes.get(ntid);
  const first = new Map();
  for (const n of col.notes.values()) if (n.ntid === ntid) first.set(stripHtml(n.fields[0] || '').toLowerCase(), n);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  col.transact('文字のファイルの読み込み', () => {
    rows.forEach((row, ri) => {
      const fields = nt.fields.map(() => '');
      let rowTags = [...tags];
      mapping.forEach((m, ci) => {
        const v = row[ci] ?? '';
        if (m === 'tags') rowTags.push(...v.split(/\s+/));
        else if (typeof m === 'number') fields[m] = html ? v : esc(v).replace(/\n/g, '<br>');
      });
      const key = stripHtml(fields[0]).toLowerCase();
      if (!key) {
        skipped++;
        return;
      }
      const ex = first.get(key);
      if (ex && dupe !== 'add') {
        if (dupe === 'update') {
          col.put('notes', { ...ex, fields, tags: normTags([...ex.tags, ...rowTags]) });
          col.genCards(col.notes.get(ex.id));
          updated++;
        } else skipped++;
        return;
      }
      let target = did;
      if (deckCol >= 0 && row[deckCol]) target = col.ensureDeck(row[deckCol]).id;
      try {
        const { note } = col.addNote(ntid, target, fields, rowTags);
        first.set(key, note);
        added++;
      } catch (e) {
        errors.push(`${ri + 1}行目：${e.message}`);
      }
    });
  });
  return { added, updated, skipped, errors };
}

const csvCell = (s, sep) => (/[",\n\r\t;]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s);

/** ノートを Anki と同じ形のタブ区切りで書き出す */
export function exportNotes(col, nids, { html = true, withTags = true, withDeck = false, withType = false, withGuid = false } = {}) {
  const lines = ['#separator:tab', `#html:${html}`];
  let c = 1;
  if (withGuid) lines.push(`#guid column:${c++}`);
  if (withType) lines.push(`#notetype column:${c++}`);
  if (withDeck) lines.push(`#deck column:${c++}`);
  const notes = nids.map((id) => col.notes.get(id)).filter(Boolean);
  const maxF = Math.max(0, ...notes.map((n) => n.fields.length));
  if (withTags) lines.push(`#tags column:${c + maxF}`);
  for (const n of notes) {
    const row = [];
    if (withGuid) row.push(n.guid || '');
    if (withType) row.push(col.notetypes.get(n.ntid)?.name || '');
    if (withDeck) {
      const card = col.cardsOfNote(n.id)[0];
      row.push(col.decks.get(card?.odid || card?.did)?.name || '');
    }
    for (let i = 0; i < maxF; i++) row.push(html ? n.fields[i] ?? '' : stripHtml(n.fields[i] ?? ''));
    if (withTags) row.push(n.tags.join(' '));
    lines.push(row.map((x) => csvCell(x, '\t')).join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** 一覧の表を CSV に */
export function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.map((x) => csvCell(String(x ?? ''), ',')).join(',')).join('\r\n');
}
