const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  qualitiesFor, upscaleSettings, loadUpscaleTemplate, compileUpscale, inputNameFor, findUpscaled, createUpscaleStore, createUpscaleService,
} = require('../src/upscale');
const { createGenerationQueue } = require('../src/generation-queue');
const { createTakeStore } = require('../src/take-store');
const { listTemplates } = require('../src/workflow-template');
const { takeFiles } = require('../src/take-outputs');
const R = require('../src/take-rules');

const TEMPLATES = path.join(__dirname, '..', 'workflow-templates');
const GB = 2 ** 30;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A project with one shot whose take 1 is chosen and take 2 is only a candidate, both with a video.
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
  const store = createTakeStore(dir);
  const pick = store.addTake('MOTION-E01-01', { status: 'succeeded', tier: 'pick', durationSec: 4.5 });
  store.updateTake('MOTION-E01-01', pick.id, { video: `video/${pick.outputKey}_00001_.mp4` });
  const cand = store.addTake('MOTION-E01-01', { status: 'succeeded', tier: 'cand', durationSec: 4.5 });
  store.updateTake('MOTION-E01-01', cand.id, { video: `video/${cand.outputKey}_00001_.mp4` });
  fs.writeFileSync(path.join(outputDir, 'video', `${pick.outputKey}_00001_.mp4`), 'original');
  return { dir, outputDir, store, pick: store.readShot('MOTION-E01-01').takes[0], cand: store.readShot('MOTION-E01-01').takes[1] };
}

function service(p, { vram = 24 * GB } = {}) {
  const queued = [];
  const svc = createUpscaleService({
    getProject: () => ({ dir: p.dir, outputDir: p.outputDir }),
    templatesDir: TEMPLATES,
    queue: { enqueue: (jobs) => queued.push(...jobs) },
    getVram: () => vram,
    picks: () => [{ shotId: 'MOTION-E01-01', take: p.store.readShot('MOTION-E01-01').takes[0] }],
  });
  return { svc, queued };
}

test('settings follow the card: a small card keeps the settings that ran on a 3080, a big one keeps the model on it', () => {
  assert.deepEqual(upscaleSettings(10 * GB, '1080p'), { quality: '1080p', resolution: 1080, blocksToSwap: 32, batchSize: 9, overlap: 3, tile: 512 });
  assert.equal(upscaleSettings(23.5 * GB, '1080p').blocksToSwap, 0);
  assert.equal(upscaleSettings(null, '720p').blocksToSwap, 32, 'unknown memory counts as a small card');
  for (const gb of [8, 16, 24]) assert.equal((upscaleSettings(gb * GB).batchSize - 1) % 4, 0, 'batches are 4n+1 frames');
  assert.equal(upscaleSettings(24 * GB, '4k'), null);
  assert.deepEqual(qualitiesFor(10 * GB), ['720p', '1080p']);
  assert.deepEqual(qualitiesFor(24 * GB), ['720p', '1080p', '1440p']);
});

test('the upscale workflow reads the original from the input folder and saves beside the takes', () => {
  const template = loadUpscaleTemplate(TEMPLATES);
  const graph = compileUpscale(template, { inputName: 'blackbox/bb_x_00001_.mp4', settings: upscaleSettings(24 * GB, '1440p'), outputKey: 'bb_x_up' });
  assert.equal(graph['3'].inputs.video, 'blackbox/bb_x_00001_.mp4');
  assert.equal(graph['3'].inputs.frame_load_cap, 0, 'the whole clip, never a 17-frame test');
  assert.equal(graph['5'].inputs.resolution, 1440);
  assert.equal(graph['5'].inputs.max_resolution, 0, 'a limit here would squeeze the long side back');
  assert.equal(graph['5'].inputs.batch_size, 21);
  assert.equal(graph['1'].inputs.blocks_to_swap, 0);
  assert.equal(graph['2'].inputs.decode_tile_size, 768);
  assert.equal(graph['6'].inputs.filename_prefix, 'video/upscaled/bb_x_up');
  assert.deepEqual(graph['6'].inputs.audio, ['3', 2], 'the original sound goes back in');
  assert.equal(template.graph['5'].inputs.resolution, 1080, 'the template itself is not changed');
  assert.equal(inputNameFor('video\\bb_x_00001_.mp4'), 'blackbox/bb_x_00001_.mp4');
});

