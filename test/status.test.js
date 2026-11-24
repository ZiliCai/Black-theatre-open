const test = require('node:test');
const assert = require('node:assert/strict');
const { getStatus } = require('../src/status');

const WORKDIR = 'C:\\BlackBox\\ComfyUI_windows_portable';
const config = { workdir: WORKDIR, port: 8188 };
const OURS_CMD = '"C:\\BlackBox\\ComfyUI_windows_portable\\python_embeded\\python.exe" -s ComfyUI\\main.py --port 8188';

const goodApi = {
  systemStats: async () => ({ ramTotal: 32e9, ramFree: 9e9, vramTotal: 10e9, vramFree: 4e9, deviceName: 'RTX 3080' }),
  queue: async () => ({ running: 1, pending: 2 }),
};
const deadApi = {
  systemStats: async () => { throw new Error('ECONNREFUSED'); },
  queue: async () => { throw new Error('ECONNREFUSED'); },
};
const base = {
  config, api: goodApi, probe: async () => ({ pid: 25400, commandLine: OURS_CMD }),
  memoryOf: async () => 1300, launch: null, isAlive: () => false, now: () => 100000,
};

test('api answers: running, with gpu, ram and queue numbers', async () => {
  const s = await getStatus(base);
  assert.equal(s.state, 'running');
  assert.equal(s.pid, 25400);
  assert.equal(s.ours, true);
  assert.deepEqual([s.vramTotal, s.vramFree], [10e9, 4e9]);
  assert.deepEqual([s.queueRunning, s.queuePending], [1, 2]);
  assert.equal(s.processMemMB, 1300);
});

test('api answers but the listener is someone else: running, flagged as not ours', async () => {
  const s = await getStatus({ ...base, probe: async () => ({ pid: 9, commandLine: 'D:\\x\\python.exe -s ComfyUI\\main.py' }) });
  assert.equal(s.state, 'running');
  assert.equal(s.ours, false);
});

test('nothing listening and nothing launched: stopped', async () => {
  const s = await getStatus({ ...base, api: deadApi, probe: async () => null });
  assert.equal(s.state, 'stopped');
  assert.equal(s.pid, null);
});

test('our process is listening but the api is not ready yet: starting', async () => {
  const s = await getStatus({ ...base, api: deadApi });
  assert.equal(s.state, 'starting');
  assert.equal(s.pid, 25400);
});

test('someone else holds the port and the api is dead: port-busy', async () => {
  const s = await getStatus({
    ...base, api: deadApi,
    probe: async () => ({ pid: 4, commandLine: 'C:\\Windows\\other.exe' }),
  });
  assert.equal(s.state, 'port-busy');
  assert.match(s.message, /8188/);
});

test('we just launched a live process that has not bound the port yet: starting', async () => {
  const s = await getStatus({
    ...base, api: deadApi, probe: async () => null,
    launch: { pid: 555, startedAt: 90000 }, isAlive: (pid) => pid === 555, now: () => 100000,
  });
  assert.equal(s.state, 'starting');
  assert.equal(s.pid, 555);
});

test('a launched process that is still not answering after 60 s: timeout', async () => {
  const s = await getStatus({
    ...base, api: deadApi, probe: async () => null,
    launch: { pid: 555, startedAt: 30000 }, isAlive: () => true, now: () => 100000,
  });
  assert.equal(s.state, 'timeout');
  assert.match(s.message, /日志/);
});

test('a launched process that died on its own: stopped, with a hint to read the log', async () => {
  const s = await getStatus({
    ...base, api: deadApi, probe: async () => null,
    launch: { pid: 555, startedAt: 99000 }, isAlive: () => false, now: () => 100000,
  });
  assert.equal(s.state, 'stopped');
  assert.match(s.message, /日志/);
});

test('a failing queue call does not break the rest of the status', async () => {
  const s = await getStatus({ ...base, api: { ...goodApi, queue: async () => { throw new Error('x'); } } });
  assert.equal(s.state, 'running');
  assert.equal(s.queueRunning, null);
  assert.equal(s.vramTotal, 10e9);
});

test('the .bat style launch (relative path) is recognised as ours via its executable path', async () => {
  const s = await getStatus({
    ...base,
    probe: async () => ({
      pid: 25400,
      commandLine: '.\\python_embeded\\python.exe -s ComfyUI\\main.py --port 8188',
      executablePath: 'C:\\BlackBox\\ComfyUI_windows_portable\\python_embeded\\python.exe',
    }),
  });
  assert.equal(s.state, 'running');
  assert.equal(s.ours, true);
  assert.equal(s.message, '');
});
