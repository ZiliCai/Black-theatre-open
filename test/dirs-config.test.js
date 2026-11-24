const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, validateConfig, loadConfig } = require('../src/config');
const { buildArgs } = require('../src/args');

function validBase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-dc-'));
  const workdir = path.join(root, 'portable');
  fs.mkdirSync(path.join(workdir, 'python_embeded'), { recursive: true });
  fs.mkdirSync(path.join(workdir, 'ComfyUI'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'python_embeded', 'python.exe'), '');
  fs.writeFileSync(path.join(workdir, 'ComfyUI', 'main.py'), '');
  return { ...defaultConfig(), workdir };
}

test('output and input dirs default to empty (= use ComfyUI defaults)', () => {
  const c = defaultConfig();
  assert.equal(c.outputDir, '');
  assert.equal(c.inputDir, '');
});

test('empty dirs add no flags, so the default command is unchanged', () => {
  const args = buildArgs(defaultConfig());
  assert.equal(args.includes('--output-directory'), false);
  assert.equal(args.includes('--input-directory'), false);
});

test('a chosen output dir becomes --output-directory with the path as one argument', () => {
  const c = { ...defaultConfig(), outputDir: 'F:\\我的 成片\\输出' };
  const args = buildArgs(c);
  assert.equal(args[args.indexOf('--output-directory') + 1], 'F:\\我的 成片\\输出');
});

test('a chosen input dir becomes --input-directory', () => {
  const c = { ...defaultConfig(), inputDir: 'D:\\refs' };
  const args = buildArgs(c);
  assert.equal(args[args.indexOf('--input-directory') + 1], 'D:\\refs');
});

test('directory flags come before the user\'s extra args', () => {
  const c = { ...defaultConfig(), outputDir: 'D:\\out' };
  c.flags = { ...c.flags, extraArgs: '--fast' };
  const args = buildArgs(c);
  assert.ok(args.indexOf('--output-directory') >= 0, 'the flag must be present');
  assert.ok(args.indexOf('--output-directory') < args.indexOf('--fast'));
  assert.equal(args[args.length - 1], '--fast');
});

test('a relative output dir is rejected', () => {
  const r = validateConfig({ ...validBase(), outputDir: 'output2' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /输出目录.*绝对路径/);
});

test('a relative input dir is rejected', () => {
  const r = validateConfig({ ...validBase(), inputDir: '..\\in' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /输入目录.*绝对路径/);
});

test('a drive root is rejected for both', () => {
  for (const key of ['outputDir', 'inputDir']) {
    for (const root of ['F:\\', 'F:', 'c:/']) {
      const r = validateConfig({ ...validBase(), [key]: root });
      assert.equal(r.ok, false, `${key}=${root} should be rejected`);
      assert.match(r.errors.join('\n'), /磁盘根目录/);
    }
  }
});

test('absolute folders (with spaces and Chinese) and empty values are accepted', () => {
  const base = validBase();
  assert.equal(validateConfig({ ...base, outputDir: 'F:\\我的 成片', inputDir: 'D:\\refs' }).ok, true);
  assert.equal(validateConfig({ ...base, outputDir: '', inputDir: '' }).ok, true);
});

test('old config files without the new fields load with empty defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-dc-'));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8199, flags: { lowvram: false } }));
  const c = loadConfig(file);
  assert.equal(c.outputDir, '');
  assert.equal(c.inputDir, '');
});
