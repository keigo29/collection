// 読み込みと書き出しのダイアログ
import { col } from '../col.js';
import { dialog, el, esc, icon, options, toast, busy, switchHtml, confirmDialog } from '../ui/dom.js';
import { pickFile, download } from '../util.js';
import { readTextFile, importRows, exportNotes } from '../io/text.js';
import { makeBackup, restoreBackup } from '../io/backup.js';
import { search } from '../search.js';
import { nav } from '../nav.js';

export async function openImport() {
  const f = await pickFile('.apkg,.colpkg,.kioku,.zip,.txt,.csv,.tsv,text/plain,text/csv');
  if (!f) return;
  const name = f.name.toLowerCase();
  if (name.endsWith('.apkg') || name.endsWith('.colpkg')) return importAnki(f);
  if (name.endsWith('.kioku') || name.endsWith('.zip')) return importBackup(f);
  return importText(f);
}

async function importAnki(f) {
  const b = busy('Anki のファイルを読んでいます');
  try {
    const { importApkg } = await import('../io/apkg.js');
    const r = await importApkg(col, f, (m) => b.set(m));
    b.done();
    await dialog({
      title: '読み込みました',
      body: `<dl class="kv"><dt>新しいノート</dt><dd>${r.notes}</dd><dt>カード</dt><dd>${r.cards}</dd><dt>書きかえたノート</dt><dd>${r.updated}</dd><dt>もうあったノート</dt><dd>${r.skipped}</dd><dt>ノートの種類</dt><dd>${r.types}</dd><dt>デッキ</dt><dd>${r.decks}</dd><dt>画像や音</dt><dd>${r.media}</dd></dl>`,
    });
    nav.go('/decks');
    nav.rerender();
  } catch (e) {
    b.done();
    console.error(e);
    toast(`読み込めませんでした：${e.message}`, { warn: true, ms: 6000 });
  }
}

async function importBackup(f) {
  if (!(await confirmDialog('バックアップから戻す', 'いまのデータは、バックアップの中身に<b>すべて入れかわります</b>。よろしいですか？', { ok: '入れかえる', danger: true }))) return;
  const b = busy('バックアップを戻しています');
  try {
    await restoreBackup(col, f);
    b.done();
    toast('バックアップから戻しました');
    nav.go('/decks');
    nav.rerender();
  } catch (e) {
    b.done();
    toast(`戻せませんでした：${e.message}`, { warn: true });
  }
}

