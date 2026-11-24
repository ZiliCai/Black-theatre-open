const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetService } = require('../src/asset-service');
const { createAssetStore } = require('../src/asset-store');
const { createTakeStore } = require('../src/take-store');
const { importScriptShot } = require('../src/script-shots');

const TEMPLATES = path.join(__dirname, '..', 'workflow-templates');
const LIST = fs.readFileSync(path.join(__dirname, 'fixtures', 'assets', '人物与场景.md'), 'utf8');
const MOTION = [
  '## MOTION-E01-001 · 冷开场',
  '- 时长：5s',
  '- 输入参考图：',
  '  - PLAN-QX（顺序：1）· IMG-QX《骑行者 角色板》（用途：身份）',
  '  - PLAN-YS-YK（顺序：2）· IMG-YS-YK《断风垭口 夜雾板》（用途：地理）',
  '### 可复制提示词',
  '> 提示词一',
  '',
].join('\n');

function harness() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-svc-')), '宣传 视频');
  const docsDir = path.join(dir, '剧本');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'ref'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, '01_人物与场景参考图.md'), LIST);
  fs.writeFileSync(path.join(docsDir, 'MOTION-E01.md'), MOTION);
  const queued = [];
  const trashed = [];
  let project = { dir, docsDir, outputDir };
  const service = createAssetService({
    getProject: () => project,
    templatesDir: TEMPLATES,
    queue: { enqueue: (jobs) => queued.push(...jobs) },
    trash: async (abs) => { trashed.push(abs); fs.rmSync(abs); },
  });
  const store = createAssetStore(dir);
  // a finished take with its picture on disk
  const made = (code, takeId) => {
    const take = store.readCard(code).takes.find((t) => t.id === takeId);
    const image = `ref/${take.outputKey}_00001_.png`;
    fs.writeFileSync(path.join(outputDir, image), 'p');
    store.updateTake(code, takeId, { status: 'succeeded', image });
    return image;
  };
  return { service, store, queued, trashed, made, dir, docsDir, outputDir, setProject: (p) => { project = p; } };
}

test('cards come from the list with their status', () => {
  const h = harness();
  const r = h.service.cards();
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 13);
  const qx = r.cards.find((c) => c.code === 'QX');
  assert.deepEqual([qx.kind, qx.status, qx.kept], ['char', 'empty', 0]);
  h.setProject(null);
  assert.equal(h.service.cards().noProject, true);
});

test('detail gives the draft defaults, the prompt and the shots that name the card', () => {
  const h = harness();
  const qx = h.service.detail('QX');
  assert.equal(qx.ok, true);
  assert.deepEqual(qx.draft, { mode: 't2i', base: '', ask: '', aspect: '3:4', count: 1, look: '', lookFrom: '' });
  assert.deepEqual(qx.look, { text: qx.card.description, edited: false, stale: false });
  assert.match(qx.prompt, /^写实电影质感/);
  assert.match(qx.prompt, /红色防风衣/);
  assert.deepEqual(qx.appearances, ['MOTION-E01-001']);
  assert.equal(h.service.detail('YS-YK').draft.aspect, '16:9');
  assert.equal(h.service.detail('NOPE').ok, false);
});

test('taking N pictures queues image jobs with their own names and seeds', () => {
  const h = harness();
  h.service.saveDraft('QX', { mode: 't2i', ask: '正面定妆，站在路边', aspect: '2:3', count: 3 });
  const r = h.service.enqueue('QX', 3);
  assert.equal(r.ok, true);
  assert.equal(h.queued.length, 3);
  const [job] = h.queued;
  assert.deepEqual([job.kind, job.family, job.shotId], ['image', 'qwen-image', 'QX']);
  assert.match(job.workflow['8'].inputs.filename_prefix, /^ref\/bb_qx-t001-/);
  assert.match(job.workflow['4'].inputs.prompt, /正面定妆，站在路边/);
  assert.deepEqual([job.workflow['5'].inputs.width, job.workflow['5'].inputs.height], [1056, 1584]);
  const takes = h.store.readCard('QX').takes;
  assert.equal(takes.length, 3);
  assert.ok(takes.every((t) => t.batch === 'b1' && t.mode === 't2i' && Number.isSafeInteger(t.seed)));
  assert.equal(new Set(takes.map((t) => t.seed)).size, 3);
  assert.equal(h.service.detail('QX').draft.count, 1, 'the next round starts at one picture again');
  assert.equal(h.service.detail('QX').draft.ask, '正面定妆，站在路边');
  assert.equal(h.store.readCard('QX').kind, 'char');
  h.service.enqueue('QX', 1);
  assert.equal(h.store.readCard('QX').takes[3].batch, 'b2');
});

