const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractErrors, buildReport, countNewErrors } = require('../src/errors');

// Real excerpts cut from the user's comfyui_boot.log (ANSI colors already removed).
const fx = (name) => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const META = {
  time: '2026-10-10 21:30:00',
  version: '1.1.0',
  stateText: '运行中(PID 25400)',
  args: 'ComfyUI\\main.py --windows-standalone-build --port 8188 --lowvram',
  vramText: '1.2 GB / 10.0 GB',
  ramText: '13.0 GB / 31.9 GB',
};

// ---------- what counts as an error ----------
test('the harmless browser-disconnect (Proactor / 10054) block is noise, not an error', () => {
  const r = extractErrors(fx('log-proactor-noise.txt'));
  assert.equal(r.real.length, 0);
  assert.ok(r.noiseCount >= 1);
});

test('the H3 text encoder "Can\'t find mmproj file" line is noise', () => {
  const r = extractErrors(fx('log-mmproj-noise.txt'));
  assert.equal(r.real.length, 0);
  assert.equal(r.noiseCount, 1);
});

test('transformers "…ImageProcessorKwargs, but not documented" lines are noise, and a [WARNING] traceback is not an error', () => {
  const r = extractErrors(fx('log-kwargs-and-import-failure.txt'));
  assert.equal(r.real.length, 0);
  assert.ok(r.noiseCount >= 1);
});

test('a custom node that failed to import is reported by folder name', () => {
  const r = extractErrors(fx('log-kwargs-and-import-failure.txt'));
  assert.deepEqual(r.importFailures, ['Nvidia_RTX_Nodes_ComfyUI']);
});

test('a healthy run has no errors and no noise', () => {
  const r = extractErrors(fx('log-healthy.txt'));
  assert.equal(r.real.length, 0);
  assert.equal(r.noiseCount, 0);
});

