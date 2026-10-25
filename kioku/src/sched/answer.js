// 答えたあとのカードの状態を決める（Anki の SM-2 と FSRS）
import { nextMemory, intervalFor, weights } from './fsrs.js';
import { seeded, dayNumber } from '../util.js';

// カードの種類
export const NEW = 0;
export const LRN = 1;
export const REV = 2;
export const RELRN = 3;
// 出す列
export const Q_NEW = 0;
export const Q_LRN = 1;
export const Q_REV = 2;
export const Q_DAYLRN = 3;
export const Q_SUSPENDED = -1;
export const Q_SIB_BURIED = -2;
export const Q_BURIED = -3;

const FUZZ = [
  [2.5, 7, 0.15],
  [7, 20, 0.1],
  [20, Infinity, 0.05],
];

export function fuzzRange(ivl) {
  if (ivl < 2.5) return [Math.round(ivl), Math.round(ivl)];
  let delta = 1;
  for (const [s, e, f] of FUZZ) delta += f * Math.max(0, Math.min(ivl, e) - s);
  const lo = Math.max(2, Math.round(ivl - delta));
  const hi = Math.round(ivl + delta);
  return [lo, Math.max(lo, hi)];
}

function fuzz(ivl, rnd, minIvl, maxIvl) {
  const [lo, hi] = fuzzRange(ivl);
  const lo2 = Math.max(minIvl, lo);
  const hi2 = Math.min(maxIvl, Math.max(lo2, hi));
  return Math.min(maxIvl, Math.max(1, Math.floor(rnd() * (hi2 - lo2 + 1)) + lo2));
}

