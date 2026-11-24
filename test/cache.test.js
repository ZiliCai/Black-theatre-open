const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearTemp, clearCache } = require('../src/cache');

// A fake portable folder with the dirs the real one has, each holding a precious file.
function makeWorkdir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cache-'));
  const workdir = path.join(root, 'portable');
  const comfy = path.join(workdir, 'ComfyUI');
  for (const d of ['temp', 'output', 'input', 'models', 'user/default/workflows', 'custom_nodes']) {
    fs.mkdirSync(path.join(comfy, d), { recursive: true });
  }
  for (const d of ['output', 'input', 'models', 'user/default/workflows', 'custom_nodes']) {
    fs.writeFileSync(path.join(comfy, d, 'precious.bin'), 'keep me');
  }
  return { root, workdir, comfy, temp: path.join(comfy, 'temp') };
}

function assertPreciousIntact(comfy) {
  for (const d of ['output', 'input', 'models', 'user/default/workflows', 'custom_nodes']) {
    assert.equal(fs.readFileSync(path.join(comfy, d, 'precious.bin'), 'utf8'), 'keep me', `${d} was touched`);
  }
}

test('empties temp (files and nested folders) but keeps the folder itself', () => {
  const { workdir, comfy, temp } = makeWorkdir();
  fs.writeFileSync(path.join(temp, 'a.png'), '12345');
  fs.mkdirSync(path.join(temp, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'sub', 'deeper', 'b.bin'), '1234567890');

  const r = clearTemp(workdir);

  assert.equal(r.ok, true);
  assert.equal(r.freedBytes, 15);
  assert.equal(r.skipped, 0);
  assert.equal(fs.existsSync(temp), true);
  assert.deepEqual(fs.readdirSync(temp), []);
  assertPreciousIntact(comfy);
});

test('never touches output, input, models, workflows or custom_nodes', () => {
  const { workdir, comfy, temp } = makeWorkdir();
  fs.writeFileSync(path.join(temp, 'junk'), 'x');
  clearTemp(workdir);
  assertPreciousIntact(comfy);
});

test('a missing temp folder is not an error and frees nothing', () => {
  const { workdir, temp } = makeWorkdir();
  fs.rmSync(temp, { recursive: true });
  const r = clearTemp(workdir);
  assert.deepEqual({ ok: r.ok, freedBytes: r.freedBytes, skipped: r.skipped }, { ok: true, freedBytes: 0, skipped: 0 });
});

test('a missing ComfyUI folder is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cache-'));
  const r = clearTemp(path.join(root, 'nope'));
  assert.equal(r.ok, false);
});

test('refuses when temp itself is a link pointing somewhere else', () => {
  const { root, workdir, temp } = makeWorkdir();
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
  fs.rmSync(temp, { recursive: true });
  fs.symlinkSync(elsewhere, temp, 'junction');

  const r = clearTemp(workdir);

  assert.equal(r.ok, false);
  assert.match(r.message, /链接|Junction|符号/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
});

test('a link inside temp is removed but its target is not followed', () => {
  const { root, workdir, temp } = makeWorkdir();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(temp, 'sneaky'), 'junction');
  fs.writeFileSync(path.join(temp, 'plain.txt'), 'abc');

  const r = clearTemp(workdir);

  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('a file that cannot be removed is skipped and counted, the rest is still cleared', () => {
  const { workdir, temp } = makeWorkdir();
  fs.writeFileSync(path.join(temp, 'locked.bin'), '1234');
  fs.writeFileSync(path.join(temp, 'free.bin'), '12');
  const remove = (p) => {
    if (path.basename(p) === 'locked.bin') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    fs.rmSync(p, { recursive: true, force: true });
  };

  const r = clearTemp(workdir, { remove });

  assert.equal(r.ok, true);
  assert.equal(r.skipped, 1);
  assert.equal(r.freedBytes, 2);
  assert.deepEqual(fs.readdirSync(temp), ['locked.bin']);
});

test('clearCache asks a running ComfyUI to free models, then empties temp', async () => {
  const { workdir, temp } = makeWorkdir();
  fs.writeFileSync(path.join(temp, 'x'), '123');
  let freeCalls = 0;
  const api = { free: async () => { freeCalls++; } };

  const r = await clearCache({ workdir, running: true, api });

  assert.equal(freeCalls, 1);
  assert.equal(r.ok, true);
  assert.equal(r.freedModels, true);
  assert.equal(r.freedBytes, 3);
});

test('clearCache does not call the API when ComfyUI is not running', async () => {
  const { workdir } = makeWorkdir();
  let freeCalls = 0;
  const api = { free: async () => { freeCalls++; } };

  const r = await clearCache({ workdir, running: false, api });

  assert.equal(freeCalls, 0);
  assert.equal(r.ok, true);
  assert.equal(r.freedModels, false);
});

test('clearCache still empties temp when the free call fails, and says so', async () => {
  const { workdir, temp } = makeWorkdir();
  fs.writeFileSync(path.join(temp, 'x'), '123');
  const api = { free: async () => { throw new Error('connect ECONNREFUSED'); } };

  const r = await clearCache({ workdir, running: true, api });

  assert.equal(r.ok, true);
  assert.equal(r.freedModels, false);
  assert.equal(r.freedBytes, 3);
  assert.match(r.message, /释放接口.*失败|ECONNREFUSED/);
});