test('image-to-image needs a kept base picture', () => {
  const h = harness();
  h.service.saveDraft('QX', { mode: 'i2i', base: 'ref/none.png', ask: '侧面' });
  assert.match(h.service.enqueue('QX', 1).errors[0], /先选一张卡里已经收进的图/);
  h.service.saveDraft('QX', { mode: 't2i', ask: '正面' });
  h.service.enqueue('QX', 1);
  const take = h.store.readCard('QX').takes[0];
  const image = h.made('QX', take.id);
  h.service.setTier({ code: 'QX', takeId: take.id, tier: 'keep', label: '正面定妆' });
  h.service.saveDraft('QX', { mode: 'i2i', base: image, ask: '侧面 45°' });
  const r = h.service.enqueue('QX', 1);
  assert.equal(r.ok, true);
  const job = h.queued[h.queued.length - 1];
  assert.equal(job.workflow['9'].inputs.image, `${image} [output]`);
  assert.match(job.workflow['4'].inputs.prompt, /^保持参考图里冷开场里的骑行者（20 多岁）的外形不变/);
});

test('the card\'s edit of the appearance replaces the list line in its pictures only while the list is unchanged', () => {
  const h = harness();
  const listed = h.service.detail('QX').card.description;
  const look = listed.replace('，车尾插一面小旗', '');
  const saved = h.service.saveDraft('QX', { mode: 't2i', ask: '正面', look, lookFrom: listed });
  assert.deepEqual(saved.look, { text: look, edited: true, stale: false });
  assert.doesNotMatch(saved.prompt, /小旗/);
  h.service.enqueue('QX', 1);
  assert.doesNotMatch(h.queued[0].workflow['4'].inputs.prompt, /小旗/);
  assert.match(fs.readFileSync(path.join(h.docsDir, '01_人物与场景参考图.md'), 'utf8'), /车尾插一面小旗/, 'the list stays as written');

  // an edit that is the list line again is dropped
  const same = h.service.saveDraft('QX', { mode: 't2i', ask: '正面', look: listed, lookFrom: listed });
  assert.equal(same.look.edited, false);
  assert.deepEqual([h.store.readCard('QX').draft.look, h.store.readCard('QX').draft.lookFrom], ['', '']);

  // once the list line changes, the old edit no longer applies
  h.service.saveDraft('QX', { mode: 't2i', ask: '正面', look, lookFrom: listed });
  const file = path.join(h.docsDir, '01_人物与场景参考图.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('红色防风衣', '蓝色防风衣'));
  const after = h.service.detail('QX');
  assert.deepEqual([after.look.edited, after.look.stale], [false, true]);
  assert.match(after.prompt, /蓝色防风衣.*车尾插一面小旗/);
});

test('keeping, the main picture, labels and taking out', () => {
  const h = harness();
  h.service.enqueue('QX', 3);
  const ids = h.store.readCard('QX').takes.map((t) => t.id);
  return (async () => {
    assert.equal((await h.service.setTier({ code: 'QX', takeId: ids[0], tier: 'keep' })).ok, false); // not made yet
    const a = h.made('QX', ids[0]);
    const b = h.made('QX', ids[1]);
    await h.service.setTier({ code: 'QX', takeId: ids[0], tier: 'keep', label: '正面定妆' });
    await h.service.setTier({ code: 'QX', takeId: ids[1], tier: 'keep' });
    let card = h.store.readCard('QX');
    assert.equal(card.main, a, 'the first kept picture becomes the main one');
    assert.deepEqual(card.set.map((s) => s.label), ['正面定妆', '参考图']);
    assert.equal(h.service.cards().cards.find((c) => c.code === 'QX').status, 'busy'); // the third is still queued
    assert.equal(h.service.setMain('QX', b).ok, true);
    assert.equal(h.service.setMain('QX', 'ref/other.png').ok, false);
    assert.equal(h.service.relabel('QX', a, '  正面  ').ok, true);
    assert.equal(h.store.readCard('QX').set[0].label, '正面');
    assert.equal(h.service.unkeep('QX', b).ok, true);
    card = h.store.readCard('QX');
    assert.equal(card.main, a, 'the main picture moves on to what is left');
    assert.equal(card.takes.find((t) => t.id === ids[1]).tier, 'cand');
    assert.ok(fs.existsSync(path.join(h.outputDir, b)), 'taking out never deletes the file');
    await h.service.setTier({ code: 'QX', takeId: ids[0], tier: 'cand' });
    card = h.store.readCard('QX');
    assert.deepEqual([card.set.length, card.main], [0, '']);
  })();
});

test('deleting moves the picture to the bin and asks first when a shot uses it', async () => {
  const h = harness();
  h.service.enqueue('QX', 2);
  const [one, two] = h.store.readCard('QX').takes.map((t) => t.id);
  const a = h.made('QX', one);
  const b = h.made('QX', two);
  await h.service.setTier({ code: 'QX', takeId: one, tier: 'keep' });
  createTakeStore(h.dir).writeDraft('MOTION-E01-001', { templateId: 'x', values: { references: [`${a} [output]`] }, continuation: { mode: 'none' } });
  assert.deepEqual(h.service.detail('QX').set[0].usedBy, ['MOTION-E01-001']);

  const asked = await h.service.setTier({ code: 'QX', takeId: one, tier: 'trash' });
  assert.equal(asked.needsConfirm, true);
  assert.match(asked.message, /MOTION-E01-001/);
  assert.ok(fs.existsSync(path.join(h.outputDir, a)));

  assert.equal((await h.service.setTier({ code: 'QX', takeId: two, tier: 'trash' })).ok, true); // not kept: no question
  assert.deepEqual(h.trashed, [path.join(h.outputDir, b)]);
  assert.equal((await h.service.setTier({ code: 'QX', takeId: one, tier: 'trash', confirmed: true })).ok, true);
  const card = h.store.readCard('QX');
  assert.deepEqual([card.set.length, card.main], [0, '']);
  assert.ok(card.takes.every((t) => t.tier === 'trash'));
});

test('pictures named after the card can be kept without renaming them', () => {
  const h = harness();
  fs.writeFileSync(path.join(h.outputDir, 'ref', 'QX_骑行者_全身.png'), 'p');
  fs.writeFileSync(path.join(h.outputDir, 'ref', 'QXY_别人.png'), 'p');
  fs.mkdirSync(path.join(h.dir, 'ref'));
  fs.writeFileSync(path.join(h.dir, 'ref', 'YS-YK_断风垭口_夜雾.png'), 'p');
  fs.writeFileSync(path.join(h.outputDir, 'ref', 'YS-YKX.png'), 'p');
  assert.deepEqual(h.service.detail('QX').existing.map((e) => [e.image, e.label]), [['ref/QX_骑行者_全身.png', '骑行者_全身']]);
  const yk = h.service.detail('YS-YK').existing;
  assert.deepEqual(yk.map((e) => [e.image, e.source]), [['ref/YS-YK_断风垭口_夜雾.png', 'ref']]);

  assert.equal(h.service.adopt('YS-YK', yk[0].relPath).ok, true);
  assert.ok(fs.existsSync(path.join(h.outputDir, 'ref', 'YS-YK_断风垭口_夜雾.png')), 'copied into the output folder');
  assert.ok(fs.existsSync(path.join(h.dir, 'ref', 'YS-YK_断风垭口_夜雾.png')), 'the original stays');
  const card = h.store.readCard('YS-YK');
  assert.deepEqual([card.main, card.set[0].label, card.kind], ['ref/YS-YK_断风垭口_夜雾.png', '断风垭口_夜雾', 'scene']);
  assert.deepEqual(h.service.detail('YS-YK').existing, []);
  assert.equal(h.service.adopt('QX', 'ref/../x.png').ok, false);
});

test('the shot import hangs a card main picture by its code', () => {
  const h = harness();
  fs.writeFileSync(path.join(h.outputDir, 'ref', 'QX_骑行者_全身.png'), 'p');
  fs.writeFileSync(path.join(h.outputDir, 'ref', 'YS-YK_旧图.png'), 'p');
  h.service.adopt('QX', 'ref/QX_骑行者_全身.png');
  h.service.enqueue('QX', 1);
  const take = h.store.readCard('QX').takes[0];
  const made = h.made('QX', take.id);
  return h.service.setTier({ code: 'QX', takeId: take.id, tier: 'keep' }).then(() => {
    h.service.setMain('QX', made);
    const mains = h.service.mains();
    assert.equal(mains.QX, made);
    assert.equal(mains['YS-YK'], '');
    const r = importScriptShot({ docsDir: h.docsDir, projectDir: h.dir, outputDir: h.outputDir, shotId: 'MOTION-E01-001', cards: mains });
    assert.deepEqual(r.values.references, [`${made} [output]`, 'ref/YS-YK_旧图.png [output]']);
    assert.deepEqual(r.warnings, ['YS-YK 还没有主图，按文件名找的']);
    const sets = h.service.sets().cards;
    assert.deepEqual(sets.map((c) => c.code), ['QX']);
    assert.deepEqual(sets[0].images.map((i) => i.main), [true, false]);
  });
});

test('a card with records that left the list stays, marked as such', () => {
  const h = harness();
  h.store.addTake('OLD1', {});
  const old = h.service.cards().cards.find((c) => c.code === 'OLD1');
  assert.equal(old.orphan, true);
  assert.equal(h.service.detail('OLD1').card.name, '清单里已没有');
  assert.equal(h.service.mains().OLD1, undefined);
});
