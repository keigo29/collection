// ノートの種類（項目とカードの型）を管理する
import { col } from '../col.js';
import { dialog, el, esc, icon, toast, promptDialog, confirmDialog, options, seg, wireSeg, menu } from '../ui/dom.js';
import { STOCK_TYPES, STOCK_ORDER } from '../stock.js';
import { remapFields, syncTemplates } from '../ops.js';
import { renderCard } from '../template.js';
import { renderInto, isNight } from '../ui/cardview.js';
import { newId } from '../util.js';

export function notetypesSection(root, redraw) {
  const types = [...col.notetypes.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const count = new Map();
  for (const n of col.notes.values()) count.set(n.ntid, (count.get(n.ntid) || 0) + 1);
  const card = el(`<div class="card"><h2>${icon('file-text')}ノートの種類<span class="grow"></span></h2><div class="stack tight" id="list"></div><div class="row" style="margin-top:10px"><button class="btn primary" data-a="add">${icon('plus')}種類を足す</button></div></div>`);
  const list = card.querySelector('#list');
  for (const t of types) {
    const row = el(`<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><div class="grow"><b>${esc(t.name)}</b><div class="sub small">${t.kind === 'cloze' ? '穴うめ' : t.kind === 'io' ? '画像の穴うめ' : `カードの型 ${t.templates.length}`}・項目 ${t.fields.length}・ノート ${count.get(t.id) || 0} 件</div></div>
      <button class="btn sm" data-a="fields">項目</button><button class="btn sm" data-a="cards">カードの型</button><button class="icon-btn" data-a="more">${icon('ellipsis')}</button></div>`);
    row.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'fields') (await editFields(t.id)) && redraw();
      if (a === 'cards') (await editTemplates(t.id)) && redraw();
      if (a === 'more')
        menu(e.target.closest('[data-a]'), [
          {
            label: '名前を変える',
            icon: 'pencil',
            fn: async () => {
              const v = await promptDialog('名前を変える', { label: '名前', value: t.name });
              if (!v) return;
              col.put('notetypes', { ...col.notetypes.get(t.id), name: v });
              redraw();
            },
          },
          {
            label: '複製',
            icon: 'copy',
            fn: () => {
              col.put('notetypes', { ...structuredClone(col.notetypes.get(t.id)), id: newId(), name: `${t.name} のコピー`, ankiId: undefined, stock: undefined });
              redraw();
            },
          },
          { sep: true },
          {
            label: '削除',
            icon: 'trash',
            danger: true,
            fn: async () => {
              if (col.notetypes.size <= 1) return toast('ノートの種類は1つ以上必要です', { warn: true });
              const n = count.get(t.id) || 0;
              if (!(await confirmDialog('ノートの種類を削除', `「${esc(t.name)}」と、この種類の <b>${n} 件のノート</b>（とそのカード）を消します。`, { ok: '削除', danger: true }))) return;
              col.transact('ノートの種類の削除', () => {
                col.deleteNotes([...col.notes.values()].filter((x) => x.ntid === t.id).map((x) => x.id));
                col.remove('notetypes', t.id);
              });
              redraw();
            },
          },
        ]);
    });
    list.appendChild(row);
  }
  card.querySelector('[data-a=add]').onclick = async () => {
    const stockNames = Object.fromEntries(STOCK_ORDER.map((k) => [k, STOCK_TYPES[k]().name]));
    const body = el(`<div class="stack"><div class="field"><label>もとにするもの</label><select class="input" id="base">${options(
      [...STOCK_ORDER.map((k) => [`s:${k}`, `ふつうの「${stockNames[k]}」`]), ...types.map((x) => [`c:${x.id}`, `「${x.name}」を複製`])],
      's:basic'
    )}</select></div><div class="field"><label>名前</label><input class="input" id="nm"></div></div>`);
    const v = await dialog({
      title: 'ノートの種類を足す',
      body,
      buttons: [
        { label: 'キャンセル', value: null },
        { label: '足す', kind: 'primary', value: 'ok' },
      ],
    });
    if (v !== 'ok') return;
    const base = body.querySelector('#base').value;
    const src = base.startsWith('s:') ? STOCK_TYPES[base.slice(2)]() : structuredClone(col.notetypes.get(Number(base.slice(2))));
    col.put('notetypes', { ...src, id: newId(), name: body.querySelector('#nm').value.trim() || src.name, ankiId: undefined, stock: undefined });
    redraw();
  };
  root.appendChild(card);
}

