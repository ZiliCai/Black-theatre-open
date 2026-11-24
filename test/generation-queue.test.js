const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGenerationQueue } = require('../src/generation-queue');
const { createTakeStore } = require('../src/take-store');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ statsFails = false, clock = () => 1000 } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-proj-'));
  const outputDir = path.join(projectDir, 'output');
  fs.mkdirSync(path.join(outputDir, 'h3_context'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
  const store = createTakeStore(projectDir);
  const state = { prompts: [], trackers: [], interrupted: 0, history: {}, statsFails, changes: 0, down: false, queueIds: null, statsGate: null, breakStore: false };
  const up = () => { if (state.down) throw new Error('connect ECONNREFUSED'); };
  const api = {
    async systemStats() {
      if (state.statsGate) await state.statsGate;
      up();
      if (state.statsFails) throw new Error('connect ECONNREFUSED');
      return {};
    },
    async prompt(graph, { clientId } = {}) {
      up();
      const id = `p${state.prompts.length + 1}`;
      state.prompts.push({ id, graph, clientId });
      // the run arrives, the answer does not (a slow remote link)
      if (state.lostAnswer) throw new Error('请求超时(30000 ms)');
      return { prompt_id: id };
    },
    async promptByClient(clientId) { up(); const p = state.prompts.find((x) => x.clientId === clientId); return p ? p.id : null; },
    async history(id) { up(); return state.history[id] ? { [id]: state.history[id] } : {}; },
    async queuePrompts() { up(); return state.queueIds || []; },
    async interrupt() { up(); state.interrupted++; },
  };
  const queue = createGenerationQueue({
    apiFactory: () => api,
    trackerFactory: (options) => { state.trackers.push(options); return { close() {} }; },
    getPort: () => 8188,
    now: clock,
    onChange: () => { state.changes++; },
    readMediaMeta: () => ({ duration: 5.9 }),
    historyEveryMs: 60 * 60 * 1000,
    // a store whose writes can be made to fail, like a OneDrive folder holding a file
    storeFor: (dir) => {
      const real = createTakeStore(dir);
      return { ...real, updateTake: (...args) => { if (state.breakStore) throw new Error('EPERM: operation not permitted, rename'); return real.updateTake(...args); } };
    },
  });
  // a finished run: its files on disk and its ComfyUI history entry
  const produce = (promptId, key) => {
    fs.writeFileSync(path.join(outputDir, 'video', `${key}_00001_.mp4`), 'v');
    fs.writeFileSync(path.join(outputDir, 'h3_context', `${key}_1026-120000_.safetensors`), 'l');
    fs.writeFileSync(path.join(outputDir, 'h3_context', `${key}_1026-120000_.jpg`), 'j');
    state.history[promptId] = { status: { status_str: 'success' }, outputs: { 364: { gifs: [{ filename: `${key}_00001_.mp4`, subfolder: 'video', type: 'output' }] } } };
  };
  const job = (shotId) => {
    const take = store.addTake(shotId, { status: 'queued' });
    return { projectDir, outputDir, shotId, takeId: take.id, workflow: { 1: { inputs: { key: take.outputKey } } }, outputKey: take.outputKey };
  };
  const takeOf = (shotId, takeId) => store.readShot(shotId).takes.find((t) => t.id === takeId);
  return { queue, state, store, produce, job, takeOf, projectDir, outputDir };
}

test('runs jobs one at a time and records outputs', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-01');
  h.queue.enqueue([a, b]);
  await tick();
  assert.equal(h.state.prompts.length, 1, 'the second job waits');
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).status, 'running');
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).promptId, 'p1');
  assert.equal(h.queue.snapshot().jobs.length, 2);

  h.produce('p1', a.outputKey);
  h.state.trackers[0].onEvent({ type: 'execution_success', data: { prompt_id: 'p1' } });
  await tick(); await tick();
  const done = h.takeOf('MOTION-E01-01', a.takeId);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.video, `video/${a.outputKey}_00001_.mp4`);
  assert.equal(done.context, `${a.outputKey}_1026-120000_`);
  assert.equal(done.durationSec, 5.9);
  assert.equal(h.state.prompts.length, 2, 'then the next one is submitted');
  assert.ok(h.state.changes > 0);
});

