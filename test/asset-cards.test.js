const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listCards, parseCards } = require('../src/asset-cards');
const { buildPrompt } = require('../src/asset-prompt');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'assets', '人物与场景.md'), 'utf8');

test('the real list format gives people, places and the style line', () => {
  const { cards, style, warnings } = parseCards(fixture, '01_人物与场景参考图.md');
  assert.deepEqual(warnings, []);
  assert.match(style, /^写实电影质感/);
  assert.match(style, /画面上没有字幕和文字/);
  const qx = cards.find((c) => c.code === 'QX');
  assert.equal(qx.kind, 'char');
  assert.equal(qx.name, '冷开场里的骑行者（20 多岁）');
  assert.match(qx.description, /红色防风衣/);
  assert.equal(qx.style, style);
  const yk = cards.find((c) => c.code === 'YS-YK');
  assert.equal(yk.kind, 'scene');
  assert.match(yk.name, /断风垭口/);
  assert.equal(cards.filter((c) => c.kind === 'char').length, 9);
  assert.equal(cards.filter((c) => c.kind === 'scene').length, 4);
});

test('tables without 代号, other headings and bad codes are skipped', () => {
  const text = [
    '## 人物', '', '| 名字 | 外形 |', '|---|---|', '| 张三 | 高 |', '',
    '| 代号 | 人物 | 外形 |', '| --- | --- | --- |', '| **hy27** | 何遇 | 偏瘦 |', '| 何遇 | 何遇 | 偏瘦 |', '| | 空 | |', '',
    '## 道具', '', '| 代号 | 道具 | 样子 |', '|---|---|---|', '| DJ1 | 刀 | 长 |', '',
    '## 人物与场景', '', '| 代号 | 场景 | 样子 |', '|:--|:--:|--:|', '| A-1 | 大堂 | 炉子 a\\|b |',
  ].join('\r\n');
  const { cards, warnings } = parseCards(text, 'x.md');
  assert.deepEqual(cards.map((c) => [c.code, c.kind, c.name]), [['HY27', 'char', '何遇'], ['A-1', 'scene', '大堂']]);
  assert.equal(cards[1].description, '炉子 a|b');
  assert.equal(cards[0].style, '');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /「何遇」不是合法代号/);
});

test('listCards reads every document, first one wins a repeated code', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), '剧本 项目-'));
  fs.writeFileSync(path.join(docs, '01_人物与场景参考图.md'), fixture);
  fs.mkdirSync(path.join(docs, '第一集'));
  fs.writeFileSync(path.join(docs, '第一集', '补充.md'), '## 人物\n\n| 代号 | 人物 | 外形 |\n|---|---|---|\n| QX | 别的骑行者 | 蓝衣服 |\n| DJ | 多吉 | 大狗 |\n');
  const r = listCards({ docsDir: docs });
  assert.equal(r.ok, true);
  assert.equal(r.cards.find((c) => c.code === 'QX').name, '冷开场里的骑行者（20 多岁）');
  assert.equal(r.cards.find((c) => c.code === 'DJ').source, '第一集/补充.md');
  assert.match(r.warnings.join(), /代号 QX 出现了两次/);
  assert.deepEqual(r.sources, ['01_人物与场景参考图.md', '第一集/补充.md']);
  assert.equal(listCards({ docsDir: path.join(docs, 'none') }).noProject, true);
});

test('prompts are put together in Chinese, the no-text line only once', () => {
  const card = { name: '骑行者', description: '红色防风衣', style: '写实电影质感。' };
  assert.equal(buildPrompt({ mode: 't2i', card, ask: '  站在路边 ' }), '写实电影质感。\n红色防风衣\n站在路边\n画面上没有字幕和文字。');
  assert.equal(buildPrompt({ mode: 'i2i', card, ask: '侧面 45°' }), '保持参考图里骑行者的外形不变：红色防风衣\n侧面 45°\n写实电影质感。\n画面上没有字幕和文字。');
  assert.equal(buildPrompt({ mode: 't2i', card: { style: '提示词里统一写明：画面上没有字幕和文字。' }, ask: '' }), '画面上没有字幕和文字。', 'a note to the writer is not drawn');
  assert.equal(buildPrompt({ mode: 't2i', card, ask: '站在路边。画面上没有字幕和文字。', look: '红色防风衣，画面里不要出现文字。' }), '写实电影质感。\n红色防风衣\n站在路边。\n画面上没有字幕和文字。', 'said once however often the parts say it');
  assert.equal(buildPrompt({ mode: 'i2i', card: {}, ask: '夜里' }), '夜里\n画面上没有字幕和文字。');
  assert.equal(buildPrompt({ mode: 't2i', card, ask: '站在路边', look: '蓝色防风衣' }), '写实电影质感。\n蓝色防风衣\n站在路边\n画面上没有字幕和文字。');
});
