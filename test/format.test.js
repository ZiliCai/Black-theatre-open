const test = require('node:test');
const assert = require('node:assert/strict');
const { formatGB, formatMB, formatBytes, stateInfo, createLogBuffer } = require('../renderer/format');

test('formatGB shows one decimal and a dash for unknown', () => {
  assert.equal(formatGB(10 * 1024 ** 3), '10.0 GB');
  assert.equal(formatGB(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatGB(null), '—');
  assert.equal(formatGB(undefined), '—');
});

test('formatMB switches to GB at 1 GB', () => {
  assert.equal(formatMB(512), '512 MB');
  assert.equal(formatMB(1331), '1.3 GB');
  assert.equal(formatMB(null), '—');
});

test('formatBytes picks a sensible unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15.0 MB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB');
});

test('every status state has a Chinese label and a tone', () => {
  assert.deepEqual(stateInfo('running'), { text: '运行中', tone: 'ok' });
  assert.deepEqual(stateInfo('starting'), { text: '启动中…', tone: 'warn' });
  assert.deepEqual(stateInfo('stopped'), { text: '未运行', tone: 'idle' });
  assert.deepEqual(stateInfo('port-busy'), { text: '端口被占用', tone: 'bad' });
  assert.deepEqual(stateInfo('timeout'), { text: '启动超时', tone: 'bad' });
  assert.deepEqual(stateInfo('error'), { text: '读取状态失败', tone: 'bad' });
  assert.deepEqual(stateInfo('mystery'), { text: 'mystery', tone: 'idle' });
});

test('log buffer keeps complete lines in order', () => {
  const b = createLogBuffer(100);
  b.append('first\nsecond\n');
  b.append('third\n');
  assert.equal(b.text(), 'first\nsecond\nthird');
});

test('a partial line is shown, then completed without duplication', () => {
  const b = createLogBuffer(100);
  b.append('loading mod');
  assert.equal(b.text(), 'loading mod');
  b.append('el... done\nnext\n');
  assert.equal(b.text(), 'loading model... done\nnext');
});

test('CRLF line endings do not produce empty lines', () => {
  const b = createLogBuffer(100);
  b.append('a\r\nb\r\n');
  assert.equal(b.text(), 'a\nb');
});

test('carriage-return progress updates overwrite the same line', () => {
  const b = createLogBuffer(100);
  b.append('step\n 10%|#   |\r 20%|##  |\r 30%|### |');
  assert.equal(b.text(), 'step\n 30%|### |');
  b.append('\r 40%|####|\n');
  assert.equal(b.text(), 'step\n 40%|####|');
});

test('only the newest N lines are kept', () => {
  const b = createLogBuffer(3);
  b.append('1\n2\n3\n4\n5\n');
  assert.equal(b.text(), '3\n4\n5');
});

test('init replaces everything with the given lines', () => {
  const b = createLogBuffer(100);
  b.append('old\n');
  b.init(['x', 'y']);
  assert.equal(b.text(), 'x\ny');
});

// ---------- v2 helpers ----------
const { usageTone, procMemTone, percent, formatAgo, formatPathParts, vramView } = require('../renderer/format');

test('percent is a clamped whole-ish number and 0 for unknown totals', () => {
  assert.equal(percent(5, 10), 50);
  assert.equal(percent(0, 10), 0);
  assert.equal(percent(15, 10), 100);
  assert.equal(percent(-1, 10), 0);
  assert.equal(percent(5, 0), 0);
  assert.equal(percent(null, 10), 0);
});

test('usage turns amber at 75% and red at 90%', () => {
  assert.equal(usageTone(0), 'ok');
  assert.equal(usageTone(74.9), 'ok');
  assert.equal(usageTone(75), 'warn');
  assert.equal(usageTone(89.9), 'warn');
  assert.equal(usageTone(90), 'bad');
  assert.equal(usageTone(100), 'bad');
  assert.equal(usageTone(null), 'idle');
});

