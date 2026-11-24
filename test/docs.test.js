const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/docs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-docs-'));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const at = (i) => () => new Date(2026, 9, 11, 3, 0, i); // local time 2026-10-11 03:00:<i>

function make(files) {
  const dir = tmp();
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  return dir;
}

// ---------- categories ----------
test('guessCategory reads the file name', () => {
  const g = D.guessCategory;
  assert.equal(g('01_故事设定.md'), '故事设定');
  assert.equal(g('02_分集大纲.md'), '大纲');
  assert.equal(g('分集细纲.md'), '细纲');
  assert.equal(g('04_第1集分镜.md'), '分镜头');
  assert.equal(g('第1集分镜头.txt'), '分镜头');
  assert.equal(g('03_制作规划.md'), '其他');
  assert.equal(g('05_参考图提示词_ChatGPT.md'), '其他');
});

test('guessCategory settles overlaps: storyboard first, then detailed outline, outline, setting', () => {
  assert.equal(D.guessCategory('分镜头设定.md'), '分镜头');
  assert.equal(D.guessCategory('大纲与细纲.md'), '细纲');
  assert.equal(D.guessCategory('大纲设定.md'), '大纲');
});

// ---------- listing ----------
test('listDocs finds .md and .txt files, skips everything else and the history folder', () => {
  const dir = make({
    'a.md': 'x', 'b.txt': 'x', 'c.xlsx': 'x', 'd.png': 'x',
    '.history/a/20261011-030000.md': 'old', '.hidden.md': 'x',
    '第一集/e.md': 'x',
  });
  const r = D.listDocs(dir, { docs: {} });
  assert.equal(r.exists, true);
  assert.deepEqual(r.docs.map((d) => d.relPath), ['a.md', 'b.txt', '第一集/e.md']);
});

test('listDocs goes two folders deep and sorts numbered names the way a person would', () => {
  const dir = make({ '10_x.md': 'x', '2_x.md': 'x', '1_x.md': 'x', 'a/b/c.md': 'x', 'a/b/c/d.md': 'x' });
  const names = D.listDocs(dir, { docs: {} }).docs.map((d) => d.relPath);
  assert.deepEqual(names, ['1_x.md', '2_x.md', '10_x.md', 'a/b/c.md']);
});

test('listDocs gives size, modified time and a category: saved choice first, else the guess', () => {
  const dir = make({ '01_故事设定.md': 'abcd', '02_分集大纲.md': 'x', '随笔.md': 'x' });
  const r = D.listDocs(dir, { docs: { '02_分集大纲.md': '细纲' } });
  const by = Object.fromEntries(r.docs.map((d) => [d.relPath, d]));
  assert.equal(by['01_故事设定.md'].category, '故事设定');
  assert.equal(by['02_分集大纲.md'].category, '细纲');
  assert.equal(by['随笔.md'].category, '其他');
  assert.equal(by['01_故事设定.md'].size, 4);
  assert.ok(by['01_故事设定.md'].mtimeMs > 0);
  assert.equal(by['01_故事设定.md'].name, '01_故事设定.md');
});

test('listDocs on a missing folder says so instead of failing', () => {
  assert.deepEqual(D.listDocs(path.join(tmp(), 'nope'), { docs: {} }), { exists: false, docs: [] });
});

// ---------- reading ----------
test('readDoc returns the text with LF line breaks and a fingerprint of the raw bytes', () => {
  const raw = Buffer.from('# 标题\r\n第二行\r\n', 'utf8');
  const dir = make({ 'a.md': raw });
  const r = D.readDoc(dir, 'a.md');
  assert.equal(r.ok, true);
  assert.equal(r.content, '# 标题\n第二行\n');
  assert.equal(r.eol, '\r\n');
  assert.equal(r.version, sha1(raw));
  assert.equal(r.readOnly, false);
  assert.equal(r.bom, false);
});

test('readDoc strips a BOM from the text and remembers it', () => {
  const dir = make({ 'a.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\n')]) });
  const r = D.readDoc(dir, 'a.md');
  assert.equal(r.content, '你好\n');
  assert.equal(r.bom, true);
  assert.equal(r.eol, '\n');
});

test('readDoc opens a file that is not UTF-8 read-only, with a reason', () => {
  const dir = make({ 'gbk.txt': Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) }); // "你好" in GBK
  const r = D.readDoc(dir, 'gbk.txt');
  assert.equal(r.ok, true);
  assert.equal(r.readOnly, true);
  assert.match(r.readOnlyReason, /UTF-8/);
});

