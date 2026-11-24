const test = require('node:test');
const assert = require('node:assert/strict');
const { isOurComfy, parseProbe } = require('../src/comfy-process');

const EXE = 'C:\\BlackBox\\ComfyUI_windows_portable\\python_embeded\\python.exe';
const RELATIVE = '.\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --port 8188 --lowvram';

const WORKDIR = 'C:\\BlackBox\\ComfyUI_windows_portable';
const OURS =
  '"C:\\BlackBox\\ComfyUI_windows_portable\\python_embeded\\python.exe" -s ComfyUI\\main.py ' +
  '--windows-standalone-build --port 8188 --lowvram';

test('recognises the ComfyUI started from this workdir', () => {
  assert.equal(isOurComfy(OURS, WORKDIR), true);
});

test('matching ignores case and slash direction', () => {
  const cmd = '"c:/blackbox/comfyui_windows_portable/python_embeded/python.exe" -s ComfyUI/main.py';
  assert.equal(isOurComfy(cmd, WORKDIR), true);
});

test('a ComfyUI from a different folder is not ours', () => {
  const cmd = '"D:\\Other\\ComfyUI_windows_portable\\python_embeded\\python.exe" -s ComfyUI\\main.py';
  assert.equal(isOurComfy(cmd, WORKDIR), false);
});

test('an unrelated python in our folder (no main.py) is not ours', () => {
  const cmd = '"C:\\BlackBox\\ComfyUI_windows_portable\\python_embeded\\python.exe" tool.py';
  assert.equal(isOurComfy(cmd, WORKDIR), false);
});

test('a folder whose name merely starts like ours is not ours', () => {
  const cmd = '"C:\\BlackBox\\ComfyUI_windows_portable_old\\python_embeded\\python.exe" -s ComfyUI\\main.py';
  assert.equal(isOurComfy(cmd, WORKDIR), false);
});

test('empty or missing command lines are not ours', () => {
  assert.equal(isOurComfy('', WORKDIR), false);
  assert.equal(isOurComfy(undefined, WORKDIR), false);
  assert.equal(isOurComfy(null, WORKDIR), false);
});

test('parses the PowerShell probe output', () => {
  const out = JSON.stringify({ pid: 25400, commandLine: OURS });
  assert.deepEqual(parseProbe(out), { pid: 25400, commandLine: OURS, executablePath: '' });
});

test('probe output with a BOM and trailing whitespace still parses', () => {
  const out = '\uFEFF' + JSON.stringify({ pid: 7, commandLine: 'x' }) + '\r\n';
  assert.deepEqual(parseProbe(out), { pid: 7, commandLine: 'x', executablePath: '' });
});

test('empty, garbage, or pid-less probe output means nothing is listening', () => {
  assert.equal(parseProbe(''), null);
  assert.equal(parseProbe('   \r\n'), null);
  assert.equal(parseProbe('not json'), null);
  assert.equal(parseProbe('{"pid":null,"commandLine":null}'), null);
});

test('a relative-path launch (the .bat style) is ours when the executable lives in the workdir', () => {
  assert.equal(isOurComfy(RELATIVE, WORKDIR, EXE), true);
});

test('executable path matching ignores case and slash direction', () => {
  assert.equal(isOurComfy(RELATIVE, WORKDIR, 'c:/blackbox/comfyui_windows_portable/python_embeded/python.exe'), true);
});

test('a relative-path launch from another folder is not ours', () => {
  assert.equal(isOurComfy(RELATIVE, WORKDIR, 'D:\\Other\\ComfyUI_windows_portable\\python_embeded\\python.exe'), false);
});

test('a relative-path launch with no executable path cannot be proven ours', () => {
  assert.equal(isOurComfy(RELATIVE, WORKDIR), false);
  assert.equal(isOurComfy(RELATIVE, WORKDIR, ''), false);
});

test('our python running some other script is not ours even with the right executable', () => {
  assert.equal(isOurComfy('.\\python_embeded\\python.exe tool.py', WORKDIR, EXE), false);
});

test('an executable in a similarly named sibling folder is not ours', () => {
  const exe = 'C:\\BlackBox\\ComfyUI_windows_portable_old\\python_embeded\\python.exe';
  assert.equal(isOurComfy(RELATIVE, WORKDIR, exe), false);
});

test('the probe output carries the executable path through', () => {
  const out = JSON.stringify({ pid: 25400, commandLine: RELATIVE, executablePath: EXE });
  assert.deepEqual(parseProbe(out), { pid: 25400, commandLine: RELATIVE, executablePath: EXE });
});

test('a probe without an executable path still parses, with an empty one', () => {
  assert.deepEqual(parseProbe(JSON.stringify({ pid: 7, commandLine: 'x' })), { pid: 7, commandLine: 'x', executablePath: '' });
});
