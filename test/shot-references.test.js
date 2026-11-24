const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShotService } = require('../src/shot-service');
const { createTakeStore } = require('../src/take-store');

const TEMPLATES = path.join(__dirname, '..', 'workflow-templates');
const shotDoc = (refs) => [
  '## MOTION-E01-01 · 门口', '- 时长：5.9s', '- 输入参考图：', '  - PLAN-HY27（顺序：1）· IMG-HY27《何遇》（用途：身份）', '### 可复制提示词', '> 一', '',
  '## MOTION-E01-02 · 厨房', '- 时长：5.9s', '- 输入参考图：', ...refs, '### 可复制提示词', '> 二', '',
].join('\n');

function harness(mains) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-refs-'));
  const docsDir = path.join(dir, '剧本');
  fs.mkdirSync(docsDir, { recursive: true });
  const doc = path.join(docsDir, 'MOTION-E01.md');
  fs.writeFileSync(doc, shotDoc(['  - PLAN-AC23（顺序：1）· IMG-AC23《阿措》（用途：身份）', '  - PLAN-YS-CF（顺序：2）· IMG-YS-CF《厨房》（用途：地理）']));
  const service = createShotService({
    getProject: () => ({ dir, docsDir, outputDir: path.join(dir, 'output') }),
    templatesDir: TEMPLATES, queue: { enqueue: () => {}, busy: () => false }, trash: async () => {}, getCardMains: () => mains,
  });
  return { service, doc, store: createTakeStore(dir) };
}

test('a new shot takes the pictures its script names, not the shot before it', () => {
  const h = harness({ HY27: 'ref/hy.png', AC23: 'ref/ac.png', 'YS-CF': 'ref/cf.png' });
  assert.deepEqual(h.service.detail('MOTION-E01-01').draft.values.references, ['ref/hy.png [output]']);
  assert.deepEqual(h.service.detail('MOTION-E01-02').draft.values.references, ['ref/ac.png [output]', 'ref/cf.png [output]']);
});

test('pictures follow the script until chosen by hand, and again once the script changes', () => {
  const mains = { HY27: 'ref/hy.png', AC23: 'ref/ac.png', 'YS-CF': 'ref/cf.png', 'YS-SS': 'ref/ss.png' };
  const h = harness(mains);
  const d = h.service.detail('MOTION-E01-02').draft;
  h.service.saveDraft('MOTION-E01-02', { ...d, values: { ...d.values, references: ['ref/ac.png [output]'] } });
  h.service.episodes();
  assert.deepEqual(h.service.detail('MOTION-E01-02').draft.values.references, ['ref/ac.png [output]'], 'a hand choice stays');
  fs.writeFileSync(h.doc, shotDoc(['  - PLAN-YS-SS（顺序：1）· IMG-YS-SS《宿舍》（用途：地理）']));
  h.service.episodes();
  assert.deepEqual(h.service.detail('MOTION-E01-02').draft.values.references, ['ref/ss.png [output]'], 'the script changed');
  mains['YS-SS'] = 'ref/ss2.png'; // the card's main picture was replaced
  h.service.episodes();
  assert.deepEqual(h.service.detail('MOTION-E01-02').draft.values.references, ['ref/ss2.png [output]']);
});

test('a draft from before pictures were tracked keeps its pictures when it was rendered, takes the script\'s when not', () => {
  const h = harness({ HY27: 'ref/hy.png', AC23: 'ref/ac.png', 'YS-CF': 'ref/cf.png' });
  for (const id of ['MOTION-E01-01', 'MOTION-E01-02']) h.store.writeDraft(id, { templateId: 'minimax-h3-wenwu-cont', values: { prompt: 'x', duration: 5.9, references: ['ref/old.png [output]'] }, continuation: { mode: 'none' } });
  h.store.addTake('MOTION-E01-01', { status: 'succeeded', templateId: 'minimax-h3-wenwu-cont' });
  h.service.episodes();
  assert.deepEqual(h.store.readShot('MOTION-E01-01').draft.values.references, ['ref/old.png [output]']);
  assert.deepEqual(h.store.readShot('MOTION-E01-02').draft.values.references, ['ref/ac.png [output]', 'ref/cf.png [output]']);
});
