const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTakeStore } = require('../src/take-store');

const tmpProject = (name = 'proj') => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'take-store-')), name);
  fs.mkdirSync(dir);
  return dir;
};

test('addTake numbers takes per shot and makes ASCII ids', () => {
  const store = createTakeStore(tmpProject());
  const a = store.addTake('MOTION-E01-05', { status: 'queued' });
  const b = store.addTake('MOTION-E01-05', { status: 'queued' });
  assert.equal(a.n, 1);
  assert.equal(b.n, 2);
  assert.match(a.id, /^e01-05-t001-[0-9a-z]{4}$/);
  assert.match(b.id, /^e01-05-t002-[0-9a-z]{4}$/);
  assert.equal(a.outputKey, `bb_${a.id}`);
  assert.equal(a.tier, '');
  assert.equal(store.addTake('HAND-E01-1', {}).id.slice(0, 13), 'h-e01-1-t001-');
});

test('writeDraft then readShot round-trips', () => {
  const store = createTakeStore(tmpProject());
  const draft = { templateId: 'minimax-h3-wenwu-cont', values: { prompt: '你好', duration: 5.9 }, continuation: { mode: 'previous' } };
  store.writeDraft('MOTION-E01-02', draft);
  const read = store.readShot('MOTION-E01-02');
  assert.deepEqual(read.draft, draft);
  assert.deepEqual(read.takes, []);
  assert.equal(read.warning, '');
});

test('a missing shot reads as empty without a warning', () => {
  const read = createTakeStore(tmpProject()).readShot('MOTION-E09-09');
  assert.deepEqual(read, { draft: null, takes: [], warning: '' });
});

test('a corrupt shot file reads as empty with a warning', () => {
  const dir = tmpProject();
  const store = createTakeStore(dir);
  store.addTake('MOTION-E01-01', {});
  store.addTake('MOTION-E01-02', {});
  fs.writeFileSync(path.join(dir, '.blackbox', 'shots', 'MOTION-E01-01.json'), '{oops');
  const bad = store.readShot('MOTION-E01-01');
  assert.deepEqual(bad.takes, []);
  assert.match(bad.warning, /损坏/);
  assert.equal(store.readShot('MOTION-E01-02').takes.length, 1);
});

test('writing to a shot whose file is damaged keeps the damaged file aside first', () => {
  const dir = tmpProject();
  const store = createTakeStore(dir, { now: () => 1234 });
  store.addTake('MOTION-E01-01', {});
  const file = path.join(dir, '.blackbox', 'shots', 'MOTION-E01-01.json');
  fs.writeFileSync(file, '{"takes": [ hand-edited');
  assert.match(store.readShot('MOTION-E01-01').warning, /损坏/);
  assert.equal(store.isDamaged(), true);
  store.writeDraft('MOTION-E01-01', { templateId: 't', values: {}, continuation: { mode: 'none' } });
  const kept = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('MOTION-E01-01.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{"takes": [ hand-edited');
  assert.equal(store.isDamaged(), false);
  assert.deepEqual(store.listShotIds(), ['MOTION-E01-01'], 'the backup is not taken for a shot');
});

test('a damaged manual-shot file is reported and kept, and numbering skips ids already used', () => {
  const dir = tmpProject();
  const store = createTakeStore(dir, { now: () => 5 });
  store.addManual({ episode: 'E01', title: 'a', after: null });
  store.addTake('HAND-E01-1', {});
  store.addTake('HAND-E01-2', {});
  fs.writeFileSync(path.join(dir, '.blackbox', 'manual-shots.json'), 'oops');
  assert.match(store.manualWarning(), /损坏/);
  const next = store.addManual({ episode: 'E01', title: 'b', after: null });
  assert.equal(next.id, 'HAND-E01-3');
  assert.ok(fs.readdirSync(path.join(dir, '.blackbox')).some((n) => n.startsWith('manual-shots.corrupt-')));
});

