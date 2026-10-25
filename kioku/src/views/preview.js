// カードの見え方を見る
import { col } from '../col.js';
import { dialog, el, seg, wireSeg } from '../ui/dom.js';
import { renderCard, cardOrds } from '../template.js';
import { renderInto, isNight } from '../ui/cardview.js';

export function previewNote(nt, fields, tags = [], did = col.conf.curDeck, startOrd = null) {
  const ords = cardOrds(nt, fields);
  if (!ords.length) ords.push(0);
  let ord = startOrd != null && ords.includes(startOrd) ? startOrd : ords[0];
  let side = 'q';
  const body = el(`<div class="stack">
    <div class="row wrap">${ords.length > 1 ? seg('ord', ords.map((o) => [o, nt.kind === 'std' ? nt.templates[o]?.name || `カード${o + 1}` : `穴 ${o + 1}`]), ord) : ''}<div class="grow"></div>${seg('side', [['q', '表'], ['a', '裏']], 'q')}</div>
    <div class="preview-box"><div class="cardhost"></div></div></div>`);
  const draw = () => {
    const r = renderCard({ card: { ord, flags: 0 }, note: { fields, tags }, nt, deckName: col.decks.get(did)?.name || '' });
    renderInto(body.querySelector('.cardhost'), side === 'q' ? r.q : r.a, r.css, { night: isNight() });
  };
  wireSeg(body, 'ord', (v) => {
    ord = Number(v);
    draw();
  });
  wireSeg(body, 'side', (v) => {
    side = v;
    draw();
  });
  draw();
  return dialog({ title: '見え方', body, wide: true });
}
