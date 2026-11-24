const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown: parse, parseInline: inline } = require('../renderer/markdown');

const text = (s) => ({ type: 'text', text: s });

// ---------- inline ----------
test('plain text stays one text node', () => {
  assert.deepEqual(inline('你好,世界'), [text('你好,世界')]);
  assert.deepEqual(inline(''), []);
});

test('bold, italic, bold-italic and inline code', () => {
  assert.deepEqual(inline('a **粗** b'), [text('a '), { type: 'strong', children: [text('粗')] }, text(' b')]);
  assert.deepEqual(inline('a *斜* b'), [text('a '), { type: 'em', children: [text('斜')] }, text(' b')]);
  assert.deepEqual(inline('***两者***'), [{ type: 'em', children: [{ type: 'strong', children: [text('两者')] }] }]);
  assert.deepEqual(inline('用 `ref2va` 模型'), [text('用 '), { type: 'code', text: 'ref2va' }, text(' 模型')]);
});

test('markers inside code are not interpreted, and unmatched markers stay as they are', () => {
  assert.deepEqual(inline('`**不是粗体**`'), [{ type: 'code', text: '**不是粗体**' }]);
  assert.deepEqual(inline('2 * 3 = 6'), [text('2 * 3 = 6')]);
  assert.deepEqual(inline('**没有结尾'), [text('**没有结尾')]);
  assert.deepEqual(inline('`没有结尾'), [text('`没有结尾')]);
});

test('underscores in file names are never emphasis', () => {
  assert.deepEqual(inline('01_故事设定_v1.md'), [text('01_故事设定_v1.md')]);
});

test('a backslash escapes the next marker', () => {
  assert.deepEqual(inline('\\*不是斜体\\*'), [text('*不是斜体*')]);
});

test('a link keeps its text and the address, but it is data, never something to click', () => {
  assert.deepEqual(inline('看 [文档](https://example.com/a) 吧'), [text('看 '), { type: 'link', text: '文档', href: 'https://example.com/a' }, text(' 吧')]);
  assert.deepEqual(inline('[坏的](javascript:alert(1))'), [{ type: 'link', text: '坏的', href: 'javascript:alert(1)' }]);
  assert.deepEqual(inline('[没有地址]'), [text('[没有地址]')]);
});

test('html in the text is just text', () => {
  assert.deepEqual(inline('<img src=x onerror=alert(1)>'), [text('<img src=x onerror=alert(1)>')]);
  assert.deepEqual(inline('<script>alert(1)</script>'), [text('<script>alert(1)</script>')]);
});

// ---------- blocks ----------
test('headings 1 to 6; seven hashes or no space is a paragraph', () => {
  const b = parse('# 一\n## 二\n###### 六\n####### 七\n\n#没空格');
  assert.deepEqual(b.map((x) => [x.type, x.level]), [['heading', 1], ['heading', 2], ['heading', 6], ['paragraph', undefined], ['paragraph', undefined]]);
  assert.deepEqual(b[0].inline, [text('一')]);
});

test('consecutive lines make one paragraph, a blank line starts the next', () => {
  const b = parse('第一行\n第二行\n\n第三段');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0].inline, [text('第一行\n第二行')]);
  assert.deepEqual(b[1].inline, [text('第三段')]);
});

test('bullet and numbered lists, with nesting by indentation', () => {
  const b = parse('- 甲\n- 乙\n  - 乙一\n  - 乙二\n- 丙\n\n1. 一\n2. 二');
  assert.equal(b[0].type, 'list');
  assert.equal(b[0].ordered, false);
  assert.equal(b[0].items.length, 3);
  assert.deepEqual(b[0].items[1].inline, [text('乙')]);
  assert.equal(b[0].items[1].children[0].type, 'list');
  assert.equal(b[0].items[1].children[0].items.length, 2);
  assert.equal(b[1].ordered, true);
  assert.equal(b[1].items.length, 2);
});