test('shot ids that are not shot ids are refused', () => {
  const store = createTakeStore(tmpProject());
  for (const bad of ['../../evil', 'MOTION-E01-01/../../x', 'C:\\x', '']) {
    assert.throws(() => store.writeDraft(bad, {}), /镜头编号/);
    assert.throws(() => store.addTake(bad, {}), /镜头编号/);
  }
  assert.deepEqual(store.readShot('../x'), { draft: null, takes: [], warning: '镜头编号不对:../x' });
});

test('works under a non-ASCII project path', () => {
  const store = createTakeStore(tmpProject('宣传视频 2026'));
  const take = store.addTake('MOTION-E01-01', { status: 'queued' });
  store.updateTake('MOTION-E01-01', take.id, { status: 'succeeded', video: 'video/x.mp4' });
  const read = store.readShot('MOTION-E01-01');
  assert.equal(read.takes[0].status, 'succeeded');
  assert.equal(read.takes[0].video, 'video/x.mp4');
  assert.deepEqual(store.listShotIds(), ['MOTION-E01-01']);
});

test('updateTake patches one take only', () => {
  const store = createTakeStore(tmpProject());
  const a = store.addTake('MOTION-E01-01', { status: 'queued' });
  const b = store.addTake('MOTION-E01-01', { status: 'queued' });
  const updated = store.updateTake('MOTION-E01-01', b.id, { status: 'running' });
  assert.equal(updated.status, 'running');
  const takes = store.readShot('MOTION-E01-01').takes;
  assert.equal(takes.find((t) => t.id === a.id).status, 'queued');
  assert.equal(store.updateTake('MOTION-E01-01', 'nope', { status: 'x' }), null);
});

test('replaceTakes keeps the draft', () => {
  const store = createTakeStore(tmpProject());
  store.writeDraft('MOTION-E01-01', { templateId: 't', values: {}, continuation: { mode: 'none' } });
  const a = store.addTake('MOTION-E01-01', {});
  store.replaceTakes('MOTION-E01-01', [{ ...a, tier: 'pick' }]);
  const read = store.readShot('MOTION-E01-01');
  assert.equal(read.takes[0].tier, 'pick');
  assert.equal(read.draft.templateId, 't');
});

test('addManual numbers within an episode', () => {
  const store = createTakeStore(tmpProject(), { now: () => 42 });
  assert.equal(store.addManual({ episode: 'E01', title: '甲', after: 'MOTION-E01-05' }).id, 'HAND-E01-1');
  assert.equal(store.addManual({ episode: 'E01', title: '乙', after: null }).id, 'HAND-E01-2');
  assert.equal(store.addManual({ episode: 'E02', title: '丙', after: null }).id, 'HAND-E02-1');
  const manual = store.readManual();
  assert.equal(manual.length, 3);
  assert.deepEqual(manual[0], { id: 'HAND-E01-1', episode: 'E01', title: '甲', after: 'MOTION-E01-05', createdAt: 42 });
  // put right before or after a shot: the shot and the side are kept
  assert.deepEqual(store.addManual({ episode: 'E01', title: '丁', anchor: 'MOTION-E01-02', place: 'before' }),
    { id: 'HAND-E01-3', episode: 'E01', title: '丁', after: null, anchor: 'MOTION-E01-02', place: 'before', createdAt: 42 });
  assert.equal(store.addManual({ episode: 'E01', title: '戊', anchor: 'MOTION-E01-02', place: 'sideways' }).after, null, 'no side: no anchor');
});

test('writes leave no temporary files behind', () => {
  const dir = tmpProject();
  const store = createTakeStore(dir);
  store.addTake('MOTION-E01-01', {});
  store.addManual({ episode: 'E01', title: 'x', after: null });
  const leftovers = [...fs.readdirSync(path.join(dir, '.blackbox')), ...fs.readdirSync(path.join(dir, '.blackbox', 'shots'))]
    .filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
