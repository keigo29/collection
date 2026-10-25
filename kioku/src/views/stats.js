// 記録（グラフ）
import { col } from '../col.js';
import { el, icon, esc, seg, wireSeg, options } from '../ui/dom.js';
import { columns, stackBar, heatmap, seriesColors, hideTip } from '../ui/chart.js';
import { fmtDuration, fmtDay, dayNumber, plural, DAY } from '../util.js';
import { studiedToday } from '../sched/queue.js';

let scope = 'all';
let range = 30;
let ro = null;

export function render(main) {
  const decks = col.sortedDecks();
  const page = el(`<div class="page">
    <div class="toolbar"><h1>記録</h1><div class="grow"></div>
      <select class="input sm" id="scope" style="width:auto;max-width:220px">${options([['all', 'すべてのデッキ'], ...decks.map((d) => [d.id, d.name])], scope)}</select>
      ${seg('range', [[30, '1か月'], [90, '3か月'], [365, '1年'], [0, 'すべて']], range)}
    </div>
    <div id="body" class="stack"></div>
  </div>`);
  main.appendChild(page);
  page.querySelector('#scope').onchange = (e) => {
    scope = e.target.value;
    draw(page);
  };
  wireSeg(page, 'range', (v) => {
    range = Number(v);
    draw(page);
  });
  draw(page);
  ro?.disconnect();
  let w = page.clientWidth;
  ro = new ResizeObserver(() => {
    if (Math.abs(page.clientWidth - w) > 30 && document.body.contains(page)) {
      w = page.clientWidth;
      draw(page);
    }
  });
  ro.observe(page);
}

export function leave() {
  ro?.disconnect();
  hideTip();
  return true;
}

