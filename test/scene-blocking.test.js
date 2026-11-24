const test = require('node:test');
const assert = require('node:assert/strict');
const { checkScene, buildScene } = require('../src/scene-model');
const B = require('../src/scene-blocking');
const { applyOps } = require('../src/scene-ai');

// A 10 × 8 room with a window along the whole south wall, a flag wall on the west and a table by the window.
const room = () => ({
  version: 1, name: '测试', levelHeight: 3,
  rooms: [{
    name: '大堂', lv: 0, x: [0, 10], z: [0, 8],
    openings: [{ name: '门', side: 'n', from: 4, to: 5, kind: 'door' }, { name: '南窗', side: 's', from: 0.5, to: 9.5, sill: 0.6, top: 2.6, kind: 'window' }],
    furniture: [
      { name: '旗墙', x: [0.12, 0.16], z: [1, 7], y: [0.5, 2.8], kind: 'flags' },
      { name: '桌子', x: [4, 6], z: [5.5, 6.5], h: 0.75 },
      { name: '桌子', x: [7, 9], z: [5.5, 6.5], h: 0.75 },
    ],
  }],
  setups: [{
    name: '窗边桌', room: '大堂', shots: ['E01-015', 'E01-017', 'E01-022'],
    people: [
      { name: '程建国', card: 'CJG45', by: '桌子#1', side: 'n', along: 0.3, pose: 'sit', facing: '王丽' },
      { name: '王丽', card: 'WL40', by: '桌子#1', side: 's', along: 0.3, pose: 'sit', facing: '程建国' },
      { name: '朵朵', card: 'DD8', by: '桌子#1', side: 's', along: 0.75, pose: 'sit' },
      { name: '阿措', card: 'AC23', by: '桌子#1', side: 'e', gap: 0.5, facing: '程建国' },
    ],
    cameras: [
      { name: '022 程建国身后', shots: ['E01-022'], at: { by: '程建国', side: 'behind', dist: 1, h: 1.4 }, look: ['王丽', '朵朵'], fov: 50 },
      { name: '017 阿措身后', shots: ['E01-017'], at: { by: '阿措', side: 'behind', dist: 0.8, h: 1.55 }, look: '程建国', fov: 40 },
      { name: '015 王丽过肩', shots: ['E01-015'], at: { by: '王丽', side: 'behind', dist: 0.6, h: 1.5 }, look: '程建国', fov: 45, expect: { face: ['程建国'], back: ['王丽'] } },
    ],
  }],
});

test('people are seated by a piece of furniture, the second of two same-named tables by #2, and face who they look at', () => {
  const s = room();
  s.setups[0].people[0].by = '桌子#2';
  const r = B.resolveSetup(s, s.setups[0]);
  const cheng = r.people.find((p) => p.name === '程建国');
  assert.equal(cheng.z, 5.5 - 0.35);
  assert.ok(Math.abs(cheng.x - (7 + 0.6)) < 1e-9);
  const wang = r.people.find((p) => p.name === '王丽');
  assert.ok(wang.facing[0] > 0.5, 'Wang Li looks east-north at the other table'); // she is at table 1, he moved to table 2
  const duo = r.people.find((p) => p.name === '朵朵');
  assert.deepEqual(duo.facing, [0, -1]); // no facing given: towards the table she sits by
});

test('from behind the father, the daughter (east of her mother) is on the left of the frame and the window is behind them', () => {
  const f = B.shotFacts(room(), 'MOTION-E01-022');
  const by = (n) => f.people.find((p) => p.name === n);
  assert.equal(by('程建国').face, '背影');
  assert.equal(by('王丽').face, '正脸');
  assert.ok(by('朵朵').sx < by('王丽').sx, 'east is screen-left when looking south');
  assert.ok(by('朵朵').behindWindow);
  const text = B.factsText(f);
  assert.match(text, /画面从左到右：[^\n]*朵朵[^\n]*王丽/);
  assert.match(text, /朝南看/);
});

test('looking north-west past Atso, the wall behind the father is the flag wall, not the window', () => {
  const f = B.shotFacts(room(), 'E01-017'.replace(/^/, 'MOTION-'));
  const cheng = f.people.find((p) => p.name === '程建国');
  assert.equal(cheng.behindWindow, false);
  assert.match(cheng.behind, /旗墙|墙/);
  assert.equal(f.people.find((p) => p.name === '阿措').face, '背影');
});

test('a camera that cannot give the framing it expects is named with what it does show', () => {
  const s = room();
  assert.deepEqual(B.expectProblems(B.shotFacts(s, 'MOTION-E01-015'), s.setups[0].cameras[2].expect), []);
  s.setups[0].cameras[2].at = { by: '程建国', side: 'behind', dist: 1, h: 1.4 };
  const problems = B.expectProblems(B.shotFacts(s, 'MOTION-E01-015'), s.setups[0].cameras[2].expect);
  assert.ok(problems.some((p) => /拍到程建国的脸/.test(p) && /背影/.test(p)));
  assert.ok(checkScene(s).some((p) => p.level === 'warn' && /拍到程建国的脸/.test(p.message)));
});

