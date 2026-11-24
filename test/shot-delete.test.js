const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShotService } = require('../src/shot-service');
const { createTakeStore } = require('../src/take-store');
const { removeShotBlock } = require('../src/script-shots');

const TEMPLATES = path.join(__dirname, '..', 'workflow-templates');
const DOC = [
  '# 第一集',
  '',
  '## MOTION-E01-01 · 林夏走下台阶',
  '- 时长：5.9s',
  '### 可复制提示词',
  '> 提示词一',
  '',
  '## MOTION-E01-02 · 站台全景',
  '- 时长：4.5s',
  '### 可复制提示词',
  '> 提示词二',
  '',
  '## 站位 · 01–03',
  '林夏在左。',
  '',
  '## MOTION-E01-03 · 回头',
  '- 时长：6s',
  '- 接续上一镜：是',
  '### 可复制提示词',
  '> 提示词三',
  '',
].join('\n');

function harness() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shot-del-')), '项目');
  const docsDir = path.join(dir, 'Minimax剧本');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'MOTION-E01.md'), DOC);
  const trashed = [];
  const service = createShotService({
    getProject: () => ({ dir, docsDir, outputDir }),
    templatesDir: TEMPLATES,
    queue: { enqueue: () => {}, busy: () => false },
    trash: async (abs) => { trashed.push(abs); fs.unlinkSync(abs); },
    getCardMains: () => ({ AC23: 'ref/ac23.png', YS: 'ref/ys.png' }),
    getCards: () => [{ code: 'AC23', kind: 'char', name: '阿措', description: '', main: 'ref/ac23.png' }],
  });
  const store = createTakeStore(dir);
  const finished = (shotId) => {
    const take = store.addTake(shotId, { status: 'succeeded', templateId: 'minimax-h3-wenwu-cont' });
    const video = `video/${take.outputKey}_00001_.mp4`;
    fs.writeFileSync(path.join(outputDir, video), 'v');
    return store.updateTake(shotId, take.id, { video, durationSec: 5 });
  };
  const ids = () => service.episodes().episodes[0].shots.map((s) => s.id);
  return { service, store, trashed, finished, dir, docsDir, ids };
}

test('a shot block comes out of the document up to the next section, which stays', () => {
  const r = removeShotBlock(DOC, 'MOTION-E01-02');
  assert.match(r.removed, /^## MOTION-E01-02 · 站台全景[\s\S]*提示词二$/);
  assert.doesNotMatch(r.content, /站台全景|提示词二/);
  assert.match(r.content, /> 提示词一\n\n## 站位 · 01–03/);
  const last = removeShotBlock(DOC, 'MOTION-E01-03');
  assert.match(last.content, /林夏在左。\n$/);
  assert.equal(removeShotBlock(DOC, 'MOTION-E01-09'), null);
});

test('deleting asks first with what it takes along, then removes the script section, videos and record', async () => {
  const h = harness();
  h.finished('MOTION-E01-02');
  const ask = await h.service.deleteShot({ shotId: 'MOTION-E01-02' });
  assert.equal(ask.needsConfirm, true);
  assert.match(ask.message, /剧本文件里的那一段会删掉/);
  assert.match(ask.message, /1 条视频会移到回收站/);
  assert.match(ask.message, /镜头 03 设的是「接上一镜」，删掉后它接的是镜头 01/);
  assert.deepEqual(h.ids(), ['MOTION-E01-01', 'MOTION-E01-02', 'MOTION-E01-03']);

  const r = await h.service.deleteShot({ shotId: 'MOTION-E01-02', confirmed: true });
  assert.equal(r.ok, true);
  assert.equal(r.next, 'MOTION-E01-03');
  assert.deepEqual(h.ids(), ['MOTION-E01-01', 'MOTION-E01-03']); // not left behind as 「剧本里已没有」
  assert.equal(h.trashed.length, 1);
  const doc = fs.readFileSync(path.join(h.docsDir, 'MOTION-E01.md'), 'utf8');
  assert.doesNotMatch(doc, /站台全景/);
  assert.match(doc, /## 站位 · 01–03/);
  const kept = fs.readdirSync(path.join(h.dir, '.blackbox', 'deleted'));
  assert.equal(kept.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, '.blackbox', 'deleted', kept[0]), 'utf8'));
  assert.match(saved.removedText, /提示词二/);
  assert.equal(saved.record.takes.length, 1);
});

test('hand-made shots next to a deleted one stay in place, and a deleted number is not given out again', async () => {
  const h = harness();
  const a = h.service.createManual({ episode: 'E01', title: 'a', anchor: 'MOTION-E01-02', place: 'after' });
  assert.deepEqual(h.ids(), ['MOTION-E01-01', 'MOTION-E01-02', a.id, 'MOTION-E01-03']);
  await h.service.deleteShot({ shotId: 'MOTION-E01-02', confirmed: true });
  assert.deepEqual(h.ids(), ['MOTION-E01-01', a.id, 'MOTION-E01-03']);
  const r = await h.service.deleteShot({ shotId: a.id, confirmed: true });
  assert.equal(r.ok, true);
  assert.deepEqual(h.ids(), ['MOTION-E01-01', 'MOTION-E01-03']);
  const b = h.service.createManual({ episode: 'E01', title: 'b', place: 'end' });
  assert.notEqual(b.id, a.id);
});

test('a shot still generating is not deleted', async () => {
  const h = harness();
  h.store.addTake('MOTION-E01-01', { status: 'running' });
  const r = await h.service.deleteShot({ shotId: 'MOTION-E01-01', confirmed: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /还有在生成的/);
  assert.deepEqual(h.ids(), ['MOTION-E01-01', 'MOTION-E01-02', 'MOTION-E01-03']);
});

test('a new shot is told the shots it sits between, and is made with what the AI settled', () => {
  const h = harness();
  const where = h.service.composeContext({ episode: 'E01', anchor: 'MOTION-E01-02', place: 'before' });
  assert.equal(where.previous.id, 'MOTION-E01-01');
  assert.equal(where.previous.prompt, '提示词一');
  assert.equal(where.next.id, 'MOTION-E01-02');
  assert.equal(where.maxReferences, 6);
  assert.equal(where.cards[0].code, 'AC23');
  assert.equal(h.service.composeContext({ episode: 'E01', place: 'end' }).previous.id, 'MOTION-E01-03');
  const made = h.service.createComposed({ episode: 'E01', title: '端粥', anchor: 'MOTION-E01-02', place: 'before', prompt: 'P', duration: 7, codes: ['AC23', 'YS'], continues: true });
  assert.equal(made.ok, true);
  assert.deepEqual(h.ids(), ['MOTION-E01-01', made.id, 'MOTION-E01-02', 'MOTION-E01-03']);
  const d = h.service.detail(made.id);
  assert.equal(d.draft.values.prompt, 'P');
  assert.equal(d.draft.values.duration, 7);
  assert.deepEqual(d.draft.values.references, ['ref/ac23.png [output]', 'ref/ys.png [output]']);
  assert.deepEqual(d.draft.continuation, { mode: 'previous' });
});