test('list markers *, + and - all work and a continuation line joins the item', () => {
  const b = parse('* 甲\n  接着\n+ 乙');
  assert.equal(b[0].items.length, 2);
  assert.deepEqual(b[0].items[0].inline, [text('甲\n接着')]);
});

test('a table with header, alignment and rows', () => {
  const b = parse('| 镜头 | 时长 | 内容 |\n|:---|---:|:---:|\n| 1 | 8s | **开场** |\n| 2 | 6s | 转场 |');
  assert.equal(b.length, 1);
  const t = b[0];
  assert.equal(t.type, 'table');
  assert.deepEqual(t.header.map((c) => c[0].text), ['镜头', '时长', '内容']);
  assert.deepEqual(t.align, ['left', 'right', 'center']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][2][0].type, 'strong');
});

test('table cells: escaped pipes, short rows padded, outer pipes optional', () => {
  const t = parse('a | b\n---|---\n x \\| y | z\nonly one')[0];
  assert.equal(t.type, 'table');
  assert.deepEqual(t.rows[0].map((c) => c[0].text), ['x | y', 'z']);
  assert.equal(t.rows[1].length, 2);
  assert.deepEqual(t.rows[1][1], []);
});

test('lines with pipes but no separator row are not a table', () => {
  assert.equal(parse('a | b\nc | d')[0].type, 'paragraph');
});

test('fenced code blocks keep their content untouched, also when never closed', () => {
  const b = parse('```js\nconst a = **1**;\n# not a heading\n```\n后面');
  assert.deepEqual([b[0].type, b[0].lang, b[0].text], ['code', 'js', 'const a = **1**;\n# not a heading']);
  assert.equal(b[1].type, 'paragraph');
  const open = parse('~~~\n一\n二');
  assert.deepEqual([open[0].type, open[0].text], ['code', '一\n二']);
});

test('block quotes hold other blocks, and a horizontal rule is a rule', () => {
  const b = parse('> 引用 **粗**\n> - 项\n\n---\n***\n___');
  assert.equal(b[0].type, 'quote');
  assert.equal(b[0].blocks[0].type, 'paragraph');
  assert.equal(b[0].blocks[1].type, 'list');
  assert.deepEqual(b.slice(1).map((x) => x.type), ['hr', 'hr', 'hr']);
});

test('windows and old-mac line endings are handled', () => {
  assert.equal(parse('# 一\r\n\r\n二\r\n三').length, 2);
  assert.equal(parse('# 一\r二').length, 2);
});

test('empty input gives no blocks', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('\n\n  \n'), []);
  assert.deepEqual(parse(null), []);
});

// ---------- hostile and big input ----------
test('very deep quotes and lists do not blow the stack', () => {
  assert.doesNotThrow(() => parse(`${'> '.repeat(500)}深`));
  assert.doesNotThrow(() => parse(Array.from({ length: 300 }, (_, i) => `${'  '.repeat(i)}- 项`).join('\n')));
  assert.doesNotThrow(() => inline('*'.repeat(10000)));
  assert.doesNotThrow(() => inline('['.repeat(5000)));
  assert.doesNotThrow(() => inline('`'.repeat(5000)));
});

test('a 70 KB storyboard-sized document with many tables parses quickly', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| ${i} | 江渡走进教室,**停住**,看见 \`清嘉\` | ${i * 3}s |`).join('\n');
  const section = `### 第${'x'}场\n\n- 要点一\n- 要点二\n\n| 镜头 | 内容 | 时长 |\n|---|---|---|\n${rows}\n\n正文段落。`.repeat(1);
  const doc = Array.from({ length: 60 }, () => section).join('\n\n');
  assert.ok(doc.length > 70000, `doc is ${doc.length} chars`);
  const start = process.hrtime.bigint();
  const blocks = parse(doc);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(blocks.length > 200);
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});
