const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTail, lastLines } = require('../src/logtail');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-log-')), 'boot.log');

test('lastLines returns only the last N lines with colors stripped', () => {
  const f = tmpFile();
  fs.writeFileSync(f, ['one', 'two', '\u001b[32m[INFO]\u001b[0m three', 'four'].join('\n') + '\n');
  assert.deepEqual(lastLines(f, 2), ['[INFO] three', 'four']);
});

test('lastLines on a missing file is an empty list', () => {
  assert.deepEqual(lastLines(path.join(os.tmpdir(), 'cl-none-' + Date.now()), 5), []);
});

test('lastLines on a file shorter than N returns everything', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'a\nb\n');
  assert.deepEqual(lastLines(f, 200), ['a', 'b']);
});

test('readNew returns only what was appended since the last read', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'first\n');
  const tail = createTail(f, { fromEnd: false });
  assert.equal(tail.readNew(), 'first\n');
  assert.equal(tail.readNew(), '');
  fs.appendFileSync(f, 'second\n');
  assert.equal(tail.readNew(), 'second\n');
});

test('with fromEnd the existing content is skipped', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'old stuff\n');
  const tail = createTail(f, { fromEnd: true });
  assert.equal(tail.readNew(), '');
  fs.appendFileSync(f, 'new\n');
  assert.equal(tail.readNew(), 'new\n');
});

test('a file that does not exist yet reads as empty, then works once created', () => {
  const f = tmpFile();
  const tail = createTail(f, { fromEnd: false });
  assert.equal(tail.readNew(), '');
  fs.writeFileSync(f, 'hello\n');
  assert.equal(tail.readNew(), 'hello\n');
});

test('a truncated file is re-read from the start', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'a long first line of text\n');
  const tail = createTail(f, { fromEnd: false });
  tail.readNew();
  fs.writeFileSync(f, 'short\n');
  assert.equal(tail.readNew(), 'short\n');
});

test('ANSI colors are stripped from incremental reads', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '');
  const tail = createTail(f, { fromEnd: false });
  fs.appendFileSync(f, '\u001b[1m\u001b[31m[ERROR]\u001b[0m bad\n');
  assert.equal(tail.readNew(), '[ERROR] bad\n');
});

test('a color code split across two reads is not leaked as garbage', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '');
  const tail = createTail(f, { fromEnd: false });
  fs.appendFileSync(f, 'ok \u001b[3');
  const first = tail.readNew();
  fs.appendFileSync(f, '2m[INFO]\u001b[0m done\n');
  const second = tail.readNew();
  assert.equal(first + second, 'ok [INFO] done\n');
});

test('a Chinese character split across two reads is decoded intact', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '');
  const tail = createTail(f, { fromEnd: false });
  const bytes = Buffer.from('远程主机\n', 'utf8');
  fs.appendFileSync(f, bytes.subarray(0, 4)); // cuts the second character in half
  const first = tail.readNew();
  fs.appendFileSync(f, bytes.subarray(4));
  const second = tail.readNew();
  assert.equal(first + second, '远程主机\n');
});
