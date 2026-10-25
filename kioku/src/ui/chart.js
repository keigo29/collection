// 小さな SVG のグラフ（棒グラフ・積み上げ・ヒートマップ）
import { esc } from './dom.js';

// 色覚の検査を通した4色（明るい表示／暗い表示）。順番を変えない
export const SERIES = {
  light: ['#005cff', '#ff5a00', '#8600ff', '#00c230'],
  dark: ['#4d8bff', '#f55a0f', '#9d4dff', '#13a83d'],
};
export function seriesColors() {
  const t = document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? SERIES.dark : SERIES.light;
}

let tip = null;
function showTip(html, x, y) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  tip.style.top = `${Math.max(8, y - h - 12)}px`;
}
export function hideTip() {
  if (tip) tip.style.display = 'none';
}

const nice = (max) => {
  if (max <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
};
const compact = (v) => (v >= 10000 ? `${Math.round(v / 1000)}K` : v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(Math.round(v * 10) / 10));

/** 上が丸い棒（下は四角） */
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * 積み上げの縦棒
 * @param host 入れる要素
 * @param data [{label, tip, values:[...]}]
 * @param series [{name, color}]
 */
export function columns(host, data, series, { height = 180, xLabelEvery = null, fmt = compact, unit = '' } = {}) {
  const W = Math.max(280, host.clientWidth || 600);
  const H = height;
  const padL = 34;
  const padB = 22;
  const padT = 8;
  const plotW = W - padL - 4;
  const plotH = H - padB - padT;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(4, nice(Math.max(0, ...totals)));
  const slot = plotW / Math.max(1, data.length);
  const bw = Math.max(1, Math.min(24, slot * 0.72));
  const every = xLabelEvery || Math.max(1, Math.ceil(data.length / Math.floor(plotW / 54)));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4;
    s += `<line class="${i ? 'gridl' : 'axis'}" x1="${padL}" x2="${W - 4}" y1="${y}" y2="${y}"/>`;
    s += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end">${fmt((max * i) / 4)}</text>`;
  }
  data.forEach((d, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    let y = padT + plotH;
    const segs = d.values.map((v, k) => ({ v, k })).filter((p) => p.v > 0);
    segs.forEach((p, j) => {
      const h = (p.v / max) * plotH;
      const top = j === segs.length - 1;
      const gap = j > 0 ? 2 : 0;
      y -= h;
      if (top) s += `<path d="${barPath(x, y, bw, h - gap, 4)}" fill="${series[p.k].color}"/>`;
      else s += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(0, h - gap)}" fill="${series[p.k].color}"/>`;
    });
    if (i % every === 0) s += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    s += `<rect class="hit" data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>`;
  });
  s += '</svg>';
  host.innerHTML = s;
  const svg = host.querySelector('svg');
  svg.addEventListener('pointermove', (e) => {
    const r = e.target.closest?.('.hit');
    if (!r) return hideTip();
    const d = data[Number(r.dataset.i)];
    const rows = series
      .map((se, k) => (d.values[k] ? `<div><span class="dot" style="--c:${se.color};width:8px;height:8px"></span> ${esc(se.name)}　<b>${fmt(d.values[k])}${unit}</b></div>` : ''))
      .join('');
    showTip(`<div><b>${esc(d.tip || d.label)}</b></div>${rows || '<div class="sub">なし</div>'}${series.length > 1 && d.values.filter(Boolean).length > 1 ? `<div>合計　<b>${fmt(d.values.reduce((a, b) => a + b, 0))}${unit}</b></div>` : ''}`, e.clientX, e.clientY);
  });
  svg.addEventListener('pointerleave', hideTip);
}

/** 横の積み上げ1本（カードの数など） */
export function stackBar(host, parts) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  let h = '<div style="display:flex;gap:2px;height:14px;border-radius:999px;overflow:hidden;background:var(--soft)">';
  for (const p of parts) if (p.value) h += `<i style="flex:${p.value};background:${p.color}" title="${esc(p.name)} ${p.value}"></i>`;
  h += '</div><div class="chart-legend">';
  for (const p of parts) h += `<span><i style="background:${p.color}"></i>${esc(p.name)} <b style="color:var(--text)">${p.value.toLocaleString()}</b>（${Math.round((p.value / total) * 100)}%）</span>`;
  host.innerHTML = h + '</div>';
}

/** 1年分のカレンダーの濃さ */
export function heatmap(host, days, { startDay, endDay, color, tipFor }) {
  const max = Math.max(1, ...days.values());
  const first = startDay - ((new Date(startDay * 86400000).getUTCDay() + 7) % 7);
  let h = '<div class="heat">';
  for (let d = first; d <= endDay; d++) {
    const v = days.get(d) || 0;
    const lvl = v ? Math.ceil((v / max) * 4) : 0;
    const bg = lvl ? `color-mix(in srgb, ${color} ${[0, 30, 55, 78, 100][lvl]}%, var(--soft))` : 'var(--soft)';
    h += `<i data-d="${d}" style="background:${bg};${d < startDay ? 'visibility:hidden' : ''}"></i>`;
  }
  host.innerHTML = h + '</div>';
  const el = host.querySelector('.heat');
  el.addEventListener('pointermove', (e) => {
    const c = e.target.closest('[data-d]');
    if (!c) return hideTip();
    showTip(tipFor(Number(c.dataset.d), days.get(Number(c.dataset.d)) || 0), e.clientX, e.clientY);
  });
  el.addEventListener('pointerleave', hideTip);
  el.scrollLeft = el.scrollWidth;
}
