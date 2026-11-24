const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { keepTake, unkeepTake, keptByVideo, normalizeShot, readKept, continuationShots } = require('../src/clip-keep');
const { planSync } = require('../src/clip-sync');

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const noMeta = () => ({}); // unreadable prompt = assume the video was made with clips

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keep-'));
  for (const [rel, spec] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, spec.data ?? rel);
    const t = new Date(spec.time);
    fs.utimesSync(full, t, t);
  }
  return root;
}
const clipFiles = (root) => fs.readdirSync(path.join(root, 'h3_context')).filter((f) => f !== 'kept.json').sort();
const read = (root, name) => fs.readFileSync(path.join(root, 'h3_context', name), 'utf8');

test('shot numbers are typed by hand and tidied, anything else is refused', () => {
  assert.equal(normalizeShot('1-4'), '1-4');
  assert.equal(normalizeShot(' 1 － 4 '), '1-4');
  assert.equal(normalizeShot('2-15B'), '2-15b');
  for (const bad of ['', '14', 'clip_1-4', '1-4-2', '../1-4', null]) assert.equal(normalizeShot(bad), null, String(bad));
  const root = makeTree({ 'h3_context/clip_a_.safetensors': { time: T0 }, 'video/clip_a_00001_.mp4': { time: T0 } });
  const r = keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '第四镜', readMeta: noMeta });
  assert.equal(r.ok, false);
  assert.match(r.message, /1-4/);
  assert.deepEqual(clipFiles(root), ['clip_a_.safetensors']);
});

test("a take from the shot page is never kept the old way, so its continuation file keeps its name", () => {
  const root = makeTree({
    'h3_context/bb_e01-01-t001-abcd_1026-120000_.safetensors': { time: T0 },
    'h3_context/bb_e01-01-t001-abcd_1026-120000_.jpg': { time: T0 },
    'h3_context/clip_1013-120000_.safetensors': { time: T0 + MIN },
    'video/bb_e01-01-t001-abcd_00001_.mp4': { time: T0 + 2 * MIN },
    'video/minimax-h3-demo_00018_.mp4': { time: T0 + 2 * MIN },
  });
  const owned = (stem) => stem.startsWith('bb_');
  const own = keepTake({ root, relPath: 'video/bb_e01-01-t001-abcd_00001_.mp4', shot: '1-4', readMeta: noMeta, isOwned: owned });
  assert.equal(own.ok, false);
  assert.match(own.message, /镜头页/);
  // an old video that would pair (by time) with a take's file is refused too
  const near = keepTake({ root, relPath: 'video/minimax-h3-demo_00018_.mp4', shot: '1-4', readMeta: noMeta, isOwned: () => true });
  assert.equal(near.ok, false);
  assert.ok(clipFiles(root).includes('bb_e01-01-t001-abcd_1026-120000_.safetensors'));
  assert.ok(!clipFiles(root).includes('clip_1-4.safetensors'));
});

test('keeping a video renames its clip (and picture) to the shot, un-keeping gives the date name back', () => {
  const root = makeTree({
    'h3_context/clip_1013-120000_.safetensors': { time: T0, data: 'take1' },
    'h3_context/clip_1013-120000_.jpg': { time: T0 },
    'h3_context/clip_1013-121000_.safetensors': { time: T0 + 10 * MIN, data: 'take2' },
    'video/clip_1013-120000_00001_.mp4': { time: T0 + 5 * MIN }, // named after its clip
    'video/clip_1013-121000_00001_.mp4': { time: T0 + 11 * MIN },
  });
  const r = keepTake({ root, relPath: 'video/clip_1013-120000_00001_.mp4', shot: '1-4', readMeta: noMeta });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.stem, 'clip_1-4');
  assert.deepEqual(clipFiles(root), ['clip_1-4.jpg', 'clip_1-4.safetensors', 'clip_1013-121000_.safetensors']);
  assert.equal(read(root, 'clip_1-4.safetensors'), 'take1');
  assert.deepEqual(keptByVideo(root), { 'video/clip_1013-120000_00001_.mp4': '1-4' });
  assert.deepEqual(r.kept, keptByVideo(root));
  assert.deepEqual(continuationShots(root), [{
    shot: '1-4',
    video: 'video/clip_1013-120000_00001_.mp4',
    clip: 'h3_context/clip_1-4.jpg [output]',
    preview: 'h3_context/clip_1-4.jpg',
    hasPreview: true,
  }]);

  const u = unkeepTake({ root, relPath: 'video/clip_1013-120000_00001_.mp4' });
  assert.equal(u.ok, true, u.message);
  assert.equal(u.restoredStem, 'clip_1013-120000_');
  assert.deepEqual(clipFiles(root), ['clip_1013-120000_.jpg', 'clip_1013-120000_.safetensors', 'clip_1013-121000_.safetensors']);
  assert.deepEqual(keptByVideo(root), {});
  assert.deepEqual(continuationShots(root), []);
  assert.equal(unkeepTake({ root, relPath: 'video/clip_1013-120000_00001_.mp4' }).ok, false);
});