test('upscaling is not offered as a way to make a shot', () => {
  const listed = listTemplates(TEMPLATES).find((t) => t.dirName === 'seedvr2-upscale');
  assert.equal(listed.kind, 'upscale');
});

test('only the chosen take is upscaled, once per size', () => {
  const p = project();
  const { svc, queued } = service(p);
  assert.match(svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.cand.id }).message, /选中/);
  const r = svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id, quality: '1080p' });
  assert.equal(r.ok, true);
  assert.equal(queued.length, 1);
  const job = queued[0];
  assert.equal(job.kind, 'upscale');
  assert.equal(job.family, 'seedvr2');
  assert.equal(job.outputKey, `${p.pick.outputKey}_up`);
  assert.deepEqual(job.inputFiles, [{ rel: `blackbox/${p.pick.outputKey}_00001_.mp4`, abs: path.join(p.outputDir, 'video', `${p.pick.outputKey}_00001_.mp4`) }]);
  const up = p.store.readShot('MOTION-E01-01').takes[0].upscale;
  assert.equal(up.status, 'queued');
  assert.equal(up.quality, '1080p');
  assert.match(svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id }).message, /已经在超分/);
  p.store.updateTake('MOTION-E01-01', p.pick.id, { upscale: { ...up, status: 'succeeded', video: 'video/upscaled/x.mp4' } });
  assert.match(svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id }).message, /已经超分成 1080p/);
  assert.equal(svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id, quality: '720p' }).ok, true, 'another size is a new run');
  assert.equal(svc.enqueueEpisode({ episodeId: 'E01', quality: '720p' }).ok, false, 'nothing left in the episode');
});

test('a size the card cannot take is refused', () => {
  const p = project();
  const { svc, queued } = service(p, { vram: 10 * GB });
  assert.match(svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id, quality: '1440p' }).message, /显存不够/);
  assert.equal(queued.length, 0);
});

test('the queue uploads the original, runs, and writes the result into the take\'s upscale record', async () => {
  const p = project();
  const { svc, queued } = service(p);
  svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id });
  const job = queued[0];
  const state = { uploads: [], prompts: [], trackers: [] };
  const api = {
    async systemStats() { return {}; },
    async outputSize() { return null; },
    async uploadOutput(rel, abs, type) { state.uploads.push({ rel, abs, type }); },
    async free() { state.freed = true; },
    async prompt(graph) { state.prompts.push(graph); return { prompt_id: 'p1' }; },
    async history() { return {}; },
    async queuePrompts() { return []; },
  };
  const queue = createGenerationQueue({
    apiFactory: () => api, trackerFactory: (o) => { state.trackers.push(o); return { close() {} }; }, getPort: () => 8188,
    readMediaMeta: () => ({ width: 1920, height: 1080, duration: 4.5 }), historyEveryMs: 3600000,
  });
  queue.enqueue([job]);
  await tick(); await tick(); await tick();
  assert.deepEqual(state.uploads, [{ rel: job.inputFiles[0].rel, abs: job.inputFiles[0].abs, type: 'input' }]);
  assert.equal(state.prompts.length, 1);
  assert.equal(queue.snapshot().jobs[0].kind, 'upscale');
  const name = `${job.outputKey}_00001.mp4`;
  fs.mkdirSync(path.join(p.outputDir, 'video', 'upscaled'), { recursive: true });
  fs.writeFileSync(path.join(p.outputDir, 'video', 'upscaled', name), 'big');
  state.trackers[0].onEvent({ type: 'executed', data: { prompt_id: 'p1', node: '6', output: { gifs: [{ filename: name, subfolder: 'video/upscaled', type: 'output' }] } } });
  state.trackers[0].onEvent({ type: 'execution_success', data: { prompt_id: 'p1' } });
  await tick(); await tick();
  const take = p.store.readShot('MOTION-E01-01').takes[0];
  assert.equal(take.status, 'succeeded', 'the take itself is untouched');
  assert.equal(take.video, p.pick.video);
  assert.equal(take.upscale.status, 'succeeded');
  assert.equal(take.upscale.video, `video/upscaled/${name}`);
  assert.equal(take.upscale.height, 1080);
  assert.equal(findUpscaled(p.outputDir, job.outputKey), `video/upscaled/${name}`);
  fs.writeFileSync(path.join(p.outputDir, 'video', 'upscaled', `${job.outputKey}_00001-audio.mp4`), 'big, with sound');
  assert.equal(findUpscaled(p.outputDir, job.outputKey), `video/upscaled/${job.outputKey}_00001-audio.mp4`, 'the copy with the sound wins');
  // the timeline plays it, and deleting the take takes it along
  const timeline = R.timeline({ order: [{ id: 'MOTION-E01-01' }], states: new Map([['MOTION-E01-01', { takes: [take] }]]) });
  assert.equal(timeline.segments[0].upscaled, `video/upscaled/${name}`);
  assert.ok(takeFiles(p.outputDir, take).some((f) => f.endsWith(name)));
});

