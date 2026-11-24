const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApi } = require('../src/comfy-api');
const { getStatus } = require('../src/status');

function serve(body) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    })));
}

test('systemStats returns the argv ComfyUI was started with', async () => {
  const argv = ['ComfyUI\\main.py', '--port', '8188', '--output-directory', 'E:\\out'];
  const s = await serve({ system: { ram_total: 1, ram_free: 1, argv }, devices: [] });
  try {
    assert.deepEqual((await createApi({ port: s.port }).systemStats()).argv, argv);
  } finally { await s.close(); }
});

test('argv is null when the server does not report it', async () => {
  const s = await serve({ system: { ram_total: 1, ram_free: 1 }, devices: [] });
  try {
    assert.equal((await createApi({ port: s.port }).systemStats()).argv, null);
  } finally { await s.close(); }
});

test('status passes argv through, and is null when ComfyUI is not reachable', async () => {
  const config = { workdir: 'F:\\x', port: 8188 };
  const common = { config, probe: async () => null, memoryOf: async () => null, launch: null, isAlive: () => false, now: () => 1 };
  const up = await getStatus({
    ...common,
    api: {
      systemStats: async () => ({ ramTotal: 1, ramFree: 1, vramTotal: 1, vramFree: 1, deviceName: 'x', argv: ['--port', '8188'] }),
      queue: async () => ({ running: 0, pending: 0 }),
    },
  });
  assert.deepEqual(up.argv, ['--port', '8188']);
  const down = await getStatus({
    ...common,
    api: { systemStats: async () => { throw new Error('x'); }, queue: async () => { throw new Error('x'); } },
  });
  assert.equal(down.argv, null);
});
