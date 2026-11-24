const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/scene-model');
const A = require('../src/scene-ai');
const HOTEL = require('./fixtures/scene-hotel.json');

const two = () => ({
  ...M.emptyScene('小屋'), levelHeight: 3,
  rooms: [
    { name: '客厅', lv: 0, x: [0, 5], z: [0, 4], openings: [{ name: '门', side: 'e', from: 1, to: 2, kind: 'door' }, { name: '大门', side: 'n', from: 2, to: 3, kind: 'door' }], furniture: [{ name: '沙发', x: [0.2, 2.2], z: [-1, -0.1], h: 0.8, kind: 'soft' }] },
    { name: '卧室', lv: 0, x: [5, 9], z: [0, 4], furniture: [{ name: '床', x: [0.1, 1.6], z: [0.1, 2.1], h: 0.5, kind: 'bed' }] },
  ],
});
const errors = (s) => M.checkScene(s).filter((p) => p.level === 'error');

test('a door cuts the wall it sits on, in both rooms that share it; a negative number counts from the far side', () => {
  const b = M.buildScene(two());
  // the shared wall x = 5, cut between z 1 and 2 on both sides
  const shared = b.boxes.filter((x) => x.wall && (Math.abs(x.x0 - 4.9) < 0.01 || Math.abs(x.x0 - 5) < 0.01));
  assert.ok(shared.length >= 4);
  for (const w of shared) assert.ok(w.z1 <= 1.001 || w.z0 >= 1.999 || w.y0 >= 2.099, `wall piece in the doorway: ${JSON.stringify(w)}`);
  const sofa = b.boxes.find((x) => x.name === '沙发');
  assert.deepEqual([sofa.z0, sofa.z1].map((v) => Math.round(v * 100) / 100), [3, 3.9]);
  assert.ok(b.boxes.some((x) => x.kind === 'roof'), 'a one-storey room gets a ceiling');
  assert.deepEqual(M.wallPieces(4, 3, [{ a: 1, b: 2, sill: 0.9, top: 2.2 }]).map((p) => [p.a, p.b, p.y0, p.y1]),
    [[0, 1, 0, 3], [1, 2, 0, 0.9], [1, 2, 2.2, 3], [2, 4, 0, 3]]);
});

test('the hotel builds and checks out, apart from the two sightlines the script still has to settle', () => {
  const b = M.buildScene(HOTEL);
  assert.equal(b.levels, 4);
  assert.ok(b.boxes.length > 500);
  assert.ok(b.boxes.some((x) => x.name === '205 程家 床（床头靠西墙）'), 'template furniture is named after its room');
  // the stairwell's stairs are stacked floor on floor, so each turns at a landing: two flights of ten and the landing
  assert.equal(b.boxes.filter((x) => x.name === '楼梯').length, 21 * 3);
  const problems = M.checkScene(HOTEL);
  assert.deepEqual(problems.filter((p) => p.level === 'error'), []);
  assert.deepEqual(problems.map((p) => p.where), ['机位「何遇探身往上看屋顶上的阿措」', '机位「阿措在屋顶探身往下看何遇的窗」']);
  assert.match(problems[0].message, /看不到「阿措」，被一面墙挡住了/);
});

test('mistakes a model makes are named in words it can act on', () => {
  const s = two();
  s.rooms[1].furniture.push({ name: '衣柜', x: [1.0, 1.6], z: [1.5, 2.5], h: 1.8 }); // into the bed
  s.rooms[1].furniture.push({ name: '书桌', x: [3.5, 4.5], z: [1, 2], h: 0.75 }); // through the east wall
  s.rooms[0].furniture.push({ name: '柜子', x: [-0.6, -0.1], z: [0.9, 2.1], h: 1.8 }); // in front of the door
  s.rooms.push({ name: '厨房', lv: 0, x: [8, 12], z: [0, 4] }); // on top of the bedroom
  s.rooms.push({ name: '客房', lv: 0, x: [0, 4], z: [4, 8], tpl: '标准间' });
  s.cameras.push({ name: '墙里', pos: [4.95, 1.5, 0.5], target: [0, 1, 0] });
  const text = M.checkScene(s).map((p) => `${p.level} ${p.where} ${p.message}`).join('\n');
  assert.match(text, /error 房间「卧室」的「衣柜」 和「床」叠在一起了/);
  assert.match(text, /error 房间「卧室」的「书桌」 出了房间：房间是 4×4 米/);
  assert.match(text, /warn 房间「客厅」的「门」 「柜子」挡在门口/);
  assert.match(text, /error 房间「卧室」和「厨房」 在一楼占了同一块地方/);
  assert.match(text, /error 房间「客房」 用了模板「标准间」，可是 templates 里没有它/);
  assert.match(text, /error 机位「墙里」 相机在一面墙里面/);
  assert.doesNotMatch(text, /「卧室」 没有门/, 'the bedroom is reached through the living room door');
});