test('the snapshot shows the whole run as one bar, and a finished run records how long it took', async () => {
  let now = 1000;
  const h = harness({ clock: () => now });
  const a = { ...h.job('MOTION-E01-01'), estimate: { totalMs: 100000, firstStepMs: 20000, tailMs: 10000 } };
  h.queue.enqueue([a]);
  let job = h.queue.snapshot().jobs[0];
  assert.equal(job.stage, 'queued');
  assert.equal(job.remainingMs, 100000, 'while waiting: how long one run takes');
  await tick();
  const t = h.state.trackers[0];
  t.onEvent({ type: 'execution_start', data: { prompt_id: 'p1', timestamp: 1000 } });
  now = 11000;
  job = h.queue.snapshot().jobs[0];
  assert.equal(job.stage, 'prep');
  assert.equal(job.progress, 0.1);
  assert.equal(job.elapsedMs, 10000);
  assert.equal(job.remainingMs, 90000);
  t.onEvent({ type: 'executing', data: { prompt_id: 'p1', node: '1' } });
  now = 21000;
  t.onEvent({ type: 'progress', data: { prompt_id: 'p1', node: '1', value: 1, max: 1 } });
  now = 31000;
  h.produce('p1', a.outputKey);
  t.onEvent({ type: 'execution_success', data: { prompt_id: 'p1', timestamp: 31000 } });
  await tick(); await tick();
  assert.deepEqual(h.takeOf('MOTION-E01-01', a.takeId).timing, { totalMs: 30000, firstStepMs: 20000, tailMs: 10000 });
});

test('a run that reached ComfyUI although its answer was lost is followed, not sent again', async () => {
  const h = harness();
  h.state.lostAnswer = true;
  const a = h.job('MOTION-E01-01');
  h.queue.enqueue([a]);
  await tick(); await tick();
  assert.equal(h.state.prompts.length, 1, 'sent once');
  const take = h.takeOf('MOTION-E01-01', a.takeId);
  assert.equal(take.status, 'running');
  assert.equal(take.promptId, 'p1');
  assert.equal(h.queue.snapshot().paused, false);
});

test('submit failure fails the take and pauses the queue', async () => {
  const h = harness({ statsFails: true });
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-01');
  h.queue.enqueue([a, b]);
  await tick();
  const failed = h.takeOf('MOTION-E01-01', a.takeId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ComfyUI 未运行或无法连接/);
  assert.equal(h.takeOf('MOTION-E01-01', b.takeId).status, 'queued');
  const snap = h.queue.snapshot();
  assert.equal(snap.paused, true);
  assert.match(snap.message, /ComfyUI 未运行或无法连接/);
  assert.equal(h.queue.busy(), true);

  h.state.statsFails = false;
  h.queue.retry();
  await tick();
  assert.equal(h.state.prompts.length, 1);
  assert.equal(h.takeOf('MOTION-E01-01', b.takeId).status, 'running');
  assert.equal(h.queue.snapshot().paused, false);
});

test('execution error fails only that take', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-02');
  h.queue.enqueue([a, b]);
  await tick();
  h.state.trackers[0].onEvent({ type: 'execution_error', data: { prompt_id: 'p1', exception_message: 'CUDA out of memory' } });
  await tick();
  const failed = h.takeOf('MOTION-E01-01', a.takeId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'CUDA out of memory');
  assert.equal(h.state.prompts.length, 2);
  assert.equal(h.queue.snapshot().paused, false);
});

test('cancel removes a queued job and interrupts a running one', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-01');
  h.queue.enqueue([a, b]);
  await tick();
  assert.equal((await h.queue.cancel(b.takeId)).ok, true);
  assert.equal(h.takeOf('MOTION-E01-01', b.takeId).status, 'cancelled');
  assert.equal(h.queue.snapshot().jobs.length, 1);

  assert.equal((await h.queue.cancel(a.takeId)).ok, true);
  assert.equal(h.state.interrupted, 1);
  h.state.trackers[0].onEvent({ type: 'execution_interrupted', data: { prompt_id: 'p1' } });
  await tick();
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).status, 'cancelled');
  assert.equal(h.queue.busy(), false);
  assert.equal((await h.queue.cancel('nope')).ok, false);
});

test('cancelAll clears the queue and interrupts the running job', async () => {
  const h = harness();
  const jobs = [h.job('MOTION-E01-01'), h.job('MOTION-E01-01'), h.job('MOTION-E01-01')];
  h.queue.enqueue(jobs);
  await tick();
  await h.queue.cancelAll();
  assert.equal(h.state.interrupted, 1);
  assert.equal(h.takeOf('MOTION-E01-01', jobs[2].takeId).status, 'cancelled');
  h.state.trackers[0].onEvent({ type: 'execution_interrupted', data: { prompt_id: 'p1' } });
  await tick();
  assert.equal(h.queue.busy(), false);
  assert.equal(h.state.prompts.length, 1);
});

test('ComfyUI dying mid-run fails the take and pauses instead of hanging', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-01');
  h.queue.enqueue([a, b]);
  await tick();
  h.state.down = true; // every request now fails
  for (let i = 0; i < 12; i++) await h.queue.pollActive();
  const failed = h.takeOf('MOTION-E01-01', a.takeId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ComfyUI 中途退出或无法连接/);
  assert.equal(h.queue.snapshot().paused, true);
  assert.equal(h.takeOf('MOTION-E01-01', b.takeId).status, 'queued');
});

