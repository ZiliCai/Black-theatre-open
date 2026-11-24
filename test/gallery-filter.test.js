const test = require('node:test');
const assert = require('node:assert/strict');
const GF = require('../renderer/gallery-filter');

const E = (name, kind, params, extra = {}) => ({
  relPath: `${extra.folder ? extra.folder + '/' : ''}${name}`, name, folder: extra.folder || '', kind,
  size: 1000, mtimeMs: 1_700_000_000_000, width: 928, height: 672, duration: 8, params: params || null,
});
const P = (extra = {}) => ({
  seed: 728888521730947, steps: 16, turbo: false, loras: [], refs: [], summary: null, promptText: null,
  continued: false, continueFrom: null, clipIndex: null, ...extra,
});
const LIST = [
  E('minimax-h3-demo_00004_.mp4', 'video', P({ summary: 'a quiet evening in the living room', refs: ['角色甲.png'], clipIndex: 1 }), { folder: 'video' }),
  E('minimax-h3-demo_00005_.mp4', 'video', P({ summary: 'the kitchen scene', turbo: true, steps: 4, clipIndex: 2, continued: true, continueFrom: 1 }), { folder: 'video' }),
  E('定妆照角色乙_00001_.png', 'image', P({ summary: 'portrait of a man', seed: 42 })),
  E('plain.mp4', 'video', null),
];

test('filterEntries keeps one kind', () => {
  assert.deepEqual(GF.filterEntries(LIST, { kind: 'image' }).map((e) => e.name), ['定妆照角色乙_00001_.png']);
  assert.equal(GF.filterEntries(LIST, { kind: 'video' }).length, 3);
  assert.equal(GF.filterEntries(LIST, {}).length, 4);
});

test('search looks in the file name, folder, story summary, picture names and seed', () => {
  const names = (q) => GF.filterEntries(LIST, { kind: 'video', query: q }).map((e) => e.name);
  assert.deepEqual(names('kitchen'), ['minimax-h3-demo_00005_.mp4']);
  assert.deepEqual(names('角色甲'), ['minimax-h3-demo_00004_.mp4']);
  assert.deepEqual(names('00005'), ['minimax-h3-demo_00005_.mp4']);
  assert.deepEqual(names('728888521730947').length, 2);
  assert.deepEqual(names('plain'), ['plain.mp4']);
  assert.deepEqual(names('video/'), ['minimax-h3-demo_00004_.mp4', 'minimax-h3-demo_00005_.mp4']);
});

test('search needs every word, ignores case, and "turbo" finds the turbo takes', () => {
  const names = (q) => GF.filterEntries(LIST, { kind: 'video', query: q }).map((e) => e.name);
  assert.deepEqual(names('KITCHEN scene'), ['minimax-h3-demo_00005_.mp4']);
  assert.deepEqual(names('kitchen living'), []);
  assert.deepEqual(names('turbo'), ['minimax-h3-demo_00005_.mp4']);
  assert.equal(names('   ').length, 3);
});

test('countByKind counts what the search leaves, for the tab badges', () => {
  assert.deepEqual(GF.countByKind(LIST, ''), { video: 3, image: 1, kept: 0 });
  assert.deepEqual(GF.countByKind(LIST, 'portrait'), { video: 0, image: 1, kept: 0 });
});

test('kept takes: their own tab in shot order, a star chip, and found by searching the shot', () => {
  const a = { ...LIST[0], keptShot: '1-10' };
  const b = { ...LIST[1], keptShot: '1-4' };
  const c = { ...LIST[3], keptShot: '2-1' };
  const list = [a, b, LIST[2], c];
  assert.deepEqual(GF.filterEntries(list, { kind: 'kept' }).map((e) => e.keptShot), ['1-4', '1-10', '2-1']);
  assert.deepEqual(GF.countByKind(list, ''), { video: 3, image: 1, kept: 3 });
  assert.deepEqual(GF.chipsOf(c), [{ text: '★ 分镜 2-1', tone: 'kept' }]);
  assert.deepEqual(GF.chipsOf(b)[0], { text: '★ 分镜 1-4', tone: 'kept' });
  assert.deepEqual(GF.filterEntries(list, { kind: 'video', query: '1-4' }).map((e) => e.keptShot), ['1-4']);
  assert.deepEqual(GF.filterEntries(list, { kind: 'video', query: '分镜' }).length, 3);
});

test('normalizeShot accepts episode-shot only, tidied', () => {
  assert.equal(GF.normalizeShot(' 1 － 4 '), '1-4');
  assert.equal(GF.normalizeShot('12-3A'), '12-3a');
  for (const bad of ['', '4', 'a-b', '1-2-3', null, undefined]) assert.equal(GF.normalizeShot(bad), null);
  assert.ok(GF.compareShots('1-4', '1-10') < 0 && GF.compareShots('2-1', '1-82') > 0);
});

test('chipsOf: clip number, which clip it continues, and Turbo or full steps', () => {
  assert.deepEqual(GF.chipsOf(LIST[0]), [{ text: '第 1 段', tone: 'clip' }, { text: '16 步', tone: 'plain' }]);
  assert.deepEqual(GF.chipsOf(LIST[1]), [
    { text: '第 2 段', tone: 'clip' }, { text: '接第 1 段', tone: 'link' }, { text: 'Turbo 4 步', tone: 'fast' },
  ]);
  assert.deepEqual(GF.chipsOf(LIST[3]), []);
});

test('formatDuration', () => {
  assert.equal(GF.formatDuration(8), '8.0 秒');
  assert.equal(GF.formatDuration(7.96), '8.0 秒');
  assert.equal(GF.formatDuration(75.2), '1:15');
  assert.equal(GF.formatDuration(null), '');
  assert.equal(GF.formatDuration(0), '');
});

test('formatResolution and formatStamp', () => {
  assert.equal(GF.formatResolution(928, 672), '928×672');
  assert.equal(GF.formatResolution(null, 10), '');
  const d = new Date(2026, 9, 11, 2, 24); // local time: 11 Oct 2026 02:24
  assert.equal(GF.formatStamp(d.getTime(), new Date(2026, 9, 11, 9, 0).getTime()), '今天 02:24');
  assert.equal(GF.formatStamp(d.getTime(), new Date(2026, 9, 12, 9, 0).getTime()), '昨天 02:24');
  assert.equal(GF.formatStamp(d.getTime(), new Date(2026, 9, 20, 9, 0).getTime()), '10-11 02:24');
  assert.equal(GF.formatStamp(d.getTime(), new Date(2027, 1, 1, 9, 0).getTime()), '2026-10-11 02:24');
});

test('title is the story summary when there is one, else the file name', () => {
  assert.equal(GF.titleOf(LIST[0]), 'a quiet evening in the living room');
  assert.equal(GF.titleOf(LIST[3]), 'plain.mp4');
});

test('indexAfterRemoval picks the neighbour to show after deleting from the viewer', () => {
  assert.equal(GF.indexAfterRemoval(5, 2), 2);
  assert.equal(GF.indexAfterRemoval(3, 2), 1);
  assert.equal(GF.indexAfterRemoval(1, 0), -1);
  assert.equal(GF.indexAfterRemoval(0, 0), -1);
});