async function importText(f) {
  const text = await f.text();
  const parsed = readTextFile(text);
  if (!parsed.rows.length) return toast('中身が空のようです', { warn: true });
  const types = [...col.notetypes.values()];
  const decks = col.sortedDecks().filter((d) => !d.filtered);
  let ntid = col.conf.addType && col.notetypes.has(col.conf.addType) ? col.conf.addType : types[0].id;
  const ncols = Math.max(...parsed.rows.slice(0, 50).map((r) => r.length));
  const body = el(`<div class="stack">
    <div class="row wrap"><div class="field grow"><label>ノートの種類</label><select class="input" id="nt">${options(types.map((t) => [t.id, t.name]), ntid)}</select></div>
      <div class="field grow"><label>デッキ</label><select class="input" id="dk">${options(decks.map((d) => [d.id, d.name]), col.conf.curDeck)}</select></div></div>
    <div class="row wrap"><div class="field grow"><label>区切り</label><select class="input" id="sep">${options([['\t', 'タブ'], [',', 'カンマ（,）'], [';', 'セミコロン（;）'], ['|', '縦線（|）']], parsed.sep)}</select></div>
      <div class="field grow"><label>同じものがあったら</label><select class="input" id="dupe">${options([['skip', '入れない'], ['update', '書きかえる'], ['add', 'そのまま足す']], 'skip')}</select></div></div>
    <div class="setting"><div class="txt"><b>HTML として読む</b><span>切ると &lt; などをそのまま文字にします</span></div><div class="ctl auto">${switchHtml('html', parsed.html ?? true)}</div></div>
    <div class="field"><label>足すタグ</label><input class="input" id="tags" value="${esc(parsed.tags.join(' '))}"></div>
    <div class="label">列の入れ先</div><div id="map" class="stack tight"></div>
    <div class="label">はじめの3行</div><div style="overflow-x:auto"><table class="simple-table" id="pv"></table></div>
  </div>`);
  let rows = parsed.rows;
  const drawMap = () => {
    const nt = col.notetypes.get(ntid);
    const opts = [['', '（使わない）'], ...nt.fields.map((f2, i) => [i, f2.name]), ['tags', 'タグ'], ['deck', 'デッキ']];
    const m = body.querySelector('#map');
    m.innerHTML = '';
    for (let i = 0; i < ncols; i++) {
      const def = i === parsed.tagsCol ? 'tags' : i === parsed.deckCol ? 'deck' : i < nt.fields.length ? i : '';
      m.appendChild(el(`<div class="row"><span class="grow">${i + 1} 列目：<span class="sub">${esc((rows[0]?.[i] || '').slice(0, 30))}</span></span><select class="input sm" style="width:45%" data-c="${i}">${options(opts, def)}</select></div>`));
    }
    body.querySelector('#pv').innerHTML = rows
      .slice(0, 3)
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c.slice(0, 40))}</td>`).join('')}</tr>`)
      .join('');
  };
  body.querySelector('#nt').onchange = (e) => {
    ntid = Number(e.target.value);
    drawMap();
  };
  body.querySelector('#sep').onchange = (e) => {
    rows = readTextFile(`#separator:${{ '\t': 'tab', ',': 'comma', ';': 'semicolon', '|': 'pipe' }[e.target.value]}\n${text.replace(/^(#.*\r?\n)+/, '')}`).rows;
    drawMap();
  };
  drawMap();
  const v = await dialog({
    title: `読み込み：${f.name}`,
    body,
    wide: true,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: `${rows.length} 行を読み込む`, kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return;
  const mapping = [];
  let deckCol = -1;
  body.querySelectorAll('[data-c]').forEach((s) => {
    const i = Number(s.dataset.c);
    if (s.value === 'deck') {
      deckCol = i;
      mapping[i] = null;
    } else mapping[i] = s.value === '' ? null : s.value === 'tags' ? 'tags' : Number(s.value);
  });
  const r = importRows(col, rows, {
    ntid,
    did: Number(body.querySelector('#dk').value),
    mapping,
    dupe: body.querySelector('#dupe').value,
    html: body.querySelector('#html').checked,
    tags: body.querySelector('#tags').value.split(/\s+/).filter(Boolean),
    deckCol,
  });
  await dialog({
    title: '読み込みました',
    body: `<dl class="kv"><dt>足した</dt><dd>${r.added}</dd><dt>書きかえた</dt><dd>${r.updated}</dd><dt>入れなかった</dt><dd>${r.skipped}</dd></dl>${r.errors.length ? `<div class="sub small">${r.errors.slice(0, 10).map(esc).join('<br>')}</div>` : ''}`,
  });
  nav.rerender();
}

/** @param o.did デッキ / o.cids カード */
export async function openExport(o = {}) {
  const decks = col.sortedDecks().filter((d) => !d.filtered);
  const body = el(`<div class="stack">
    <div class="field"><label>形</label><select class="input" id="fmt">${options(
      [
        ['apkg', 'Anki のファイル（.apkg）'],
        ['kioku', 'まるごとバックアップ（.kioku）'],
        ['txt', '文字のファイル（タブ区切り .txt）'],
      ],
      'apkg'
    )}</select></div>
    <div class="field" id="whatBox"><label>中身</label><select class="input" id="what">${options(
      [...(o.cids ? [['cids', `選んだ ${o.cids.length} 枚`]] : []), ['all', 'すべてのデッキ'], ...decks.map((d) => [d.id, d.name])],
      o.cids ? 'cids' : o.did ?? 'all'
    )}</select></div>
    <div id="opts" class="stack tight"></div></div>`);
  const drawOpts = () => {
    const fmt = body.querySelector('#fmt').value;
    body.querySelector('#whatBox').classList.toggle('hidden', fmt === 'kioku');
    body.querySelector('#opts').innerHTML =
      fmt === 'apkg'
        ? `<div class="setting"><div class="txt"><b>学習の記録も入れる</b><span>切ると、まっさらなカードとして書き出します</span></div><div class="ctl auto">${switchHtml('sched', true)}</div></div><div class="setting"><div class="txt"><b>画像や音も入れる</b></div><div class="ctl auto">${switchHtml('media', true)}</div></div>`
        : fmt === 'kioku'
          ? `<div class="setting"><div class="txt"><b>画像や音も入れる</b></div><div class="ctl auto">${switchHtml('media', true)}</div></div><div class="sub small">別の端末や、あとで戻すときに使います。</div>`
          : `<div class="setting"><div class="txt"><b>HTML のまま書く</b></div><div class="ctl auto">${switchHtml('html', true)}</div></div><div class="setting"><div class="txt"><b>タグも書く</b></div><div class="ctl auto">${switchHtml('tags', true)}</div></div><div class="setting"><div class="txt"><b>デッキの名前も書く</b></div><div class="ctl auto">${switchHtml('deck', false)}</div></div><div class="setting"><div class="txt"><b>ノートの種類も書く</b></div><div class="ctl auto">${switchHtml('type', false)}</div></div>`;
  };
  body.querySelector('#fmt').onchange = drawOpts;
  drawOpts();
  const v = await dialog({
    title: '書き出す',
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '書き出す', kind: 'primary', value: 'ok', icon: 'download' },
    ],
  });
  if (v !== 'ok') return;
  const g = (id) => body.querySelector(`#${id}`);
  const fmt = g('fmt').value;
  const what = g('what').value;
  const stamp = new Date().toISOString().slice(0, 10);
  let cids;
  let label = 'すべて';
  if (what === 'cids') cids = o.cids;
  else if (what === 'all') cids = [...col.cards.keys()];
  else {
    const d = col.decks.get(Number(what));
    label = d.name.replace(/::/g, '-');
    cids = search(col, `deck:"${d.name.replace(/"/g, '\\"')}"`);
  }
  const b = busy('書き出しています');
  try {
    if (fmt === 'kioku') {
      download(`kioku-バックアップ-${stamp}.kioku`, await makeBackup(col, { withMedia: g('media').checked }));
    } else if (fmt === 'apkg') {
      const { exportApkg } = await import('../io/apkg.js');
      download(`${label}-${stamp}.apkg`, await exportApkg(col, cids, { withSched: g('sched').checked, withMedia: g('media').checked }, (m) => b.set(m)));
    } else {
      const nids = [...new Set(cids.map((id) => col.cards.get(id)?.nid).filter(Boolean))];
      download(`${label}-${stamp}.txt`, exportNotes(col, nids, { html: g('html').checked, withTags: g('tags').checked, withDeck: g('deck').checked, withType: g('type').checked }), 'text/plain');
    }
    toast('書き出しました');
  } catch (e) {
    console.error(e);
    toast(`書き出せませんでした：${e.message}`, { warn: true });
  } finally {
    b.done();
  }
}

export { icon };
