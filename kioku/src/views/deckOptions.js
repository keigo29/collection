// デッキの設定（Anki の「オプション」）
import { col } from '../col.js';
import { dialog, el, esc, options, switchHtml, promptDialog, confirmDialog, toast } from '../ui/dom.js';
import { defaultPreset } from '../stock.js';
import { DEFAULT_W } from '../sched/fsrs.js';
import { newId } from '../util.js';
import { nav } from '../nav.js';

const steps = (arr) => (arr || []).map((m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join(' ');
function parseSteps(s) {
  const out = [];
  for (const t of s.trim().split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(t);
    if (!m) throw new Error(`「${t}」は読めません。例：1m 10m 1d`);
    const v = Number(m[1]);
    const u = (m[2] || 'm').toLowerCase();
    out.push(u === 's' ? v / 60 : u === 'h' ? v * 60 : u === 'd' ? v * 1440 : v);
  }
  return out;
}

function num(id, label, help, value, { step = 1, min = 0, max = 99999 } = {}) {
  return `<div class="setting"><div class="txt"><b>${label}</b>${help ? `<span>${help}</span>` : ''}</div><div class="ctl"><input class="input sm" type="number" id="${id}" value="${value}" step="${step}" min="${min}" max="${max}"></div></div>`;
}
function txt(id, label, help, value) {
  return `<div class="setting"><div class="txt"><b>${label}</b>${help ? `<span>${help}</span>` : ''}</div><div class="ctl"><input class="input sm" id="${id}" value="${esc(value)}"></div></div>`;
}
function sel(id, label, help, list, value) {
  return `<div class="setting"><div class="txt"><b>${label}</b>${help ? `<span>${help}</span>` : ''}</div><div class="ctl"><select class="input sm" id="${id}">${options(list, value)}</select></div></div>`;
}
function sw(id, label, help, value) {
  return `<div class="setting"><div class="txt"><b>${label}</b>${help ? `<span>${help}</span>` : ''}</div><div class="ctl auto">${switchHtml(id, value)}</div></div>`;
}

export async function openDeckOptions(did) {
  const deck = col.decks.get(did);
  if (!deck || deck.filtered) return;
  let pid = deck.presetId && col.presets.has(deck.presetId) ? deck.presetId : col.defaultPresetId();
  const body = el('<div class="stack"></div>');
  const users = (id) => [...col.decks.values()].filter((d) => !d.filtered && (d.presetId || col.defaultPresetId()) === id).length;

  const draw = () => {
    const p = { ...defaultPreset(), ...col.presets.get(pid) };
    const presets = [...col.presets.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    body.innerHTML = `
      <div class="row"><div class="field grow"><label>使う設定（${users(pid)} 個のデッキで使っています）</label><select class="input" id="preset">${options(presets.map((x) => [x.id, x.name]), pid)}</select></div></div>
      <div class="row wrap"><button class="btn sm" data-a="add">新しい設定</button><button class="btn sm" data-a="clone">複製</button><button class="btn sm" data-a="rename">名前を変える</button><button class="btn sm danger" data-a="del">削除</button></div>
      <div class="card inset"><h2>1日の上限</h2>
        ${num('newPerDay', '新しいカード', '1日に新しく見るカードの数', p.newPerDay)}
        ${num('revPerDay', '復習', '1日におさらいするカードの数のいちばん多い数', p.revPerDay)}
      </div>
      <div class="card inset"><h2>新しいカード</h2>
        ${txt('learnSteps', '学習のステップ', '覚えるまでに出す間隔。例：1m 10m（m=分 h=時間 d=日）', steps(p.learnSteps))}
        ${num('graduatingIvl', '卒業の間隔（日）', 'ステップを終えたときの次の間隔', p.graduatingIvl, { min: 1 })}
        ${num('easyIvl', '「簡単」の間隔（日）', 'はじめて「簡単」を押したときの間隔', p.easyIvl, { min: 1 })}
        ${sel('insertOrder', '足したカードの順番', '', [['due', '足した順'], ['random', 'ばらばら']], p.insertOrder)}
      </div>
      <div class="card inset"><h2>忘れたとき</h2>
        ${txt('relearnSteps', '再学習のステップ', '忘れたカードをもう一度覚える間隔', steps(p.relearnSteps))}
        ${num('minIvl', 'いちばん短い間隔（日）', '再学習のあとの間隔', p.minIvl, { min: 1 })}
        ${num('lapseMult', '新しい間隔の割合', '忘れたとき、前の間隔にかける数（0 なら最短）', p.lapseMult, { step: 0.05, max: 1 })}
        ${num('leechThreshold', '苦手とみなす回数', 'この回数忘れると「苦手」にします', p.leechThreshold, { min: 1 })}
        ${sel('leechAction', '苦手のときにすること', '', [['tag', 'タグ（leech）を付けるだけ'], ['suspend', '保留にする']], p.leechAction)}
      </div>
      <div class="card inset"><h2>出す順番</h2>
        ${sel('gatherOrder', '新しいカードの集め方', '', [['deck', 'デッキの順'], ['random', 'ばらばら']], p.gatherOrder)}
        ${sel('newSort', '新しいカードの並べ方', '', [['template', '足した順（カードの型ごと）'], ['due', '足した順'], ['random', 'ばらばら']], p.newSort)}
        ${sel('newMix', '新しいカードと復習', '', [['mix', '混ぜる'], ['after', '復習のあと'], ['before', '復習の前']], p.newMix)}
        ${sel('reviewSort', '復習の並べ方', '', [['due', '期日の順'], ['overdue', '遅れている順'], ['ascIvl', '間隔の短い順'], ['descIvl', '間隔の長い順'], ['descEase', '難しい順'], ['random', 'ばらばら']], p.reviewSort)}
      </div>
      <div class="card inset"><h2>同じノートのカード</h2>
        ${sw('buryNew', '新しいカードは同じ日に出さない', '裏表などのカードを、次の日にまわします', p.buryNew)}
        ${sw('buryRev', '復習も同じ日に出さない', '', p.buryRev)}
        ${sw('buryInterday', '日をまたぐ学習中のカードも', '', p.buryInterday)}
      </div>
      <div class="card inset"><h2>音と時間</h2>
        ${sw('autoplay', '音を自動で流す', '', p.autoplay !== false)}
        ${sw('replayQuestion', '裏でも表の音を流す', '', p.replayQuestion !== false)}
        ${sw('showTimer', '時間を出す', '', p.showTimer)}
        ${num('maxAnswerSecs', '記録する時間の上限（秒）', 'これより長くかかっても、この秒数で記録します', p.maxAnswerSecs, { min: 10 })}
        ${num('autoAdvanceQ', '自動で答えを出す（秒）', '0 なら使わない', p.autoAdvanceQ, { step: 0.5 })}
        ${num('autoAdvanceA', '自動で「正解」にする（秒）', '0 なら使わない', p.autoAdvanceA, { step: 0.5 })}
      </div>
      <div class="card inset"><h2>FSRS（新しい計算のしかた）</h2>
        ${sw('fsrs', 'FSRS を使う（すべてのデッキ）', '覚えている強さを推定して、思い出せる見こみが決めた割合になる日に出します', col.conf.fsrs)}
        ${num('desiredRetention', '思い出したい割合', '0.9 なら、9割は思い出せる日に出します。上げると復習がふえます', p.desiredRetention, { step: 0.01, min: 0.7, max: 0.99 })}
        <div class="field" style="padding-top:8px"><label>パラメーター（19個、空ならふつうの値）</label><textarea class="input code" id="fsrsWeights" rows="2" placeholder="${DEFAULT_W.join(', ')}">${p.fsrsWeights ? p.fsrsWeights.join(', ') : ''}</textarea></div>
      </div>
      <div class="card inset"><h2>上級（SM-2）</h2>
        ${num('startEase', 'はじめの易しさ', '', p.startEase, { step: 0.05, min: 1.31 })}
        ${num('easyBonus', '「簡単」のボーナス', '', p.easyBonus, { step: 0.05, min: 1 })}
        ${num('hardFactor', '「難しい」の割合', '', p.hardFactor, { step: 0.05, min: 0.5 })}
        ${num('ivlModifier', '間隔にかける数', '', p.ivlModifier, { step: 0.05, min: 0.5 })}
        ${num('maxIvl', 'いちばん長い間隔（日）', '', p.maxIvl, { min: 1 })}
      </div>
      <div class="field"><label>このデッキの説明（学習の前に出ます）</label><textarea class="input" id="desc" rows="2">${esc(deck.desc || '')}</textarea></div>
      ${col.childDecks(did).length ? `<div class="setting"><div class="txt"><b>下のデッキにも同じ設定を使う</b></div><div class="ctl auto">${switchHtml('applyKids', false)}</div></div>` : ''}`;
    body.querySelector('#preset').onchange = (e) => {
      save(false);
      pid = Number(e.target.value) || e.target.value;
      draw();
    };
  };

  const read = () => {
    const g = (id) => body.querySelector(`#${id}`);
    const n = (id) => Number(g(id).value);
    const b = (id) => g(id).checked;
    const w = g('fsrsWeights').value.trim();
    let weights = null;
    if (w) {
      weights = w.split(/[\s,]+/).map(Number);
      if (weights.length < 19 || weights.some((x) => !Number.isFinite(x))) throw new Error('FSRS のパラメーターは 19 個の数を並べてください');
    }
    return {
      newPerDay: n('newPerDay'),
      revPerDay: n('revPerDay'),
      learnSteps: parseSteps(g('learnSteps').value),
      graduatingIvl: Math.max(1, n('graduatingIvl')),
      easyIvl: Math.max(1, n('easyIvl')),
      insertOrder: g('insertOrder').value,
      relearnSteps: parseSteps(g('relearnSteps').value),
      minIvl: Math.max(1, n('minIvl')),
      lapseMult: n('lapseMult'),
      leechThreshold: n('leechThreshold'),
      leechAction: g('leechAction').value,
      gatherOrder: g('gatherOrder').value,
      newSort: g('newSort').value,
      newMix: g('newMix').value,
      reviewSort: g('reviewSort').value,
      buryNew: b('buryNew'),
      buryRev: b('buryRev'),
      buryInterday: b('buryInterday'),
      autoplay: b('autoplay'),
      replayQuestion: b('replayQuestion'),
      showTimer: b('showTimer'),
      maxAnswerSecs: n('maxAnswerSecs'),
      autoAdvanceQ: n('autoAdvanceQ'),
      autoAdvanceA: n('autoAdvanceA'),
      desiredRetention: Math.min(0.99, Math.max(0.7, n('desiredRetention'))),
      fsrsWeights: weights,
      startEase: n('startEase'),
      easyBonus: n('easyBonus'),
      hardFactor: n('hardFactor'),
      ivlModifier: n('ivlModifier'),
      maxIvl: n('maxIvl'),
      _fsrs: b('fsrs'),
      _desc: g('desc').value,
      _kids: g('applyKids')?.checked,
    };
  };

  const save = (final = true) => {
    const v = read();
    const { _fsrs, _desc, _kids, ...p } = v;
    col.transact('デッキの設定', () => {
      col.put('presets', { ...col.presets.get(pid), ...p });
      if (final) {
        col.put('decks', { ...col.decks.get(did), presetId: pid, desc: _desc });
        if (_kids) for (const id of col.deckTreeIds(did)) if (id !== did && !col.decks.get(id).filtered) col.put('decks', { ...col.decks.get(id), presetId: pid });
        if (_fsrs !== col.conf.fsrs) col.setConf({ fsrs: _fsrs });
      }
    });
  };

  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    try {
      save(false);
    } catch (err) {
      return toast(err.message, { warn: true });
    }
    if (a === 'add' || a === 'clone') {
      const name = await promptDialog(a === 'add' ? '新しい設定' : '設定を複製', { label: '名前', value: a === 'clone' ? `${col.presets.get(pid).name} のコピー` : '' });
      if (!name) return;
      const id = newId();
      col.put('presets', { ...(a === 'add' ? defaultPreset() : col.presets.get(pid)), id, name });
      pid = id;
      draw();
    }
    if (a === 'rename') {
      const name = await promptDialog('名前を変える', { label: '名前', value: col.presets.get(pid).name });
      if (!name) return;
      col.put('presets', { ...col.presets.get(pid), name });
      draw();
    }
    if (a === 'del') {
      if (col.presets.size <= 1) return toast('設定は1つ以上必要です', { warn: true });
      if (!(await confirmDialog('設定を削除', `「${esc(col.presets.get(pid).name)}」を消します。使っていたデッキは別の設定になります。`, { ok: '削除', danger: true }))) return;
      const old = pid;
      col.transact('設定の削除', () => {
        col.remove('presets', old);
        const fallback = col.defaultPresetId();
        for (const d of col.decks.values()) if (d.presetId === old) col.put('decks', { ...d, presetId: fallback });
      });
      pid = col.defaultPresetId();
      draw();
    }
  });
  draw();
  const v = await dialog({
    title: `${deck.name.split('::').pop()} の設定`,
    body,
    wide: true,
    buttons: [
      { label: 'ふつうに戻す', value: 'reset', left: true },
      { label: 'キャンセル', value: null },
      { label: '保存', kind: 'primary', value: 'save' },
    ],
    beforeClose: (val) => {
      if (val === 'reset') {
        const keep = col.presets.get(pid);
        col.put('presets', { ...defaultPreset(), id: pid, name: keep.name });
        draw();
        return false;
      }
      if (val === 'save') {
        try {
          save(true);
        } catch (err) {
          toast(err.message, { warn: true });
          return false;
        }
      }
      return true;
    },
  });
  if (v === 'save') {
    toast('設定を保存しました');
    if (!location.hash.startsWith('#/study')) nav.rerender();
  }
}