test('ComfyUI own memory turns amber at 60% of the computer RAM, red at 80%', () => {
  const ram = 32 * 1024 ** 3;
  assert.equal(procMemTone(1300, ram), 'ok');
  assert.equal(procMemTone(0.6 * 32 * 1024 - 1, ram), 'ok');
  assert.equal(procMemTone(0.6 * 32 * 1024, ram), 'warn');
  assert.equal(procMemTone(0.8 * 32 * 1024, ram), 'bad');
  assert.equal(procMemTone(null, ram), 'idle');
  assert.equal(procMemTone(1300, null), 'idle');
});

test('formatAgo speaks plain Chinese', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAgo(now - 20 * 1000, now), '刚刚');
  assert.equal(formatAgo(now - 5 * 60 * 1000, now), '5 分钟前');
  assert.equal(formatAgo(now - 3 * 3600 * 1000, now), '3 小时前');
  assert.equal(formatAgo(now - 2 * 86400 * 1000, now), '2 天前');
  assert.equal(formatAgo(now - 45 * 86400 * 1000, now), '1 个月前');
  assert.equal(formatAgo(0, now), '—');
  assert.equal(formatAgo(null, now), '—');
});

test('formatPathParts splits a long Windows path into a short tail and the rest', () => {
  assert.deepEqual(formatPathParts('C:\\BlackBox\\ComfyUI_windows_portable\\ComfyUI\\output'), {
    head: 'C:\\BlackBox\\ComfyUI_windows_portable\\ComfyUI\\', tail: 'output',
  });
  assert.deepEqual(formatPathParts('D:\\成片\\'), { head: 'D:\\', tail: '成片' });
  assert.deepEqual(formatPathParts(''), { head: '', tail: '' });
});

// ---------- GPU memory gauge: busy vs. idle ----------
const GB10 = 10 * 1024 ** 3;
const gpu = (usedGB, queueRunning, queuePending) => ({
  used: usedGB * 1024 ** 3, total: GB10, queueRunning, queuePending,
});

test('while a job runs, the GPU gauge warns as before (amber at 75%, red at 90%)', () => {
  assert.deepEqual(vramView(gpu(7.9, 1, 0)), { pct: 79, tone: 'warn', holdingModels: false });
  assert.equal(vramView(gpu(9.5, 1, 0)).tone, 'bad');
  assert.equal(vramView(gpu(3, 1, 0)).tone, 'ok');
});

test('a queued job counts as busy even if nothing is running yet', () => {
  assert.equal(vramView(gpu(7.9, 0, 2)).tone, 'warn');
  assert.equal(vramView(gpu(7.9, 0, 2)).holdingModels, false);
});

test('with an empty queue, high GPU memory is calm, not an alarm, and explains itself', () => {
  const v = vramView(gpu(7.9, 0, 0));
  assert.equal(v.tone, 'calm');
  assert.equal(v.holdingModels, true);
  assert.equal(v.pct, 79);
});

test('with an empty queue even 95% stays calm', () => {
  const v = vramView(gpu(9.5, 0, 0));
  assert.equal(v.tone, 'calm');
  assert.equal(v.holdingModels, true);
});

test('the "models are still loaded" note needs real usage: from 25% of the card, not the desktop baseline', () => {
  assert.equal(vramView(gpu(0.7, 0, 0)).holdingModels, false);
  assert.equal(vramView(gpu(2.4, 0, 0)).holdingModels, false);
  assert.equal(vramView(gpu(2.5, 0, 0)).holdingModels, true);
  assert.equal(vramView(gpu(0.7, 0, 0)).tone, 'calm');
});

test('when the queue is unknown the old warning colours apply and no note is shown', () => {
  assert.deepEqual(vramView(gpu(9.5, null, null)), { pct: 95, tone: 'bad', holdingModels: false });
  assert.equal(vramView(gpu(9.5, undefined, undefined)).tone, 'bad');
});

test('no GPU data at all is the neutral "idle" look', () => {
  assert.deepEqual(vramView({ used: null, total: null, queueRunning: 0, queuePending: 0 }), { pct: 0, tone: 'idle', holdingModels: false });
});