function renameRefs(text, from, to) {
  const e = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\{\\{([#^/]?)((?:[^}:]*:)*)${e}\\}\\}`, 'g'), (_, p, f) => `{{${p}${f}${to}}}`);
}

async function editFields(ntid) {
  const nt = structuredClone(col.notetypes.get(ntid));
  let fields = nt.fields.map((f, i) => ({ ...f, old: i, oldName: f.name }));
  let sortIdx = nt.sortIdx || 0;
  const body = el('<div class="stack"></div>');
  const draw = () => {
    body.innerHTML = `<div class="stack tight">${fields
      .map(
        (f, i) => `<div class="row" data-i="${i}"><input class="input sm grow" value="${esc(f.name)}" data-name>
        <button class="icon-btn ${sortIdx === i ? 'on' : ''}" data-a="sort" title="一覧で並べかえに使う">${icon('list-ordered')}</button>
        <button class="icon-btn" data-a="up" title="上へ">${icon('arrow-up')}</button><button class="icon-btn" data-a="down" title="下へ">${icon('arrow-down')}</button>
        <button class="icon-btn" data-a="del" title="消す">${icon('trash')}</button></div>`
      )
      .join('')}</div><button class="btn sm" data-a="add">${icon('plus')}項目を足す</button><div class="sub small">${icon('list-ordered')} が付いた項目で一覧を並べかえます。${nt.kind === 'io' ? '画像の穴うめでは、はじめの2つ（隠す場所・画像）は動かさないでください。' : ''}</div>`;
  };
  body.addEventListener('input', (e) => {
    const r = e.target.closest('[data-i]');
    if (r && e.target.matches('[data-name]')) fields[Number(r.dataset.i)].name = e.target.value;
  });
  body.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const i = Number(e.target.closest('[data-i]')?.dataset.i);
    if (a === 'add') fields.push({ name: `項目${fields.length + 1}`, old: -1 });
    if (a === 'del' && fields.length > 1) {
      fields.splice(i, 1);
      if (sortIdx >= fields.length) sortIdx = 0;
    }
    if (a === 'up' && i > 0) [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
    if (a === 'down' && i < fields.length - 1) [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
    if (a === 'sort') sortIdx = i;
    draw();
  });
  draw();
  const v = await dialog({
    title: `項目：${nt.name}`,
    body,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '保存', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return false;
  const names = fields.map((f) => f.name.trim());
  if (names.some((n) => !n) || new Set(names).size !== names.length) {
    toast('項目の名前は空にせず、重ならないようにしてください', { warn: true });
    return false;
  }
  const removed = nt.fields.filter((_, i) => !fields.some((f) => f.old === i));
  if (removed.length && !(await confirmDialog('項目を消す', `「${removed.map((f) => esc(f.name)).join('」「')}」の中身は消えます。`, { ok: '消す', danger: true }))) return false;
  col.transact('項目の変更', () => {
    let templates = nt.templates;
    for (const f of fields) if (f.old >= 0 && f.oldName !== f.name.trim()) templates = templates.map((t) => ({ ...t, qfmt: renameRefs(t.qfmt, f.oldName, f.name.trim()), afmt: renameRefs(t.afmt, f.oldName, f.name.trim()) }));
    col.put('notetypes', { ...col.notetypes.get(ntid), fields: fields.map(({ old, oldName, ...f }) => ({ ...f, name: f.name.trim() })), sortIdx, templates });
    remapFields(col, ntid, fields.map((f) => f.old));
  });
  toast('項目を保存しました');
  return true;
}

async function editTemplates(ntid) {
  const nt = structuredClone(col.notetypes.get(ntid));
  let templates = nt.templates.map((t, i) => ({ ...t, old: i }));
  let css = nt.css || '';
  let cur = 0;
  let side = 'qfmt';
  const sample = [...col.notes.values()].find((n) => n.ntid === ntid) || { fields: nt.fields.map((f) => `（${f.name}）`), tags: ['タグ'] };
  const body = el(`<div class="stack">
    <div class="row wrap"><select class="input sm" id="tsel" style="width:auto"></select>
      ${nt.kind === 'std' ? `<button class="btn sm" data-a="add">${icon('plus')}型を足す</button><button class="btn sm" data-a="rename">名前</button><button class="btn sm danger" data-a="del">消す</button>` : ''}
      <div class="grow"></div>${seg('side', [['qfmt', '表'], ['afmt', '裏'], ['css', '見た目（CSS）']], 'qfmt')}</div>
    <div class="grid2" style="align-items:start"><textarea class="input code" id="src" rows="16" spellcheck="false"></textarea><div class="preview-box"><div class="cardhost"></div></div></div>
    <div class="sub small">{{項目の名前}} で中身が入ります。{{FrontSide}} は表の中身、{{#項目}}…{{/項目}} は中身があるときだけ、{{type:項目}} は答えの入力、{{hint:項目}} はヒント、{{furigana:項目}} は 漢字[かんじ] を振り仮名に、{{tts ja_JP:項目}} は読み上げです。${nt.kind === 'std' ? '' : '穴うめは {{cloze:項目}} を使います。'}</div>
  </div>`);
  const src = body.querySelector('#src');
  const tsel = body.querySelector('#tsel');
  const drawSel = () => {
    tsel.innerHTML = options(templates.map((t, i) => [i, t.name]), cur);
  };
  const load = () => {
    src.value = side === 'css' ? css : templates[cur][side];
    preview();
  };
  const preview = () => {
    const t = templates[cur];
    const r = renderCard({ card: { ord: nt.kind === 'std' ? cur : 0, flags: 0 }, note: sample, nt: { ...nt, templates: nt.kind === 'std' ? templates : [t], css }, deckName: 'デッキ' });
    renderInto(body.querySelector('.cardhost'), side === 'afmt' ? r.a : r.q, css, { night: isNight() });
  };
  src.addEventListener('input', () => {
    if (side === 'css') css = src.value;
    else templates[cur][side] = src.value;
    preview();
  });
  src.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  });
  tsel.onchange = () => {
    cur = Number(tsel.value);
    load();
  };
  wireSeg(body, 'side', (v) => {
    side = v;
    load();
  });
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'add') {
      const n = templates.length + 1;
      templates.push({ name: `カード${n}`, qfmt: `{{${nt.fields[0].name}}}`, afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n', old: -1 });
      cur = templates.length - 1;
      drawSel();
      load();
    }
    if (a === 'rename') {
      const v = await promptDialog('型の名前', { label: '名前', value: templates[cur].name });
      if (v) {
        templates[cur].name = v;
        drawSel();
      }
    }
    if (a === 'del') {
      if (templates.length <= 1) return toast('カードの型は1つ以上必要です', { warn: true });
      templates.splice(cur, 1);
      cur = 0;
      drawSel();
      load();
    }
  });
  drawSel();
  load();
  const v = await dialog({
    title: `カードの型：${nt.name}`,
    body,
    xwide: true,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: '保存', kind: 'primary', value: 'ok' },
    ],
  });
  if (v !== 'ok') return false;
  const removedOrds = nt.templates.map((_, i) => i).filter((i) => !templates.some((t) => t.old === i));
  if (removedOrds.length) {
    let n = 0;
    for (const c of col.cards.values()) if (removedOrds.includes(c.ord) && col.notes.get(c.nid)?.ntid === ntid) n++;
    if (n && !(await confirmDialog('カードの型を消す', `消した型のカード <b>${n} 枚</b>も消えます。`, { ok: '消す', danger: true }))) return false;
  }
  const ordMap = {};
  templates.forEach((t, i) => t.old >= 0 && (ordMap[t.old] = i));
  col.transact('カードの型の変更', () => {
    col.put('notetypes', { ...col.notetypes.get(ntid), templates: templates.map(({ old, ...t }) => t), css });
    syncTemplates(col, ntid, removedOrds, ordMap);
  });
  toast('カードの型を保存しました');
  return true;
}
