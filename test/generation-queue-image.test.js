const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGenerationQueue } = require('../src/generation-queue');
const { createTakeStore } = require('../src/take-store');
const { createAssetStore } = require('../src/asset-store');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Image takes next to video takes: one queue, each recorded in its own store, memory freed between families.
function harness({ freeFails = false } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), '宣传 视频-'));
  const outputDir = path.join(projectDir, 'output');
  fs.mkdirSync(path.join(outputDir, 'ref'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
  const shots = createTakeStore(projectDir);
  const cards = createAssetStore(projectDir);
  const calls = [];
  const state = { history: {}, trackers: [] };
  const api = {
    async systemStats() { return {}; },
    async free() { calls.push('free'); if (freeFails) throw new Error('HTTP 500'); },
    async prompt() { calls.push('prompt'); return { prompt_id: `p${calls.filter((c) => c === 'prompt').length}` }; },
    async history(id) { return state.history[id] ? { [id]: state.history[id] } : {}; },
    async queuePrompts() { return []; },
    async interrupt() {},
  };
  const queue = createGenerationQueue({
    apiFactory: () => api,
    trackerFactory: (options) => { state.trackers.push(options); return { close() {} }; },
    getPort: () => 8188,
    now: () => 1000,
    readMediaMeta: (file) => (/\.png$/.test(file) ? { width: 1140, height: 1472 } : { duration: 4 }),
    historyEveryMs: 60 * 60 * 1000,
  });
  const imageJob = (code, family = 'qwen-image') => {
    const take = cards.addTake(code, {});
    return { kind: 'image', family, projectDir, outputDir, shotId: code, takeId: take.id, outputKey: take.outputKey, workflow: {} };
  };
  const videoJob = (shotId) => {
    const take = shots.addTake(shotId, {});
    return { kind: 'video', family: 'h3', projectDir, outputDir, shotId, takeId: take.id, outputKey: take.outputKey, workflow: {} };
  };
  const finish = async (i, promptId, outputs = {}) => {
    state.history[promptId] = { status: { status_str: 'success' }, outputs };
    state.trackers[i].onEvent({ type: 'execution_success', data: { prompt_id: promptId } });
    await tick(); await tick();
  };
  return { queue, cards, shots, calls, finish, imageJob, videoJob, outputDir, projectDir };
}

test('an image take records its picture and size in the card', async () => {
  const h = harness();
  const job = h.imageJob('QX');
  h.queue.enqueue([job]);
  await tick();
  assert.equal(h.cards.readCard('QX').takes[0].status, 'running');
  assert.equal(h.queue.snapshot().jobs[0].kind, 'image');
  fs.writeFileSync(path.join(h.outputDir, 'ref', `${job.outputKey}_00001_.png`), 'p');
  await h.finish(0, 'p1', { 8: { images: [{ filename: `${job.outputKey}_00001_.png`, subfolder: 'ref', type: 'output' }] } });
  const take = h.cards.readCard('QX').takes[0];
  assert.equal(take.status, 'succeeded');
  assert.equal(take.image, `ref/${job.outputKey}_00001_.png`);
  assert.deepEqual([take.width, take.height], [1140, 1472]);
  assert.equal(take.video, undefined);
});

test('memory is freed only when the model family changes', async () => {
  const h = harness();
  const jobs = [h.imageJob('QX'), h.imageJob('QX'), h.videoJob('MOTION-E01-01'), h.imageJob('YS-YK')];
  h.queue.enqueue(jobs);
  await tick();
  for (let i = 0; i < jobs.length; i++) {
    await h.finish(i, `p${i + 1}`);
    await tick();
  }
  assert.deepEqual(h.calls, ['prompt', 'prompt', 'free', 'prompt', 'free', 'prompt']);
  assert.equal(h.shots.readShot('MOTION-E01-01').takes[0].status, 'succeeded');
});

test('a failing free does not stop the run', async () => {
  const h = harness({ freeFails: true });
  h.queue.enqueue([h.videoJob('MOTION-E01-01'), h.imageJob('QX')]);
  await tick();
  await h.finish(0, 'p1');
  await tick();
  assert.deepEqual(h.calls, ['prompt', 'free', 'prompt']);
  assert.equal(h.cards.readCard('QX').takes[0].status, 'running');
});

test('resume finds a finished image take by its file name', async () => {
  const h = harness();
  const take = h.cards.addTake('QX', {});
  h.cards.updateTake('QX', take.id, { status: 'running', promptId: 'gone' });
  const waiting = h.cards.addTake('QX', {});
  fs.writeFileSync(path.join(h.outputDir, 'ref', `${take.outputKey}_00001_.png`), 'p');
  await h.queue.resume({ projectDir: h.projectDir, outputDir: h.outputDir, store: h.cards, kind: 'image' });
  const [done, interrupted] = h.cards.readCard('QX').takes;
  assert.equal(done.status, 'succeeded');
  assert.equal(done.image, `ref/${take.outputKey}_00001_.png`);
  assert.equal(interrupted.id, waiting.id);
  assert.equal(interrupted.status, 'interrupted');
});
