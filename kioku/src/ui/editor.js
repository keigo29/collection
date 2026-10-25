// ノートの中身を書く部品（追加・編集・一覧で使う）
import { col } from '../col.js';
import { el, icon, esc, toast } from './dom.js';
import { mediaUrl } from './cardview.js';
import { isDupe } from '../ops.js';
import { keyLabel, pickFile } from '../util.js';
import { parseOcclusions, occlusionsToText } from '../template.js';

const KEEP_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'IMG', 'SUB', 'SUP', 'SPAN', 'A', 'TABLE', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'RUBY', 'RT', 'RB', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'HR', 'MARK', 'S']);

/** 貼りつけた HTML を、基本の書式だけにする */
function cleanPaste(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const walk = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 8) {
        ch.remove();
        continue;
      }
      if (ch.nodeType !== 1) continue;
      if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'XML'].includes(ch.tagName)) {
        ch.remove();
        continue;
      }
      walk(ch);
      if (!KEEP_TAGS.has(ch.tagName)) {
        ch.replaceWith(...ch.childNodes);
        continue;
      }
      for (const a of [...ch.attributes]) if (!['src', 'href'].includes(a.name)) ch.removeAttribute(a.name);
      if (ch.tagName === 'SPAN' && !ch.attributes.length) ch.replaceWith(...ch.childNodes);
    }
  };
  walk(t.content);
  return t.innerHTML;
}

/** 保存する形 → 画面に出す形（画像の名前を見られる URL に） */
async function toDisplay(box, html) {
  box.innerHTML = html;
  for (const img of box.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^(https?:|data:|blob:)/.test(src)) continue;
    img.dataset.src = src;
    const u = await mediaUrl(decodeURIComponent(src));
    if (u) img.src = u;
  }
}

function fromDisplay(box) {
  const c = box.cloneNode(true);
  for (const img of c.querySelectorAll('img[data-src]')) {
    img.setAttribute('src', img.dataset.src);
    img.removeAttribute('data-src');
  }
  let h = c.innerHTML;
  if (h === '<br>' || h === '<div><br></div>') h = '';
  return h;
}

function insertHtml(html) {
  document.execCommand('insertHTML', false, html);
}

