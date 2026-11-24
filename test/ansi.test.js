const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi } = require('../src/ansi');

test('removes color codes from a log line', () => {
  const line = '\u001b[32m[INFO]\u001b[0m Prompt executed in 0.00 seconds';
  assert.equal(stripAnsi(line), '[INFO] Prompt executed in 0.00 seconds');
});

test('removes bold-plus-color sequences with several parameters', () => {
  assert.equal(stripAnsi('\u001b[1m\u001b[31m[ERROR]\u001b[0m boom'), '[ERROR] boom');
  assert.equal(stripAnsi('\u001b[38;5;153m[12:54:06]\u001b[0m ok'), '[12:54:06] ok');
});

test('keeps Chinese text and plain text untouched', () => {
  assert.equal(stripAnsi('远程主机强迫关闭了一个现有的连接。'), '远程主机强迫关闭了一个现有的连接。');
  assert.equal(stripAnsi('plain 12:00 [x]'), 'plain 12:00 [x]');
});