test('readDoc refuses files over 2 MB, missing files, other file types and paths outside the folder', () => {
  const dir = make({ 'big.md': Buffer.alloc(D.MAX_BYTES + 1, 0x61), 'x.png': 'x' });
  assert.match(D.readDoc(dir, 'big.md').message, /2 MB/);
  assert.equal(D.readDoc(dir, 'missing.md').ok, false);
  assert.equal(D.readDoc(dir, 'x.png').ok, false);
  assert.equal(D.readDoc(dir, '../x.md').ok, false);
  assert.equal(D.readDoc(dir, 'C:\\Windows\\win.ini').ok, false);
  assert.equal(D.readDoc(dir, '.history/a/20261011-030000.md').ok, false);
});

// ---------- saving ----------
test('saveDoc writes the new text and keeps the old one in the history', () => {
  const dir = make({ 'a.md': 'old\n' });
  const v0 = D.readDoc(dir, 'a.md').version;
  const r = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'new\n', expectVersion: v0, now: at(1) });
  assert.equal(r.ok, true, r.message);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'new\n');
  assert.equal(r.version, sha1(Buffer.from('new\n')));
  const hist = fs.readdirSync(path.join(dir, '.history', 'a'));
  assert.deepEqual(hist, ['20261011-030001.md']);
  assert.equal(fs.readFileSync(path.join(dir, '.history', 'a', hist[0]), 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.history', 'a.md']);
});

test('saving identical content changes nothing and adds no history', () => {
  const dir = make({ 'a.md': 'same\n' });
  const r = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'same\n', expectVersion: D.readDoc(dir, 'a.md').version, now: at(1) });
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(fs.existsSync(path.join(dir, '.history')), false);
});

test('saveDoc keeps CRLF line breaks and the BOM the file already had', () => {
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('一\r\n二\r\n')]);
  const dir = make({ 'a.md': raw });
  const r = D.readDoc(dir, 'a.md');
  D.saveDoc({ docsDir: dir, relPath: 'a.md', content: '一\n二\n三\n', expectVersion: r.version, now: at(1) });
  const after = fs.readFileSync(path.join(dir, 'a.md'));
  assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(after.subarray(3).toString('utf8'), '一\r\n二\r\n三\r\n');
});

test('saveDoc leaves LF files as LF, even if the pasted text had CRLF', () => {
  const dir = make({ 'a.md': 'a\nb\n' });
  D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'a\r\nb\r\nc\r\n', expectVersion: D.readDoc(dir, 'a.md').version, now: at(1) });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'a\nb\nc\n');
});

test('a file changed on disk since it was opened is not overwritten', () => {
  const dir = make({ 'a.md': 'mine\n' });
  const opened = D.readDoc(dir, 'a.md').version;
  fs.writeFileSync(path.join(dir, 'a.md'), 'someone else\n');
  const r = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'my edit\n', expectVersion: opened, now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.currentVersion, sha1(Buffer.from('someone else\n')));
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'someone else\n');
  assert.equal(fs.existsSync(path.join(dir, '.history')), false);
});

test('overwrite after a conflict saves anyway and keeps the other version in the history', () => {
  const dir = make({ 'a.md': 'mine\n' });
  const opened = D.readDoc(dir, 'a.md').version;
  fs.writeFileSync(path.join(dir, 'a.md'), 'someone else\n');
  const r = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'my edit\n', expectVersion: opened, overwrite: true, now: at(2) });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'my edit\n');
  const [h] = fs.readdirSync(path.join(dir, '.history', 'a'));
  assert.equal(fs.readFileSync(path.join(dir, '.history', 'a', h), 'utf8'), 'someone else\n');
});

test('saving a file that was deleted meanwhile is a conflict too, not a silent re-create', () => {
  const dir = make({ 'a.md': 'x\n' });
  const opened = D.readDoc(dir, 'a.md').version;
  fs.rmSync(path.join(dir, 'a.md'));
  const r = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'y\n', expectVersion: opened, now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
  assert.equal(fs.existsSync(path.join(dir, 'a.md')), false);
});

test('the history keeps only the 30 newest versions of a document', () => {
  const dir = make({ 'a.md': 'v0\n' });
  let version = D.readDoc(dir, 'a.md').version;
  for (let i = 1; i <= 35; i++) {
    const r = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: `v${i}\n`, expectVersion: version, now: at(i) });
    assert.equal(r.ok, true);
    version = r.version;
  }
  const hist = fs.readdirSync(path.join(dir, '.history', 'a')).sort();
  assert.equal(hist.length, D.HISTORY_KEEP);
  assert.equal(D.HISTORY_KEEP, 30);
  assert.equal(fs.readFileSync(path.join(dir, '.history', 'a', hist[hist.length - 1]), 'utf8'), 'v34\n'); // newest kept
  assert.equal(fs.readFileSync(path.join(dir, '.history', 'a', hist[0]), 'utf8'), 'v5\n'); // v0..v4 pruned
});