export function createEditor({ ntid, note = null, mode = 'add', onChange = () => {} }) {
  let nt = col.notetypes.get(note?.ntid ?? ntid);
  const root = el('<div class="editor"></div>');
  let boxes = [];
  let htmlMode = new Set();
  let focused = null;
  let tags = [...(note?.tags || [])];
  let io = null;
  const sticky = new Set((nt.fields || []).map((f, i) => (f.sticky ? i : -1)).filter((i) => i >= 0));

  const tools = el(`<div class="ed-tools" role="toolbar">
    <button class="icon-btn" data-c="bold" title="太字（${keyLabel('⌘B')}）">${icon('bold')}</button>
    <button class="icon-btn" data-c="italic" title="斜め（${keyLabel('⌘I')}）">${icon('italic')}</button>
    <button class="icon-btn" data-c="underline" title="下線（${keyLabel('⌘U')}）">${icon('underline')}</button>
    <button class="icon-btn" data-c="superscript" title="上つき（${keyLabel('⌘=')}）">${icon('superscript')}</button>
    <button class="icon-btn" data-c="subscript" title="下つき（${keyLabel('⌘⇧=')}）">${icon('subscript')}</button>
    <button class="icon-btn" data-c="hilite" title="色をつける">${icon('highlighter')}</button>
    <button class="icon-btn" data-c="insertUnorderedList" title="箇条書き">${icon('list')}</button>
    <button class="icon-btn" data-c="removeFormat" title="書式を消す（${keyLabel('⌘R')}）">${icon('eraser')}</button>
    <span class="sep"></span>
    <button class="icon-btn" data-c="cloze" title="穴うめ（${keyLabel('⌘⇧C')}、同じ番号は ${keyLabel('⌘⌥⇧C')}）">${icon('brackets')}</button>
    <button class="icon-btn" data-c="math" title="数式（${keyLabel('⌘M')}）">${icon('sigma')}</button>
    <button class="icon-btn" data-c="image" title="画像を入れる">${icon('image')}</button>
    <button class="icon-btn" data-c="audio" title="音を入れる">${icon('volume-2')}</button>
    <button class="icon-btn" data-c="record" title="録音する">${icon('mic')}</button>
    <span class="sep"></span>
    <button class="icon-btn" data-c="html" title="HTML で書く（${keyLabel('⌘⇧X')}）">${icon('code')}</button>
  </div>`);
  const fieldsWrap = el('<div class="stack tight"></div>');
  const tagsWrap = el(`<div class="ed-field"><div class="ed-head">${icon('tag')}タグ<span class="grow"></span><span class="small">スペースで区切る</span></div><div class="tags-input"><input placeholder="タグを入力" autocapitalize="off" autocomplete="off"></div></div>`);
  root.append(tools, fieldsWrap, tagsWrap);

  tools.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-c]')) e.preventDefault();
  });
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (b) command(b.dataset.c, e);
  });

  function command(c, e) {
    const box = focused ?? boxes.find(Boolean);
    if (!box) return;
    if (c === 'html') return toggleHtml(boxes.indexOf(box));
    if (htmlMode.has(boxes.indexOf(box))) return;
    box.focus();
    switch (c) {
      case 'cloze':
        return cloze(e?.altKey);
      case 'math': {
        const sel = getSelection().toString();
        return insertHtml(`\\(${sel ? esc(sel) : ''}\\)`);
      }
      case 'image':
        return pickMedia('image/*');
      case 'audio':
        return pickMedia('audio/*');
      case 'record':
        return record();
      case 'hilite':
        return document.execCommand('hiliteColor', false, 'rgba(255,174,0,.35)');
      default:
        document.execCommand(c);
    }
    changed();
  }

  function cloze(same) {
    const all = boxes.map((b) => (b ? fromDisplay(b) : '')).join(' ');
    let max = 0;
    for (const m of all.matchAll(/\{\{c(\d+)::/g)) max = Math.max(max, Number(m[1]));
    const n = same ? Math.max(1, max) : max + 1;
    const sel = getSelection();
    const text = sel.rangeCount ? sel.getRangeAt(0).cloneContents() : null;
    const div = document.createElement('div');
    if (text) div.appendChild(text);
    insertHtml(`{{c${n}::${div.innerHTML}}}`);
    if (!div.innerHTML) {
      // 中にカーソルを入れる
      const s = getSelection();
      for (let i = 0; i < 2; i++) s.modify?.('move', 'backward', 'character');
    }
    if (nt.kind !== 'cloze') toast('穴うめは「穴うめ」の種類のノートで使います', { warn: true });
    changed();
  }

  async function addFile(file) {
    const name = await col.addMedia(file);
    const u = await mediaUrl(name);
    if (file.type.startsWith('image/')) insertHtml(`<img src="${u}" data-src="${esc(name)}">`);
    else insertHtml(`[sound:${esc(name)}]`);
    changed();
  }

  async function pickMedia(accept) {
    const box = focused;
    const f = await pickFile(accept);
    if (!f) return;
    box?.focus();
    await addFile(f);
  }

  let recorder = null;
  async function record() {
    if (recorder) {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) return toast('この端末では録音できません', { warn: true });
    const box = focused;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      const btn = tools.querySelector('[data-c=record]');
      btn.classList.add('on');
      btn.style.color = 'var(--danger)';
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        btn.classList.remove('on');
        btn.style.color = '';
        recorder = null;
        const type = chunks[0]?.type || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(chunks, { type });
        box?.focus();
        await addFile(new File([blob], `録音-${Date.now().toString(36)}.${ext}`, { type }));
      };
      recorder.start();
      toast('録音しています。もう一度押すと止まります');
    } catch {
      toast('マイクを使えませんでした', { warn: true });
    }
  }

  function toggleHtml(i) {
    const wrap = fieldsWrap.children[i];
    if (!wrap) return;
    const box = boxes[i];
    let ta = wrap.querySelector('textarea');
    if (htmlMode.has(i)) {
      htmlMode.delete(i);
      toDisplay(box, ta.value);
      ta.remove();
      box.classList.remove('hidden');
      box.focus();
    } else {
      htmlMode.add(i);
      ta = el(`<textarea class="input ed-html code" spellcheck="false"></textarea>`);
      ta.value = fromDisplay(box);
      ta.oninput = () => {
        box.innerHTML = ta.value;
        changed();
      };
      box.classList.add('hidden');
      wrap.appendChild(ta);
      ta.focus();
    }
  }

  function keys(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const i = boxes.indexOf(e.currentTarget);
    if (e.shiftKey && k === 'c') {
      e.preventDefault();
      cloze(e.altKey);
    } else if (e.shiftKey && k === 'x') {
      e.preventDefault();
      toggleHtml(i);
    } else if (k === 'r' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('removeFormat');
    } else if (k === 'm' && !e.shiftKey) {
      e.preventDefault();
      command('math');
    } else if (k === '=' || k === '+') {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'subscript' : 'superscript');
    }
  }

  function changed() {
    checkDupe();
    onChange();
  }

  let dupeEl = null;
  function checkDupe() {
    if (!dupeEl || !boxes[0]) return;
    const d = isDupe(col, nt.id, fromDisplay(boxes[0]), note?.id);
    dupeEl.classList.toggle('hidden', !d);
  }

  function build(values) {
    fieldsWrap.innerHTML = '';
    boxes = [];
    htmlMode = new Set();
    io = null;
    nt.fields.forEach((f, i) => {
      if (nt.kind === 'io' && i <= 1) {
        boxes.push(null);
        if (i === 0) {
          io = createIoEditor(values[1] || '', values[0] || '', changed);
          fieldsWrap.appendChild(io.el);
        }
        return;
      }
      const wrap = el(`<div class="ed-field"><div class="ed-head"><span>${esc(f.name)}</span>${i === 0 ? '<span class="ed-dupe hidden">同じものがすでにあります</span>' : ''}<span class="grow"></span>${mode === 'add' ? `<button class="icon-btn ${sticky.has(i) ? 'on' : ''}" data-pin title="次も同じ中身を残す">${icon(sticky.has(i) ? 'pin' : 'pin-off')}</button>` : ''}</div><div class="ed-box" contenteditable="true" spellcheck="false" ${f.rtl ? 'dir="rtl"' : ''}></div></div>`);
      const box = wrap.querySelector('.ed-box');
      if (i === 0) dupeEl = wrap.querySelector('.ed-dupe');
      toDisplay(box, values[i] ?? '');
      box.addEventListener('focus', () => (focused = box));
      box.addEventListener('input', changed);
      box.addEventListener('keydown', keys);
      box.addEventListener('paste', async (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) {
          e.preventDefault();
          for (const f2 of files) await addFile(f2);
          return;
        }
        const html = e.clipboardData?.getData('text/html');
        e.preventDefault();
        if (html) insertHtml(cleanPaste(html));
        else insertHtml(esc(e.clipboardData.getData('text/plain')).replace(/\r?\n/g, '<br>'));
      });
      box.addEventListener('drop', async (e) => {
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        e.preventDefault();
        box.focus();
        for (const f2 of files) await addFile(f2);
      });
      wrap.querySelector('[data-pin]')?.addEventListener('click', (e) => {
        const b = e.currentTarget;
        if (sticky.has(i)) sticky.delete(i);
        else sticky.add(i);
        b.classList.toggle('on', sticky.has(i));
        b.innerHTML = icon(sticky.has(i) ? 'pin' : 'pin-off');
        const fields = nt.fields.map((x, j) => ({ ...x, sticky: sticky.has(j) }));
        col.put('notetypes', { ...nt, fields });
        nt = col.notetypes.get(nt.id);
      });
      boxes.push(box);
      fieldsWrap.appendChild(wrap);
    });
    checkDupe();
  }

  // ---- タグ
  const tagBox = tagsWrap.querySelector('.tags-input');
  const tagInput = tagBox.querySelector('input');
  let sugg = null;
  function drawTags() {
    tagBox.querySelectorAll('.tag').forEach((t) => t.remove());
    for (const t of tags) {
      const chip = el(`<span class="tag">${esc(t)}<button class="x" title="外す">${icon('x')}</button></span>`);
      chip.querySelector('.x').onclick = () => {
        tags = tags.filter((x) => x !== t);
        drawTags();
        onChange();
      };
      tagBox.insertBefore(chip, tagInput);
    }
  }
  function commitTag() {
    const v = tagInput.value.trim();
    if (v) {
      for (const t of v.split(/\s+/)) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
      tagInput.value = '';
      drawTags();
      onChange();
    }
    sugg?.remove();
    sugg = null;
  }
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === ',') {
      if (tagInput.value.trim()) {
        e.preventDefault();
        if (e.key === 'Enter' && sugg?.querySelector('button.hi')) tagInput.value = sugg.querySelector('button.hi').dataset.t;
        commitTag();
      }
    } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
      tags.pop();
      drawTags();
      onChange();
    } else if (e.key === 'ArrowDown' && sugg) {
      e.preventDefault();
      const bs = [...sugg.querySelectorAll('button')];
      const i = bs.findIndex((b) => b.classList.contains('hi'));
      bs.forEach((b) => b.classList.remove('hi'));
      bs[(i + 1) % bs.length]?.classList.add('hi');
    }
  });
  tagInput.addEventListener('input', () => {
    sugg?.remove();
    sugg = null;
    const q = tagInput.value.trim().toLowerCase();
    if (!q) return;
    const list = col.allTags().filter((t) => t.toLowerCase().includes(q) && !tags.includes(t)).slice(0, 8);
    if (!list.length) return;
    sugg = el(`<div class="menu suggest" style="position:absolute">${list.map((t) => `<button data-t="${esc(t)}">${icon('tag')}<span>${esc(t)}</span></button>`).join('')}</div>`);
    sugg.addEventListener('mousedown', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.preventDefault();
      tagInput.value = b.dataset.t;
      commitTag();
    });
    tagBox.appendChild(sugg);
  });
  tagInput.addEventListener('blur', () => setTimeout(commitTag, 120));

  build(note?.fields || nt.fields.map(() => ''));
  drawTags();

  return {
    el: root,
    get notetype() {
      return nt;
    },
    getData() {
      commitTag();
      const fields = boxes.map((b, i) => {
        if (!b) return '';
        if (htmlMode.has(i)) return fieldsWrap.children[i]?.querySelector('textarea')?.value ?? fromDisplay(b);
        return fromDisplay(b);
      });
      if (io) {
        fields[0] = io.occlusionText();
        fields[1] = io.imageHtml();
      }
      return { fields, tags: [...tags] };
    },
    setNotetype(id) {
      const old = this.getData();
      nt = col.notetypes.get(id);
      sticky.clear();
      nt.fields.forEach((f, i) => f.sticky && sticky.add(i));
      build(nt.fields.map((_, i) => old.fields[i] ?? ''));
    },
    /** 追加のあと：残す項目以外を空にする */
    reset() {
      const old = this.getData();
      build(nt.fields.map((_, i) => (sticky.has(i) ? old.fields[i] : '')));
      this.focusFirst();
    },
    focusFirst() {
      const b = boxes.find((x, i) => x && !sticky.has(i)) || boxes.find(Boolean);
      if (b && !matchMedia('(pointer: coarse)').matches) b.focus();
    },
    hasContent() {
      const d = this.getData();
      return d.fields.some((f) => f.replace(/<[^>]+>/g, '').trim() || /<img/.test(f));
    },
  };
}

