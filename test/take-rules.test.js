const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/take-rules');
const { createTakeStore } = require('../src/take-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WENWU = 'minimax-h3-wenwu-cont';
const HYBRID = 'minimax-h3-hybrid';
const NAMES = { [WENWU]: 'MiniMax H3 文武双全 · 参考图生视频 · 接续版', [HYBRID]: 'MiniMax H3 Hybrid · 参考图生视频' };
const shot = (n, extra = {}) => ({ id: `MOTION-E01-0${n}`, episode: 'E01', title: `镜${n}`, duration: null, source: 'script', ...extra });
const take = (id, extra = {}) => ({ id, n: 1, status: 'succeeded', tier: '', templateId: WENWU, context: `bb_${id}_1026-142233_`, video: `video/bb_${id}_00001_.mp4`, durationSec: null, continuedFrom: null, ...extra });
const states = (entries) => new Map(Object.entries(entries).map(([id, v]) => [id, Array.isArray(v) ? { takes: v, draft: null } : v]));

test('picking a second take demotes the first to cand', () => {
  const takes = [take('a', { tier: 'pick' }), take('b')];
  const out = R.applyTier(takes, 'b', 'pick');
  assert.deepEqual(out.map((t) => t.tier), ['cand', 'pick']);
  assert.equal(takes[0].tier, 'pick', 'input is not mutated');
});

test('clicking the same tier again clears it', () => {
  assert.equal(R.applyTier([take('a', { tier: 'cand' })], 'a', 'cand')[0].tier, '');
  assert.equal(R.applyTier([take('a', { tier: 'pick' })], 'a', 'pick')[0].tier, '');
});

test('pickOf ignores picks that did not succeed', () => {
  assert.equal(R.pickOf([take('a', { tier: 'pick', status: 'failed' })]), null);
  assert.equal(R.pickOf([take('a'), take('b', { tier: 'pick' })]).id, 'b');
});

test('manual shot goes after its anchor, then to the end', () => {
  const script = [shot(3), shot(1), shot(2)];
  const manual = [
    { id: 'HAND-E01-2', episode: 'E01', title: 'y', after: 'MOTION-E01-01', createdAt: 20 },
    { id: 'HAND-E01-1', episode: 'E01', title: 'x', after: 'MOTION-E01-01', createdAt: 10 },
    { id: 'HAND-E01-3', episode: 'E01', title: 'z', after: null, createdAt: 30 },
    { id: 'HAND-E01-4', episode: 'E01', title: 'w', after: 'MOTION-E01-99', createdAt: 40 },
  ];
  assert.deepEqual(R.orderEpisode(script, manual).map((s) => s.id),
    ['MOTION-E01-01', 'HAND-E01-1', 'HAND-E01-2', 'MOTION-E01-02', 'MOTION-E01-03', 'HAND-E01-3', 'HAND-E01-4']);
});

test('a hand-made shot put before or after a shot lands right next to it, replayed in the order they were made', () => {
  const script = [shot(3), shot(1), shot(2)];
  const at = (id, anchor, place, createdAt) => ({ id, episode: 'E01', title: id, after: null, anchor, place, createdAt });
  const manual = [
    { id: 'HAND-E01-1', episode: 'E01', title: 'old', after: 'MOTION-E01-01', createdAt: 10 }, // the older kind
    at('HAND-E01-2', 'MOTION-E01-01', 'after', 20), // right after 01, in front of the older one
    at('HAND-E01-3', 'MOTION-E01-02', 'before', 30),
    at('HAND-E01-4', 'MOTION-E01-01', 'before', 40), // the new first shot
    at('HAND-E01-5', 'HAND-E01-2', 'after', 50), // next to a hand-made one
    at('HAND-E01-6', 'MOTION-E01-09', 'after', 60), // its shot is gone: to the end
    at('HAND-E01-7', 'HAND-E01-6', 'after', 70), // next to one at the end
    at('HAND-E01-8', 'HAND-E01-6', 'before', 80),
  ];
  const order = R.orderEpisode(script, manual).map((s) => s.id);
  assert.deepEqual(order, ['HAND-E01-4', 'MOTION-E01-01', 'HAND-E01-2', 'HAND-E01-5', 'HAND-E01-1', 'HAND-E01-3', 'MOTION-E01-02', 'MOTION-E01-03',
    'HAND-E01-8', 'HAND-E01-6', 'HAND-E01-7']);
  assert.deepEqual(order.filter((id) => id.startsWith('MOTION')), ['MOTION-E01-01', 'MOTION-E01-02', 'MOTION-E01-03'], 'the script order is kept');
  // the file order decides between shots made in the same millisecond
  const same = [at('HAND-E01-1', 'MOTION-E01-02', 'before', 5), at('HAND-E01-2', 'MOTION-E01-02', 'before', 5)];
  assert.deepEqual(R.orderEpisode(script, same).map((s) => s.id), ['MOTION-E01-01', 'HAND-E01-1', 'HAND-E01-2', 'MOTION-E01-02', 'MOTION-E01-03']);
});

test('shot numbers for messages', () => {
  assert.equal(R.shotNo('MOTION-E01-05'), '05');
  assert.equal(R.shotNo('HAND-E01-1'), '手动1');
});

const order = [shot(1), shot(2), shot(3), shot(4)];
const resolve = (st, shotId, choice, templateId = WENWU) => R.resolveContinuation({ order, states: st, shotId, choice, templateId, templateNames: NAMES });

test('none means no continuation', () => {
  assert.deepEqual(resolve(states({}), 'MOTION-E01-02', { mode: 'none' }), { ok: true, enabled: false });
});

test('previous on first shot is refused', () => {
  assert.deepEqual(resolve(states({}), 'MOTION-E01-01', { mode: 'previous' }), { ok: false, message: '这是本集第一镜，没有上一镜可接' });
});

test("previous resolves to the pick's context jpg", () => {
  const st = states({ 'MOTION-E01-04': [take('e01-04-t002-a1b2', { tier: 'pick', context: 'bb_e01-04-t002-a1b2_1026-142233_' })] });
  const order5 = [...order, shot(5)];
  const r = R.resolveContinuation({ order: order5, states: st, shotId: 'MOTION-E01-05', choice: { mode: 'previous' }, templateId: WENWU, templateNames: NAMES });
  assert.deepEqual(r, { ok: true, enabled: true, clip: 'h3_context/bb_e01-04-t002-a1b2_1026-142233_.jpg [output]', from: { shotId: 'MOTION-E01-04', takeId: 'e01-04-t002-a1b2' } });
});

test('a chosen other shot resolves the same way', () => {
  const st = states({ 'MOTION-E01-01': [take('p1', { tier: 'pick' })] });
  const r = resolve(st, 'MOTION-E01-03', { mode: 'shot', shotId: 'MOTION-E01-01' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.from, { shotId: 'MOTION-E01-01', takeId: 'p1' });
});

test('cross-template continuation is refused with names', () => {
  const st = states({ 'MOTION-E01-04': [take('h', { tier: 'pick', templateId: HYBRID })] });
  const r = R.resolveContinuation({ order: [...order, shot(5)], states: st, shotId: 'MOTION-E01-05', choice: { mode: 'previous' }, templateId: WENWU, templateNames: NAMES });
  assert.deepEqual(r, { ok: false, message: '镜头 04 是用 MiniMax H3 Hybrid · 参考图生视频 生成的，当前模板接不了' });
});

test('no pick in source is refused', () => {
  const st = states({ 'MOTION-E01-01': [take('c', { tier: 'cand' })] });
  assert.deepEqual(resolve(st, 'MOTION-E01-02', { mode: 'previous' }), { ok: false, message: '镜头 01 还没有选中，先去选一条' });
});

test('a pick without a continuation file is refused', () => {
  const st = states({ 'MOTION-E01-01': [take('c', { tier: 'pick', context: null })] });
  assert.deepEqual(resolve(st, 'MOTION-E01-02', { mode: 'previous' }), { ok: false, message: '镜头 01 的选中没有接续文件，换一条带接续的模板重新生成' });
});

test('legacy shot resolves to clip_1-4', () => {
  assert.deepEqual(resolve(states({}), 'MOTION-E01-02', { mode: 'legacy', legacyShot: '1-4' }),
    { ok: true, enabled: true, clip: 'h3_context/clip_1-4.jpg [output]', from: { legacy: '1-4' } });
});

test('stale propagates down the chain', () => {
  const st = states({
    'MOTION-E01-01': [take('s1a', { tier: 'cand' }), take('s1b', { tier: 'pick' })],
    'MOTION-E01-02': [take('s2', { tier: 'pick', continuedFrom: { shotId: 'MOTION-E01-01', takeId: 's1a' } })],
    'MOTION-E01-03': [take('s3', { tier: 'pick', continuedFrom: { shotId: 'MOTION-E01-02', takeId: 's2' } })],
    'MOTION-E01-04': [take('s4', { continuedFrom: { shotId: 'MOTION-E01-03', takeId: 's3' } }), take('s4b')],
  });
  const stale = R.staleness({ order, states: st });
  assert.equal(stale.get('s2'), 'prev-changed');
  assert.equal(stale.get('s3'), 'upstream-changed');
  assert.equal(stale.get('s4'), 'upstream-changed');
  assert.equal(stale.get('s4b'), '');
  assert.equal(stale.get('s1b'), '');
});

test('a take continued from a legacy clip is never stale', () => {
  const st = states({ 'MOTION-E01-01': [take('x', { continuedFrom: { legacy: '1-4' } })] });
  assert.equal(R.staleness({ order, states: st }).get('x'), '');
});

test('dependents lists live takes built on a take', () => {
  const st = states({
    'MOTION-E01-02': [take('d1', { continuedFrom: { shotId: 'MOTION-E01-01', takeId: 'src' } }), take('d2', { tier: 'trash', continuedFrom: { shotId: 'MOTION-E01-01', takeId: 'src' } })],
    'MOTION-E01-03': [take('d3', { continuedFrom: { shotId: 'MOTION-E01-01', takeId: 'src' } })],
  });
  assert.deepEqual(R.dependents(st, 'src'), [{ shotId: 'MOTION-E01-02', takeId: 'd1' }, { shotId: 'MOTION-E01-03', takeId: 'd3' }]);
});

test('timeline durations fall back pick > draft > script > 5', () => {
  const st = states({
    'MOTION-E01-01': [take('a', { tier: 'pick', durationSec: 4.2 })],
    'MOTION-E01-02': { takes: [], draft: { values: { duration: 6 } } },
  });
  const tl = R.timeline({ order: [shot(1), shot(2), shot(3, { duration: 5.9 }), shot(4)], states: st, gapMode: 'black' });
  assert.deepEqual(tl.segments.map((s) => s.duration), [4.2, 6, 5.9, 5]);
  assert.deepEqual(tl.segments.map((s) => s.start), [0, 4.2, 10.2, 16.1]);
  assert.equal(Math.round(tl.total * 10) / 10, 21.1);
  assert.equal(tl.segments[0].kind, 'pick');
  assert.equal(tl.segments[0].video, 'video/bb_a_00001_.mp4');
});

test('gap modes black / cand / skip', () => {
  const st = states({
    'MOTION-E01-01': [take('a', { tier: 'pick', durationSec: 4 })],
    'MOTION-E01-02': [take('c1', { tier: 'cand', n: 1, durationSec: 3 }), take('c2', { tier: 'cand', n: 2, durationSec: 5 })],
  });
  const o = [shot(1), shot(2), shot(3)];
  const black = R.timeline({ order: o, states: st, gapMode: 'black' });
  assert.deepEqual(black.segments.map((s) => s.kind), ['pick', 'gap', 'gap']);
  assert.equal(black.segments[1].hasCand, true);
  const cand = R.timeline({ order: o, states: st, gapMode: 'cand' });
  assert.deepEqual(cand.segments.map((s) => [s.kind, s.takeId]), [['pick', 'a'], ['cand', 'c2'], ['gap', null]]);
  assert.equal(cand.segments[1].duration, 5);
  const skip = R.timeline({ order: o, states: st, gapMode: 'skip' });
  assert.deepEqual(skip.segments.map((s) => s.shotId), ['MOTION-E01-01']);
  assert.equal(skip.total, 4);
});

test('timeline carries the stale mark of the take it shows', () => {
  const st = states({
    'MOTION-E01-01': [take('a1', { tier: 'cand' }), take('a2', { tier: 'pick' })],
    'MOTION-E01-02': [take('b', { tier: 'pick', continuedFrom: { shotId: 'MOTION-E01-01', takeId: 'a1' } })],
  });
  const tl = R.timeline({ order: [shot(1), shot(2)], states: st, gapMode: 'black' });
  assert.deepEqual(tl.segments.map((s) => s.stale), ['', 'prev-changed']);
});

test('timeline marks a pick continued from the previous pick as linked', () => {
  const st = states({
    'MOTION-E01-01': [take('a', { tier: 'pick' })],
    'MOTION-E01-02': [take('b', { tier: 'pick', continuedFrom: { shotId: 'MOTION-E01-01', takeId: 'a' } })],
    'MOTION-E01-03': [take('c', { tier: 'pick', continuedFrom: { shotId: 'MOTION-E01-01', takeId: 'a' } })],
  });
  const tl = R.timeline({ order: [shot(1), shot(2), shot(3)], states: st, gapMode: 'black' });
  assert.deepEqual(tl.segments.map((s) => s.linked), [false, true, false]);
});

test('shot status', () => {
  assert.equal(R.shotStatus([]), 'none');
  assert.equal(R.shotStatus([take('a', { tier: 'cand' })]), 'cand');
  assert.equal(R.shotStatus([take('a', { tier: 'cand' }), take('b', { tier: 'pick' })]), 'pick');
  assert.equal(R.shotStatus([take('a', { tier: 'pick' }), take('q', { status: 'queued' })]), 'running');
});

test('locate maps time to segment and offset', () => {
  const segments = [{ start: 0, duration: 4 }, { start: 4, duration: 5 }, { start: 9, duration: 4.5 }];
  assert.deepEqual(R.locate(segments, 0), { index: 0, offset: 0 });
  assert.deepEqual(R.locate(segments, 4), { index: 1, offset: 0 });
  assert.deepEqual(R.locate(segments, 8.99), { index: 1, offset: 4.99 });
  assert.deepEqual(R.locate(segments, 13.5), { index: 2, offset: 4.5 });
  assert.deepEqual(R.locate(segments, 99), { index: 2, offset: 4.5 });
  assert.deepEqual(R.locate(segments, -1), { index: 0, offset: 0 });
  assert.equal(R.locate([], 3), null);
});

test('takeKey is ASCII', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'take-key-')), '宣传视频');
  fs.mkdirSync(dir);
  const store = createTakeStore(dir);
  for (const id of ['MOTION-E01-05', 'HAND-E01-1']) assert.match(store.addTake(id, {}).outputKey, /^bb_[a-z0-9-]+$/);
});
