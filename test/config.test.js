const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, validateConfig, loadConfig, saveConfig } = require('../src/config');

// A fake ComfyUI_windows_portable folder, optionally with a Chinese + space path.
function makeWorkdir(name = 'portable') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-'));
  const workdir = path.join(root, name);
  fs.mkdirSync(path.join(workdir, 'python_embeded'), { recursive: true });
  fs.mkdirSync(path.join(workdir, 'ComfyUI'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'python_embeded', 'python.exe'), '');
  fs.writeFileSync(path.join(workdir, 'ComfyUI', 'main.py'), '');
  return { root, workdir };
}

test('a folder with python.exe and main.py is valid', () => {
  const { workdir } = makeWorkdir();
  const cfg = { ...defaultConfig(), workdir };
  assert.deepEqual(validateConfig(cfg), { ok: true, errors: [] });
});

test('a path with Chinese characters and spaces is valid', () => {
  const { workdir } = makeWorkdir('我的 ComfyUI 目录');
  assert.equal(validateConfig({ ...defaultConfig(), workdir }).ok, true);
});

test('missing python.exe is reported with the path that was checked', () => {
  const { workdir } = makeWorkdir();
  fs.rmSync(path.join(workdir, 'python_embeded', 'python.exe'));
  const r = validateConfig({ ...defaultConfig(), workdir });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /python_embeded[\\/]python\.exe/);
});

test('missing main.py is reported', () => {
  const { workdir } = makeWorkdir();
  fs.rmSync(path.join(workdir, 'ComfyUI', 'main.py'));
  const r = validateConfig({ ...defaultConfig(), workdir });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /main\.py/);
});

test('a non-existent workdir is reported once, not as two file errors', () => {
  const r = validateConfig({ ...defaultConfig(), workdir: 'Z:\\definitely\\not\\here' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /工作目录/);
});

test('ports outside 1..65535 or non-integers are rejected', () => {
  const { workdir } = makeWorkdir();
  for (const port of [0, 70000, -1, 8188.5, '8188', NaN, null]) {
    const r = validateConfig({ ...defaultConfig(), workdir, port });
    assert.equal(r.ok, false, `port ${String(port)} should be rejected`);
    assert.match(r.errors.join('\n'), /端口/);
  }
});

test('negative or non-numeric reserve-vram is rejected, zero is fine', () => {
  const { workdir } = makeWorkdir();
  const base = { ...defaultConfig(), workdir };
  for (const reserveVram of [-0.1, 'abc', NaN]) {
    const r = validateConfig({ ...base, flags: { ...base.flags, reserveVram } });
    assert.equal(r.ok, false, `reserveVram ${String(reserveVram)} should be rejected`);
  }
  assert.equal(validateConfig({ ...base, flags: { ...base.flags, reserveVram: 0 } }).ok, true);
});

test('loading a file that does not exist gives the defaults', () => {
  const file = path.join(os.tmpdir(), 'cl-never-' + Date.now() + '.json');
  assert.deepEqual(loadConfig(file), defaultConfig());
});

test('loading a corrupt file gives the defaults instead of throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-'));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(loadConfig(file), defaultConfig());
});

test('a partial file is merged over the defaults, including nested flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-'));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8199, flags: { lowvram: false } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 8199);
  assert.equal(cfg.flags.lowvram, false);
  assert.equal(cfg.flags.reserveVram, 2.5);
  assert.equal(cfg.flags.disablePinnedMemory, true);
  assert.equal(cfg.workdir, defaultConfig().workdir);
});

test('save then load round-trips, and the file is created inside a missing folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-'));
  const file = path.join(root, 'nested', 'config.json');
  const cfg = defaultConfig();
  cfg.port = 8199;
  cfg.workdir = 'F:\\路径 带空格\\portable';
  saveConfig(file, cfg);
  assert.deepEqual(loadConfig(file), cfg);
});

// ---------- script projects ----------
test('the defaults have no project, an empty known list and a projects root', () => {
  const d = defaultConfig();
  assert.equal(d.activeProject, '');
  assert.deepEqual(d.projects, []);
  assert.equal(d.projectsRoot, 'C:\\BlackBox\\projects');
});

test('an old config file without project fields loads with the defaults for them', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8190, outputDir: 'C:\\BlackBox\\projects\\example' }));
  const c = loadConfig(file);
  assert.equal(c.activeProject, '');
  assert.deepEqual(c.projects, []);
  assert.equal(c.outputDir, 'C:\\BlackBox\\projects\\example');
});

test('project fields that are the wrong type fall back to the defaults when loading', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ projects: 'nope', activeProject: 5, projectsRoot: 7 }));
  const c = loadConfig(file);
  assert.deepEqual(c.projects, []);
  assert.equal(c.activeProject, '');
  assert.equal(c.projectsRoot, 'C:\\BlackBox\\projects');
});

test('the known list keeps only strings when loading', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cfg-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ projects: ['D:\\a', 3, null, 'D:\\b'] }));
  assert.deepEqual(loadConfig(file).projects, ['D:\\a', 'D:\\b']);
});

test('a relative projects root is reported', () => {
  const { workdir } = makeWorkdir();
  const bad = validateConfig({ ...defaultConfig(), workdir, projectsRoot: 'relative\\dir' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /项目根目录/.test(e)));
  assert.equal(validateConfig({ ...defaultConfig(), workdir }).ok, true);
});

test('a project that has gone missing never blocks starting ComfyUI', () => {
  const { workdir } = makeWorkdir();
  const c = { ...defaultConfig(), workdir, activeProject: 'F:\\no\\such\\project', projects: ['F:\\no\\such\\project'] };
  assert.equal(validateConfig(c).ok, true);
});
