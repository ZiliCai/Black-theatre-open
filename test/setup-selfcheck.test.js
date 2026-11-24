const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { run, checkGpu, checkChat } = require('../src/setup-selfcheck');

const llm = { baseUrl: 'https://api.deepseek.com', model: 'example' };

test('the desktop probe requires a GPU and a reachable queue through the forwarded port', async (t) => {
  let devices = [];
  let queueStatus = 200;
  const service = http.createServer((req, res) => {
    if (req.url === '/queue') res.statusCode = queueStatus;
    res.end(JSON.stringify(req.url === '/system_stats' ? { devices } : { queue_running: [], queue_pending: [] }));
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const port = service.address().port;
  await assert.rejects(checkGpu(null), /重新连接/);
  await assert.rejects(checkGpu(port), /没有报告可用显卡/);
  devices = [{ name: 'cuda:0 test GPU', vram_total: 8 * 2 ** 30 }];
  assert.match(await checkGpu(port), /8\.0 GiB/);
  queueStatus = 503;
  await assert.rejects(checkGpu(port), /任务队列/);
});

test('text readiness requires a real nonempty completion and reports account failures without exposing credentials', async () => {
  const success = await checkChat(llm, 'private-fixture', async (_config, _key, message) => {
    assert.equal(message.thinking.type, 'disabled');
    assert.equal(message.maxTokens, 32);
    assert.equal(message.purpose, '配置自检');
    return { content: 'OK' };
  });
  assert.match(success, /已返回/);
  await assert.rejects(checkChat(llm, 'k', async () => ({ content: ' ' })), /未返回可用文本/);
  await assert.rejects(checkChat(llm, 'k', async () => { throw Error('LLM API HTTP 402: private-fixture'); }),
    (e) => e.message.includes('余额不足') && !e.message.includes('private'));
  await assert.rejects(checkChat({ ...llm, baseUrl: 'https://api.deepseek.com.example' }, 'k', assert.fail), /官方地址/);
});

test('reports only selected capabilities and keeps independent successes when chat fails', async () => {
  const fixture = { state: { run: 'run' }, preview: 'run.png', llm, port: 12, getKey: async () => 'k',
    probeGpu: async () => 'GPU', probeChat: async () => { throw Error('余额不足'); } };
  const partial = await run(fixture);
  const items = Object.fromEntries(partial.checks.map((c) => [c.id, c.status]));
  assert.deepEqual(items, { gpu: 'pass', models: 'pass', image: 'pass', video: 'skip', file: 'pass', chat: 'fail' });
  assert.equal(partial.ok, false);
  const gpuOnly = await run({ ...fixture, llm: {}, preview: 'run.mp4', getKey: assert.fail });
  assert.equal(gpuOnly.ok, true);
  assert.equal(gpuOnly.checks.find((c) => c.id === 'video').status, 'pass');
  assert.equal(gpuOnly.checks.find((c) => c.id === 'chat').status, 'skip');
  const clearedKey = await run({ ...fixture, llm: {}, requiresChat: true, getKey: async () => '', probeChat: checkChat });
  assert.equal(clearedKey.ok, false);
});
