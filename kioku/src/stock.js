// 最初から入っているノートの種類と、デッキの設定のひな形

export const STOCK_CSS = `.card {
  font-size: 22px;
  line-height: 1.6;
  text-align: center;
}
.cloze { font-weight: 700; color: var(--cloze, #005cff); }
`;

const t = (name, qfmt, afmt) => ({ name, qfmt, afmt });

export const STOCK_TYPES = {
  basic: () => ({
    name: '基本',
    kind: 'std',
    fields: [{ name: '表' }, { name: '裏' }],
    templates: [t('カード1', '{{表}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{裏}}')],
    css: STOCK_CSS,
    sortIdx: 0,
  }),
  reversed: () => ({
    name: '基本（裏表も）',
    kind: 'std',
    fields: [{ name: '表' }, { name: '裏' }],
    templates: [
      t('カード1', '{{表}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{裏}}'),
      t('カード2', '{{裏}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{表}}'),
    ],
    css: STOCK_CSS,
    sortIdx: 0,
  }),
  optional: () => ({
    name: '基本（裏表は選べる）',
    kind: 'std',
    fields: [{ name: '表' }, { name: '裏' }, { name: '裏表も' }],
    templates: [
      t('カード1', '{{表}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{裏}}'),
      t('カード2', '{{#裏表も}}{{裏}}{{/裏表も}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{表}}'),
    ],
    css: STOCK_CSS,
    sortIdx: 0,
  }),
  typing: () => ({
    name: '基本（答えを入力）',
    kind: 'std',
    fields: [{ name: '表' }, { name: '裏' }],
    templates: [t('カード1', '{{表}}\n\n{{type:裏}}', '{{表}}\n\n<hr id=answer>\n\n{{type:裏}}')],
    css: STOCK_CSS,
    sortIdx: 0,
  }),
  cloze: () => ({
    name: '穴うめ',
    kind: 'cloze',
    fields: [{ name: '本文' }, { name: '補足' }],
    templates: [t('穴うめ', '{{cloze:本文}}', '{{cloze:本文}}<br>\n{{補足}}')],
    css: STOCK_CSS,
    sortIdx: 0,
  }),
  io: () => ({
    name: '画像の穴うめ',
    kind: 'io',
    fields: [{ name: '隠す場所' }, { name: '画像' }, { name: '見出し' }, { name: '補足' }],
    templates: [
      t(
        '画像の穴うめ',
        '{{#見出し}}<div class="io-header">{{見出し}}</div>{{/見出し}}\n{{image-occlusion:隠す場所}}',
        '{{#見出し}}<div class="io-header">{{見出し}}</div>{{/見出し}}\n{{image-occlusion:隠す場所}}\n{{#補足}}<div class="io-extra">{{補足}}</div>{{/補足}}'
      ),
    ],
    css: STOCK_CSS + `.io-header{margin-bottom:12px;font-weight:700}.io-extra{margin-top:12px;font-size:18px}\n`,
    sortIdx: 2,
  }),
};

export const STOCK_ORDER = ['basic', 'reversed', 'optional', 'typing', 'cloze', 'io'];

export function defaultPreset() {
  return {
    name: 'ふつう',
    // 1日の上限
    newPerDay: 20,
    revPerDay: 200,
    // 新しいカード
    learnSteps: [1, 10],
    graduatingIvl: 1,
    easyIvl: 4,
    insertOrder: 'due', // due=追加した順 / random
    // 忘れたとき
    relearnSteps: [10],
    minIvl: 1,
    lapseMult: 0,
    leechThreshold: 8,
    leechAction: 'tag', // tag / suspend
    // 出す順番
    gatherOrder: 'deck', // deck / random / ascending / descending
    newSort: 'template', // template / due / random
    newMix: 'mix', // mix / after / before
    interdayMix: 'mix',
    reviewSort: 'due', // due / ascIvl / descIvl / random / overdue / descEase
    // あとまわし
    buryNew: false,
    buryRev: false,
    buryInterday: false,
    // 上級
    maxIvl: 36500,
    startEase: 2.5,
    easyBonus: 1.3,
    ivlModifier: 1.0,
    hardFactor: 1.2,
    // 時間と音
    maxAnswerSecs: 60,
    showTimer: false,
    autoplay: true,
    replayQuestion: true,
    autoAdvanceQ: 0,
    autoAdvanceA: 0,
    // FSRS
    desiredRetention: 0.9,
    fsrsWeights: null,
  };
}

export function defaultConf() {
  return {
    id: 'conf',
    rollover: 4,
    fsrs: false,
    learnAheadMins: 20,
    nextPos: 1,
    curDeck: 1,
    flagNames: {},
    addDeck: null,
    addType: null,
    showIntervals: true,
    showRemaining: true,
    lastAddedNotetypeDeck: {},
    mod: 0,
  };
}

export const FLAGS = [
  { n: 1, name: '赤', color: '#f2280d' },
  { n: 2, name: 'だいだい', color: '#ff5a00' },
  { n: 3, name: '緑', color: '#00c230' },
  { n: 4, name: '青', color: '#005cff' },
  { n: 5, name: '桃', color: '#e85dd0' },
  { n: 6, name: '水色', color: '#1fb8cc' },
  { n: 7, name: '紫', color: '#8600ff' },
];

export const PALETTE = ['#005cff', '#00c230', '#ff5a00', '#8600ff', '#1fb8cc', '#f2280d', '#ffae00', '#717680'];
