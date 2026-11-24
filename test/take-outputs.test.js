const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findContext, takeFiles, pickVideo } = require('../src/take-outputs');

function outputDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'take-out-'));
  fs.mkdirSync(path.join(dir, 'h3_context'));
  fs.mkdirSync(path.join(dir, 'video'));
  return dir;
}
const touch = (file, mtimeSec) => {
  fs.writeFileSync(file, 'x');
  if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
};

test('findContext picks the newest matching stem and needs the jpg', () => {
  const dir = outputDir();
  const ctx = (name) => path.join(dir, 'h3_context', name);
  touch(ctx('bb_k1_1026-100000_.safetensors'), 1000);
  touch(ctx('bb_k1_1026-100000_.jpg'), 1000);
  touch(ctx('bb_k1_1026-110000_.safetensors'), 2000);
  touch(ctx('bb_k1_1026-110000_.jpg'), 2000);
  touch(ctx('bb_k1_1026-120000_.safetensors'), 3000); // newest, but its picture is missing
  touch(ctx('bb_k10_1026-130000_.safetensors'), 4000); // another key that only starts the same
  touch(ctx('bb_k10_1026-130000_.jpg'), 4000);
  assert.equal(findContext(dir, 'bb_k1'), 'bb_k1_1026-110000_');
  assert.equal(findContext(dir, 'bb_none'), null);
  assert.equal(findContext(path.join(dir, 'missing'), 'bb_k1'), null);
});

test('takeFiles lists only files that exist', () => {
  const dir = outputDir();
  touch(path.join(dir, 'video', 'bb_k1_00001_.mp4'));
  touch(path.join(dir, 'h3_context', 'bb_k1_s_.safetensors'));
  const files = takeFiles(dir, { video: 'video/bb_k1_00001_.mp4', context: 'bb_k1_s_' });
  assert.deepEqual(files, [path.join(dir, 'video', 'bb_k1_00001_.mp4'), path.join(dir, 'h3_context', 'bb_k1_s_.safetensors')]);
  assert.deepEqual(takeFiles(dir, { video: null, context: null }), []);
});

test('takeFiles refuses paths that leave the output folder', () => {
  const dir = outputDir();
  assert.deepEqual(takeFiles(dir, { video: '../outside.mp4', context: '../x' }), []);
});

test('pickVideo prefers the video named after the take', () => {
  const videos = [{ relPath: 'video/第一遍对比/minimax-h3-hybrid_00001_.mp4' }, { relPath: 'video/bb_k1_1026-1_00001_.mp4' }];
  assert.equal(pickVideo(videos, 'bb_k1'), 'video/bb_k1_1026-1_00001_.mp4');
  assert.equal(pickVideo([{ relPath: 'YZ_H3_00001.mp4' }], 'bb_k1'), 'YZ_H3_00001.mp4');
  assert.equal(pickVideo([], 'bb_k1'), null);
});
