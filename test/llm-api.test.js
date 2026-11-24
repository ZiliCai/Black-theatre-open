const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { normalizeBaseUrl, testLlm, optimizeLlm } = require('../src/llm-api');

test('API base URLs reject missing protocols and embedded credentials', () => {
  assert.equal(normalizeBaseUrl(' https://api.example.com/v1/ '), 'https://api.example.com/v1');
  assert.throws(() => normalizeBaseUrl('api.example.com'), /http:\/\/ 或 https:\/\//);
  assert.throws(() => normalizeBaseUrl('https://user:secret@example.com/v1'), /账号或密码/);
});

test('LLM test and optimization use an OpenAI-compatible endpoint', async () => {
  let chatBody = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      assert.equal(req.headers.authorization, 'Bearer test-key');
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        chatBody = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"prompt":"optimized prompt"}' } }] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const tested = await testLlm({ baseUrl, model: 'demo-model' }, 'test-key');
    assert.equal(tested.ok, true);
    const content = await optimizeLlm({ baseUrl, model: 'demo-model' }, 'test-key', {
      system: 'system prompt', user: 'user prompt', temperature: 0.2, maxTokens: 100,
    });
    assert.equal(content, '{"prompt":"optimized prompt"}');
    assert.equal(chatBody.model, 'demo-model');
    assert.equal(chatBody.messages[0].role, 'system');
    assert.equal(chatBody.messages[1].content, 'user prompt');
    assert.equal(chatBody.temperature, 0.2);
    assert.equal(chatBody.max_tokens, 100);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
