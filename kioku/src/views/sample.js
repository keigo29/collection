// はじめての人のための見本のデッキ
const WORDS = [
  ['apple', 'りんご'],
  ['remember', '覚えている・思い出す'],
  ['review', 'おさらいする'],
  ['improve', 'よくする・上達する'],
  ['effort', '努力'],
  ['habit', '習慣'],
];

const CLOZE = [
  '日本で一番高い山は{{c1::富士山}}で、高さは{{c2::3776}} m です。',
  '{{c1::忘却曲線}}を考えたのは{{c2::エビングハウス}}です。',
  '光の速さはおよそ秒速{{c1::30万::数字}} km です。',
];

export function addSampleDeck(col) {
  const nt = (stock) => [...col.notetypes.values()].find((t) => t.stock === stock) || [...col.notetypes.values()][0];
  col.transact('見本のデッキ', () => {
    const words = col.ensureDeck('見本::英単語');
    const facts = col.ensureDeck('見本::穴うめ');
    const math = col.ensureDeck('見本::数式と入力');
    for (const [en, ja] of WORDS) col.addNote(nt('reversed').id, words.id, [en, ja], ['見本']);
    for (const t of CLOZE) col.addNote(nt('cloze').id, facts.id, [t, ''], ['見本']);
    col.addNote(nt('basic').id, math.id, ['二次方程式 \\(ax^2+bx+c=0\\) の解は？', '\\[x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\\]'], ['見本', '数学']);
    col.addNote(nt('typing').id, math.id, ['「ありがとう」を英語で', 'thank you'], ['見本']);
    col.addNote(nt('basic').id, math.id, ['日本の首都は？', '東京'], ['見本']);
  });
}
