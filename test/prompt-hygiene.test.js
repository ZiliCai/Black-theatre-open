const test = require('node:test');
const assert = require('node:assert/strict');
const { negations, addedNegations, dropNoText, pictureStyle } = require('../src/prompt-hygiene');
const { buildPrompt } = require('../src/asset-prompt');

// the 崖上 style paragraph as the project wrote it
const STYLE = '写实电影质感，高原上的光清透、空气冷冽，经幡颜色鲜亮，雾是柔和的灰白色。日常戏整体干净，不脏、不暗；夜戏靠实际光源照明，比如炉火、灯泡、头灯、车灯。人物都要好看、上镜，主角配角都按正规影视剧演员的颜值来写，配角也一样，只用发型、衣着、神态和标志物区分人物，不靠丑化。丧尸和恐怖的画面不受「干净」限制：阴冷、昏暗，暗部要深。丧尸按正规影视剧里的丧尸来写，吓人但不恶心：灰白发青的皮肤、凹陷的脸颊、浑浊的灰白眼睛。提示词里统一写明：画面上没有字幕和文字。';

test('negations are found in Chinese and English, everyday 不 words are not', () => {
  assert.deepEqual(negations('半身取景，耳后不夹香烟，耳朵干净，没有烟。不远处是山，他不停地挥手，不胖也不矮。'), ['耳后不夹香烟', '没有烟', '不胖也不矮']);
  assert.deepEqual(negations('The bike does not move, no lens flare, both boots planted. He never pedals.'), ['The bike does not move', 'no lens flare', 'He never pedals']);
  assert.deepEqual(addedNegations('耳后不夹香烟。', '耳后不夹香烟。耳朵上绝对没有烟。'), ['耳朵上绝对没有烟']);
  assert.deepEqual(addedNegations('耳后不夹香烟，没有烟。', '耳朵干净。'), []);
});

test('the no-text line is taken out wherever it was written', () => {
  assert.equal(dropNoText('半身取景。画面上没有字幕和文字。高原日光。'), '半身取景。高原日光。');
  assert.equal(dropNoText('背景墙上不要出现文字和水印'), '');
  assert.equal(dropNoText('手里拿着一本书'), '手里拿着一本书');
});

test('a picture gets the look of the style, not the notes to the writer or the rules for other pictures', () => {
  const portrait = pictureStyle(STYLE, '老周 厨师 白色厨师服');
  assert.equal(portrait, '写实电影质感，高原上的光清透、空气冷冽，经幡颜色鲜亮，雾是柔和的灰白色。日常戏整体干净，不脏、不暗。');
  const zombie = pictureStyle(STYLE, '垭口丧尸 干掉的血');
  assert.match(zombie, /阴冷、昏暗，暗部要深/);
  assert.match(zombie, /灰白发青的皮肤、凹陷的脸颊/, 'what follows the colon of a writer note is still how it looks');
  assert.doesNotMatch(zombie, /来写|提示词|夜戏/);
  assert.match(pictureStyle(STYLE, '断风垭口 夜里'), /夜戏靠实际光源照明/);
  assert.equal(pictureStyle('写实电影质感。', ''), '写实电影质感。');
});

test('老周: the prompt says no-text once and carries no zombie rules', () => {
  const card = { code: 'LZ50', name: '老周（厨师，50 岁）', style: STYLE, description: '五十岁但很精神。标志：肩上搭一条旧毛巾' };
  const prompt = buildPrompt({ mode: 't2i', card, ask: '半身取景，看向镜头。画面上没有字幕和文字。' });
  assert.equal(prompt.match(/没有字幕/g).length, 1);
  assert.doesNotMatch(prompt, /丧尸|提示词里/);
  assert.ok(prompt.endsWith('画面上没有字幕和文字。'));
});
