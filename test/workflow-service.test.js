const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWorkflowService } = require('../src/workflow-service');
const { loadTemplate, templateForm } = require('../src/workflow-template');

const templateDir = path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-hybrid');
const template = loadTemplate(templateDir);

function harness() {
  const state = { submitted: null, tracker: null, closed: false, interrupted: false, history: {}, clientId: '' };
  const api = {
    async systemStats() { return { argv: ['--preview-method', 'auto'] }; },
    async prompt(graph, options) { state.submitted = graph; state.clientId = options.clientId; return { prompt_id: 'prompt-test' }; },
    async history() { return state.history; },
    async interrupt() { state.interrupted = true; },
  };
  const service = createWorkflowService({
    getTemplateDir: () => templateDir,
    getConfig: () => ({ port: 8188 }),
    apiFactory: () => api,
    trackerFactory: (options) => {
      state.tracker = options;
      return { close() { state.closed = true; } };
    },
    now: () => 1000,
    idFactory: () => 'client-test',
  });
  return { service, state };
}

test('start submits a compiled graph and tracks progress, preview and output video', async () => {
  const { service, state } = harness();
  const started = await service.start(templateForm(template).defaults);
  assert.equal(started.ok, true);
  assert.equal(started.run.promptId, 'prompt-test');
  assert.equal(started.run.clientId, 'client-test');
  assert.equal(started.run.previewMethod, 'auto');
  assert.equal(state.clientId, 'client-test');
  assert.equal(state.tracker.clientId, 'client-test');
  assert.equal(state.submitted['362'].inputs.value, false);
  const duplicate = await service.start(templateForm(template).defaults);
  assert.equal(duplicate.ok, false);

  state.tracker.onEvent({ type: 'execution_start', data: { prompt_id: 'prompt-test', timestamp: 1000 } });
  state.tracker.onEvent({ type: 'executing', data: { prompt_id: 'prompt-test', node: '125' } });
  state.tracker.onEvent({ type: 'progress', data: { prompt_id: 'prompt-test', node: '125', value: 1, max: 4 } });
  state.tracker.onEvent({ type: 'preview', data: { prompt_id: 'prompt-test', node: '125', mime: 'image/jpeg', data: 'frame' } });
  state.history = { 'prompt-test': { status: { status_str: 'success' }, outputs: {
    9: { videos: [{ filename: 'final.mp4', subfolder: 'video', type: 'output' }] },
  } } };
  state.tracker.onEvent({ type: 'execution_success', data: { prompt_id: 'prompt-test', timestamp: 5000 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.run().run.status, 'succeeded');
  assert.equal(service.run().run.preview.data, 'frame');
  assert.deepEqual(service.run().run.videos, [{ relPath: 'video/final.mp4', name: 'final.mp4' }]);
  assert.equal(state.closed, true);
  service.close();
});

test('late history from a previous run cannot finish a new run', async () => {
  const { service, state } = harness();
  await service.start(templateForm(template).defaults);
  let resolveHistory;
  state.history = new Promise((resolve) => { resolveHistory = resolve; });
  state.tracker.onEvent({ type: 'execution_success', data: { prompt_id: 'prompt-test', timestamp: 5000 } });
  const next = await service.start(templateForm(template).defaults);
  assert.equal(next.ok, true);
  resolveHistory({ 'prompt-test': { status: { status_str: 'success' }, outputs: { 9: { videos: [{ filename: 'old.mp4', type: 'output' }] } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.run().run.status, 'queued');
  assert.equal(service.run().run.outputs, null);
  assert.deepEqual(service.run().run.videos, []);
  service.close();
});

test('cancel interrupts the active task and finishes as cancelled', async () => {
  const { service, state } = harness();
  await service.start(templateForm(template).defaults);
  const cancelled = await service.cancel();
  assert.equal(cancelled.ok, true);
  assert.equal(state.interrupted, true);
  assert.equal(service.run().run.status, 'cancelling');
  state.tracker.onEvent({ type: 'execution_interrupted', data: { prompt_id: 'prompt-test' } });
  assert.equal(service.run().run.status, 'cancelled');
  service.close();
});