test('two saves in the same second do not overwrite each other in the history', () => {
  const dir = make({ 'a.md': 'v0\n' });
  let version = D.readDoc(dir, 'a.md').version;
  for (const text of ['v1\n', 'v2\n', 'v3\n']) {
    version = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: text, expectVersion: version, now: at(5) }).version;
  }
  const hist = fs.readdirSync(path.join(dir, '.history', 'a'));
  assert.equal(hist.length, 3);
  const texts = hist.map((h) => fs.readFileSync(path.join(dir, '.history', 'a', h), 'utf8')).sort();
  assert.deepEqual(texts, ['v0\n', 'v1\n', 'v2\n']);
});

test('saveDoc refuses read-only files, big text, bad paths and other file types', () => {
  const dir = make({ 'gbk.txt': Buffer.from([0xc4, 0xe3]), 'x.png': 'x', 'a.md': 'a\n' });
  const v = (f) => sha1(fs.readFileSync(path.join(dir, f)));
  assert.equal(D.saveDoc({ docsDir: dir, relPath: 'gbk.txt', content: 'x', expectVersion: v('gbk.txt'), now: at(1) }).ok, false);
  assert.equal(D.saveDoc({ docsDir: dir, relPath: 'x.png', content: 'x', expectVersion: v('x.png'), now: at(1) }).ok, false);
  assert.equal(D.saveDoc({ docsDir: dir, relPath: '../evil.md', content: 'x', expectVersion: '', now: at(1) }).ok, false);
  const big = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: 'a'.repeat(D.MAX_BYTES + 1), expectVersion: v('a.md'), now: at(1) });
  assert.equal(big.ok, false);
  assert.match(big.message, /2 MB/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'a\n');
});

// ---------- create / rename / trash ----------
test('createDoc makes a .md file with a title line, and the folder if it is missing', () => {
  const dir = path.join(tmp(), '剧本');
  const r = D.createDoc({ docsDir: dir, name: '第二集分镜' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.relPath, '第二集分镜.md');
  assert.equal(fs.readFileSync(path.join(dir, '第二集分镜.md'), 'utf8'), '# 第二集分镜\n\n');
});

test('createDoc keeps a .txt extension and refuses duplicates and bad names', () => {
  const dir = make({ 'a.md': 'x' });
  assert.equal(D.createDoc({ docsDir: dir, name: 'n.txt' }).relPath, 'n.txt');
  for (const bad of ['a', 'a.md', '', '  ', 'x/y', 'x\\y', 'a:b', '.hidden', 'CON', 'q'.repeat(121), 'file.png']) {
    const r = D.createDoc({ docsDir: dir, name: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.message);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.md', 'n.txt']);
});

test('renameDoc renames the file and its history, keeping the extension', () => {
  const dir = make({ '旧.md': 'x\n' });
  D.saveDoc({ docsDir: dir, relPath: '旧.md', content: 'y\n', expectVersion: D.readDoc(dir, '旧.md').version, now: at(1) });
  const r = D.renameDoc({ docsDir: dir, relPath: '旧.md', newName: '新' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.relPath, '新.md');
  assert.ok(fs.existsSync(path.join(dir, '新.md')));
  assert.equal(fs.existsSync(path.join(dir, '旧.md')), false);
  assert.equal(fs.existsSync(path.join(dir, '.history', '旧')), false);
  assert.equal(fs.readdirSync(path.join(dir, '.history', '新')).length, 1);
});

test('renameDoc works in a sub-folder and refuses clashes and bad names', () => {
  const dir = make({ '第一集/a.md': 'x', '第一集/b.md': 'x', 'c.md': 'x' });
  assert.equal(D.renameDoc({ docsDir: dir, relPath: '第一集/a.md', newName: 'z' }).relPath, '第一集/z.md');
  assert.equal(D.renameDoc({ docsDir: dir, relPath: '第一集/z.md', newName: 'b' }).ok, false);
  assert.equal(D.renameDoc({ docsDir: dir, relPath: 'c.md', newName: 'a/b' }).ok, false);
  assert.equal(D.renameDoc({ docsDir: dir, relPath: '../c.md', newName: 'q' }).ok, false);
  assert.equal(D.renameDoc({ docsDir: dir, relPath: 'nope.md', newName: 'q' }).ok, false);
});

test('trashDoc hands the real path to the trash function and refuses anything else', async () => {
  const dir = make({ 'a.md': 'x', 'p.png': 'x', 'sub/b.md': 'x' });
  const sent = [];
  const trash = async (p) => { sent.push(p); };
  assert.equal((await D.trashDoc({ docsDir: dir, relPath: 'a.md', trash })).ok, true);
  assert.deepEqual(sent, [path.join(dir, 'a.md')]);
  for (const bad of ['p.png', 'sub', 'nope.md', '../a.md']) assert.equal((await D.trashDoc({ docsDir: dir, relPath: bad, trash })).ok, false, bad);
  assert.equal(sent.length, 1);
  const failing = await D.trashDoc({ docsDir: dir, relPath: 'sub/b.md', trash: async () => { throw new Error('in use'); } });
  assert.deepEqual([failing.ok, failing.message], [false, 'in use']);
});

// ---------- history ----------
test('listHistory is newest first, readHistory returns an old version, restoring goes through saveDoc', () => {
  const dir = make({ 'a.md': 'v0\n' });
  let version = D.readDoc(dir, 'a.md').version;
  for (let i = 1; i <= 3; i++) version = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: `v${i}\n`, expectVersion: version, now: at(i) }).version;
  const list = D.listHistory(dir, 'a.md');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((h) => h.id), ['20261011-030003.md', '20261011-030002.md', '20261011-030001.md']);
  assert.equal(list[0].time, new Date(2026, 9, 11, 3, 0, 3).toISOString());
  assert.equal(D.readHistory(dir, 'a.md', list[2].id).content, 'v0\n');
  const restored = D.saveDoc({ docsDir: dir, relPath: 'a.md', content: D.readHistory(dir, 'a.md', list[2].id).content, expectVersion: version, now: at(9) });
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'v0\n');
  assert.equal(D.listHistory(dir, 'a.md').length, 4); // v3 went into the history, nothing was lost
});