test('named operations change a copy; a template item changed in one room is copied into it first', () => {
  const r = A.applyOps(HOTEL, [
    { op: 'update_furniture', room: '何遇', name: '何遇的床', set: { z: [3.2, 5.2] } },
    { op: 'update_furniture', room: '205 程家', name: '扶手椅', set: { kind: 'wood' } },
    { op: 'remove_furniture', room: '205 程家', name: '卫生间' },
    { op: 'add_person', item: { name: '多吉', lv: 0, x: 19, z: 3 } },
    { op: 'update_room', name: '何遇', set: { name: '何遇的宿舍' } },
    { op: 'remove_room', name: '不存在' },
  ]);
  assert.deepEqual(r.done.length, 4);
  assert.deepEqual(r.failed.map((f) => f.message), ['这是模板里的东西，单独一间去不掉；要整排都去掉，改模板（set_template）', '没有叫「不存在」的房间']);
  assert.deepEqual(r.scene.rooms.find((x) => x.name === '何遇的宿舍').furniture.find((f) => f.name === '何遇的床').z, [3.2, 5.2]);
  assert.equal(r.scene.rooms.find((x) => x.name === '205 程家').furniture.find((f) => f.name === '扶手椅').kind, 'wood');
  assert.equal(HOTEL.rooms.find((x) => x.name === '何遇').furniture.find((f) => f.name === '何遇的床').z[0], 3.3, 'the original is untouched');
  assert.deepEqual(A.parseJson('好的：\n```json\n{"ops": [1, 2,],}\n```'), { ops: [1, 2] });
});

test('a change that breaks the scene goes back to the model with the problem, and the fixed one is kept', async () => {
  const asked = [];
  const replies = [
    { note: '床挪到东边', ops: [{ op: 'update_furniture', room: '卧室', name: '床', set: { x: [3, 4.5] } }] },
    { note: '床挪到东边', ops: [{ op: 'update_furniture', room: '卧室', name: '床', set: { x: [2.4, 3.9] } }] },
  ];
  const r = await A.editScene({ scene: two(), remark: '床靠东墙', llm: async (m) => { asked.push(m); return JSON.stringify(replies.shift()); } });
  assert.equal(r.ok, true);
  assert.equal(r.tries, 2);
  assert.match(asked[1].user, /改完以后 房间「卧室」的「床」：出了房间/);
  assert.equal(asked[1].history.length, 2, 'the model sees its own first answer');
  assert.deepEqual(r.scene.rooms[1].furniture[0].x, [2.4, 3.9]);
  assert.deepEqual(r.added, []);
  assert.match(asked[0].system, /负数表示从另一头往回量/);
});

test('building from documents: layout, a template, then one call per floor', async () => {
  const calls = [];
  const llm = async (m) => {
    calls.push(m.user.slice(0, 40));
    if (/按文档搭/.test(m.user)) {
      return JSON.stringify({ levelHeight: 3, rooms: [
        { name: '走廊', lv: 0, x: [0, 8], z: [0, 1.5] },
        { name: '一号房', lv: 0, x: [0, 4], z: [1.5, 6], tpl: '客房' },
        { name: '二号房', lv: 0, x: [4, 8], z: [1.5, 6], tpl: '客房' },
      ], cameras: [] });
    }
    if (/模板「客房」/.test(m.user)) {
      return JSON.stringify({ openings: [{ name: '房门', side: 'n', from: 0.3, to: 1.2, kind: 'door' }], furniture: [{ name: '床', x: [0.1, 1.6], z: [-2.1, -0.1], h: 0.5, kind: 'bed' }] });
    }
    return JSON.stringify({ rooms: { 走廊: { openings: [{ name: '大门', side: 'w', from: 0.3, to: 1.2, kind: 'door' }], furniture: [] } } });
  };
  const steps = [];
  const r = await A.buildFromDocs({ name: '小旅馆', docs: [{ relPath: 'a.md', content: '一条走廊两间客房' }], llm, onProgress: (p) => steps.push(p.step) });
  assert.equal(r.ok, true);
  assert.deepEqual(steps, ['layout', 'template', 'level', 'done']);
  assert.equal(calls.length, 3);
  assert.deepEqual(r.problems.filter((p) => p.level === 'error'), []);
  assert.ok(M.buildScene(r.scene).boxes.some((b) => b.name === '二号房 床'));
});

