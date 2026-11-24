const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApi } = require('../src/comfy-api');

// A tiny fake ComfyUI. Returns { port, requests, close }.
function fakeComfy(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      const route = routes[`${req.method} ${req.url}`];
      if (!route) { res.statusCode = 404; return res.end('nope'); }
      if (route.hang) return; // never answers
      res.statusCode = route.status || 200;
      res.setHeader('content-type', 'application/json');
      res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
      })));
}

test('systemStats returns vram and ram numbers', async () => {
  const fake = await fakeComfy({
    'GET /system_stats': {
      body: {
        system: { ram_total: 34210701312, ram_free: 5683679232 },
        devices: [{ name: 'cuda:0 RTX 3080', vram_total: 10737418240, vram_free: 9000000000 }],
      },
    },
  });
  try {
    const s = await createApi({ port: fake.port }).systemStats();
    assert.deepEqual(s, {
      ramTotal: 34210701312, ramFree: 5683679232,
      vramTotal: 10737418240, vramFree: 9000000000, deviceName: 'cuda:0 RTX 3080',
      argv: null, // this fake server does not report argv
    });
  } finally { await fake.close(); }
});

test('queuePrompts lists the prompt ids running and waiting', async () => {
  const fake = await fakeComfy({
    'GET /queue': { body: { queue_running: [[0, 'p-run', {}]], queue_pending: [[1, 'p-wait', {}], [2, 'p-wait2', {}]] } },
  });
  try {
    assert.deepEqual(await createApi({ port: fake.port }).queuePrompts(), ['p-run', 'p-wait', 'p-wait2']);
  } finally { await fake.close(); }
});

test('systemStats copes with a machine that reports no GPU device', async () => {
  const fake = await fakeComfy({ 'GET /system_stats': { body: { system: { ram_total: 1, ram_free: 1 }, devices: [] } } });
  try {
    const s = await createApi({ port: fake.port }).systemStats();
    assert.equal(s.vramTotal, null);
    assert.equal(s.vramFree, null);
  } finally { await fake.close(); }
});

test('queue counts running and pending jobs', async () => {
  const fake = await fakeComfy({
    'GET /queue': { body: { queue_running: [[0, 'a']], queue_pending: [[1, 'b'], [2, 'c']] } },
  });
  try {
    assert.deepEqual(await createApi({ port: fake.port }).queue(), { running: 1, pending: 2 });
  } finally { await fake.close(); }
});

test('free posts the unload flags as JSON', async () => {
  const fake = await fakeComfy({ 'POST /free': { body: '' } });
  try {
    await createApi({ port: fake.port }).free();
    const req = fake.requests.find((r) => r.url === '/free');
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(req.body), { unload_models: true, free_memory: true });
  } finally { await fake.close(); }
});

test('prompt submits the graph with its websocket client id', async () => {
  const fake = await fakeComfy({ 'POST /prompt': { body: { prompt_id: 'p-1' } } });
  try {
    const result = await createApi({ port: fake.port }).prompt({ 1: { class_type: 'Test' } }, { clientId: 'client-1' });
    assert.equal(result.prompt_id, 'p-1');
    const req = fake.requests.find((r) => r.url === '/prompt');
    assert.deepEqual(JSON.parse(req.body), { prompt: { 1: { class_type: 'Test' } }, client_id: 'client-1' });
  } finally { await fake.close(); }
});

test('promptByClient finds a run ComfyUI holds by the client id it was sent with', async () => {
  const fake = await fakeComfy({ 'GET /queue': { body: { queue_running: [[3, 'p-run', {}, { client_id: 'c-1' }, []]], queue_pending: [[4, 'p-wait', {}, { client_id: 'c-2' }, []]] } } });
  try {
    const api = createApi({ port: fake.port });
    assert.equal(await api.promptByClient('c-2'), 'p-wait');
    assert.equal(await api.promptByClient('c-9'), null);
  } finally { await fake.close(); }
});

test('a non-200 answer rejects with the status code', async () => {
  const fake = await fakeComfy({ 'GET /queue': { status: 500, body: 'boom' } });
  try {
    await assert.rejects(createApi({ port: fake.port }).queue(), /500/);
  } finally { await fake.close(); }
});

test('nothing listening rejects (connection refused)', async () => {
  const fake = await fakeComfy({});
  const port = fake.port;
  await fake.close();
  await assert.rejects(createApi({ port }).systemStats(), /ECONNREFUSED|refused/i);
});

test('a server that never answers rejects after the timeout', async () => {
  const fake = await fakeComfy({ 'GET /queue': { hang: true } });
  try {
    const started = Date.now();
    await assert.rejects(createApi({ port: fake.port, timeoutMs: 150 }).queue(), /超时|timeout/i);
    assert.ok(Date.now() - started < 2000);
  } finally { await fake.close(); }
});

test('requests go straight to 127.0.0.1 even when proxy env vars are set', async () => {
  const fake = await fakeComfy({ 'GET /queue': { body: { queue_running: [], queue_pending: [] } } });
  const saved = { h: process.env.HTTP_PROXY, s: process.env.HTTPS_PROXY };
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  try {
    assert.deepEqual(await createApi({ port: fake.port }).queue(), { running: 0, pending: 0 });
  } finally {
    for (const [k, v] of [['HTTP_PROXY', saved.h], ['HTTPS_PROXY', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fake.close();
  }
});
