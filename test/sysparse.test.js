const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNetstatListener, parseTasklistMemMB } = require('../src/comfy-process');

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180',
  '  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       25400',
  '  TCP    127.0.0.1:8188         127.0.0.1:51234        ESTABLISHED     25400',
  '  TCP    127.0.0.1:51234        127.0.0.1:8188         ESTABLISHED     9999',
  '  TCP    [::]:8199              [::]:0                 LISTENING       777',
  '  TCP    0.0.0.0:81880          0.0.0.0:0              LISTENING       555',
].join('\r\n');

test('finds the pid listening on a port (IPv4)', () => {
  assert.equal(parseNetstatListener(NETSTAT, 8188), 25400);
});

test('finds a listener bound on IPv6', () => {
  assert.equal(parseNetstatListener(NETSTAT, 8199), 777);
});

test('established client connections and longer port numbers do not count', () => {
  assert.equal(parseNetstatListener(NETSTAT, 51234), null);
  assert.equal(parseNetstatListener(NETSTAT, 8818), null);
  assert.equal(parseNetstatListener(NETSTAT, 1881), null);
});

test('no listener on that port gives null; empty output gives null', () => {
  assert.equal(parseNetstatListener(NETSTAT, 9), null);
  assert.equal(parseNetstatListener('', 8188), null);
});

test('reads working-set size from tasklist CSV output', () => {
  const out = '"python.exe","25400","Console","1","1,331,200 K"\r\n';
  assert.equal(parseTasklistMemMB(out), 1300);
});

test('tasklist output with no match gives null', () => {
  assert.equal(parseTasklistMemMB('INFO: No tasks are running which match the specified criteria.'), null);
  assert.equal(parseTasklistMemMB(''), null);
});