test('a build opens every call with the same documents, and furnishing a room, a floor or a template with one system prompt', async () => {
  const systems = [];
  const llm = async (m) => {
    systems.push(m.system);
    if (/按文档搭/.test(m.user)) {
      return JSON.stringify({ levelHeight: 3, rooms: [
        { name: '走廊', lv: 0, x: [0, 8], z: [0, 1.5] },
        { name: '一号房', lv: 0, x: [0, 4], z: [1.5, 6], tpl: '客房' },
        { name: '二号房', lv: 0, x: [4, 8], z: [1.5, 6], tpl: '客房' },
      ], cameras: [] });
    }
    if (/模板「客房」/.test(m.user)) {
      assert.match(m.user, /只输出 JSON：\{ "openings"/);
      return JSON.stringify({ openings: [{ name: '房门', side: 'n', from: 0.3, to: 1.2, kind: 'door' }], furniture: [{ name: '床', x: [0.1, 1.6], z: [-2.1, -0.1], h: 0.5, kind: 'bed' }] });
    }
    assert.match(m.user, /只输出 JSON：\{ "rooms"/);
    return JSON.stringify({ rooms: { 走廊: { openings: [{ name: '大门', side: 'w', from: 0.3, to: 1.2, kind: 'door' }], furniture: [] } } });
  };
  const docs = [{ relPath: 'a.md', content: '一条走廊两间客房' }];
  assert.equal((await A.buildFromDocs({ name: '小旅馆', docs, llm })).ok, true);
  const opening = '下面是剧本里的设定文档，后面的任务按它们来：\n\n<doc path="a.md">\n一条走廊两间客房\n</doc>\n\n';
  assert.equal(systems.length, 3);
  for (const s of systems) assert.ok(s.startsWith(opening));
  assert.equal(systems[1], systems[2], 'the template and the floor share the whole system prompt');
  await A.furnishRoom({ scene: two(), roomName: '卧室', docs, llm: async (m) => { systems.push(m.system); return JSON.stringify({ openings: [], furniture: [] }); } });
  assert.equal(systems[3], systems[1]);
});

test('stacked stairs turn at a landing and arrive above where they start; the floor above is open over them', () => {
  const stair = { name: '楼梯', shape: 'stairs', x: [0, 3], z: [0, 6], h: 3, dir: 's' };
  const s = {
    ...M.emptyScene('楼'), levelHeight: 3,
    rooms: [0, 1].map((lv) => ({ name: `${lv + 1}楼楼梯间`, lv, x: [0, 3], z: [0, 6], furniture: [{ ...stair }] })),
  };
  const b = M.buildScene(s);
  const [low] = b.plan.stairs;
  assert.equal(low.flights.length, 2);
  const [up, back] = low.flights;
  assert.deepEqual([up.dir, back.dir], ['s', 'n']);
  assert.deepEqual([up.x0, up.x1, back.x0, back.x1], [0, 1.5, 1.5, 3]); // side by side across the stairwell
  assert.equal(up.y1, back.y0); // the landing is half way up
  assert.ok(low.landing.z0 >= up.z1 - 0.001 && Math.abs(low.landing.z1 - 6) < 0.001, 'the landing is at the far (south) end');
  // the second flight tops out at the north end: where the same stair on the floor above starts
  const topStep = b.boxes.filter((x) => x.name === '楼梯' && x.group === 0 && x.x0 >= 1.5).sort((p, q) => q.y1 - p.y1)[0];
  assert.ok(topStep.z0 < 1, `the last step is at the north end: ${JSON.stringify(topStep)}`);
  // the upper floor has a hole over the stair, the ground floor none
  const upper = b.boxes.filter((x) => x.floor && x.group === 1);
  assert.equal(upper.length, 0, 'a stairwell as big as the room leaves nothing of the floor above');
  assert.equal(b.boxes.filter((x) => x.floor && x.group === 0).length, 1);
  // a single stair, or one that says turn: false, stays one straight flight
  const single = M.buildScene({ ...s, rooms: [s.rooms[0]] });
  assert.equal(single.plan.stairs[0].flights.length, 1);
  const straight = M.buildScene({ ...s, rooms: s.rooms.map((r) => ({ ...r, furniture: [{ ...stair, turn: false }] })) });
  assert.equal(straight.plan.stairs[0].flights.length, 1);
});

test('an outside wall is thickened outwards; a wall between two rooms is not', () => {
  const b = M.buildScene(two());
  const west = b.boxes.filter((x) => x.wall && x.room === '客厅' && x.x0 < 0.05 && x.z1 - x.z0 > 1);
  assert.ok(west.length && west.every((w) => Math.abs(w.x0 + 0.15) < 0.001 && Math.abs(w.x1 - 0.1) < 0.001), JSON.stringify(west));
  const shared = b.boxes.filter((x) => x.wall && x.room === '客厅' && x.x1 > 4.95 && x.x0 > 4.8);
  assert.ok(shared.length && shared.every((w) => Math.abs(w.x1 - 5) < 0.001), JSON.stringify(shared));
  // the rooms' insides are where they were: the sofa still sits against the south wall
  assert.deepEqual(M.checkScene(two()).filter((p) => p.level === 'error'), []);
});
