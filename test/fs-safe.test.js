const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeFile, removeTree } = require('../src/fs-safe');
const { clearTemp } = require('../src/cache');

// Node 24 on Windows kills the whole process when fs.rmSync meets a non-ASCII name, so these tests use Chinese names
// on purpose: if anything in the delete path went back to rmSync, this file would crash instead of failing politely.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fs-'));

test('removeFile deletes a file with a Chinese name and does not mind a missing one', () => {
  const dir = tmp();
  const f = path.join(dir, '预览图_00001_.png');
  fs.writeFileSync(f, 'x');
  removeFile(f);
  assert.equal(fs.existsSync(f), false);
  assert.doesNotThrow(() => removeFile(f));
});

test('removeTree deletes a folder tree with Chinese names, files and sub-folders', () => {
  const dir = path.join(tmp(), '剧本');
  fs.mkdirSync(path.join(dir, '第一集', '素材'), { recursive: true });
  fs.writeFileSync(path.join(dir, '第一集', '素材', '镜头.mp4'), 'x');
  fs.writeFileSync(path.join(dir, '说明.txt'), 'x');
  removeTree(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('removeTree on a plain file, and on something that is not there', () => {
  const dir = tmp();
  const f = path.join(dir, '单个.txt');
  fs.writeFileSync(f, 'x');
  removeTree(f);
  assert.equal(fs.existsSync(f), false);
  assert.doesNotThrow(() => removeTree(path.join(dir, '没有')));
});

test('removeTree removes a junction without following it into the folder it points at', () => {
  const dir = tmp();
  const target = path.join(dir, '真实文件夹');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, '重要.txt'), 'keep');
  const link = path.join(dir, '链接');
  fs.symlinkSync(target, link, 'junction');
  removeTree(link);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(target, '重要.txt'), 'utf8'), 'keep');
});

test('clearing the cache survives files and folders with Chinese names in temp', () => {
  const workdir = tmp();
  const temp = path.join(workdir, 'ComfyUI', 'temp');
  fs.mkdirSync(path.join(temp, '预览'), { recursive: true });
  fs.writeFileSync(path.join(temp, '预览', '帧_00001_.png'), '12345');
  fs.writeFileSync(path.join(temp, '中文名.png'), '123');
  fs.writeFileSync(path.join(temp, 'ascii.png'), '12');
  const r = clearTemp(workdir);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.freedBytes, 10);
  assert.equal(r.skipped, 0);
  assert.deepEqual(fs.readdirSync(temp), []);
});
