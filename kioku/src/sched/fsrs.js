// FSRS-5（Anki の新しい出題の計算）。覚えている強さ（S）と難しさ（D）から次の間隔を決める

export const DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898,
  0.51655, 0.6621,
];

const DECAY = -0.5;
const FACTOR = 19 / 81;

const clampD = (d) => Math.min(10, Math.max(1, d));

export function weights(w) {
  return Array.isArray(w) && w.length >= 19 ? w : DEFAULT_W;
}

export function retrievability(elapsedDays, s) {
  return Math.pow(1 + (FACTOR * elapsedDays) / s, DECAY);
}

export function intervalFor(s, desired) {
  return (s / FACTOR) * (Math.pow(desired, 1 / DECAY) - 1);
}

const initS = (w, g) => Math.max(0.1, w[g - 1]);
const initD = (w, g) => clampD(w[4] - Math.exp(w[5] * (g - 1)) + 1);

function nextD(w, d, g) {
  const delta = -w[6] * (g - 3);
  const dp = d + (delta * (10 - d)) / 9;
  return clampD(w[7] * initD(w, 4) + (1 - w[7]) * dp);
}

function recallS(w, d, s, r, g) {
  const hard = g === 2 ? w[15] : 1;
  const easy = g === 4 ? w[16] : 1;
  return s * (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hard * easy + 1);
}

function forgetS(w, d, s, r) {
  const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  return Math.min(sf, s / Math.exp(w[17] * w[18]));
}

function shortS(w, s, g) {
  return s * Math.exp(w[17] * (g - 3 + w[18]));
}

/**
 * 答えたあとの覚えている強さと難しさ
 * @param {{s?:number,d?:number}|null} mem いまの状態（なければ初めて）
 * @param {number} elapsed 前に答えてからの日数
 */
export function nextMemory(wIn, mem, elapsed, g) {
  const w = weights(wIn);
  if (!mem || !mem.s) return { s: initS(w, g), d: initD(w, g) };
  const { s, d } = mem;
  const nd = nextD(w, d, g);
  if (elapsed < 1) return { s: Math.max(0.1, shortS(w, s, g)), d: nd };
  const r = retrievability(elapsed, s);
  const ns = g === 1 ? forgetS(w, d, s, r) : recallS(w, d, s, r, g);
  return { s: Math.max(0.1, ns), d: nd };
}
