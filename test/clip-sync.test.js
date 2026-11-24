const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planSync, trashClips } = require('../src/clip-sync');

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-clip-'));
  for (const [rel, spec] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, spec.data ?? 'x');
    const t = new Date(spec.time);
    fs.utimesSync(full, t, t);
  }
  return root;
}
const stems = (list) => list.map((c) => c.stem);

test('each video keeps the newest clip saved before it, the other clips are removable', () => {
  const root = makeTree({
    'h3_context/clip_1012-100000_.safetensors': { time: T0 },
    'h3_context/clip_1012-100000_.jpg': { time: T0, data: 'jpg' },
    'h3_context/clip_1012-101000_.safetensors': { time: T0 + 10 * MIN },
    'h3_context/clip_1012-102000_.safetensors': { time: T0 + 20 * MIN },
    'video/m_00001_.mp4': { time: T0 + 1 * MIN }, // follows the first clip
    'video/m_00002_.mp4': { time: T0 + 21 * MIN }, // follows the third clip; the second take was deleted
  });
  const p = planSync({ root });
  assert.deepEqual(stems(p.keep), ['clip_1012-100000_', 'clip_1012-102000_']);
  assert.deepEqual(stems(p.remove), ['clip_1012-101000_']);
  assert.deepEqual(p.keep[0].videos, ['video/m_00001_.mp4']);
  assert.deepEqual(p.keep[0].files, ['clip_1012-100000_.safetensors', 'clip_1012-100000_.jpg']);
  assert.equal(p.keep[0].bytes, 4);
  assert.equal(p.removeBytes, 1);
  assert.equal(p.videoCount, 2);
});

test('a video in a sub-folder counts too, and two videos can share one clip', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0 },
    'h3_context/clip_b_.safetensors': { time: T0 + 30 * MIN },
    'video/final_00001_.mp4': { time: T0 + 8 * MIN },
    'video/第一遍对比/first_00001_.mp4': { time: T0 + 2 * MIN },
  });
  const p = planSync({ root });
  assert.deepEqual(stems(p.keep), ['clip_a_']);
  assert.deepEqual(p.keep[0].videos, ['video/final_00001_.mp4', 'video/第一遍对比/first_00001_.mp4']);
  assert.deepEqual(stems(p.remove), ['clip_b_']);
});

test('numbered slots are held back unless asked for', () => {
  const root = makeTree({
    'h3_context/clip_00003.safetensors': { time: T0 },
    'h3_context/clip_00008_.safetensors': { time: T0 + MIN }, // old auto name: a take, not a slot
    'video/m_00001_.mp4': { time: T0 + 5 * MIN },
  });
  let p = planSync({ root });
  assert.deepEqual(stems(p.keep), ['clip_00008_']);
  assert.deepEqual(stems(p.held), ['clip_00003']);
  assert.deepEqual(stems(p.remove), []);
  p = planSync({ root, includeSlots: true });
  assert.deepEqual(stems(p.remove), ['clip_00003']);
});

test('while ComfyUI is generating, a clip newer than every video is left alone', () => {
  const root = makeTree({
    'h3_context/clip_old_.safetensors': { time: T0 },
    'h3_context/clip_now_.safetensors': { time: T0 + 30 * MIN },
    'video/m_00001_.mp4': { time: T0 + 5 * MIN },
  });
  const idle = planSync({ root, generating: false });
  assert.deepEqual(stems(idle.remove), ['clip_now_']);
  const busy = planSync({ root, generating: true });
  assert.deepEqual(stems(busy.remove), []);
  assert.deepEqual(stems(busy.held), ['clip_now_']);
});

test('a video far later than any clip is not matched to an old clip', () => {
  const root = makeTree({
    'h3_context/clip_old_.safetensors': { time: T0 },
    'video/m_00001_.mp4': { time: T0 + 3 * 60 * MIN },
  });
  const p = planSync({ root });
  assert.deepEqual(stems(p.keep), []);
  assert.deepEqual(stems(p.remove), ['clip_old_']);
});

test('with no videos at all every take is removable, and a missing folder is reported', () => {
  const root = makeTree({ 'h3_context/clip_a_.safetensors': { time: T0 } });
  assert.deepEqual(stems(planSync({ root }).remove), ['clip_a_']);
  assert.equal(planSync({ root: path.join(root, 'nope') }).missing, true);
  assert.deepEqual(planSync({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'cl-clip-')) }).remove, []);
});

test('only the fresh plan decides what is trashed; a clip that gained a video is kept', async () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0 },
    'h3_context/clip_a_.jpg': { time: T0 },
    'h3_context/clip_b_.safetensors': { time: T0 + 10 * MIN },
    'h3_context/clip_b_.jpg': { time: T0 + 10 * MIN },
    'h3_context/clip_c_.safetensors': { time: T0 + 20 * MIN },
    'video/m_00001_.mp4': { time: T0 + 21 * MIN }, // clip_c_ is kept
  });
  const gone = [];
  const trash = async (p) => { gone.push(path.basename(p)); fs.rmSync(p); };
  const r = await trashClips({ root, stems: ['clip_a_', 'clip_c_', '../evil', 'clip_nope_', 42], trash });
  assert.deepEqual(r.trashed, ['clip_a_']);
  assert.deepEqual(r.skipped, ['clip_c_', '../evil', 'clip_nope_', 42]);
  assert.deepEqual(gone.sort(), ['clip_a_.jpg', 'clip_a_.safetensors']);
  assert.ok(fs.existsSync(path.join(root, 'h3_context/clip_b_.safetensors')), 'not asked for, so untouched');
  assert.ok(fs.existsSync(path.join(root, 'h3_context/clip_c_.safetensors')));
});

test('one failure does not stop the rest, and its files are reported', async () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0 },
    'h3_context/clip_b_.safetensors': { time: T0 + MIN },
  });
  const trash = async (p) => {
    if (p.includes('clip_a_')) throw new Error('文件正被占用');
    fs.rmSync(p);
  };
  const r = await trashClips({ root, stems: ['clip_a_', 'clip_b_'], trash });
  assert.deepEqual(r.trashed, ['clip_b_']);
  assert.deepEqual(r.failed, [{ stem: 'clip_a_', message: '文件正被占用' }]);
});

test('a video made without the clip-saving node (an upscale) is not matched to any clip', () => {
  const root = makeTree({
    'h3_context/clip_a_.safetensors': { time: T0 },
    'h3_context/clip_b_.safetensors': { time: T0 + 10 * MIN },
    'video/m_00001_.mp4': { time: T0 + 1 * MIN },
    'video/seedvr2/up_00001_.mp4': { time: T0 + 12 * MIN },
  });
  const readMeta = (file) => ({ tags: { prompt: file.includes('seedvr2') ? '{"1":{"class_type":"SeedVR2VideoUpscaler"}}' : '{"338":{"class_type":"MiniMaxH3MotionContextSaveLatent"}}' } });
  const p = planSync({ root, readMeta });
  assert.deepEqual(stems(p.keep), ['clip_a_']);
  assert.deepEqual(stems(p.remove), ['clip_b_']);
  assert.equal(p.videoCount, 1);
  // a video whose prompt cannot be read is assumed to have been made with clips, so its clip is kept
  const unknown = planSync({ root, readMeta: () => ({}) });
  assert.deepEqual(stems(unknown.keep), ['clip_a_', 'clip_b_']);
  assert.deepEqual(stems(planSync({ root, readMeta: () => { throw new Error('bad file'); } }).keep), ['clip_a_', 'clip_b_']);
});