function draw(page) {
  const body = page.querySelector('#body');
  body.innerHTML = '';
  const C = seriesColors();
  const roll = col.conf.rollover;
  const today = col.today();
  const ids = scope === 'all' ? null : col.deckTreeIds(Number(scope));
  const cards = [...col.cards.values()].filter((c) => !ids || ids.has(c.did) || ids.has(c.odid));
  const cardSet = new Set(cards.map((c) => c.id));
  const logs = [...col.revlog.values()].filter((r) => cardSet.has(r.cid) || (!ids && !col.cards.has(r.cid)));
  const firstDay = logs.length ? Math.min(...logs.map((r) => dayNumber(r.at, roll))) : today;
  const span = range || Math.max(30, today - firstDay + 1);
  const start = today - span + 1;

  // ---- 今日
  const st = studiedToday(col).all;
  const t = el(`<div class="card"><h2>${icon('calendar')}今日</h2><div class="stat-row">
    <div class="stat"><span class="k">答えた数</span><span class="v">${plural(st.count)}</span><span class="d">${fmtDuration(st.time)}</span></div>
    <div class="stat"><span class="k">「もう一度」</span><span class="v">${st.count ? Math.round((st.again / st.count) * 100) : 0}%</span><span class="d">${st.again} 回</span></div>
    <div class="stat"><span class="k">新規・学習</span><span class="v">${plural(st.lrn)}</span><span class="d">再学習 ${st.relrn}</span></div>
    <div class="stat"><span class="k">復習</span><span class="v">${plural(st.rev)}</span><span class="d">${st.mature ? `育ったカードの正解 ${Math.round((st.correctMature / st.mature) * 100)}%` : '　'}</span></div>
  </div></div>`);
  body.appendChild(t);

  // ---- これからの予定
  const fwd = Math.min(range || 365, 365);
  const due = new Array(fwd).fill(0).map(() => [0, 0]);
  let overdue = 0;
  for (const c of cards) {
    if (c.queue === 2 || c.queue === 3) {
      const d = (c.odid && c.odue ? c.odue : c.due) - today;
      if (d < 0) overdue++;
      const k = Math.max(0, d);
      if (k < fwd) due[k][c.ivl >= 21 ? 1 : 0]++;
    } else if (c.queue === 1) due[0][0]++;
  }
  body.appendChild(
    chartCard(
      '予定',
      `これから ${fwd} 日に出る復習の数${overdue ? `（遅れている ${overdue} 枚は今日に入っています）` : ''}`,
      (h) =>
        columns(
          h,
          due.map((v, i) => ({ label: i === 0 ? '今日' : `${i}日後`, tip: `${fmtDay(today + i)}（${i === 0 ? '今日' : `${i}日後`}）`, values: v })),
          [
            { name: '若い（21日未満）', color: C[0] },
            { name: '育った（21日以上）', color: C[3] },
          ],
          { unit: '枚' }
        ),
      [
        ['若い（21日未満）', C[0]],
        ['育った（21日以上）', C[3]],
      ]
    )
  );

  // ---- 毎日の答えた数・時間
  const byDay = new Map();
  const timeDay = new Map();
  for (const r of logs) {
    if (r.type === 4) continue;
    const d = dayNumber(r.at, roll);
    if (d < start) continue;
    if (!byDay.has(d)) byDay.set(d, [0, 0, 0, 0]);
    const k = r.type === 0 ? 0 : r.type === 2 ? 1 : r.type === 3 ? 2 : 3;
    byDay.get(d)[k]++;
    timeDay.set(d, (timeDay.get(d) || 0) + (r.time || 0));
  }
  const group = span > 120 ? 7 : 1;
  const binned = [];
  for (let d = start; d <= today; d += group) {
    const v = [0, 0, 0, 0];
    let tm = 0;
    for (let k = 0; k < group && d + k <= today; k++) {
      const x = byDay.get(d + k);
      if (x) x.forEach((n, i) => (v[i] += n));
      tm += timeDay.get(d + k) || 0;
    }
    const ago = today - d;
    binned.push({ label: ago === 0 ? '今日' : group > 1 ? fmtDay(d).slice(5) : `${ago}日前`, tip: group > 1 ? `${fmtDay(d)} からの1週間` : fmtDay(d), values: v, time: tm });
  }
  const typeSeries = [
    { name: '学習', color: C[0] },
    { name: '再学習', color: C[1] },
    { name: 'フィルター', color: C[2] },
    { name: '復習', color: C[3] },
  ];
  const days = byDay.size;
  const total = [...byDay.values()].reduce((a, v) => a + v.reduce((x, y) => x + y, 0), 0);
  body.appendChild(
    chartCard('答えた数', `${group > 1 ? '1週間ごと・' : ''}学んだ日 ${days} / ${span} 日・1日に平均 ${days ? Math.round(total / days) : 0} 枚`, (h) => columns(h, binned, typeSeries, { unit: '枚' }), typeSeries.map((s) => [s.name, s.color]))
  );
  const totalTime = [...timeDay.values()].reduce((a, b) => a + b, 0);
  body.appendChild(
    chartCard(`学んだ時間`, `合計 ${fmtDuration(totalTime)}・学んだ日に平均 ${days ? fmtDuration(totalTime / days) : '0分'}`, (h) =>
      columns(
        h,
        binned.map((b) => ({ ...b, values: [Math.round((b.time / 60000) * 10) / 10] })),
        [{ name: '時間', color: C[0] }],
        { unit: '分' }
      )
    )
  );

  // ---- カレンダー
  const heatDays = new Map();
  const yearStart = today - 364;
  for (const r of logs) {
    if (r.type === 4) continue;
    const d = dayNumber(r.at, roll);
    if (d >= yearStart) heatDays.set(d, (heatDays.get(d) || 0) + 1);
  }
  let streak = 0;
  let sd = heatDays.get(today) ? today : today - 1;
  while (heatDays.get(sd)) {
    streak++;
    sd--;
  }
  body.appendChild(
    chartCard('カレンダー', `この1年で学んだ日 ${heatDays.size} 日・続けている日数 ${streak} 日`, (h) =>
      heatmap(h, heatDays, { startDay: yearStart, endDay: today, color: C[3], tipFor: (d, v) => `<b>${fmtDay(d)}</b><div>${v} 枚</div>` })
    )
  );

  // ---- カードの数・間隔・易しさ
  const grid = el('<div class="grid2"></div>');
  const counts = { new: 0, lrn: 0, young: 0, mature: 0, susp: 0, buried: 0 };
  for (const c of cards) {
    if (c.queue === -1) counts.susp++;
    else if (c.queue <= -2) counts.buried++;
    else if (c.type === 0) counts.new++;
    else if (c.type === 1 || c.type === 3) counts.lrn++;
    else if (c.ivl >= 21) counts.mature++;
    else counts.young++;
  }
  grid.appendChild(
    chartCard('カードの数', `全部で ${plural(cards.length)} 枚`, (h) =>
      stackBar(h, [
        { name: '新規', value: counts.new, color: C[0] },
        { name: '学習中', value: counts.lrn, color: C[1] },
        { name: '若い', value: counts.young, color: C[2] },
        { name: '育った', value: counts.mature, color: C[3] },
        { name: '保留', value: counts.susp, color: 'var(--g350)' },
        { name: 'あとまわし', value: counts.buried, color: 'var(--g300)' },
      ])
    )
  );
  // 間隔
  const ivls = cards.filter((c) => c.type === 2 || c.type === 3).map((c) => c.ivl);
  const bins = [
    [1, 1, '1日'],
    [2, 3, '2〜3日'],
    [4, 7, '〜1週'],
    [8, 14, '〜2週'],
    [15, 30, '〜1か月'],
    [31, 90, '〜3か月'],
    [91, 180, '〜半年'],
    [181, 365, '〜1年'],
    [366, Infinity, '1年〜'],
  ];
  const avgIvl = ivls.length ? ivls.reduce((a, b) => a + b, 0) / ivls.length : 0;
  grid.appendChild(
    chartCard('間隔', `平均 ${Math.round(avgIvl)} 日・いちばん長い ${ivls.length ? Math.max(...ivls) : 0} 日`, (h) =>
      columns(
        h,
        bins.map(([lo, hi, l]) => ({ label: l, values: [ivls.filter((v) => v >= lo && v <= hi).length] })),
        [{ name: 'カード', color: C[0] }],
        { unit: '枚', height: 160, xLabelEvery: 1 }
      )
    )
  );
  if (col.conf.fsrs) {
    const ds = cards.filter((c) => c.d).map((c) => Math.round(((c.d - 1) / 9) * 100));
    grid.appendChild(
      chartCard('難しさ（FSRS）', ds.length ? `平均 ${Math.round(ds.reduce((a, b) => a + b, 0) / ds.length)}%` : 'まだありません', (h) =>
        columns(
          h,
          [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((lo) => ({ label: `${lo}%`, values: [ds.filter((v) => v >= lo && (v < lo + 10 || (lo === 90 && v <= 100))).length] })),
          [{ name: 'カード', color: C[2] }],
          { unit: '枚', height: 160, xLabelEvery: 1 }
        )
      )
    );
  } else {
    const es = cards.filter((c) => c.type === 2 && c.factor).map((c) => c.factor / 10);
    grid.appendChild(
      chartCard('易しさ', es.length ? `平均 ${Math.round(es.reduce((a, b) => a + b, 0) / es.length)}%` : 'まだありません', (h) =>
        columns(
          h,
          [130, 150, 170, 190, 210, 230, 250, 270, 290, 310].map((lo, i, arr) => ({ label: `${lo}%`, values: [es.filter((v) => v >= lo && (i === arr.length - 1 || v < arr[i + 1])).length] })),
          [{ name: 'カード', color: C[2] }],
          { unit: '枚', height: 160, xLabelEvery: 2 }
        )
      )
    );
  }
  // 時間帯
  const hours = new Array(24).fill(0).map(() => [0, 0]);
  for (const r of logs) {
    if (r.type === 4 || dayNumber(r.at, roll) < start) continue;
    const hr = new Date(r.at).getHours();
    hours[hr][r.ease === 1 ? 1 : 0]++;
  }
  grid.appendChild(
    chartCard('時間帯', '何時に学んだか（正解ともう一度）', (h) =>
      columns(
        h,
        hours.map((v, i) => ({ label: `${i}時`, tip: `${i}時台・正解 ${v[0] + v[1] ? Math.round((v[0] / (v[0] + v[1])) * 100) : 0}%`, values: v })),
        [
          { name: '正解など', color: C[0] },
          { name: 'もう一度', color: C[1] },
        ],
        { unit: '回', height: 160, xLabelEvery: 3 }
      ),
      [
        ['正解など', C[0]],
        ['もう一度', C[1]],
      ]
    )
  );
  // 押したボタン
  const btn = { 0: [0, 0, 0, 0, 0], 1: [0, 0, 0, 0, 0], 2: [0, 0, 0, 0, 0] };
  for (const r of logs) {
    if (r.type === 4 || dayNumber(r.at, roll) < start || !r.ease) continue;
    const k = r.type === 1 ? (r.lastIvl >= 21 ? 2 : 1) : 0;
    btn[k][r.ease]++;
  }
  const btnRow = (name, a) => {
    const sum = a.reduce((x, y) => x + y, 0);
    const pct = (n) => (sum ? `${Math.round((n / sum) * 100)}%` : '—');
    return `<tr><td>${name}</td>${[1, 2, 3, 4].map((g) => `<td>${a[g]}<span class="sub">（${pct(a[g])}）</span></td>`).join('')}<td><b>${sum ? Math.round(((sum - a[1]) / sum) * 100) : 0}%</b></td></tr>`;
  };
  grid.appendChild(
    el(`<div class="card"><h2>${icon('keyboard')}押したボタン</h2><div style="overflow-x:auto"><table class="simple-table"><tr><th></th><th>もう一度</th><th>難しい</th><th>正解</th><th>簡単</th><th>正しい割合</th></tr>
      ${btnRow('学習中', btn[0])}${btnRow('若い', btn[1])}${btnRow('育った', btn[2])}</table></div></div>`)
  );
  // 本当に覚えていた割合
  const ret = (from, mature) => {
    let ok = 0;
    let n = 0;
    for (const r of logs) {
      if (r.type !== 1 || dayNumber(r.at, roll) < from) continue;
      if (mature !== r.lastIvl >= 21) continue;
      n++;
      if (r.ease > 1) ok++;
    }
    return n ? `${Math.round((ok / n) * 1000) / 10}%<span class="sub small">（${n}）</span>` : '—';
  };
  grid.appendChild(
    el(`<div class="card"><h2>${icon('check')}覚えていた割合</h2><table class="simple-table"><tr><th></th><th>若い</th><th>育った</th></tr>
      ${[
        ['今日', today],
        ['昨日から', today - 1],
        ['1週間', today - 6],
        ['1か月', today - 29],
        ['1年', today - 364],
      ]
        .map(([l, d]) => `<tr><td>${l}</td><td>${ret(d, false)}</td><td>${ret(d, true)}</td></tr>`)
        .join('')}</table><div class="sub small" style="margin-top:8px">復習で「もう一度」以外を押した割合です。育った＝間隔が21日以上</div></div>`)
  );
  body.appendChild(grid);
  // グラフは置いてから描く（幅を測るため）
  for (const fn of pending.splice(0)) fn();
}

const pending = [];
function chartCard(title, sub, drawFn, legend = null) {
  const c = el(`<div class="card"><h2>${esc(title)} <span class="sub small">${esc(sub)}</span></h2><div class="plot"></div>${legend ? `<div class="chart-legend">${legend.map(([n, col2]) => `<span><i style="background:${col2}"></i>${esc(n)}</span>`).join('')}</div>` : ''}</div>`);
  pending.push(() => drawFn(c.querySelector('.plot')));
  return c;
}

export { DAY };
