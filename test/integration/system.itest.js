// Real-system test: starts / stops / restarts a SEPARATE ComfyUI on port 8199.
// It never touches the user's own instance on 8188.   Run: npm run test:integration
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig } = require('../../src/config');
const { createRuntime } = require('../../src/runtime');
const { isAlive } = require('../../src/system');

const PORT = 8199;
const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-int-')), 'boot.log');
const config = { ...defaultConfig(), port: PORT, logPath };
const rt = createRuntime({ getConfig: () => config });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForState(state, ms = 150000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await rt.getStatus();
    if (s.state === state) return s;
    await sleep(2000);
  }
  throw new Error(`never reached "${state}", last status: ${JSON.stringify(s)}`);
}

test.after(async () => { await rt.controller.stop({ confirmed: true }); });

test('safety: this test must not run while something else owns port 8199', async () => {
  const s = await rt.getStatus();
  assert.equal(s.state, 'stopped', `port ${PORT} is not free: ${JSON.stringify(s)}`);
});

test('start brings up a real ComfyUI that the launcher recognises as its own', { timeout: 200000 }, async () => {
  const r = await rt.controller.start();
  assert.equal(r.ok, true, r.message);
  const s = await waitForState('running');
  assert.equal(s.ours, true);
  assert.equal(s.pid, r.pid, 'the listener should be the process we spawned');
  assert.ok(s.processMemMB > 100, `process memory should be reported, got ${s.processMemMB}`);
  assert.ok(fs.statSync(logPath).size > 0, 'ComfyUI output should land in the log file');
});

test('the ComfyUI process keeps running without the launcher holding a handle', async () => {
  const s = await rt.getStatus();
  assert.equal(isAlive(s.pid), true);
});

test('starting again is a no-op and does not spawn a second process', async () => {
  const before = (await rt.getStatus()).pid;
  const r = await rt.controller.start();
  assert.equal(r.noop, true);
  assert.equal((await rt.getStatus()).pid, before);
});

test('clear cache works against the live instance', async () => {
  const r = await rt.clearCache();
  assert.equal(r.ok, true, r.message);
  assert.equal(r.freedModels, true, 'the /free call should have succeeded');
});

test('stop ends it, frees the port and leaves nothing behind', { timeout: 60000 }, async () => {
  const pid = (await rt.getStatus()).pid;
  const r = await rt.controller.stop();
  assert.equal(r.ok, true, r.message);
  assert.equal((await rt.getStatus()).state, 'stopped');
  await sleep(500);
  assert.equal(isAlive(pid), false);
});

test('restart gives a new process that comes back up', { timeout: 400000 }, async () => {
  await rt.controller.start();
  const first = await waitForState('running');
  const r = await rt.controller.restart();
  assert.equal(r.ok, true, r.message);
  const second = await waitForState('running');
  assert.notEqual(second.pid, first.pid);
  assert.equal(isAlive(first.pid), false);
  await rt.controller.stop();
});

test('a ComfyUI started like the user\'s .bat (relative path via cmd) is recognised and can be stopped', { timeout: 300000 }, async () => {
  const fd = fs.openSync(logPath, 'a');
  const batLine =
    `.\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --port ${PORT} ` +
    '--lowvram --reserve-vram 2.5 --disable-pinned-memory';
  const child = spawn('cmd.exe', ['/c', batLine], {
    cwd: config.workdir, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  child.unref();
  fs.closeSync(fd);

  const s = await waitForState('running');
  assert.equal(s.ours, true, `a relative-path launch must be recognised, status: ${JSON.stringify(s)}`);
  assert.equal(s.message, '');

  const r = await rt.controller.stop();
  assert.equal(r.ok, true, r.message);
  assert.equal((await rt.getStatus()).state, 'stopped');
});

test('custom input/output directories really reach ComfyUI: argv, uploads and saved images land there', { timeout: 400000 }, async () => {
  const { effectiveDirs } = require('../../src/dirs');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-int-out-'));
  const inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-int-in-'));
  const saved = { outputDir: config.outputDir, inputDir: config.inputDir };
  config.outputDir = outDir;
  config.inputDir = inDir;
  try {
    const r = await rt.controller.start();
    assert.equal(r.ok, true, r.message);
    const s = await waitForState('running');

    // 1. ComfyUI reports the flags it was started with, and our "effective dir" logic agrees.
    assert.ok(s.argv.includes('--output-directory') && s.argv.includes(outDir), `argv: ${JSON.stringify(s.argv)}`);
    const eff = effectiveDirs({ workdir: config.workdir, config, argv: s.argv });
    assert.equal(eff.output.path.toLowerCase(), outDir.toLowerCase());
    assert.equal(eff.input.path.toLowerCase(), inDir.toLowerCase());
    assert.equal(eff.output.pending, false);

    // 2. Changing the saved setting while it runs is "pending" until a restart.
    const otherOut = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-int-out2-'));
    const pending = effectiveDirs({ workdir: config.workdir, config: { ...config, outputDir: otherOut }, argv: s.argv });
    assert.equal(pending.output.path.toLowerCase(), outDir.toLowerCase());
    assert.equal(pending.output.pending, true);

    // 3. An uploaded image goes to the custom INPUT directory.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'launcher_probe.png');
    const up = await fetch(`http://127.0.0.1:${PORT}/upload/image`, { method: 'POST', body: form });
    assert.equal(up.status, 200, await up.text());
    assert.equal(fs.existsSync(path.join(inDir, 'launcher_probe.png')), true, 'upload should land in the custom input dir');

    // 4. A saved image goes to the custom OUTPUT directory (EmptyImage -> SaveImage, no model needed).
    const prompt = {
      1: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
      2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'launcher_probe' } },
    };
    const q = await fetch(`http://127.0.0.1:${PORT}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
    });
    assert.equal(q.status, 200, await q.text());
    const end = Date.now() + 60000;
    let found = [];
    while (Date.now() < end && !found.length) {
      await sleep(1000);
      found = fs.readdirSync(outDir).filter((f) => f.startsWith('launcher_probe'));
    }
    assert.ok(found.length > 0, 'the saved image should land in the custom output dir');
  } finally {
    await rt.controller.stop({ confirmed: true });
    config.outputDir = saved.outputDir;
    config.inputDir = saved.inputDir;
  }
});

test('a foreign program on the port: start refuses, stop refuses, the program survives', { timeout: 60000 }, async () => {
  const foreign = http.createServer((req, res) => res.end('foreign'));
  await new Promise((r) => foreign.listen(PORT, '127.0.0.1', r));
  try {
    const s = await rt.getStatus();
    assert.equal(s.state, 'port-busy');
    assert.equal((await rt.controller.start()).ok, false);
    const stop = await rt.controller.stop();
    assert.equal(stop.ok, false);
    assert.match(stop.message, /拒绝/);
    const answer = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port: PORT, path: '/', agent: false }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
      }).on('error', reject));
    assert.equal(answer, 'foreign');
  } finally {
    foreign.closeAllConnections();
    await new Promise((r) => foreign.close(r));
  }
});