test('the real access-violation crash is one block, kept whole, including the blank line before "Stack"', () => {
  const r = extractErrors(fx('log-crash.txt'));
  assert.equal(r.real.length, 1);
  const b = r.real[0];
  assert.equal(b.kind, 'crash');
  const text = b.lines.join('\n');
  assert.match(text, /Windows fatal exception: access violation/);
  assert.match(text, /Stack \(most recent call first\)/);
  assert.match(text, /nodes_minimax_h3\.py", line 360 in execute/);
  assert.equal(b.lines[b.lines.length - 1], '  File "threading.py", line 1015 in _bootstrap');
  assert.equal(text.includes('setup plugin'), false, 'the next [INFO] line must not be swallowed');
});

test('a prompt-validation failure is one block of consecutive [ERROR] lines', () => {
  const r = extractErrors(fx('log-validation.txt'));
  assert.equal(r.real.length, 1);
  const b = r.real[0];
  assert.equal(b.kind, 'validation');
  const text = b.lines.join('\n');
  assert.match(text, /Failed to validate prompt for output 3/);
  assert.match(text, /Required input is missing/);
  assert.match(text, /Output will be ignored/);
  assert.equal(text.includes('[WARNING] invalid prompt'), false);
});

test('a Python fatal error at startup is recognised', () => {
  const r = extractErrors(fx('log-fatal-python.txt'));
  assert.equal(r.real.length, 1);
  assert.equal(r.real[0].kind, 'fatal');
  assert.match(r.real[0].lines.join('\n'), /invalid PYTHONUTF8 environment variable value/);
});

test('a plain Python traceback is an error block ending at its exception line', () => {
  const lines = [
    '[INFO] got prompt',
    'Traceback (most recent call last):',
    '  File "x.py", line 1, in <module>',
    '    foo()',
    'ValueError: bad value',
    '[INFO] Prompt executed in 1.00 seconds',
  ];
  const r = extractErrors(lines);
  assert.equal(r.real.length, 1);
  assert.equal(r.real[0].kind, 'error');
  assert.equal(r.real[0].lines.at(-1), 'ValueError: bad value');
});

test('noise mixed with a real crash: only the crash is real, the noise is counted', () => {
  const lines = [...fx('log-proactor-noise.txt'), ...fx('log-crash.txt'), ...fx('log-mmproj-noise.txt')];
  const r = extractErrors(lines);
  assert.equal(r.real.length, 1);
  assert.equal(r.real[0].kind, 'crash');
  assert.ok(r.noiseCount >= 2);
});

test('blocks know whether they happened in the current or the previous run', () => {
  const lines = [
    '[INFO] Starting server',
    ...fx('log-crash.txt'),
    '===== [启动器] 2026/10/10 20:00:00 启动 ComfyUI,端口 8188 =====',
    '[INFO] Starting server',
    ...fx('log-validation.txt'),
  ];
  const r = extractErrors(lines);
  assert.equal(r.real.length, 2);
  assert.equal(r.real[0].run, 'previous');
  assert.equal(r.real[1].run, 'current');
});

test('with no start marker in the log, the run is unknown', () => {
  const r = extractErrors(fx('log-crash.txt'));
  assert.equal(r.real[0].run, 'unknown');
});

// ---------- red-dot counting ----------
test('countNewErrors counts real errors and ignores noise and healthy text', () => {
  assert.equal(countNewErrors(fx('log-crash.txt').join('\n')), 1);
  assert.equal(countNewErrors(fx('log-validation.txt').join('\n')), 1);
  assert.equal(countNewErrors(fx('log-proactor-noise.txt').join('\n')), 0);
  assert.equal(countNewErrors(fx('log-mmproj-noise.txt').join('\n')), 0);
  assert.equal(countNewErrors(fx('log-healthy.txt').join('\n')), 0);
  assert.equal(countNewErrors(''), 0);
});

// ---------- the report ----------
test('the report for a crash carries the header, the crash, and no noise', () => {
  const lines = [...fx('log-healthy.txt'), ...fx('log-proactor-noise.txt'), ...fx('log-crash.txt'), ...fx('log-proactor-noise.txt')];
  const r = buildReport({ lines, meta: META });
  assert.equal(r.found, true);
  assert.match(r.text, /ComfyUI 报错报告/);
  assert.match(r.text, /2026-10-10 21:30:00/);
  assert.match(r.text, /运行中\(PID 25400\)/);
  assert.match(r.text, /--port 8188 --lowvram/);
  assert.match(r.text, /1\.2 GB \/ 10\.0 GB/);
  assert.match(r.text, /崩溃/);
  assert.match(r.text, /Windows fatal exception: access violation/);
  assert.match(r.text, /已过滤 \d+ 处已知无害提示/);
  assert.equal(r.text.includes('ConnectionResetError'), false);
  assert.equal(r.text.includes('_ProactorBasePipeTransport'), false);
});

test('the report includes three lines of context before the error', () => {
  const r = buildReport({ lines: fx('log-crash.txt'), meta: META });
  assert.match(r.text, /Requested to load MiniMaxH3TEModel_/);
});

test('the report says which run the error happened in', () => {
  const lines = [
    '[INFO] Starting server', ...fx('log-crash.txt'),
    '===== [启动器] 2026/10/10 20:00:00 启动 ComfyUI,端口 8188 =====', '[INFO] Starting server',
  ];
  assert.match(buildReport({ lines, meta: META }).text, /上次运行期间/);
});

test('only the latest real error is shown, and earlier ones are counted', () => {
  const lines = [...fx('log-validation.txt'), ...fx('log-healthy.txt'), ...fx('log-crash.txt')];
  const r = buildReport({ lines, meta: META });
  assert.match(r.text, /崩溃/);
  assert.match(r.text, /此前还有 1 处报错/);
  assert.equal(r.text.includes('Required input is missing'), false);
});

test('custom nodes that failed to import are listed in the header', () => {
  const lines = [...fx('log-kwargs-and-import-failure.txt'), ...fx('log-crash.txt')];
  assert.match(buildReport({ lines, meta: META }).text, /自定义节点导入失败:Nvidia_RTX_Nodes_ComfyUI/);
});

test('with no real error the report says so and still gives the recent log', () => {
  const lines = [...fx('log-healthy.txt'), ...fx('log-proactor-noise.txt')];
  const r = buildReport({ lines, meta: META });
  assert.equal(r.found, false);
  assert.match(r.text, /没发现明确报错/);
  assert.match(r.text, /got prompt/);
  assert.equal(r.text.includes('ConnectionResetError'), false);
});

test('the no-error tail is capped at 60 lines', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `[INFO] line number ${i}`);
  const r = buildReport({ lines, meta: META });
  assert.equal(r.found, false);
  assert.match(r.text, /line number 299/);
  assert.match(r.text, /line number 240/);
  assert.equal(r.text.includes('line number 239'), false);
});

test('an empty log gives a polite report instead of an exception', () => {
  const r = buildReport({ lines: [], meta: META });
  assert.equal(r.found, false);
  assert.match(r.text, /没发现明确报错/);
});

test('a huge error block is cut from the middle and says so', () => {
  const lines = ['[ERROR] boom', ...Array.from({ length: 600 }, (_, i) => `  File "f${i}.py", line ${i}`)];
  const r = buildReport({ lines, meta: META });
  const n = r.text.split('\n').length;
  assert.ok(n <= 260, `report should be capped, got ${n} lines`);
  assert.match(r.text, /中间省略/);
  assert.match(r.text, /boom/);
});
