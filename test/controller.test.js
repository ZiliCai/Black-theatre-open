const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createController } = require('../src/controller');
const { defaultConfig } = require('../src/config');

// A valid fake workdir so validateConfig passes.
function validConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ctl-'));
  const workdir = path.join(root, 'portable');
  fs.mkdirSync(path.join(workdir, 'python_embeded'), { recursive: true });
  fs.mkdirSync(path.join(workdir, 'ComfyUI'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'python_embeded', 'python.exe'), '');
  fs.writeFileSync(path.join(workdir, 'ComfyUI', 'main.py'), '');
  return { ...defaultConfig(), workdir, port: 8199 };
}

const oursCmd = (cfg) => `"${cfg.workdir}\\python_embeded\\python.exe" -s ComfyUI\\main.py --port ${cfg.port}`;

// Builds a controller with spies. `world.listener` is what the port probe returns.
function setup(over = {}) {
  const cfg = over.config || validConfig();
  const calls = { start: [], kill: [], wait: [] };
  const world = { listener: over.listener === undefined ? null : over.listener, queue: over.queue || { running: 0, pending: 0 } };
  const ctl = createController({
    getConfig: () => cfg,
    makeApi: () => ({ queue: async () => { if (over.queueFails) throw new Error('x'); return world.queue; } }),
    probe: async () => world.listener,
    starter: async (c) => { calls.start.push(c); return { pid: 4242 }; },
    killer: async (pid) => { calls.kill.push(pid); if (over.killFails) throw new Error('拒绝访问'); world.listener = null; },
    waitPortFree: async (port, ms) => { calls.wait.push([port, ms]); return over.portFreed === undefined ? true : over.portFreed; },
    now: () => 777,
  });
  return { ctl, cfg, calls, world };
}

test('start launches ComfyUI when nothing is listening and remembers the launch', async () => {
  const { ctl, cfg, calls } = setup();
  const r = await ctl.start();
  assert.equal(r.ok, true);
  assert.equal(r.pid, 4242);
  assert.deepEqual(calls.start, [cfg]);
  assert.deepEqual(ctl.getLaunch(), { pid: 4242, startedAt: 777 });
});

test('start refuses an invalid config and launches nothing', async () => {
  const bad = { ...defaultConfig(), workdir: 'Z:\\nope', port: 8199 };
  const { ctl, calls } = setup({ config: bad });
  const r = await ctl.start();
  assert.equal(r.ok, false);
  assert.match(r.message, /工作目录/);
  assert.equal(calls.start.length, 0);
});

test('start when our ComfyUI is already running does nothing', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) } });
  const r = await ctl.start();
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.match(r.message, /已在运行/);
  assert.equal(calls.start.length, 0);
});

test('start refuses when another program holds the port, and does not kill it', async () => {
  const { ctl, calls } = setup({ listener: { pid: 9, commandLine: 'C:\\Windows\\other.exe' } });
  const r = await ctl.start();
  assert.equal(r.ok, false);
  assert.match(r.message, /8199/);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.kill.length, 0);
});

test('stop kills our process and waits up to 15 s for the port to free', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) } });
  const r = await ctl.stop();
  assert.equal(r.ok, true);
  assert.deepEqual(calls.kill, [31]);
  assert.deepEqual(calls.wait, [[8199, 15000]]);
  assert.equal(ctl.getLaunch(), null);
});

test('stop when nothing is running is a harmless no-op', async () => {
  const { ctl, calls } = setup();
  const r = await ctl.stop();
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.equal(calls.kill.length, 0);
});

test('stop refuses to kill a process that is not our ComfyUI', async () => {
  const { ctl, calls } = setup({ listener: { pid: 9, commandLine: 'C:\\Windows\\other.exe' } });
  const r = await ctl.stop();
  assert.equal(r.ok, false);
  assert.match(r.message, /拒绝/);
  assert.equal(calls.kill.length, 0);
});

test('stop asks for confirmation when jobs are queued, and kills nothing yet', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, queue: { running: 1, pending: 2 } });
  const r = await ctl.stop();
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
  assert.match(r.message, /1.*运行.*2.*等待/);
  assert.equal(calls.kill.length, 0);
});

test('stop with confirmed=true kills even when jobs are queued', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, queue: { running: 1, pending: 0 } });
  const r = await ctl.stop({ confirmed: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.kill, [31]);
});

test('if the queue cannot be read, stop still proceeds (a hung server must be killable)', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, queueFails: true });
  const r = await ctl.stop();
  assert.equal(r.ok, true);
  assert.deepEqual(calls.kill, [31]);
});

test('stop reports failure when taskkill fails, and when the port never frees', async () => {
  const cfg = validConfig();
  const a = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, killFails: true });
  const r1 = await a.ctl.stop();
  assert.equal(r1.ok, false);
  assert.match(r1.message, /拒绝访问/);

  const b = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, portFreed: false });
  const r2 = await b.ctl.stop();
  assert.equal(r2.ok, false);
  assert.match(r2.message, /15 秒/);
});

test('restart = stop then start', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) } });
  const r = await ctl.restart();
  assert.equal(r.ok, true);
  assert.deepEqual(calls.kill, [31]);
  assert.equal(calls.start.length, 1);
  assert.match(r.message, /重启/);
});

test('restart when nothing was running just starts', async () => {
  const { ctl, calls } = setup();
  const r = await ctl.restart();
  assert.equal(r.ok, true);
  assert.equal(calls.start.length, 1);
});

test('restart does not start a new one when stop needs confirmation or fails', async () => {
  const cfg = validConfig();
  const a = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, queue: { running: 1, pending: 0 } });
  const r1 = await a.ctl.restart();
  assert.equal(r1.needsConfirm, true);
  assert.equal(a.calls.start.length, 0);

  const b = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, portFreed: false });
  const r2 = await b.ctl.restart();
  assert.equal(r2.ok, false);
  assert.equal(b.calls.start.length, 0);
});

test('restart with confirmed=true goes through even with a busy queue', async () => {
  const cfg = validConfig();
  const { ctl, calls } = setup({ config: cfg, listener: { pid: 31, commandLine: oursCmd(cfg) }, queue: { running: 1, pending: 1 } });
  const r = await ctl.restart({ confirmed: true });
  assert.equal(r.ok, true);
  assert.equal(calls.start.length, 1);
});

test('stop recognises and ends a relative-path launch (the .bat style) through its executable path', async () => {
  const cfg = validConfig();
  const relative = {
    pid: 25400,
    commandLine: '.\\python_embeded\\python.exe -s ComfyUI\\main.py --port 8199',
    executablePath: path.join(cfg.workdir, 'python_embeded', 'python.exe'),
  };
  const { ctl, calls } = setup({ config: cfg, listener: relative });
  const r = await ctl.stop();
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(calls.kill, [25400]);
});

test('start treats a relative-path launch of ours as already running', async () => {
  const cfg = validConfig();
  const relative = {
    pid: 25400,
    commandLine: '.\\python_embeded\\python.exe -s ComfyUI\\main.py --port 8199',
    executablePath: path.join(cfg.workdir, 'python_embeded', 'python.exe'),
  };
  const { ctl, calls } = setup({ config: cfg, listener: relative });
  const r = await ctl.start();
  assert.equal(r.noop, true);
  assert.equal(calls.start.length, 0);
});
