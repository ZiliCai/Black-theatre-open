const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseShots, listScriptShots, importScriptShot, reviseScriptShotPrompt } = require('../src/script-shots');

const MOTION = `## MOTION-EP001-001 · 洞底·等
- 分镜：SHOT-EP001-001
- 时长：4.5s
- 接续上一镜：否（冷开场）
- 输入参考图：
  - PLAN-HZ30（顺序：1）· IMG-HZ30《何舟（30岁）角色板》（用途：身份）
  - PLAN-DK-J25（顺序：2）· IMG-DK-J25《2025年洞底夜景板》（用途：地理）

### 可复制提示词
> subject_definitions:
> <Subject 1> is the woman in <Picture 1>.
>
> summary:
> [reference generation] She waits.
>
> retention_analysis:
> fully_preserved
>
> detailed_description:
> She checks her watch.
>
> overall_soundscape:
> Water drips.
>
> non_diegetic_music:
> N/A
`;

function fixture(t, { single = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-shots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const docsDir = path.join(root, '剧本');
  const projectDir = root;
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(path.join(docsDir, '提示词'), { recursive: true });
  fs.mkdirSync(path.join(docsDir, '剧集', 'EP001'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ref'), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  if (single) fs.writeFileSync(path.join(docsDir, '提示词', 'MOTION-EP001-001.md'), MOTION);
  fs.writeFileSync(path.join(docsDir, '剧集', 'EP001', '视频提示词.md'), MOTION.replace('She waits.', 'Duplicate version.'));
  fs.writeFileSync(path.join(docsDir, 'short-drama.json'), JSON.stringify({ format: { aspect_ratio: '9:16' } }));
  fs.writeFileSync(path.join(outputDir, 'HZ30_全身.png'), 'character');
  fs.writeFileSync(path.join(outputDir, 'DK_J25_岔口_夜.png'), 'wrong-scene');
  fs.writeFileSync(path.join(root, 'ref', 'DK_J25_洞底_夜.png'), 'right-scene');
  return { root, docsDir, projectDir, outputDir };
}

test('parses motion prompt, duration and ordered reference ids', () => {
  const shots = parseShots(MOTION, '提示词/MOTION-EP001-001.md');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].duration, 4.5);
  assert.equal(shots[0].continuePrevious, false);
  assert.deepEqual(shots[0].references.map((r) => r.id), ['IMG-HZ30', 'IMG-DK-J25']);
  assert.match(shots[0].prompt, /subject_definitions:[\s\S]*non_diegetic_music:\nN\/A$/);
  assert.doesNotMatch(shots[0].prompt, /^>/m);
  assert.equal(shots[0].continueFrom, '');
});

test('a continuation that names a shot continues from that shot of the same episode', () => {
  const named = parseShots(MOTION.replace('- 接续上一镜：否（冷开场）', '- 接续上一镜：是（接 3：同一扇窗）'), 'MOTION-EP001-001.md');
  assert.equal(named[0].continuePrevious, true);
  assert.equal(named[0].continueFrom, 'MOTION-EP001-003');
  const plain = parseShots(MOTION.replace('- 接续上一镜：否（冷开场）', '- 接续上一镜：是（他接着往下走）'), 'MOTION-EP001-001.md');
  assert.equal(plain[0].continueFrom, '');
  const off = parseShots(MOTION.replace('- 接续上一镜：否（冷开场）', '- 接续上一镜：否（不接 003）'), 'MOTION-EP001-001.md');
  assert.equal(off[0].continueFrom, '');
});

test('lists preferred single-shot documents and imports matching assets without overwriting', (t) => {
  const dirs = fixture(t);
  const listed = listScriptShots(dirs);
  assert.equal(listed.ok, true);
  assert.equal(listed.shots.length, 1);
  assert.equal(listed.shots[0].source, '提示词/MOTION-EP001-001.md');
  assert.equal(listed.aspectRatio, '9:16');

  const imported = importScriptShot({ ...dirs, shotId: 'MOTION-EP001-001' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.values.duration, 4.5);
  assert.equal(imported.values.aspect, '9:16');
  assert.deepEqual(imported.values.references, ['HZ30_全身.png [output]', 'ref/DK_J25_洞底_夜.png [output]']);
  assert.deepEqual(imported.copied, ['ref/DK_J25_洞底_夜.png']);
  assert.equal(fs.readFileSync(path.join(dirs.outputDir, 'ref', 'DK_J25_洞底_夜.png'), 'utf8'), 'right-scene');

  fs.writeFileSync(path.join(dirs.outputDir, 'ref', 'DK_J25_洞底_夜.png'), 'keep-existing');
  fs.writeFileSync(path.join(dirs.projectDir, 'ref', 'DK_J25_洞底_夜.png'), 'new-source');
  const again = importScriptShot({ ...dirs, shotId: 'MOTION-EP001-001' });
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(path.join(dirs.outputDir, 'ref', 'DK_J25_洞底_夜.png'), 'utf8'), 'keep-existing');
});

test('revises only the selected prompt block, keeps history and refuses stale content', (t) => {
  const dirs = fixture(t);
  const relPath = '提示词/MOTION-EP001-001.md';
  const source = path.join(dirs.docsDir, relPath);
  const second = MOTION.replace(/MOTION-EP001-001/g, 'MOTION-EP001-002').replace(/SHOT-EP001-001/g, 'SHOT-EP001-002').replace('She waits.', 'Second shot stays.');
  fs.writeFileSync(source, `${MOTION}\n${second}`);
  const combined = path.join(dirs.docsDir, '剧集', 'EP001', '视频提示词.md');
  const combinedBefore = fs.readFileSync(combined, 'utf8');
  const original = parseShots(MOTION, relPath)[0].prompt;
  const revised = original.replace('She waits.', 'She never turns around.');
  const result = reviseScriptShotPrompt({ docsDir: dirs.docsDir, shotId: 'MOTION-EP001-001', expectedPrompt: original, prompt: revised });
  assert.equal(result.ok, true, JSON.stringify(result));

  const text = fs.readFileSync(source, 'utf8');
  assert.match(text, /She never turns around\./);
  assert.match(text, /- 时长：4\.5s/);
  assert.match(text, /PLAN-HZ30/);
  assert.match(text, /Second shot stays\./);
  assert.equal(fs.readFileSync(combined, 'utf8'), combinedBefore);
  const history = fs.readdirSync(path.join(dirs.docsDir, '.history', '提示词', 'MOTION-EP001-001'));
  assert.equal(history.length, 1);

  const conflict = reviseScriptShotPrompt({ docsDir: dirs.docsDir, shotId: 'MOTION-EP001-001', expectedPrompt: original, prompt: 'stale rewrite' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
});

test('refuses to rewrite a combined generated prompt document', (t) => {
  const dirs = fixture(t, { single: false });
  const combined = path.join(dirs.docsDir, '剧集', 'EP001', '视频提示词.md');
  const before = fs.readFileSync(combined, 'utf8');
  const result = reviseScriptShotPrompt({ docsDir: dirs.docsDir, shotId: 'MOTION-EP001-001', expectedPrompt: 'anything', prompt: 'new prompt' });
  assert.equal(result.ok, false);
  assert.match(result.message, /拼合版/);
  assert.equal(fs.readFileSync(combined, 'utf8'), before);
});
