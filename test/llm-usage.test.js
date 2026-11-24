const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../src/llm-usage');
const { completeLlm, onUsage, chatMessages, prefixOf } = require('../src/llm-api');

// 2026-11-02 02:00 and 14:00 Beijing time
const NIGHT = Date.UTC(2026, 10, 1, 18, 0);
const DAY = Date.UTC(2026, 10, 2, 6, 0);

test('off-peak is 00:30–08:30 Beijing time, and a window may run past midnight', () => {
  assert.equal(U.isOffPeak(NIGHT), true);
  assert.equal(U.isOffPeak(DAY), false);
  assert.equal(U.isOffPeak(Date.UTC(2026, 10, 1, 16, 29)), false, '00:29');
  assert.equal(U.isOffPeak(Date.UTC(2026, 10, 1, 16, 30)), true, '00:30');
  assert.equal(U.isOffPeak(DAY, { start: '22:00', end: '06:00' }), false);
  assert.equal(U.isOffPeak(NIGHT, { start: '22:00', end: '06:00' }), true);
});

test('token counts come from DeepSeek cache fields, or from OpenAI cached_tokens', () => {
  assert.deepEqual(U.countsOf({ prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } }),
    { hit: 800, miss: 200, out: 300, reasoning: 250 });
  assert.deepEqual(U.countsOf({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens: 10 }), { hit: 600, miss: 400, out: 10, reasoning: 0 });
  assert.deepEqual(U.countsOf(null), { hit: 0, miss: 0, out: 0, reasoning: 0 });
});

test('a call is priced by its model row and the hour it ran; a versioned name finds its row', () => {
  const e = { model: 'deepseek-v4-pro-0813', hit: 1e6, miss: 1e6, out: 1e6 };
  assert.equal(U.priceFor(U.DEFAULT_PRICES, e.model).model, 'deepseek-v4-pro');
  assert.equal(U.costOf({ ...e, at: NIGHT }, U.DEFAULT_PRICES), 0.15 + 4.5 + 13.5);
  assert.equal(U.costOf({ ...e, at: DAY }, U.DEFAULT_PRICES), 0.3 + 9 + 27);
  assert.equal(U.costOf({ ...e, model: 'other', at: DAY }, U.DEFAULT_PRICES), null);
});

test('the log sums per day and model and per purpose; prices can be edited and reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-'));
  let at = DAY;
  const log = U.createUsageLog({ dir, now: () => at });
  log.record({ model: 'deepseek-flash', purpose: '剧本讨论', usage: { prompt_cache_hit_tokens: 500000, prompt_cache_miss_tokens: 500000, completion_tokens: 100000 } });
  at = NIGHT;
  log.record({ model: 'deepseek-flash', purpose: '镜头改写', usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000000, completion_tokens: 0 } });
  log.record({ model: 'mystery', purpose: '镜头改写', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  fs.appendFileSync(path.join(dir, 'llm-usage.jsonl'), '{"at": 12'); // a line cut off by a crash
  at = DAY;
  const s = log.summary();
  assert.equal(s.total.calls, 3);
  assert.equal(s.total.unpriced, 1);
  // day: 0.5*0.04 + 0.5*2 + 0.1*8 = 1.82; night (previous day): 1*1 = 1
  assert.ok(Math.abs(s.total.cost - 2.82) < 1e-9, String(s.total.cost));
  assert.deepEqual(s.days.map((d) => [d.day, d.model, d.calls]), [['2026-11-02', 'deepseek-flash', 2], ['2026-11-02', 'mystery', 1]]);
  assert.equal(s.today.calls, 3, 'NIGHT is 02:00 on the same Beijing day');
  assert.deepEqual(s.purposes.map((p) => p.purpose), ['剧本讨论', '镜头改写']);
  const bad = log.setPrices({ models: [{ model: 'x', hit: [1], miss: [1, 1], out: [1, 1] }] });
  assert.equal(bad.ok, false);
  assert.equal(log.setPrices({ offPeak: { start: '01:00', end: '07:00' }, models: [{ model: 'deepseek-flash', hit: [0, 0], miss: [10, 10], out: [0, 0] }] }).ok, true);
  assert.ok(Math.abs(log.summary().total.cost - 15) < 1e-9, '0.5M + 1M cache-miss tokens at 10 yuan');
  log.resetPrices();
  assert.equal(log.prices().models.length, 2);
});

test('every completed call is reported to the usage listener, even one whose reply is unusable', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: {}, finish_reason: 'length' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const seen = [];
  onUsage((u) => seen.push(u));
  try {
    await assert.rejects(completeLlm({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'deepseek-flash' }, 'k', { system: 's', user: 'u', purpose: '剧本讨论' }));
  } finally {
    onUsage(null);
    server.close();
  }
  assert.deepEqual(seen, [{ model: 'deepseek-flash', usage: { prompt_tokens: 7, completion_tokens: 3 }, purpose: '剧本讨论', prefix: prefixOf('s') }]);
});

test('the log keeps the fingerprint of the system prompt next to the cache hits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-usage-'));
  const log = U.createUsageLog({ dir, now: () => 1 });
  const entry = log.record({ model: 'deepseek-flash', purpose: '镜头改写', prefix: prefixOf('fixed rules'), usage: { prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 5 } });
  assert.deepEqual(entry, { at: 1, model: 'deepseek-flash', purpose: '镜头改写', hit: 900, miss: 100, out: 5, reasoning: 0, prefix: prefixOf('fixed rules') });
  assert.equal(prefixOf('fixed rules'), prefixOf('fixed rules'));
  assert.notEqual(prefixOf('fixed rules'), prefixOf('fixed rules.'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'llm-usage.jsonl'), 'utf8')).prefix, entry.prefix);
  assert.equal('prefix' in log.record({ model: 'm', usage: { prompt_tokens: 1 } }), false);
});

test('fixed text goes first; a Claude model gets cache marks on the system prompt and the last earlier turn', () => {
  const asked = { system: 'rules', history: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }], user: 'q2' };
  assert.deepEqual(chatMessages('deepseek-flash', asked), [
    { role: 'system', content: 'rules' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' },
  ]);
  const mark = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  assert.deepEqual(chatMessages('anthropic/claude-sonnet-4.5', asked), [
    { role: 'system', content: mark('rules') }, { role: 'user', content: 'q1' }, { role: 'assistant', content: mark('a1') }, { role: 'user', content: 'q2' },
  ]);
  assert.deepEqual(chatMessages('claude-x', { system: 's', user: 'u' }), [{ role: 'system', content: mark('s') }, { role: 'user', content: 'u' }]);
});