test('a setup that names a missing thing or leaves out a side is an error of the scene', () => {
  const s = room();
  s.setups[0].people[1] = { name: '王丽', by: '沙发', side: 's' };
  s.setups[0].people[2] = { name: '朵朵', by: '桌子', side: 'x' };
  const errs = checkScene(s).filter((p) => p.level === 'error').map((p) => p.message);
  assert.ok(errs.some((m) => /沙发/.test(m)));
  assert.ok(errs.some((m) => /side/.test(m)));
});

test('the prompt is held against the blocking: sides, faces, the window behind and a person missing from the pictures', () => {
  const facts = B.shotFacts(room(), 'MOTION-E01-022');
  const references = [{ order: 1, id: 'IMG-WL40', title: '王丽 角色板' }, { order: 2, id: 'IMG-YS-DT', title: '大堂' }];
  const prompt = [
    'subject_definitions:', '<Subject 1> is the woman in <Picture 1>.', '<Subject 2> is the lobby in <Picture 2>.',
    'summary:', 'x', 'shot_description:',
    '<Subject 1> sits on the left side of the frame, her back to the camera.',
    '<Subject 1> rests her hands on the table with the window behind her.',
  ].join('\n');
  const w = B.blockingWarnings({ prompt, facts, references });
  assert.ok(w.some((t) => /王丽在画面左边/.test(t)), w.join('\n'));
  assert.ok(w.some((t) => /背对镜头/.test(t)));
  assert.ok(!w.some((t) => /身后是窗/.test(t)), 'the window really is behind her');
  assert.ok(w.some((t) => /参考图里没有朵朵/.test(t)));
  assert.ok(!w.some((t) => /参考图里没有王丽/.test(t)));
});

test('turning toward a side of the frame is a direction, not where someone is', () => {
  const facts = B.shotFacts(room(), 'MOTION-E01-022');
  const references = [{ order: 1, id: 'IMG-WL40', title: '王丽 角色板', use: '身份' }];
  const says = (line) => B.blockingWarnings({ prompt: `subject_definitions:\n<Subject 1> is the woman in <Picture 1>.\nsummary:\n${line}`, facts, references });
  // Wang Li is right of centre here
  assert.ok(says('<Subject 1> sits at the left of the frame.').some((t) => /提示词里王丽在画面左边/.test(t)));
  assert.ok(!says('<Subject 1> looks toward the left of the frame.').some((t) => /提示词里王丽在画面左边/.test(t)));
  // both sides named in one sentence: which one is hers is not clear, so nothing is said
  assert.ok(!says('<Subject 1> sits at the left of the frame, and the teapot stands at the right of the frame.').some((t) => /提示词里王丽在画面左边/.test(t)));
});

test('the rewrite brief carries the facts; a shot outside every setup has none', () => {
  const s = room();
  assert.match(B.blockingBrief(B.shotFacts(s, 'MOTION-E01-022')), /以它为准[\s\S]*王丽：画面/);
  assert.equal(B.shotFacts(s, 'MOTION-E01-030'), null);
  assert.equal(B.blockingBrief(null), '');
});

test('a camera given a shot size works out its distance; over the right shoulder puts that person on the left of the frame', () => {
  const s = room();
  s.setups[0].cameras = [
    { name: 'a', shots: ['E01-015'], at: { by: '程建国', side: 'front', h: 1.2 }, look: '程建国', frame: '特写' },
    { name: 'b', shots: ['E01-017'], at: { by: '王丽', side: 'behind', shoulder: 'right', h: 1.4 }, look: '程建国', frame: '近景' },
    { name: 'c', shots: ['E01-022'], at: { by: '王丽', side: 'behind', shoulder: 'left', h: 1.4 }, look: '程建国', frame: '近景' },
  ];
  const close = B.shotFacts(s, 'MOTION-E01-015').people.find((p) => p.name === '程建国');
  assert.equal(close.size, '特写');
  const right = B.shotFacts(s, 'MOTION-E01-017');
  const left = B.shotFacts(s, 'MOTION-E01-022');
  assert.equal(right.people.find((p) => p.name === '程建国').size, '近景');
  assert.ok(!right.people.find((p) => p.name === '程建国').hiddenBy);
  assert.ok(right.people.find((p) => p.name === '王丽').sx < -0.3, 'her right shoulder: she is on screen-left');
  assert.ok(left.people.find((p) => p.name === '王丽').sx > 0.3, 'her left shoulder: she is on screen-right');
  // the camera stays in the room even when the lens wants it further back
  for (const f of [right, left]) assert.ok(f.camera.pos[2] < 8 - 0.2);
});

test('a chosen setup is drawn with its people and cameras; the AI can add one by name', () => {
  const s = room();
  const built = buildScene(s, { setup: '窗边桌' });
  assert.equal(built.people.length, 4);
  assert.ok(built.cameras.some((c) => c.name === '022 程建国身后' && c.setup === '窗边桌'));
  assert.equal(buildScene(s).people.length, 0);
  const { scene, failed } = applyOps({ ...s, setups: [] }, [{ op: 'add_setup', item: s.setups[0] }, { op: 'update_setup', name: '窗边桌', set: { shots: ['E01-022'] } }]);
  assert.deepEqual(failed, []);
  assert.deepEqual(scene.setups[0].shots, ['E01-022']);
});
