const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunProgress, createWebSocketTracker, outputVideos } = require('../src/run-progress');

test('progress events produce per-step timing, averages and remaining time', () => {
  let now = 1000;
  const progress = createRunProgress('prompt-1', () => now);
  progress.event({ type: 'execution_start', data: { prompt_id: 'prompt-1', timestamp: 1000 } });
  progress.event({ type: 'executing', data: { prompt_id: 'prompt-1', node: '125' } });
  now = 3000;
  progress.event({ type: 'progress', data: { prompt_id: 'prompt-1', node: '125', value: 1, max: 4 } });
  assert.equal(progress.state.stepMs, 2000);
  assert.equal(progress.state.averageStepMs, 2000);
  assert.equal(progress.state.remainingMs, 6000);
  now = 6000;
  progress.event({ type: 'progress', data: { prompt_id: 'prompt-1', node: '125', value: 2, max: 4 } });
  assert.equal(progress.state.stepMs, 3000);
  assert.equal(progress.state.averageStepMs, 2500);
  assert.equal(progress.state.remainingMs, 5000);
  progress.event({ type: 'progress', data: { prompt_id: 'another', node: '125', value: 3, max: 4 } });
  assert.equal(progress.state.value, 2);
  progress.event({ type: 'execution_success', data: { prompt_id: 'prompt-1', timestamp: 7000 } });
  assert.equal(progress.state.status, 'succeeded');
  assert.equal(progress.state.remainingMs, 0);
});

test('the websocket tracker parses events and closes cleanly', () => {
  const events = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; FakeWebSocket.instance = this; }
    close() { this.closed = true; }
  }
  const tracker = createWebSocketTracker({ port: 8188, promptId: 'p', onEvent: (event) => events.push(event), WebSocketClass: FakeWebSocket });
  assert.equal(FakeWebSocket.instance.url, 'ws://127.0.0.1:8188/ws');
  FakeWebSocket.instance.onmessage({ data: JSON.stringify({ type: 'executing', data: { prompt_id: 'p', node: '125' } }) });
  assert.equal(events[0].type, 'executing');
  tracker.close();
  assert.equal(FakeWebSocket.instance.closed, true);
});

test('the websocket tracker negotiates metadata and decodes binary previews', async () => {
  const events = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; FakeWebSocket.instance = this; }
    send(data) { this.sent = data; }
    close() {}
  }
  const tracker = createWebSocketTracker({ port: 8188, promptId: 'p', clientId: 'client 1', onEvent: (event) => events.push(event), WebSocketClass: FakeWebSocket });
  const ws = FakeWebSocket.instance;
  assert.equal(ws.url, 'ws://127.0.0.1:8188/ws?clientId=client%201');
  ws.onopen();
  assert.deepEqual(JSON.parse(ws.sent), { type: 'feature_flags', data: { supports_preview_metadata: true } });

  const metadata = Buffer.from(JSON.stringify({ prompt_id: 'p', node_id: '125', image_type: 'image/png' }));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(metadata.length, 4);
  await ws.onmessage({ data: Buffer.concat([header, metadata, Buffer.from('png-bytes')]) });
  let preview = events.find((event) => event.type === 'preview');
  assert.equal(preview.data.prompt_id, 'p');
  assert.equal(preview.data.node, '125');
  assert.equal(preview.data.mime, 'image/png');
  assert.equal(Buffer.from(preview.data.data, 'base64').toString(), 'png-bytes');

  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  await ws.onmessage({ data: Buffer.concat([header, Buffer.from('jpeg-bytes')]) });
  preview = events.filter((event) => event.type === 'preview')[1];
  assert.equal(preview.data.mime, 'image/jpeg');
  assert.equal(Buffer.from(preview.data.data, 'base64').toString(), 'jpeg-bytes');
  tracker.close();
});

test('preview events are filtered by prompt and output videos become media relative paths', () => {
  const progress = createRunProgress('p');
  progress.event({ type: 'preview', data: { prompt_id: 'other', data: 'wrong' } });
  assert.equal(progress.state.preview, null);
  progress.event({ type: 'preview', data: { prompt_id: 'p', node: '125', mime: 'image/jpeg', data: 'right' } });
  assert.equal(progress.state.preview.data, 'right');
  progress.finish('succeeded', { outputs: {
    9: { videos: [{ filename: 'final.mp4', subfolder: 'video', type: 'output' }] },
    10: { images: [{ filename: '../escape.mp4', subfolder: '', type: 'output' }, { filename: 'still.png', subfolder: '', type: 'output' }] },
  } });
  assert.deepEqual(progress.state.videos, [{ relPath: 'video/final.mp4', name: 'final.mp4' }]);
  assert.deepEqual(outputVideos(null), []);
});