export function isLeech(lapses, threshold) {
  if (!threshold) return false;
  return lapses >= threshold && (lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}

function hardDelay(steps, idx) {
  if (idx === 0) return steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(steps[0] * 1.5, steps[0] + 1440);
  return steps[Math.min(idx, steps.length - 1)];
}

/**
 * @param card いまのカード（書きかえない）
 * @param grade 1=もう一度 2=難しい 3=正解 4=簡単
 * @param o {preset, now, today, fsrs}
 * @returns {{card, log, leech:boolean}}
 */
export function answer(card, grade, o) {
  const p = o.preset;
  const now = o.now;
  const today = o.today;
  const c = { ...card };
  const rnd = seeded(card.id / 1000 + card.reps * 7919 + grade);
  const maxIvl = Math.max(1, p.maxIvl || 36500);
  const dr = p.desiredRetention || 0.9;
  const w = weights(p.fsrsWeights);
  const wasNew = card.type === NEW;
  const lastIvl = card.type === REV ? card.ivl : card.type === RELRN ? card.ivl : 0;
  let logType = card.type === REV ? 1 : card.type === RELRN ? 2 : 0;
  let leech = false;

  // FSRS: 覚えている強さを先に新しくする
  const lastDay = card.lastReview ? dayNumber(card.lastReview, o.rollover ?? 4) : null;
  const elapsed = lastDay == null ? (card.type === REV ? card.ivl : 0) : today - lastDay;
  const memFor = (g) => (o.fsrs ? nextMemory(w, card.s ? { s: card.s, d: card.d } : null, elapsed, g) : null);
  const fsrsIvl = (g) => {
    const m = memFor(g);
    return Math.min(maxIvl, Math.max(1, Math.round(intervalFor(m.s, dr))));
  };

  const setLearn = (mins) => {
    if (mins >= 1440) {
      c.queue = Q_DAYLRN;
      c.due = today + Math.max(1, Math.round(mins / 1440));
    } else {
      c.queue = Q_LRN;
      c.due = now + Math.round(mins * 60000);
    }
  };
  const graduate = (ivl) => {
    c.type = REV;
    c.queue = Q_REV;
    c.ivl = Math.min(maxIvl, Math.max(1, Math.round(ivl)));
    c.due = today + c.ivl;
    c.left = 0;
  };

  if (card.type === NEW || card.type === LRN) {
    const steps = p.learnSteps || [];
    if (wasNew) {
      c.type = LRN;
      c.left = steps.length;
      c.factor = Math.round((p.startEase || 2.5) * 1000);
    }
    const left = wasNew ? steps.length : card.left || 0;
    const idx = Math.max(0, steps.length - left);
    // 卒業したときの間隔
    let goodIvl = p.graduatingIvl || 1;
    let easyIvl = p.easyIvl || 4;
    if (o.fsrs) {
      goodIvl = fsrsIvl(3);
      easyIvl = Math.max(goodIvl + 1, fsrsIvl(4));
    } else if (easyIvl <= goodIvl) easyIvl = goodIvl + 1;
    if (!steps.length) {
      if (grade === 4) graduate(easyIvl);
      else graduate(grade === 1 && o.fsrs ? fsrsIvl(1) : goodIvl);
    } else if (grade === 1) {
      c.type = LRN;
      c.left = steps.length;
      setLearn(steps[0]);
    } else if (grade === 2) {
      c.type = LRN;
      c.left = left;
      setLearn(hardDelay(steps, idx));
    } else if (grade === 3) {
      if (left - 1 <= 0) graduate(goodIvl);
      else {
        c.type = LRN;
        c.left = left - 1;
        setLearn(steps[idx + 1]);
      }
    } else {
      graduate(easyIvl);
    }
    if (c.type === REV && o.fsrs && c.ivl > 2) {
      c.ivl = fuzz(c.ivl, rnd, 1, maxIvl);
      c.due = today + c.ivl;
    }
  } else if (card.type === RELRN) {
    const steps = p.relearnSteps || [];
    const left = card.left || 0;
    const idx = Math.max(0, steps.length - left);
    if (!steps.length || grade === 4) {
      graduate(grade === 4 ? card.ivl + 1 : card.ivl);
    } else if (grade === 1) {
      c.left = steps.length;
      setLearn(steps[0]);
    } else if (grade === 2) {
      setLearn(hardDelay(steps, idx));
    } else if (left - 1 <= 0) {
      graduate(o.fsrs ? Math.max(1, Math.min(card.ivl, fsrsIvl(3))) : card.ivl);
    } else {
      c.left = left - 1;
      setLearn(steps[idx + 1]);
    }
  } else {
    // 復習
    const minIvl = Math.max(1, p.minIvl || 1);
    const early = card.due > today;
    const overdue = Math.max(0, today - card.due);
    const ease = (card.factor || 2500) / 1000;
    const mod = p.ivlModifier || 1;
    let hardI;
    let goodI;
    let easyI;
    if (o.fsrs) {
      hardI = fsrsIvl(2);
      goodI = fsrsIvl(3);
      easyI = fsrsIvl(4);
      hardI = Math.min(hardI, goodI);
      goodI = Math.max(hardI + 1, goodI);
      easyI = Math.max(goodI + 1, easyI);
    } else {
      const base = early ? Math.max(1, card.ivl - (card.due - today)) : card.ivl;
      const hf = p.hardFactor || 1.2;
      hardI = Math.max(early ? 1 : hf > 1 ? card.ivl + 1 : 1, base * hf * mod);
      goodI = Math.max(hardI + 1, (base + overdue / 2) * ease * mod);
      easyI = Math.max(goodI + 1, (base + overdue) * ease * (p.easyBonus || 1.3) * mod);
      if (early) {
        goodI = Math.max(card.ivl, goodI);
        easyI = Math.max(goodI + 1, easyI);
      }
    }
    const f = (v) => fuzz(Math.min(maxIvl, v), rnd, minIvl, maxIvl);
    if (grade === 1) {
      c.lapses = (card.lapses || 0) + 1;
      c.factor = Math.max(1300, (card.factor || 2500) - 200);
      const lapseIvl = o.fsrs ? Math.min(card.ivl, fsrsIvl(1)) : Math.round(card.ivl * (p.lapseMult || 0));
      c.ivl = Math.max(minIvl, lapseIvl, 1);
      leech = isLeech(c.lapses, p.leechThreshold);
      const steps = p.relearnSteps || [];
      if (steps.length) {
        c.type = RELRN;
        c.left = steps.length;
        setLearn(steps[0]);
      } else {
        graduate(c.ivl);
      }
    } else {
      const hf = f(hardI);
      const gf = Math.max(hf + 1, f(goodI));
      const ef = Math.max(gf + 1, f(easyI));
      const final = grade === 2 ? hf : grade === 3 ? gf : ef;
      if (grade === 2) c.factor = Math.max(1300, (card.factor || 2500) - 150);
      if (grade === 4) c.factor = (card.factor || 2500) + 150;
      graduate(Math.min(maxIvl, final));
    }
  }

  if (o.fsrs) {
    const m = memFor(grade);
    c.s = m.s;
    c.d = m.d;
  }
  c.reps = (card.reps || 0) + 1;
  c.lastReview = now;
  if (o.cramming) logType = 3;
  const ivlForLog = c.queue === Q_LRN ? -Math.round((c.due - now) / 1000) : c.ivl;
  const log = {
    type: logType,
    ease: grade,
    ivl: ivlForLog,
    lastIvl,
    factor: c.factor,
    newCard: wasNew,
  };
  return { card: c, log, leech };
}

/** 4つのボタンの、次に出るまでの秒数 */
export function nextIntervals(card, o) {
  return [1, 2, 3, 4].map((g) => {
    const { card: c } = answer(card, g, o);
    if (c.queue === Q_LRN) return (c.due - o.now) / 1000;
    return (c.due - o.today) * 86400;
  });
}
