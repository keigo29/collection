// ノートを直すダイアログ
import { col } from '../col.js';
import { dialog, el, toast, confirmDialog } from '../ui/dom.js';
import { createEditor } from '../ui/editor.js';
import { previewNote } from './preview.js';

export async function editNoteDialog(nid) {
  const note = col.notes.get(nid);
  if (!note) return false;
  const nt = col.notetypes.get(note.ntid);
  const editor = createEditor({ note: structuredClone(note), mode: 'edit' });
  const body = el(`<div class="stack"><div class="sub small">ノートの種類：${nt.name.replace(/[<>&]/g, '')}</div></div>`);
  body.appendChild(editor.el);
  const v = await dialog({
    title: 'ノートを直す',
    body,
    wide: true,
    buttons: [
      { label: '削除', kind: 'danger', value: 'delete', left: true },
      { label: '見え方', value: 'preview', left: true },
      { label: 'キャンセル', value: null },
      { label: '保存', kind: 'primary', value: 'save' },
    ],
    beforeClose: async (val) => {
      if (val === 'preview') {
        const d = editor.getData();
        previewNote(nt, d.fields, d.tags);
        return false;
      }
      if (val === 'delete') {
        const n = col.cardsOfNote(nid).length;
        return confirmDialog('ノートを削除', `このノートと ${n} 枚のカードを消します。`, { ok: '削除', danger: true });
      }
      return true;
    },
    onOpen: (d) => {
      d.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          d.querySelector('.foot .btn.primary').click();
        }
      });
    },
  });
  if (v === 'delete') {
    col.deleteNotes([nid]);
    toast('削除しました');
    return true;
  }
  if (v !== 'save') return false;
  const d = editor.getData();
  const n = col.notes.get(nid);
  col.updateNote({ ...n, fields: d.fields, tags: d.tags });
  toast('保存しました');
  return true;
}
