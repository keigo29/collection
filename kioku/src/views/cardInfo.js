// カードの情報
import { col } from '../col.js';
import { dialog, esc } from '../ui/dom.js';
import { fmtDate, fmtDateTime, fmtDay, fmtSpan, fmtDuration, stripHtml, DAY } from '../util.js';
import { retrievability } from '../sched/fsrs.js';

export const TYPE_NAMES = ['新規', '学習中', '復習', '再学習'];
const LOG_TYPES = ['学習', '復習', '再学習', 'フィルター', '手で変更'];
const EASES = ['', 'もう一度', '難しい', '正解', '簡単'];

export function dueText(c, today = col.today()) {
  if (c.queue === -1) return '保留';
  if (c.queue === -2 || c.queue === -3) return 'あとまわし';
  if (c.type === 0) return `新規 #${c.odid ? c.odue : c.due}`;
  if (c.queue === 1) return fmtDateTime(c.due);
  const d = c.odid && c.odue ? c.odue : c.due;
  return fmtDay(d);
}

export function openCardInfo(cid) {
  const c = col.cards.get(cid);
  if (!c) return;
  const n = col.notes.get(c.nid);
  const nt = col.notetypes.get(n.ntid);
  const logs = col.revlogOf(cid);
  const reviews = logs.filter((l) => l.type !== 4);
  const total = reviews.reduce((a, l) => a + (l.time || 0), 0);
  const first = reviews[0];
  const last = reviews.at(-1);
  const deck = col.decks.get(c.odid || c.did);
  const tmpl = nt.kind === 'std' ? nt.templates[c.ord]?.name : `穴 ${c.ord + 1}`;
  const r = c.s && c.lastReview ? retrievability((Date.now() - c.lastReview) / DAY, c.s) : null;
  const rows = [
    ['作った日', fmtDate(c.created ?? n.created ?? c.id / 1000)],
    ['はじめて答えた日', first ? fmtDate(first.at) : '—'],
    ['最後に答えた日', last ? fmtDate(last.at) : '—'],
    ['期日', dueText(c)],
    ['種類', TYPE_NAMES[c.type] || ''],
    ['間隔', c.type === 2 || c.type === 3 ? fmtSpan(c.ivl * 86400) : '—'],
    ['易しさ', c.factor ? `${(c.factor / 10).toFixed(0)}%` : '—'],
    c.s ? ['覚えている強さ（FSRS）', `${c.s.toFixed(1)} 日`] : null,
    c.d ? ['難しさ（FSRS）', `${Math.round(((c.d - 1) / 9) * 100)}%`] : null,
    r != null ? ['いま思い出せる見こみ', `${Math.round(r * 100)}%`] : null,
    ['答えた回数', `${c.reps} 回`],
    ['忘れた回数', `${c.lapses} 回`],
    ['かかった時間（平均）', reviews.length ? fmtDuration(total / reviews.length) : '—'],
    ['かかった時間（合計）', fmtDuration(total)],
    ['カードの型', tmpl],
    ['ノートの種類', nt.name],
    ['デッキ', deck?.name || ''],
    ['カード ID', c.id],
    ['ノート ID', n.id],
  ].filter(Boolean);
  const table = logs.length
    ? `<table class="simple-table"><tr><th>日時</th><th>種類</th><th>答え</th><th>間隔</th><th>易しさ</th><th>時間</th></tr>${[...logs]
        .reverse()
        .map(
          (l) =>
            `<tr><td>${fmtDateTime(l.at)}</td><td>${LOG_TYPES[l.type] || ''}</td><td>${EASES[l.ease] || '—'}</td><td>${l.ivl < 0 ? fmtSpan(-l.ivl) : l.ivl ? fmtSpan(l.ivl * 86400) : '—'}</td><td>${l.factor ? `${Math.round(l.factor / 10)}%` : ''}</td><td>${fmtDuration(l.time || 0)}</td></tr>`
        )
        .join('')}</table>`
    : '<div class="sub">まだ答えていません</div>';
  dialog({
    title: 'カードの情報',
    wide: true,
    body: `<div class="sub" style="font-weight:600">${esc(stripHtml(n.fields[nt.sortIdx || 0] || '').slice(0, 80))}</div><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="label">これまでの答え</div>${table}`,
  });
}
