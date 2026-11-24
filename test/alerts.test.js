const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  alertFromChunk, alertFromLog, exitAlert, mergeAlert, shouldNotify, createExitWatcher, createBurstBuffer,
} = require('../src/alerts');

const fxLines = (name) => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};
const fxText = (name) => fxLines(name).join('\n');

// 2026-10-10 20:35 local time
const T = new Date(2026, 9, 10, 20, 35, 12).getTime();

// ---------- alerts from new log text ----------
test('a crash in new log text raises a crash alert with a clock time', () => {
  const a = alertFromChunk(fxText('log-crash.txt'), T);
  assert.equal(a.kind, 'crash');
  assert.equal(a.count, 1);
  assert.equal(a.title, 'ComfyUI 崩溃了');
  assert.match(a.sub, /20:35/);
});

test('each kind of error has its own plain-Chinese title', () => {
  assert.equal(alertFromChunk(fxText('log-validation.txt'), T).title, '工作流校验失败');
  assert.equal(alertFromChunk(fxText('log-fatal-python.txt'), T).title, 'ComfyUI 启动失败');
  const plain = ['[INFO] got prompt', 'Traceback (most recent call last):', '  File "x.py", line 1', 'ValueError: bad value'].join('\n');
  assert.equal(alertFromChunk(plain, T).title, 'ComfyUI 出现报错');
});

test('harmless noise and healthy text raise nothing', () => {
  assert.equal(alertFromChunk(fxText('log-proactor-noise.txt'), T), null);
  assert.equal(alertFromChunk(fxText('log-mmproj-noise.txt'), T), null);
  assert.equal(alertFromChunk(fxText('log-kwargs-and-import-failure.txt'), T), null);
  assert.equal(alertFromChunk(fxText('log-healthy.txt'), T), null);
  assert.equal(alertFromChunk('', T), null);
});

test('several errors in one chunk give one alert: the most severe kind, with the count', () => {
  const a = alertFromChunk(`${fxText('log-validation.txt')}\n${fxText('log-crash.txt')}`, T);
  assert.equal(a.kind, 'crash');
  assert.equal(a.count, 2);
  assert.match(a.sub, /共 2 处/);
});

// ---------- alerts from the log when the launcher opens ----------
test('on open, an error from the current run raises an alert with no clock time', () => {
  const lines = ['[INFO] Starting server', ...fxLines('log-crash.txt')];
  const a = alertFromLog(lines);
  assert.equal(a.kind, 'crash');
  assert.equal(a.at, null);
  assert.match(a.sub, /本次运行/);
});

test('on open, an error from a previous run does not raise an alert', () => {
  const lines = [...fxLines('log-crash.txt'), '[INFO] Starting server', ...fxLines('log-healthy.txt')];
  assert.equal(alertFromLog(lines), null);
});

test('on open, with no start marker in the log there is no alert', () => {
  assert.equal(alertFromLog(fxLines('log-crash.txt')), null);
});

test('on open, a healthy or empty log raises nothing', () => {
  assert.equal(alertFromLog(['[INFO] Starting server', ...fxLines('log-healthy.txt')]), null);
  assert.equal(alertFromLog([]), null);
});

// ---------- unexpected exit ----------
test('the unexpected-exit alert says ComfyUI quit on its own', () => {
  const a = exitAlert(T);
  assert.equal(a.kind, 'exit');
  assert.equal(a.title, 'ComfyUI 意外退出了');
  assert.match(a.sub, /20:35/);
});

// ---------- merging a new alert into the one already showing ----------
test('with nothing showing, the new alert is used as is', () => {
  const a = alertFromChunk(fxText('log-crash.txt'), T);
  assert.deepEqual(mergeAlert(null, a), a);
});

test('a second alert adds to the count and moves the time forward', () => {
  const first = alertFromChunk(fxText('log-validation.txt'), T);
  const later = T + 5 * 60 * 1000;
  const m = mergeAlert(first, alertFromChunk(fxText('log-validation.txt'), later));
  assert.equal(m.count, 2);
  assert.equal(m.at, later);
  assert.match(m.sub, /20:40/);
  assert.match(m.sub, /共 2 处/);
});

test('the more severe kind wins when merging, whichever came first', () => {
  const crash = alertFromChunk(fxText('log-crash.txt'), T);
  const validation = alertFromChunk(fxText('log-validation.txt'), T);
  assert.equal(mergeAlert(validation, crash).kind, 'crash');
  assert.equal(mergeAlert(crash, validation).kind, 'crash');
  assert.equal(mergeAlert(crash, validation).title, 'ComfyUI 崩溃了');
});

