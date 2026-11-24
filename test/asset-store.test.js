const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetStore } = require('../src/asset-store');

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), '宣传 视频-'));

test('takes get ASCII ids and numbers per card, under a non-ASCII project path', () => {
  const dir = project();
  const store = createAssetStore(dir, { now: () => 5, rand: () => 0.5 });
  const a = store.addTake('YS-YK', { mode: 't2i' });
  const b = store.addTake('YS-YK', { mode: 'i2i' });
  assert.match(a.id, /^ys-yk-t001-[a-z0-9]{4}$/);
  assert.equal(b.n, 2);
  assert.match(a.outputKey, /^bb_[a-z0-9-]+$/);
  assert.equal(a.status, 'queued');
  const read = store.readCard('YS-YK');
  assert.deepEqual(read.takes.map((t) => t.mode), ['t2i', 'i2i']);
  assert.ok(fs.existsSync(path.join(dir, '.blackbox', 'assets', 'YS-YK.json')));
  assert.deepEqual(store.listCodes(), ['YS-YK']);
});

test('updateTake, drafts and the kept set are written back', () => {
  const store = createAssetStore(project());
  const t = store.addTake('QX', {});
  assert.equal(store.updateTake('QX', t.id, { status: 'succeeded', image: 'ref/x.png' }).image, 'ref/x.png');
  assert.equal(store.updateTake('QX', 'nope', { status: 'failed' }), null);
  store.writeDraft('QX', { mode: 't2i', ask: '正面' }, 'char');
  store.change('QX', () => ({ set: [{ image: 'ref/x.png', label: '正面' }], main: 'ref/x.png' }));
  const card = store.readCard('QX');
  assert.equal(card.kind, 'char');
  assert.equal(card.draft.ask, '正面');
  assert.equal(card.main, 'ref/x.png');
  assert.equal(card.takes[0].status, 'succeeded');
});

test('a corrupt card reads as empty with a warning and is kept aside on the next write', () => {
  const dir = project();
  const store = createAssetStore(dir, { now: () => 77 });
  store.addTake('QX', {});
  store.addTake('HY27', {});
  const file = path.join(dir, '.blackbox', 'assets', 'QX.json');
  fs.writeFileSync(file, '{ broken');
  const read = store.readCard('QX');
  assert.deepEqual(read.takes, []);
  assert.match(read.warning, /损坏/);
  assert.equal(store.isDamaged(), true);
  assert.equal(store.readCard('HY27').takes.length, 1);
  store.addTake('QX', {});
  assert.ok(fs.existsSync(path.join(dir, '.blackbox', 'assets', 'QX.corrupt-77.json')));
  assert.equal(store.isDamaged(), false);
});

test('bad codes are refused', () => {
  const store = createAssetStore(project());
  assert.throws(() => store.addTake('../x', {}), /代号不对/);
  assert.throws(() => store.addTake('qx', {}), /代号不对/);
  assert.match(store.readCard('何遇').warning, /代号不对/);
});