// ---- 画像の穴うめの編集
function createIoEditor(imageHtml, occl, onChange) {
  const root = el(`<div class="ed-field"><div class="ed-head"><span>画像と隠す場所</span><span class="grow"></span>
    <select class="input sm" style="width:auto" data-mode><option value="0">1つずつ隠す</option><option value="1">全部隠して1つ答える</option></select></div>
    <div class="stack tight"><div class="row wrap"><button class="btn sm" data-a="pick">${icon('image')}画像を選ぶ</button><span class="small sub">画像の上をなぞると、隠す四角ができます。四角を押すと選べて、Delete で消せます。</span></div>
    <div class="ioarea"></div><div class="row wrap hidden" data-sel><span class="small sub">選んだ四角の番号</span><input class="input sm" type="number" min="1" style="width:80px" data-n><button class="btn sm danger" data-a="del">${icon('trash')}消す</button></div></div></div>`);
  let shapes = parseOcclusions(occl).map((s) => ({ ...s, props: { ...s.props } }));
  let imgName = /src=["']?([^"' >]+)/.exec(imageHtml)?.[1] || '';
  let sel = -1;
  const area = root.querySelector('.ioarea');
  const modeSel = root.querySelector('[data-mode]');
  modeSel.value = shapes.some((s) => s.props.oi === '1') ? '1' : '0';

  async function draw() {
    area.innerHTML = '';
    if (!imgName) {
      area.appendChild(el(`<div class="empty" style="padding:24px;background:var(--soft);border-radius:14px">${icon('image')}<span>画像を選ぶか、ここに貼りつけてください</span></div>`));
      return;
    }
    const wrap = el('<div class="io-editor"></div>');
    const img = el('<img alt="" draggable="false">');
    img.src = (await mediaUrl(decodeURIComponent(imgName))) || '';
    wrap.appendChild(img);
    shapes.forEach((s, i) => {
      const p = s.props;
      const b = el(`<div class="box ${i === sel ? 'sel' : ''}" data-i="${i}">${s.n}</div>`);
      Object.assign(b.style, { left: `${p.left * 100}%`, top: `${p.top * 100}%`, width: `${(p.width || p.rx * 2) * 100}%`, height: `${(p.height || p.ry * 2) * 100}%` });
      wrap.appendChild(b);
    });
    area.appendChild(wrap);
    let start = null;
    let ghost = null;
    wrap.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.box');
      if (b) {
        sel = Number(b.dataset.i);
        showSel();
        draw();
        return;
      }
      const r = wrap.getBoundingClientRect();
      start = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
      ghost = el('<div class="box"></div>');
      wrap.appendChild(ghost);
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = (e.clientX - start.r.left) / start.r.width;
      const y = (e.clientY - start.r.top) / start.r.height;
      Object.assign(ghost.style, { left: `${Math.min(x, start.x) * 100}%`, top: `${Math.min(y, start.y) * 100}%`, width: `${Math.abs(x - start.x) * 100}%`, height: `${Math.abs(y - start.y) * 100}%` });
    });
    wrap.addEventListener('pointercancel', () => {
      start = null;
      draw();
    });
    wrap.addEventListener('pointerup', (e) => {
      if (!start) return;
      const x = Math.max(0, Math.min(1, (e.clientX - start.r.left) / start.r.width));
      const y = Math.max(0, Math.min(1, (e.clientY - start.r.top) / start.r.height));
      const w = Math.abs(x - start.x);
      const h = Math.abs(y - start.y);
      const s0 = start;
      start = null;
      if (w < 0.01 || h < 0.01) return draw();
      const n = Math.max(0, ...shapes.map((s) => s.n)) + 1;
      const f = (v) => v.toFixed(4).replace(/^0/, '');
      shapes.push({ n, shape: 'rect', props: { left: f(Math.min(x, s0.x)), top: f(Math.min(y, s0.y)), width: f(w), height: f(h) } });
      sel = shapes.length - 1;
      showSel();
      draw();
      onChange();
    });
  }
  function showSel() {
    const row = root.querySelector('[data-sel]');
    row.classList.toggle('hidden', sel < 0);
    if (sel >= 0) row.querySelector('[data-n]').value = shapes[sel].n;
  }
  root.querySelector('[data-n]').addEventListener('change', (e) => {
    if (sel < 0) return;
    shapes[sel].n = Math.max(1, Number(e.target.value) || 1);
    draw();
    onChange();
  });
  root.querySelector('[data-a=del]').onclick = () => {
    if (sel < 0) return;
    shapes.splice(sel, 1);
    sel = -1;
    showSel();
    draw();
    onChange();
  };
  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && e.target.tagName !== 'INPUT') {
      shapes.splice(sel, 1);
      sel = -1;
      showSel();
      draw();
      onChange();
    }
  });
  root.tabIndex = -1;
  const setImage = async (file) => {
    imgName = await col.addMedia(file);
    shapes = [];
    sel = -1;
    showSel();
    draw();
    onChange();
  };
  root.querySelector('[data-a=pick]').onclick = async () => {
    const f = await pickFile('image/*');
    if (f) setImage(f);
  };
  root.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      setImage(f);
    }
  });
  modeSel.onchange = onChange;
  draw();
  return {
    el: root,
    occlusionText() {
      const oi = modeSel.value === '1';
      return occlusionsToText(
        shapes.map((s) => {
          const props = { ...s.props };
          if (oi) props.oi = '1';
          else delete props.oi;
          return { ...s, props };
        })
      );
    },
    imageHtml: () => (imgName ? `<img src="${esc(imgName)}">` : ''),
  };
}
