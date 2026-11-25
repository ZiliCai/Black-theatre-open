const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { recipe, collect } = require('../src/autodl-setup');
const catalog = require('../autodl/models.json');
const root = path.join(__dirname, '..');

for (const profile of ['wenwu', 'hybrid', 'image']) {
  test('AutoDL builds an executable acceptance recipe for ' + profile, async () => {
    const plan = recipe(root, profile, true);
    assert.equal(Boolean(plan.video), profile !== 'image');
    assert.ok(plan.nodes.includes('SeedVR2VideoUpscaler'));
    const files = new Set(plan.workflows.flatMap((workflow) => catalog.workflows[workflow]));
    const names = [...files].map((p) => path.posix.basename(p));
    for (const file of files) {
      assert.match(catalog.files[file].sha256, /^[0-9a-f]{64}$/);
      assert.ok(catalog.files[file].bytes > 0);
    }
    for (const plugin of plan.plugins) assert.ok((await fs.stat(path.join(root, 'comfyui-plugins', plugin))).isDirectory());
    for (const graph of [plan.image, plan.video].filter(Boolean)) {
      for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs)) {
          if (typeof value === 'string' && /\.(gguf|safetensors)$/.test(value)) assert.ok(names.includes(path.win32.basename(value)), value);
        }
      }
    }
    if (plan.video) {
      const json = JSON.stringify(plan.video);
      assert.ok(json.includes('ref/bbt_acceptance.png [output]'));
      assert.ok(json.includes('video/bbt_acceptance'));
    }
  });
}
test('acceptance is complete only after local bytes match the remote checksum', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bbt-accept-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  let payload = Buffer.from('short clip');
  const original = Buffer.from(payload);
  const run = 'a'.repeat(32);
  const state = { run, file: 'video/bbt_acceptance_' + run + '_00001.mp4', bytes: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const server = http.createServer((_req, res) => res.end(payload));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  payload = Buffer.from('other clip');
  await assert.rejects(collect(state, port, tmp), /不完整/);
  assert.deepEqual(await fs.readdir(tmp), []);
  payload = original;
  const name = await collect(state, port, tmp);
  assert.deepEqual(await fs.readFile(path.join(tmp, name)), original);
  assert.equal(await collect(state, 0, tmp), name);
  await assert.rejects(collect({ ...state, file: '../etc/passwd' }, port, tmp), /信息无效/);
});

test('the download list covers every weight referenced by both published Wenwu graphs', async () => {
  for (const id of ['minimax-h3-wenwu', 'minimax-h3-wenwu-cont']) {
    const graph = JSON.parse(await fs.readFile(path.join(root, 'workflow-templates', id, 'workflow.api.json'), 'utf8'));
    const weights = Object.values(graph).flatMap((node) => Object.values(node.inputs))
      .filter((value) => typeof value === 'string' && /\.(safetensors|gguf|pt|pth|ckpt|bin)$/i.test(value));
    const planned = catalog.workflows[id].map((file) => path.posix.basename(file));
    assert.deepEqual([...new Set(weights)].sort(), [...planned].sort());
  }
});

test('a GPU-less download run only marks the recipe; the full run stays unmarked', () => {
  const full = recipe(root, 'wenwu');
  const download = recipe(root, 'wenwu', false, true);
  assert.equal(download.modelsOnly, true);
  assert.equal('modelsOnly' in full, false);
  assert.deepEqual(download.workflows, full.workflows);
});