test('history ids that are not our own file names are refused', () => {
  const dir = make({ 'a.md': 'x', '.history/a/20261011-030000.md': 'old', 'secret.md': 'secret' });
  assert.equal(D.readHistory(dir, 'a.md', '20261011-030000.md').ok, true);
  for (const bad of ['../../secret.md', '..\\..\\secret.md', 'x.md', '20261011-030000.md/../../../secret.md', '']) assert.equal(D.readHistory(dir, 'a.md', bad).ok, false, bad);
  assert.deepEqual(D.listHistory(dir, 'never-saved.md'), []);
});

// ---------- search ----------
test('search finds documents containing every word, in the text or the file name, ignoring case', () => {
  const dir = make({
    '设定.md': '江渡是男主\n清嘉是女主\n',
    '大纲.md': '第一集 梯坎\n江渡遇见清嘉\n',
    'notes.txt': 'Nothing here\n',
    '.history/设定/20261011-030000.md': '江渡 清嘉 旧版本\n',
  });
  const names = (q) => D.searchDocs(dir, q).map((r) => r.relPath);
  assert.deepEqual(names('江渡 清嘉'), ['大纲.md', '设定.md']);
  assert.deepEqual(names('梯坎'), ['大纲.md']);
  assert.deepEqual(names('NOTHING'), ['notes.txt']);
  assert.deepEqual(names('notes'), ['notes.txt']);
  assert.deepEqual(names('不存在'), []);
  assert.deepEqual(names('  '), []);
});

test('search results carry a few matching lines with their line numbers', () => {
  const dir = make({ 'a.md': '一\n二 江渡\n三\n四 江渡\n五 江渡\n六 江渡\n七 江渡\n' });
  const [r] = D.searchDocs(dir, '江渡');
  assert.deepEqual(r.matches.map((m) => m.line), [2, 4, 5]);
  assert.equal(r.matches[0].text, '二 江渡');
  assert.equal(r.total, 5);
});

test('search skips files that are too big or not UTF-8, and stops at the result limit', () => {
  const files = { 'gbk.txt': Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), 'big.md': Buffer.alloc(D.MAX_BYTES + 1, 0x61) };
  for (let i = 0; i < 8; i++) files[`d${i}.md`] = 'hit\n';
  const dir = make(files);
  assert.equal(D.searchDocs(dir, 'hit').length, 8);
  assert.equal(D.searchDocs(dir, 'hit', { limit: 3 }).length, 3);
  assert.deepEqual(D.searchDocs(dir, 'aaaa'), []);
});
