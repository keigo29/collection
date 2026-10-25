// 設定
import { col } from '../col.js';
import { el, icon, esc, seg, wireSeg, switchHtml, toast, confirmDialog, dialog, busy, promptDialog } from '../ui/dom.js';
import { syncSettings, saveSyncSettings, connect } from '../sync.js';
import { listBackups, restoreAuto, makeBackup } from '../io/backup.js';
import { checkDatabase, checkMedia, emptyCards } from '../ops.js';
import { FLAGS } from '../stock.js';
import { fmtDateTime, plural, download, keyLabel } from '../util.js';
import { nav } from '../nav.js';
import { notetypesSection } from './notetypes.js';
import { openImport, openExport } from './io.js';

const TABS = [
  ['general', 'settings', '全体'],
  ['sync', 'cloud', '同期'],
  ['data', 'database', '読み込み・書き出し'],
  ['types', 'file-text', 'ノートの種類'],
  ['tools', 'wrench', '点検'],
  ['help', 'keyboard', 'キーと使い方'],
];

const THEME_KEY = 'kioku.theme';
export function applyTheme(t) {
  let v = t;
  try {
    if (v === undefined) v = localStorage.getItem(THEME_KEY) || 'system';
    else localStorage.setItem(THEME_KEY, v);
  } catch {
    v = v || 'system';
  }
  if (v === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f3f4f5';
  return v;
}

export function side(root, { arg }) {
  const tab = arg || 'general';
  const sec = el(`<div class="side-sec"><div class="side-h"><span>設定</span></div>${TABS.map(([k, ic, n]) => `<a class="nav-item ${k === tab ? 'on' : ''}" href="#/settings/${k}">${icon(ic)}<span class="label">${n}</span></a>`).join('')}</div>`);
  root.appendChild(sec);
}

export function render(main, { arg }) {
  const tab = TABS.some((t) => t[0] === arg) ? arg : 'general';
  const page = el(`<div class="page" style="max-width:820px"><div class="toolbar"><h1>${TABS.find((t) => t[0] === tab)[2]}</h1></div></div>`);
  page.appendChild(el(`<div class="seg show-sm" style="align-self:flex-start">${TABS.map(([k, , n]) => `<button class="${k === tab ? 'on' : ''}" onclick="location.hash='#/settings/${k}'">${n}</button>`).join('')}</div>`));
  main.appendChild(page);
  const redraw = () => {
    main.innerHTML = '';
    render(main, { arg: tab });
  };
  ({ general, sync: syncTab, data, types: (p) => notetypesSection(p, redraw), tools, help })[tab](page, redraw);
}

function general(page) {
  let theme = 'system';
  try {
    theme = localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    /* 保存できない環境 */
  }
  const c = col.conf;
  const card = el(`<div class="card">
    <div class="setting"><div class="txt"><b>表示</b><span>明るい・暗い・端末に合わせる</span></div><div class="ctl auto">${seg('theme', [['system', '端末に合わせる'], ['light', '明るい'], ['dark', '暗い']], theme)}</div></div>
    <div class="setting"><div class="txt"><b>日の切りかわる時刻</b><span>この時刻をすぎると「次の日」になります（夜ふかしの人は遅めに）</span></div><div class="ctl"><select class="input sm" id="rollover">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === c.rollover ? 'selected' : ''}>${h}時</option>`).join('')}</select></div></div>
    <div class="setting"><div class="txt"><b>先に出す学習中のカード（分）</b><span>ほかにカードがないとき、この分だけ先の学習中のカードを出します</span></div><div class="ctl"><input class="input sm" type="number" id="ahead" min="0" value="${c.learnAheadMins ?? 20}"></div></div>
    <div class="setting"><div class="txt"><b>ボタンの上に次の間隔を出す</b></div><div class="ctl auto">${switchHtml('showIvl', c.showIntervals !== false)}</div></div>
    <div class="setting"><div class="txt"><b>FSRS を使う</b><span>覚えている強さから次の日を決める、新しい計算のしかた（くわしくはデッキの設定で）</span></div><div class="ctl auto">${switchHtml('fsrs', !!c.fsrs)}</div></div>
  </div>`);
  const flags = el(`<div class="card"><h2>${icon('flag')}目印の名前</h2><div class="stack tight">${FLAGS.map((f) => `<div class="row"><span class="dot" style="--c:${f.color}"></span><input class="input sm grow" data-flag="${f.n}" value="${esc(c.flagNames?.[f.n] || '')}" placeholder="${f.name}"></div>`).join('')}</div></div>`);
  page.append(card, flags);
  wireSeg(card, 'theme', (v) => applyTheme(v));
  card.querySelector('#rollover').onchange = (e) => {
    col.setConf({ rollover: Number(e.target.value) });
    col.checkDay();
  };
  card.querySelector('#ahead').onchange = (e) => col.setConf({ learnAheadMins: Math.max(0, Number(e.target.value) || 0) });
  card.querySelector('#showIvl').onchange = (e) => col.setConf({ showIntervals: e.target.checked });
  card.querySelector('#fsrs').onchange = (e) => {
    col.setConf({ fsrs: e.target.checked });
    toast(e.target.checked ? 'FSRS を使います。次に答えたときから計算が変わります' : 'もとの計算（SM-2）に戻しました');
  };
  flags.addEventListener('change', (e) => {
    const n = e.target.dataset.flag;
    if (!n) return;
    col.setConf({ flagNames: { ...(col.conf.flagNames || {}), [n]: e.target.value.trim() } });
  });
}

function syncTab(page, redraw) {
  const st = syncSettings();
  const intro = el(`<div class="card stack">
    <div class="row"><span class="dot" style="--c:${st.token ? 'var(--ok)' : 'var(--sub)'}"></span><b class="grow">${st.token ? `${esc(st.login || '')} の GitHub につないでいます` : 'まだつないでいません'}</b>${st.lastSync ? `<span class="sub small">最後の同期 ${fmtDateTime(st.lastSync)}</span>` : ''}</div>
    <div class="sub" style="line-height:1.7">パソコンとスマホで同じカードを使うために、データを <b>GitHub の Gist</b>（ひみつのメモ置き場）に置きます。サーバーを用意しないので、お金はかかりません。<br>鍵（トークン）はこの端末の中だけに保存され、GitHub 以外には送りません。</div>
    ${
      st.token
        ? `<div class="row wrap"><button class="btn primary" data-a="sync">${icon('refresh-cw')}いま同期する</button><button class="btn" data-a="up">${icon('upload')}この端末の中身で上書き</button><button class="btn" data-a="down">${icon('download')}Gist の中身で上書き</button><button class="btn danger" data-a="off">${icon('log-out')}つなぐのをやめる</button></div>
           <div class="setting"><div class="txt"><b>自動で同期する</b><span>開いたときと、学習を終えたときに同期します</span></div><div class="ctl auto">${switchHtml('auto', st.auto !== false)}</div></div>`
        : `<ol class="sub" style="line-height:1.9;margin:0;padding-left:20px">
            <li>GitHub にログインして <a href="https://github.com/settings/tokens/new?scopes=gist&description=KIOKU" target="_blank" rel="noopener">鍵を作るページ</a> を開く</li>
            <li>「gist」だけにチェックが入っていることを確かめ、期限を決めて「Generate token」を押す</li>
            <li>できた鍵（ghp_ ではじまる文字）をここに貼りつける</li>
            <li>ほかの端末でも、同じ鍵を貼りつける</li></ol>
          <div class="row"><input class="input grow" id="token" placeholder="ghp_..." autocomplete="off" spellcheck="false"><button class="btn primary" data-a="connect">つなぐ</button></div>`
    }
  </div>`);
  page.appendChild(intro);
  page.appendChild(
    el(`<div class="card sub small" style="line-height:1.7">${icon('lightbulb')} 同じカードを2つの端末で同時に答えたときは、あとで答えたほうが残ります。画像や音が多いと、同期に時間がかかります。</div>`)
  );
  intro.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'connect') {
      const token = intro.querySelector('#token').value.trim();
      if (!token) return;
      const b = busy('GitHub につないでいます');
      try {
        await connect(token);
        b.done();
        toast('つなぎました。同期します');
        await nav.runSync('merge');
        redraw();
      } catch (err) {
        b.done();
        toast(err.message, { warn: true });
      }
    }
    if (a === 'sync') {
      await nav.runSync('merge');
      redraw();
    }
    if (a === 'up' && (await confirmDialog('この端末の中身で上書き', 'Gist の中身を、この端末の中身で置きかえます。ほかの端末で学んだ分は消えます。', { ok: '上書き', danger: true }))) {
      await nav.runSync('upload');
      redraw();
    }
    if (a === 'down' && (await confirmDialog('Gist の中身で上書き', 'この端末の中身を、Gist の中身で置きかえます。この端末だけで学んだ分は消えます。', { ok: '上書き', danger: true }))) {
      await nav.runSync('download');
      redraw();
    }
    if (a === 'off' && (await confirmDialog('つなぐのをやめる', 'この端末から鍵を消します。Gist のデータはそのまま残ります。', { ok: 'やめる' }))) {
      saveSyncSettings({ token: null, gistId: null, login: null });
      redraw();
    }
  });
  intro.querySelector('#auto')?.addEventListener('change', (e) => saveSyncSettings({ auto: e.target.checked }));
}

async function data(page) {
  const card = el(`<div class="card stack">
    <div class="setting"><div class="txt"><b>読み込む</b><span>Anki のファイル（.apkg・.colpkg）、文字のファイル（.txt・.csv）、KIOKU のバックアップ（.kioku）</span></div><div class="ctl auto"><button class="btn primary" data-a="import">${icon('file-up')}ファイルを選ぶ</button></div></div>
    <div class="setting"><div class="txt"><b>書き出す</b><span>Anki のファイル・バックアップ・文字のファイル</span></div><div class="ctl auto"><button class="btn" data-a="export">${icon('file-down')}書き出す</button></div></div>
    <div class="setting"><div class="txt"><b>いますぐバックアップ</b><span>画像や音も入った .kioku ファイルを保存します</span></div><div class="ctl auto"><button class="btn" data-a="backup">${icon('download')}保存</button></div></div>
  </div>`);
  page.appendChild(card);
  card.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'import') openImport();
    if (a === 'export') openExport();
    if (a === 'backup') {
      const b = busy('バックアップを作っています');
      download(`kioku-バックアップ-${new Date().toISOString().slice(0, 10)}.kioku`, await makeBackup(col));
      b.done();
    }
  });
  const list = await listBackups();
  const auto = el(`<div class="card"><h2>${icon('clock')}自動の控え <span class="sub small">1日に1回、この端末に残します（画像や音はふくみません）</span></h2>${
    list.length
      ? `<table class="simple-table">${list.map((b) => `<tr><td>${fmtDateTime(b.at)}</td><td>ノート ${plural(b.notes)}・カード ${plural(b.cards)}</td><td style="text-align:right"><button class="btn sm" data-r="${b.id}">戻す</button></td></tr>`).join('')}</table>`
      : '<div class="sub">まだありません</div>'
  }</div>`);
  auto.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-r]')?.dataset.r;
    if (!id) return;
    if (!(await confirmDialog('控えから戻す', 'いまのデータは、この控えの中身にすべて入れかわります。', { ok: '戻す', danger: true }))) return;
    await restoreAuto(col, Number(id));
    toast('控えから戻しました');
    nav.go('/decks');
  });
  page.appendChild(auto);
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    page.appendChild(el(`<div class="card sub small">${icon('database')} この端末で使っている大きさ：${((est.usage || 0) / 1048576).toFixed(1)} MB（使える目安 ${((est.quota || 0) / 1073741824).toFixed(1)} GB）・ノート ${plural(col.notes.size)}・カード ${plural(col.cards.size)}・画像や音 ${plural(col.mediaMeta.size)}</div>`));
  }
}

function tools(page) {
  const card = el(`<div class="card stack">
    <div class="setting"><div class="txt"><b>データを点検する</b><span>こわれたところを見つけて直します</span></div><div class="ctl auto"><button class="btn" data-a="db">${icon('wrench')}点検</button></div></div>
    <div class="setting"><div class="txt"><b>画像や音を点検する</b><span>使っていないもの・なくなったものを探します</span></div><div class="ctl auto"><button class="btn" data-a="media">${icon('image')}点検</button></div></div>
    <div class="setting"><div class="txt"><b>空のカードを探す</b><span>表が空になってしまったカードを消します</span></div><div class="ctl auto"><button class="btn" data-a="empty">${icon('square-dashed-mouse-pointer')}探す</button></div></div>
    <div class="setting"><div class="txt"><b>すべてを消す</b><span>この端末のカード・記録・画像をすべて消します</span></div><div class="ctl auto"><button class="btn danger" data-a="wipe">${icon('trash')}消す</button></div></div>
  </div>`);
  page.appendChild(card);
  card.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'db') {
      const r = checkDatabase(col);
      dialog({ title: 'データの点検', body: `<ul style="margin:0;padding-left:20px;line-height:1.8">${r.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` });
    }
    if (a === 'media') {
      const r = checkMedia(col);
      const v = await dialog({
        title: '画像や音の点検',
        body: `<div><b>使っていない：${r.unused.length}</b><div class="sub small code">${r.unused.slice(0, 50).map(esc).join('<br>')}</div></div><div><b>なくなっている：${r.missing.length}</b><div class="sub small code">${r.missing.slice(0, 50).map(esc).join('<br>')}</div></div>`,
        buttons: [{ label: '閉じる', value: null }, ...(r.unused.length ? [{ label: '使っていないものを消す', kind: 'danger', value: 'del' }] : [])],
      });
      if (v === 'del') {
        for (const n of r.unused) await col.removeMedia(n);
        toast(`${r.unused.length} 個を消しました`);
      }
    }
    if (a === 'empty') {
      const ids = emptyCards(col);
      if (!ids.length) return toast('空のカードはありませんでした');
      if (await confirmDialog('空のカード', `${ids.length} 枚の空のカードを消します。`, { ok: '消す', danger: true })) {
        col.deleteCards(ids);
        toast('消しました');
      }
    }
    if (a === 'wipe') {
      const v = await promptDialog('すべてを消す', { label: '本当に消すときは「消す」と入力してください', ok: 'すべて消す' });
      if (v !== '消す') return;
      const { clearStores } = await import('../db.js');
      await clearStores(['mediaBlobs']);
      await col.replaceAll({});
      toast('すべて消しました');
      nav.go('/decks');
    }
  });
}

function help(page) {
  const k = (s) => `<span class="kbd">${esc(keyLabel(s))}</span>`;
  const rows = (list) => `<table class="simple-table">${list.map(([a, b]) => `<tr><td style="width:40%">${a}</td><td>${esc(b)}</td></tr>`).join('')}</table>`;
  page.appendChild(
    el(`<div class="card"><h2>${icon('play')}学習中</h2>${rows([
      [`${k('Space')} ${k('Enter')}`, '答えを見る／「正解」'],
      [`${k('1')} ${k('2')} ${k('3')} ${k('4')}`, 'もう一度／難しい／正解／簡単'],
      [k('E'), '編集'],
      [k('*'), '印をつける'],
      [`${k('-')} ${k('=')}`, 'カード／ノートを今日は出さない'],
      [`${k('@')} ${k('!')}`, 'カード／ノートを保留にする'],
      [`${k('⌘1')}〜${k('⌘7')}`, '目印'],
      [k('R'), '音をもう一度'],
      [k('I'), 'カードの情報'],
      [`${k('Z')} ${k('⌘Z')}`, '元に戻す'],
      [k('Esc'), 'やめる'],
      ['スマホ', '答えの面を右へすべらせると「正解」、左は「もう一度」'],
    ])}</div>`)
  );
  page.appendChild(
    el(`<div class="card"><h2>${icon('keyboard')}どこでも</h2>${rows([
      [k('D'), 'デッキ'],
      [k('A'), 'カードを足す'],
      [k('B'), '一覧'],
      [k('T'), '記録'],
      [k('Y'), '同期'],
      [k('/'), '一覧で検索'],
      [k('⌘Enter'), '追加・保存'],
      [k('⌘⇧C'), '穴うめを作る（同じ番号は ⌘⌥⇧C）'],
      [k('⌘⇧X'), 'HTML で書く'],
    ])}</div>`)
  );
  page.appendChild(
    el(`<div class="card"><h2>${icon('monitor')}スマホで使う</h2><div class="sub" style="line-height:1.8">このページをスマホで開き、共有メニューの「ホーム画面に追加」を押すと、アプリのように使えます。通信がなくても学習でき、つながったときに同期します。</div></div>`)
  );
}
