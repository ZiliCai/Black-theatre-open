const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShots, castGaps } = require('../src/script-shots');

const shot = (n, cont, refs) => [`## MOTION-E01-${n} · 镜${n}`, `- 时长：6.6s`, `- 接续上一镜：${cont}`, '- 输入参考图：',
  ...refs.map(([code, title, use], i) => `  - PLAN-${code}（顺序：${i + 1}）· IMG-${code}《${title}》（用途：${use}）`), ''].join('\n');

test('a continuing shot that drops someone the shot before had is named, with who is missing', () => {
  const doc = [
    shot('022', '否', [['WL40', '王丽 角色板', '身份'], ['DD8', '朵朵 角色板', '身份'], ['YS-DT', '大堂', '场景']]),
    shot('023', '是（接 022）', [['AC23', '阿措 角色板', '身份'], ['DD8', '朵朵 角色板', '身份']]),
    shot('024', '否', [['AC23', '阿措 角色板', '身份']]),
    shot('025', '是（接 023）', [['AC23', '阿措 角色板', '身份'], ['DD8', '朵朵 角色板', '身份']]),
  ].join('\n');
  const shots = parseShots(doc, 'x.md');
  assert.equal(shots[0].references[2].use, '场景');
  assert.deepEqual(castGaps(shots), [{ id: 'MOTION-E01-023', from: 'MOTION-E01-022', missing: ['王丽 角色板'] }]);
});

test('a picture number in the prompt that points at the wrong kind of reference is named', () => {
  const { pictureMismatches } = require('../src/script-shots');
  const refs = [['AC23', '阿措 角色板', '身份'], ['WL40', '王丽 角色板', '身份'], ['YS-DT', '大堂 场景板', '地理']];
  const prompt = (defs) => ['### 可复制提示词', '> subject_definitions:', ...defs.map((d) => `> ${d}`), '>', '> summary:', '> s'].join('\n');
  const shotOf = (defs) => parseShots(`${shot('023', '否', refs)}\n${prompt(defs)}\n`, 'x.md')[0];
  const ok = shotOf(['<Subject 1> is the 23-year-old woman in <Picture 1>.', '<Subject 2> is Wang Li, the mother, in <Picture 2>.', '<Subject 3> is the window table area of the hotel lobby in <Picture 3>.']);
  assert.deepEqual(pictureMismatches(ok), []);
  const swapped = shotOf(['<Subject 1> is the 23-year-old woman in <Picture 1>.', '<Subject 2> is the window table area of the hotel lobby in <Picture 2>.', '<Subject 3> is Wang Li, the mother, in <Picture 3>.', '<Subject 4> is a dog in <Picture 4>.']);
  assert.deepEqual(pictureMismatches(swapped), [
    { subject: 2, picture: 2, says: '地点', title: '王丽 角色板' },
    { subject: 3, picture: 3, says: '人物', title: '大堂 场景板' },
    { subject: 4, picture: 4, says: '', title: '' },
  ]);
});