test('a run ComfyUI no longer knows about (restarted) fails after a while', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  h.queue.enqueue([a]);
  await tick();
  h.state.queueIds = []; // reachable, but neither in history nor in the queue
  for (let i = 0; i < 12; i++) await h.queue.pollActive();
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).status, 'failed');
  assert.equal(h.queue.busy(), false);
});

test('a run still in ComfyUI queue is not given up', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  h.queue.enqueue([a]);
  await tick();
  h.state.queueIds = ['p1'];
  for (let i = 0; i < 20; i++) await h.queue.pollActive();
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).status, 'running');
});

test('cancel drops the running job when ComfyUI cannot be reached', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  h.queue.enqueue([a]);
  await tick();
  h.state.down = true;
  const r = await h.queue.cancel(a.takeId);
  assert.equal(r.ok, true);
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).status, 'cancelled');
  assert.equal(h.queue.busy(), false);
});

test('cancelling while the job is being submitted never submits it twice', async () => {
  const h = harness();
  let release;
  h.state.statsGate = new Promise((r) => { release = r; });
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-01');
  h.queue.enqueue([a, b]);
  await tick(); // a is waiting for systemStats
  await h.queue.cancel(a.takeId);
  release();
  await tick(); await tick(); await tick();
  assert.equal(h.takeOf('MOTION-E01-01', a.takeId).status, 'cancelled');
  assert.equal(h.state.prompts.length, 1, 'only b reaches ComfyUI');
  assert.equal(h.takeOf('MOTION-E01-01', b.takeId).status, 'running');
});

test('a record that cannot be written does not stop the queue', async () => {
  const h = harness();
  const a = h.job('MOTION-E01-01');
  const b = h.job('MOTION-E01-01');
  h.queue.enqueue([a, b]);
  await tick();
  h.state.breakStore = true;
  h.produce('p1', a.outputKey);
  h.state.trackers[0].onEvent({ type: 'execution_success', data: { prompt_id: 'p1' } });
  await tick(); await tick();
  h.state.breakStore = false;
  assert.equal(h.state.prompts.length, 2, 'the next take is still submitted');
});

test('resume re-attaches a take ComfyUI is still running', async () => {
  const h = harness();
  const running = h.store.addTake('MOTION-E01-01', { status: 'running', promptId: 'old1' });
  h.state.queueIds = ['old1'];
  await h.queue.resume({ projectDir: h.projectDir, outputDir: h.outputDir, store: h.store });
  assert.equal(h.queue.busy(), true);
  assert.equal(h.takeOf('MOTION-E01-01', running.id).status, 'running');
  h.produce('old1', running.outputKey);
  await h.queue.pollActive();
  assert.equal(h.takeOf('MOTION-E01-01', running.id).status, 'succeeded');
  assert.equal(h.queue.busy(), false);
});

test('resume finds the files of a take whose history is gone', async () => {
  const h = harness();
  const t = h.store.addTake('MOTION-E01-01', { status: 'running', promptId: 'gone' });
  h.produce('gone', t.outputKey);
  delete h.state.history.gone;
  await h.queue.resume({ projectDir: h.projectDir, outputDir: h.outputDir, store: h.store });
  const r = h.takeOf('MOTION-E01-01', t.id);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.video, `video/${t.outputKey}_00001_.mp4`);
});

test('resume leaves takes alone while ComfyUI cannot be reached', async () => {
  const h = harness();
  const t = h.store.addTake('MOTION-E01-01', { status: 'running', promptId: 'x' });
  h.state.down = true;
  await h.queue.resume({ projectDir: h.projectDir, outputDir: h.outputDir, store: h.store });
  assert.equal(h.takeOf('MOTION-E01-01', t.id).status, 'running');
});

test('resume recovers submitted takes and interrupts the rest', async () => {
  const h = harness();
  const ran = h.store.addTake('MOTION-E01-01', { status: 'running', promptId: 'old1' });
  const lost = h.store.addTake('MOTION-E01-01', { status: 'running', promptId: 'old2' });
  const never = h.store.addTake('MOTION-E01-02', { status: 'queued' });
  h.produce('old1', ran.outputKey);
  await h.queue.resume({ projectDir: h.projectDir, outputDir: h.outputDir, store: h.store });
  const recovered = h.takeOf('MOTION-E01-01', ran.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.context, `${ran.outputKey}_1026-120000_`);
  assert.equal(h.takeOf('MOTION-E01-01', lost.id).status, 'interrupted');
  assert.equal(h.takeOf('MOTION-E01-02', never.id).status, 'interrupted');
});