test('an older video without the clip in its name is paired by time, like the clip sync does', () => {
  const root = makeTree({
    'h3_context/clip_00003.safetensors': { time: T0, data: 'roll17' },
    'h3_context/clip_1013-010516_.safetensors': { time: T0 + 30 * MIN, data: 'roll18' },
    'video/minimax-h3-demo_00017_.mp4': { time: T0 + 4000 },
    'video/minimax-h3-demo_00018_.mp4': { time: T0 + 30 * MIN + 3000 },
  });
  const r = keepTake({ root, relPath: 'video/minimax-h3-demo_00018_.mp4', shot: '1-3', readMeta: noMeta });
  assert.equal(r.ok, true, r.message);
  assert.equal(read(root, 'clip_1-3.safetensors'), 'roll18');
  // the kept clip is never handed to another video, even one made right after it
  const s = keepTake({ root, relPath: 'video/minimax-h3-demo_00017_.mp4', shot: '1-2', readMeta: noMeta });
  assert.equal(read(root, 'clip_1-2.safetensors'), 'roll17', s.message);
});

test('a better take for the same shot replaces the old one, which gets its date name back', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0, data: 'A' },
    'h3_context/clip_a_.jpg': { time: T0, data: 'A.jpg' },
    'h3_context/clip_b_.safetensors': { time: T0 + 10 * MIN, data: 'B' },
    'h3_context/clip_b_.jpg': { time: T0 + 10 * MIN, data: 'B.jpg' },
    'video/clip_a_00001_.mp4': { time: T0 + MIN },
    'video/clip_b_00001_.mp4': { time: T0 + 11 * MIN },
  });
  assert.equal(keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-4', readMeta: noMeta }).ok, true);
  const r = keepTake({ root, relPath: 'video/clip_b_00001_.mp4', shot: '1-4', readMeta: noMeta });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.replaced, { video: 'video/clip_a_00001_.mp4', restoredStem: 'clip_a_' });
  assert.match(r.message, /clip_a_/);
  assert.equal(read(root, 'clip_1-4.safetensors'), 'B');
  assert.equal(read(root, 'clip_1-4.jpg'), 'B.jpg');
  assert.equal(read(root, 'clip_a_.safetensors'), 'A');
  assert.equal(read(root, 'clip_a_.jpg'), 'A.jpg');
  assert.deepEqual(keptByVideo(root), { 'video/clip_b_00001_.mp4': '1-4' });
});

test('a kept video can move to another shot and still remembers its first name', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0, data: 'A' },
    'video/clip_a_00001_.mp4': { time: T0 + MIN },
  });
  keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-4', readMeta: noMeta });
  const r = keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-5', readMeta: noMeta });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(clipFiles(root), ['clip_1-5.safetensors']);
  assert.equal(keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-5', readMeta: noMeta }).ok, true); // same again: nothing to do
  unkeepTake({ root, relPath: 'video/clip_a_00001_.mp4' });
  assert.deepEqual(clipFiles(root), ['clip_a_.safetensors']);
});

test('an upscaled video has no clip of its own, and a stray clip_<shot> file is never overwritten', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0 },
    'h3_context/clip_1-4.safetensors': { time: T0, data: 'hand-made' },
    'video/clip_a_00001_.mp4': { time: T0 + MIN },
    'video/seedvr2/up_00001_.mp4': { time: T0 + 2 * MIN },
  });
  const readMeta = (f) => ({ tags: { prompt: f.includes('seedvr2') ? '{"1":{"class_type":"SeedVR2VideoUpscaler"}}' : '{"338":{"class_type":"MiniMaxH3MotionContextSaveLatent"}}' } });
  const up = keepTake({ root, relPath: 'video/seedvr2/up_00001_.mp4', shot: '1-3', readMeta });
  assert.equal(up.ok, false);
  assert.match(up.message, /找不到/);
  const r = keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-4', readMeta });
  assert.equal(r.ok, false);
  assert.equal(read(root, 'clip_1-4.safetensors'), 'hand-made');
  assert.ok(fs.existsSync(path.join(root, 'h3_context/clip_a_.safetensors')));
  assert.equal(keepTake({ root, relPath: '../outside.mp4', shot: '1-1', readMeta }).ok, false);
  assert.equal(keepTake({ root, relPath: 'video/nope.mp4', shot: '1-1', readMeta }).ok, false);
});

test('a file held open by ComfyUI leaves everything as it was', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0, data: 'A' },
    'h3_context/clip_b_.safetensors': { time: T0 + 10 * MIN, data: 'B' },
    'video/clip_a_00001_.mp4': { time: T0 + MIN },
    'video/clip_b_00001_.mp4': { time: T0 + 11 * MIN },
  });
  keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-4', readMeta: noMeta });
  const locked = (from, to) => {
    if (from.includes('clip_b_')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    fs.renameSync(from, to);
  };
  const r = keepTake({ root, relPath: 'video/clip_b_00001_.mp4', shot: '1-4', readMeta: noMeta, rename: locked });
  assert.equal(r.ok, false);
  assert.match(r.message, /占用/);
  assert.equal(read(root, 'clip_1-4.safetensors'), 'A', 'the old take is back on the shot');
  assert.equal(read(root, 'clip_b_.safetensors'), 'B');
  assert.deepEqual(keptByVideo(root), { 'video/clip_a_00001_.mp4': '1-4' });
});

test('a record whose clip was deleted is forgotten, and the clip sync never clears a kept clip', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0 },
    'video/clip_a_00001_.mp4': { time: T0 + MIN },
  });
  keepTake({ root, relPath: 'video/clip_a_00001_.mp4', shot: '1-4', readMeta: noMeta });
  fs.rmSync(path.join(root, 'video/clip_a_00001_.mp4')); // the video goes, the kept clip must stay
  const plan = planSync({ root, readMeta: noMeta });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.held[0].stem, 'clip_1-4');
  assert.match(plan.held[0].reason, /1-4/);
  fs.rmSync(path.join(root, 'h3_context/clip_1-4.safetensors'));
  assert.deepEqual(readKept(root).shots, {});
});
