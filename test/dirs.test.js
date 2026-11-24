const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgvDir, defaultDirs, effectiveDirs, checkDir, dirStats } = require('../src/dirs');

const WORKDIR = 'C:\\BlackBox\\ComfyUI_windows_portable';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-dirs-'));

// ---------- argv ----------
test('reads a flag value from a separate argument', () => {
  assert.equal(parseArgvDir(['main.py', '--output-directory', 'D:\\out', '--port', '8188'], '--output-directory'), 'D:\\out');
});

test('reads --flag=value style', () => {
  assert.equal(parseArgvDir(['--input-directory=D:\\in'], '--input-directory'), 'D:\\in');
});

test('missing flag, missing value, or no argv gives null', () => {
  assert.equal(parseArgvDir(['--port', '8188'], '--output-directory'), null);
  assert.equal(parseArgvDir(['--output-directory'], '--output-directory'), null);
  assert.equal(parseArgvDir(null, '--output-directory'), null);
  assert.equal(parseArgvDir(undefined, '--output-directory'), null);
});

// ---------- effective dirs ----------
test('defaults live under <workdir>\\ComfyUI', () => {
  assert.deepEqual(defaultDirs(WORKDIR), {
    output: 'C:\\BlackBox\\ComfyUI_windows_portable\\ComfyUI\\output',
    input: 'C:\\BlackBox\\ComfyUI_windows_portable\\ComfyUI\\input',
  });
});

test('not running and nothing configured: the defaults, source "default"', () => {
  const e = effectiveDirs({ workdir: WORKDIR, config: { outputDir: '', inputDir: '' }, argv: null });
  assert.equal(e.output.path, defaultDirs(WORKDIR).output);
  assert.equal(e.output.source, 'default');
  assert.equal(e.output.pending, false);
  assert.equal(e.input.path, defaultDirs(WORKDIR).input);
});

test('not running with a configured dir: that dir, source "config"', () => {
  const e = effectiveDirs({ workdir: WORKDIR, config: { outputDir: 'D:\\成片', inputDir: '' }, argv: null });
  assert.equal(e.output.path, 'D:\\成片');
  assert.equal(e.output.source, 'config');
  assert.equal(e.output.pending, false);
});

test('running with no directory flags: the real dir is the default, and nothing is pending', () => {
  const e = effectiveDirs({
    workdir: WORKDIR, config: { outputDir: '', inputDir: '' },
    argv: ['ComfyUI\\main.py', '--port', '8188'],
  });
  assert.equal(e.output.path, defaultDirs(WORKDIR).output);
  assert.equal(e.output.source, 'running');
  assert.equal(e.output.pending, false);
});

test('running with a flag: the flag value wins over the config', () => {
  const e = effectiveDirs({
    workdir: WORKDIR, config: { outputDir: '', inputDir: '' },
    argv: ['ComfyUI\\main.py', '--output-directory', 'E:\\real'],
  });
  assert.equal(e.output.path, 'E:\\real');
  assert.equal(e.output.source, 'running');
});

test('config changed while running: still shows the running dir, flagged pending, with the new one', () => {
  const e = effectiveDirs({
    workdir: WORKDIR, config: { outputDir: 'D:\\new', inputDir: '' },
    argv: ['ComfyUI\\main.py', '--port', '8188'],
  });
  assert.equal(e.output.path, defaultDirs(WORKDIR).output);
  assert.equal(e.output.pending, true);
  assert.equal(e.output.configuredPath, 'D:\\new');
  assert.equal(e.input.pending, false);
});

test('pending comparison ignores case, slash direction and a trailing slash', () => {
  const e = effectiveDirs({
    workdir: WORKDIR, config: { outputDir: 'd:/Out/', inputDir: '' },
    argv: ['--output-directory', 'D:\\out'],
  });
  assert.equal(e.output.pending, false);
});

test('a relative flag value is resolved against the workdir', () => {
  const e = effectiveDirs({
    workdir: WORKDIR, config: { outputDir: '', inputDir: '' },
    argv: ['--output-directory', 'myout'],
  });
  assert.equal(e.output.path, path.win32.resolve(WORKDIR, 'myout'));
});

// ---------- checkDir ----------
test('an existing writable folder passes and leaves no test file behind', () => {
  const d = tmp();
  assert.deepEqual(checkDir(d), { ok: true, created: false, message: '' });
  assert.deepEqual(fs.readdirSync(d), []);
});

test('a missing folder is created (with parents) when create is on', () => {
  const d = path.join(tmp(), 'a', 'b 带空格');
  const r = checkDir(d, { create: true });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(fs.statSync(d).isDirectory(), true);
});

test('a missing folder is reported, not created, when create is off', () => {
  const d = path.join(tmp(), 'nope');
  const r = checkDir(d);
  assert.equal(r.ok, false);
  assert.match(r.message, /不存在/);
  assert.equal(fs.existsSync(d), false);
});

test('a path that is a file is rejected', () => {
  const f = path.join(tmp(), 'file.txt');
  fs.writeFileSync(f, 'x');
  const r = checkDir(f);
  assert.equal(r.ok, false);
  assert.match(r.message, /不是文件夹/);
});

test('relative paths and drive roots are rejected', () => {
  assert.match(checkDir('relative\\dir').message, /绝对路径/);
  assert.match(checkDir('F:\\').message, /磁盘根目录/);
});

test('a folder that cannot be created is reported with the reason', () => {
  const f = path.join(tmp(), 'blocker');
  fs.writeFileSync(f, 'x');
  const r = checkDir(path.join(f, 'child'), { create: true }); // parent is a file
  assert.equal(r.ok, false);
  assert.match(r.message, /无法创建|不可写/);
});

// ---------- dirStats ----------
function tree() {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.png'), '12345');
  fs.mkdirSync(path.join(d, 'video', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(d, 'video', 'b.mp4'), '1234567890');
  fs.writeFileSync(path.join(d, 'video', 'deep', 'c.bin'), '123');
  return d;
}

test('sums size and counts files recursively', async () => {
  const s = await dirStats(tree());
  assert.equal(s.exists, true);
  assert.equal(s.sizeBytes, 18);
  assert.equal(s.fileCount, 3);
  assert.equal(s.approximate, false);
  assert.ok(s.latestMtime > 0);
});

test('a missing folder reports exists:false instead of throwing', async () => {
  const s = await dirStats(path.join(tmp(), 'nope'));
  assert.deepEqual({ exists: s.exists, sizeBytes: s.sizeBytes, fileCount: s.fileCount }, { exists: false, sizeBytes: 0, fileCount: 0 });
});

test('stops at the file limit and says the numbers are approximate', async () => {
  const s = await dirStats(tree(), { maxFiles: 2 });
  assert.equal(s.approximate, true);
  assert.ok(s.fileCount <= 2);
});

test('stops at the time limit and says the numbers are approximate', async () => {
  const s = await dirStats(tree(), { maxMs: 0 });
  assert.equal(s.approximate, true);
});

test('does not follow links out of the folder', async () => {
  const d = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'big.bin'), 'x'.repeat(1000));
  fs.symlinkSync(outside, path.join(d, 'link'), 'junction');
  fs.writeFileSync(path.join(d, 'mine.txt'), '12');
  const s = await dirStats(d);
  assert.equal(s.sizeBytes, 2);
  assert.equal(s.fileCount, 1);
});