test('an original missing on this computer fails before anything is sent', async () => {
  const p = project();
  const { svc, queued } = service(p);
  svc.enqueue({ shotId: 'MOTION-E01-01', takeId: p.pick.id });
  fs.rmSync(queued[0].inputFiles[0].abs);
  const prompts = [];
  const queue = createGenerationQueue({
    apiFactory: () => ({ async systemStats() { return {}; }, async prompt(g) { prompts.push(g); return { prompt_id: 'p1' }; } }),
    trackerFactory: () => ({ close() {} }), getPort: () => 8188, historyEveryMs: 3600000,
  });
  queue.enqueue(queued);
  await tick(); await tick();
  assert.equal(prompts.length, 0);
  const up = p.store.readShot('MOTION-E01-01').takes[0].upscale;
  assert.equal(up.status, 'failed');
  assert.match(up.error, /原片/);
});

test('after a restart an upscale that finished meanwhile is picked up by its name', async () => {
  const p = project();
  const upStore = createUpscaleStore(p.dir);
  p.store.updateTake('MOTION-E01-01', p.pick.id, { upscale: { status: 'running', promptId: 'p9', outputKey: `${p.pick.outputKey}_up`, quality: '1080p' } });
  assert.deepEqual(upStore.readShot('MOTION-E01-01').takes.map((t) => t.id), [p.pick.id], 'only takes with an upscale record');
  fs.mkdirSync(path.join(p.outputDir, 'video', 'upscaled'), { recursive: true });
  fs.writeFileSync(path.join(p.outputDir, 'video', 'upscaled', `${p.pick.outputKey}_up_00001.mp4`), 'big');
  const queue = createGenerationQueue({
    apiFactory: () => ({ async queuePrompts() { return []; }, async history() { return {}; } }),
    getPort: () => 8188, readMediaMeta: () => ({ width: 1920, height: 1080, duration: 4.5 }),
  });
  await queue.resume({ projectDir: p.dir, outputDir: p.outputDir, store: upStore, kind: 'upscale' });
  const take = p.store.readShot('MOTION-E01-01').takes[0];
  assert.equal(take.upscale.status, 'succeeded');
  assert.equal(take.upscale.quality, '1080p', 'the rest of the record stays');
  assert.equal(take.upscale.video, `video/upscaled/${p.pick.outputKey}_up_00001.mp4`);
  assert.equal(take.status, 'succeeded');
});