test('with past runs the whole run is one bar: elapsed against what is left, capped until done', () => {
  let now = 0;
  const estimate = { totalMs: 100000, firstStepMs: 20000, tailMs: 10000 };
  const progress = createRunProgress('p', () => now, { startedAt: 0, estimate });
  assert.deepEqual(progress.overall(0), { progress: 0, remainingMs: 100000, elapsedMs: 0, stage: 'queued' });
  progress.event({ type: 'execution_start', data: { prompt_id: 'p', timestamp: 0 } });
  now = 10000;
  assert.deepEqual(progress.overall(), { progress: 0.1, remainingMs: 90000, elapsedMs: 10000, stage: 'prep' });
  now = 20000;
  progress.event({ type: 'executing', data: { prompt_id: 'p', node: 'sampler' } });
  now = 27000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: 'sampler', value: 1, max: 10 } });
  assert.equal(progress.overall().remainingMs, 73000, 'one step says nothing about the rate yet: past runs decide');
  now = 32000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: 'sampler', value: 2, max: 10 } });
  now = 34000;
  const sampling = progress.overall();
  assert.equal(sampling.stage, 'steps');
  assert.equal(sampling.remainingMs, 8 * 5000 - 2000 + 10000, 'the steps still to go at the rate after the first one, then the tail');
  assert.equal(sampling.progress, 34000 / (34000 + 48000));
  now = 90000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: 'sampler', value: 10, max: 10 } });
  progress.event({ type: 'executing', data: { prompt_id: 'p', node: 'decode' } });
  now = 95000;
  assert.equal(progress.overall().stage, 'tail');
  assert.equal(progress.overall().remainingMs, 5000);
  now = 130000;
  assert.equal(progress.overall().progress, 0.95, 'a run slower than the estimate waits just short of full');
  progress.event({ type: 'execution_success', data: { prompt_id: 'p', timestamp: 131000 } });
  assert.equal(progress.overall().progress, 1);
  assert.deepEqual(progress.timing(), { totalMs: 131000, firstStepMs: 27000, tailMs: 131000 - 90000 });
});

test('the whole-run bar never moves back, e.g. when a second sampler starts', () => {
  let now = 0;
  const progress = createRunProgress('p', () => now, { startedAt: 0, estimate: { totalMs: 100000, tailMs: 10000 } });
  progress.event({ type: 'executing', data: { prompt_id: 'p', node: 'a' } });
  now = 1000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: 'a', value: 1, max: 2 } });
  now = 2000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: 'a', value: 2, max: 2 } });
  progress.event({ type: 'executing', data: { prompt_id: 'p', node: 'between' } });
  now = 13000;
  const before = progress.overall().progress;
  assert.equal(before, 0.95);
  progress.event({ type: 'executing', data: { prompt_id: 'p', node: 'b' } });
  now = 14000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: 'b', value: 1, max: 20 } });
  assert.equal(progress.overall().progress, before);
});

test('without past runs: nodes before the steps, the steps fill 10%-90%, then the rest', () => {
  let now = 0;
  const progress = createRunProgress('p', () => now, { startedAt: 0, nodeCount: 10 });
  progress.event({ type: 'execution_start', data: { prompt_id: 'p', timestamp: 0 } });
  for (const node of ['1', '2', '3']) progress.event({ type: 'executing', data: { prompt_id: 'p', node } });
  assert.equal(progress.overall().progress, 0.1 * (2 / 10));
  assert.equal(progress.overall().remainingMs, null);
  now = 1000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: '3', value: 1, max: 4 } });
  now = 2000;
  progress.event({ type: 'progress', data: { prompt_id: 'p', node: '3', value: 2, max: 4 } });
  assert.equal(progress.overall().progress, 0.1 + 0.8 * 0.5);
  assert.equal(progress.overall().remainingMs, 2000);
  progress.event({ type: 'executing', data: { prompt_id: 'p', node: '4' } });
  assert.equal(progress.overall().stage, 'tail');
  assert.ok(progress.overall().progress >= 0.9);
});