test('a crash found in the log plus the process exiting reads as the crash, not just an exit', () => {
  const m = mergeAlert(alertFromChunk(fxText('log-crash.txt'), T), exitAlert(T + 2000));
  assert.equal(m.kind, 'crash');
  assert.equal(m.count, 2);
});

test('an exit alone is more severe than a validation failure', () => {
  const m = mergeAlert(alertFromChunk(fxText('log-validation.txt'), T), exitAlert(T));
  assert.equal(m.kind, 'exit');
});

// ---------- desktop notification throttle ----------
test('no desktop notification while the launcher window is in front', () => {
  assert.equal(shouldNotify({ windowFocused: true, lastNotifiedAt: null, now: T }), false);
});

test('a desktop notification when the window is in the background and none was sent yet', () => {
  assert.equal(shouldNotify({ windowFocused: false, lastNotifiedAt: null, now: T }), true);
});

test('at most one desktop notification per 60 seconds', () => {
  assert.equal(shouldNotify({ windowFocused: false, lastNotifiedAt: T - 30 * 1000, now: T }), false);
  assert.equal(shouldNotify({ windowFocused: false, lastNotifiedAt: T - 60 * 1000, now: T }), true);
  assert.equal(shouldNotify({ windowFocused: false, lastNotifiedAt: T - 5 * 60 * 1000, now: T }), true);
});

// ---------- the exit watcher ----------
function watcher(startAt = T) {
  let now = startAt;
  const w = createExitWatcher({ now: () => now });
  return { w, advance: (ms) => { now += ms; } };
}

test('running then stopped on its own is an unexpected exit', () => {
  const { w } = watcher();
  assert.equal(w.observe('running'), false);
  assert.equal(w.observe('stopped'), true);
});

test('it only fires once, not on every poll while stopped', () => {
  const { w } = watcher();
  w.observe('running');
  assert.equal(w.observe('stopped'), true);
  assert.equal(w.observe('stopped'), false);
  assert.equal(w.observe('stopped'), false);
});

test('a stop the launcher asked for is not unexpected', () => {
  const { w } = watcher();
  w.observe('running');
  w.expectStop();
  assert.equal(w.observe('stopped'), false);
});

test('a restart the launcher asked for is not unexpected, even through the starting state', () => {
  const { w, advance } = watcher();
  w.observe('running');
  w.expectStop();
  advance(3000);
  assert.equal(w.observe('stopped'), false);
  assert.equal(w.observe('starting'), false);
  assert.equal(w.observe('running'), false);
});

test('an old "expect a stop" does not hide a real crash later', () => {
  const { w, advance } = watcher();
  w.observe('running');
  w.expectStop();
  w.observe('stopped');
  w.observe('running');
  advance(5 * 60 * 1000);
  assert.equal(w.observe('stopped'), true);
});

test('never having seen it running means nothing to report', () => {
  const { w } = watcher();
  assert.equal(w.observe('stopped'), false);
  assert.equal(w.observe('starting'), false);
  assert.equal(w.observe('stopped'), false);
});

test('a failed start (starting then stopped) is not an exit', () => {
  const { w } = watcher();
  w.observe('stopped');
  w.observe('starting');
  assert.equal(w.observe('stopped'), false);
});

test('a status-read error or timeout is not an exit', () => {
  const { w } = watcher();
  w.observe('running');
  assert.equal(w.observe('error'), false);
  assert.equal(w.observe('timeout'), false);
});

// ---------- bursts: a multi-line error can arrive in two reads ----------
test('the burst buffer holds text back until a quiet read, then releases it all at once', () => {
  const b = createBurstBuffer();
  assert.equal(b.push('first part\n'), null);
  assert.equal(b.push('second part\n'), null);
  assert.equal(b.push(''), 'first part\nsecond part\n');
  assert.equal(b.push(''), null);
});

test('a burst buffer with nothing pending stays quiet', () => {
  const b = createBurstBuffer();
  assert.equal(b.push(''), null);
  assert.equal(b.push(''), null);
});

test('a validation failure split in two reads is counted once when the burst is joined', () => {
  const lines = fxLines('log-validation.txt');
  const cut = lines.findIndex((l) => /Required input is missing/.test(l)) + 2; // cut in the middle of the block
  const first = `${lines.slice(0, cut).join('\n')}\n`;
  const second = `${lines.slice(cut).join('\n')}\n`;

  const separately = [alertFromChunk(first, T), alertFromChunk(second, T)].filter(Boolean);
  assert.ok(separately.reduce((n, a) => n + a.count, 0) > 1, 'splitting really does over-count (the problem being solved)');

  const b = createBurstBuffer();
  b.push(first);
  b.push(second);
  const joined = alertFromChunk(b.push(''), T);
  assert.equal(joined.count, 1);
  assert.equal(joined.kind, 'validation');
});
