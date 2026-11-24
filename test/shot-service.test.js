const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShotService } = require('../src/shot-service');
const { createTakeStore } = require('../src/take-store');

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
  '- 接续上一镜：是',
  '### 可复制提示词',
  '> 提示词二',
  '',
  '## MOTION-E01-03 · 回头',
  '- 时长：6s',
  '### 可复制提示词',
  '> 提示词三',
  '',
].join('\n');

function harness({ trashFails = false, getDefaultTemplate } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shot-svc-')), '宣传视频');
  const docsDir = path.join(dir, 'Minimax剧本');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'h3_context'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'MOTION-E01.md'), DOC);
  const queued = [];
  const trashed = [];
  let project = { dir, docsDir, outputDir };
  const service = createShotService({
    getProject: () => project,
    templatesDir: TEMPLATES,
    getDefaultTemplate,
    queue: { enqueue: (jobs) => queued.push(...jobs), busy: () => false },
    trash: async (abs) => {
      if (trashFails) throw new Error('文件正被占用');
      trashed.push(abs);
      fs.rmSync(abs);
    },
  });
  const store = createTakeStore(dir);
  // a finished take on disk: video plus continuation latent and picture
  const finished = (shotId, extra = {}) => {
    const take = store.addTake(shotId, { status: 'succeeded', templateId: 'minimax-h3-wenwu-cont', ...extra });
    const video = `video/${take.outputKey}_00001_.mp4`;
    const context = `${take.outputKey}_1026-120000_`;
    fs.writeFileSync(path.join(outputDir, video), 'v');
    fs.writeFileSync(path.join(outputDir, 'h3_context', `${context}.safetensors`), 'l');
    fs.writeFileSync(path.join(outputDir, 'h3_context', `${context}.jpg`), 'j');
    return store.updateTake(shotId, take.id, { video, context, durationSec: 5 });
  };
  return { service, store, queued, trashed, finished, dir, docsDir, outputDir, setProject: (p) => { project = p; } };
}

test('a new shot uses the verified remote workflow and preserves an existing draft choice', () => {
  const { service } = harness({ getDefaultTemplate: () => 'minimax-h3-hybrid' });
  const first = service.detail('MOTION-E01-01').draft;
  assert.equal(first.templateId, 'minimax-h3-hybrid');
  service.saveDraft('MOTION-E01-01', { ...first, templateId: 'minimax-h3-wenwu-cont' });
  assert.equal(service.detail('MOTION-E01-01').draft.templateId, 'minimax-h3-wenwu-cont');
});

test('episodes lists script shots then manual and orphan', () => {
  const h = harness();
  h.store.addManual({ episode: 'E01', title: '插入', after: 'MOTION-E01-01' });
  h.store.addTake('MOTION-E01-09', {});
  const r = h.service.episodes();
  assert.equal(r.ok, true);
  assert.deepEqual(r.episodes.map((e) => e.id), ['E01']);
  const shots = r.episodes[0].shots;
  assert.deepEqual(shots.map((s) => s.id), ['MOTION-E01-01', 'HAND-E01-1', 'MOTION-E01-02', 'MOTION-E01-03', 'MOTION-E01-09']);
  assert.deepEqual(shots.map((s) => s.source), ['script', 'manual', 'script', 'script', 'orphan']);
  assert.equal(shots[0].n, '01');
  assert.equal(shots[0].title, '林夏走下台阶');
  assert.equal(shots[0].duration, 5.9);
  assert.equal(shots[4].status, 'running');
});

test('a hand-made shot goes right before or after the selected shot, or at the end; script shots keep their order', () => {
  const h = harness();
  const ids = () => h.service.episodes().episodes[0].shots.map((s) => [s.id, s.n]);
  const after = h.service.createManual({ episode: 'E01', title: '后', anchor: 'MOTION-E01-01', place: 'after' });
  assert.equal(after.ok, true);
  // 02 continues "the shot before": that is the new shot now, and the user is told how to keep 01
  assert.match(after.notice, /^镜头 02 设的是「接上一镜」，插进来以后它接的是这个新镜头；要接原来的镜头 01，在剧本里把镜头 02 写成「接续上一镜：是（接 01）」/);
  assert.match(h.service.detail('MOTION-E01-02').continuation.resolved.message, /镜头 手动1 还没有选中/);
  const before = h.service.createManual({ episode: 'e01', title: '前', anchor: 'MOTION-E01-01', place: 'before' });
  assert.equal(before.notice, '', '01 does not continue anything');
  const next = h.service.createManual({ episode: 'E01', title: '紧跟', anchor: 'MOTION-E01-01', place: 'after' });
  const end = h.service.createManual({ episode: 'E01', title: '尾', anchor: 'MOTION-E01-02', place: 'end' });
  assert.deepEqual([after.id, before.id, next.id, end.id], ['HAND-E01-1', 'HAND-E01-2', 'HAND-E01-3', 'HAND-E01-4']);
  assert.deepEqual(ids(), [
    ['HAND-E01-2', '手动2'], ['MOTION-E01-01', '01'], ['HAND-E01-3', '手动3'], ['HAND-E01-1', '手动1'],
    ['MOTION-E01-02', '02'], ['MOTION-E01-03', '03'], ['HAND-E01-4', '手动4'],
  ]);
  // a new shot takes the settings of the shot now in front of it
  assert.equal(h.service.detail('HAND-E01-3').draft.continuation.mode, 'none');
});

test('a hand-made shot is not put next to a shot of another episode, one the script dropped, or on an unknown side', () => {
  const h = harness();
  h.store.addTake('MOTION-E01-09', {});
  assert.match(h.service.createManual({ episode: 'E02', title: 'x', anchor: 'MOTION-E01-01', place: 'after' }).message, /不在这一集里/);
  assert.match(h.service.createManual({ episode: 'E01', title: 'x', anchor: 'MOTION-E01-09', place: 'before' }).message, /剧本里已经没有了/);
  assert.match(h.service.createManual({ episode: 'E01', title: 'x', anchor: 'MOTION-E01-01', place: 'up' }).message, /插入位置不对/);
  assert.match(h.service.createManual({ episode: 'E01', title: 'x', anchor: '', place: 'after' }).message, /不在这一集里/);
  assert.deepEqual(h.store.readManual(), []);
});

test('default draft takes continuation from the script line', () => {
  const h = harness();
  assert.deepEqual(h.service.detail('MOTION-E01-01').draft.continuation, { mode: 'none' });
  const second = h.service.detail('MOTION-E01-02');
  assert.deepEqual(second.draft.continuation, { mode: 'previous' });
  assert.equal(second.draft.templateId, 'minimax-h3-wenwu-cont');
  assert.equal(second.draft.values.prompt, '提示词二');
  assert.equal(second.draft.values.duration, 4.5);
  assert.equal(second.continuation.supported, true);
  assert.deepEqual(second.continuation.resolved, { ok: false, message: '镜头 01 还没有选中，先去选一条' });
});

test('default draft inherits previous shot template and values', () => {
  const h = harness();
  const first = h.service.detail('MOTION-E01-01');
  h.service.saveDraft('MOTION-E01-01', { ...first.draft, templateId: 'minimax-h3-hybrid', values: { ...first.draft.values, steps: 9 } });
  const second = h.service.detail('MOTION-E01-02');
  assert.equal(second.draft.templateId, 'minimax-h3-hybrid');
  assert.equal(second.draft.values.steps, 9);
  assert.equal(second.draft.values.prompt, '提示词二');
  assert.equal(second.draft.values.duration, 4.5);
});

test('the script prompt always wins over a stored draft', () => {
  const h = harness();
  const first = h.service.detail('MOTION-E01-01');
  h.service.saveDraft('MOTION-E01-01', { ...first.draft, values: { ...first.draft.values, prompt: '旧的' } });
  assert.equal(h.service.detail('MOTION-E01-01').draft.values.prompt, '提示词一');
});

test('a new length in the script replaces the stored one, a hand-set length stays until then', () => {
  const h = harness();
  const first = h.service.detail('MOTION-E01-01');
  h.service.saveDraft('MOTION-E01-01', { ...first.draft, values: { ...first.draft.values, duration: 5.2 } });
  assert.equal(h.service.detail('MOTION-E01-01').draft.values.duration, 5.2);
  fs.writeFileSync(path.join(h.docsDir, 'MOTION-E01.md'), DOC.replace('- 时长：5.9s', '- 时长：4.5s'));
  assert.equal(h.service.detail('MOTION-E01-01').draft.values.duration, 4.5);
  const tl = h.service.timeline('E01');
  assert.equal(tl.segments[0].duration, 4.5);
});

test('a draft saved before lengths were tracked takes the script length once', () => {
  const h = harness();
  h.store.writeDraft('MOTION-E01-02', { templateId: 'minimax-h3-wenwu-cont', values: { duration: 9.4 }, continuation: { mode: 'previous' } });
  assert.equal(h.service.detail('MOTION-E01-02').draft.values.duration, 4.5);
  assert.equal(h.store.readShot('MOTION-E01-02').draft.scriptDuration, 4.5);
});

test('the script decides continuation: a named shot, then later script changes, but a hand-set choice stays until then', () => {
  const h = harness();
  const third = h.service.detail('MOTION-E01-03');
  assert.deepEqual(third.draft.continuation, { mode: 'none' });
  fs.writeFileSync(path.join(h.docsDir, 'MOTION-E01.md'), DOC.replace('- 时长：6s', '- 时长：6s\n- 接续上一镜：是（接 01）'));
  assert.deepEqual(h.service.detail('MOTION-E01-03').draft.continuation, { mode: 'shot', shotId: 'MOTION-E01-01' });
  h.service.saveDraft('MOTION-E01-03', { ...third.draft, continuation: { mode: 'previous' } });
  assert.deepEqual(h.service.detail('MOTION-E01-03').draft.continuation, { mode: 'previous' });
  fs.writeFileSync(path.join(h.docsDir, 'MOTION-E01.md'), DOC);
  assert.deepEqual(h.service.detail('MOTION-E01-03').draft.continuation, { mode: 'none' });
});

test('a draft saved before continuation was tracked keeps a choice that already matches the script', () => {
  const h = harness();
  h.store.writeDraft('MOTION-E01-02', { templateId: 'minimax-h3-wenwu-cont', values: { duration: 4.5 }, continuation: { mode: 'previous' } });
  assert.deepEqual(h.service.detail('MOTION-E01-02').draft.continuation, { mode: 'previous' });
  assert.equal(h.store.readShot('MOTION-E01-02').draft.scriptContinuation, undefined);
});

test('detail fills values missing from the draft with template defaults', () => {
  const h = harness();
  h.service.saveDraft('MOTION-E01-01', { templateId: 'minimax-h3-hybrid', values: { duration: 3, references: [] }, continuation: { mode: 'none' } });
  const d = h.service.detail('MOTION-E01-01');
  assert.equal(d.draft.values.duration, 3);
  assert.equal(d.draft.values.steps, d.form.defaults.steps);
  assert.equal(d.draft.values.aspect, d.form.defaults.aspect);
  assert.equal(d.draft.values.continuationEnabled, undefined);
  assert.equal(d.draft.values.continuationClip, undefined);
});

test('rejects prompt write when script changed', () => {
  const h = harness();
  const loaded = h.service.detail('MOTION-E01-01').draft.values.prompt;
  const file = path.join(h.docsDir, 'MOTION-E01.md');
  const edited = DOC.replace('> 提示词一', '> 外面改过的提示词');
  fs.writeFileSync(file, edited);
  const r = h.service.writePrompt('MOTION-E01-01', { expected: loaded, prompt: '我的新提示词' });
  assert.deepEqual(r, { ok: false, message: '剧本文件已在外面修改，请刷新后再改' });
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
});

test('writePrompt saves into the script block', () => {
  const h = harness();
  const r = h.service.writePrompt('MOTION-E01-02', { expected: '提示词二', prompt: '新的第二镜' });
  assert.equal(r.ok, true, r.message);
  const text = fs.readFileSync(path.join(h.docsDir, 'MOTION-E01.md'), 'utf8');
  assert.match(text, /> 新的第二镜/);
  assert.match(text, /> 提示词一/);
});

test('writePrompt on a manual shot only changes its draft', () => {
  const h = harness();
  const { id } = h.service.createManual({ episode: 'E01', title: '补拍', after: null });
  const draft = h.service.detail(id).draft;
  assert.equal(h.service.writePrompt(id, { expected: draft.values.prompt, prompt: '手写的' }).ok, true);
  assert.equal(h.service.detail(id).draft.values.prompt, '手写的');
});

test('enqueue refuses when the continuation source has no pick', () => {
  const h = harness();
  const r = h.service.enqueue('MOTION-E01-02', 2);
  assert.deepEqual(r, { ok: false, errors: ['镜头 01 还没有选中，先去选一条'] });
  assert.equal(h.queued.length, 0);
  assert.deepEqual(h.store.readShot('MOTION-E01-02').takes, []);
});

test('enqueue compiles with unique prefixes and hands jobs to the queue', () => {
  const h = harness();
  const r = h.service.enqueue('MOTION-E01-01', 2);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.takeIds.length, 2);
  assert.equal(h.queued.length, 2);
  const takes = h.store.readShot('MOTION-E01-01').takes;
  for (const [i, job] of h.queued.entries()) {
    const take = takes.find((t) => t.id === job.takeId);
    assert.equal(job.workflow['507'].inputs.filename_prefix, `h3_context/${take.outputKey}`);
    assert.equal(job.workflow['364'].inputs.filename_prefix, `video/${take.outputKey}`);
    assert.equal(job.workflow['500'].inputs.value, false);
    assert.equal(job.outputKey, take.outputKey);
    assert.equal(job.outputDir, h.outputDir);
    assert.equal(take.status, 'queued');
    assert.equal(take.templateId, 'minimax-h3-wenwu-cont');
    assert.equal(take.seed, job.workflow['397'].inputs.seed, `take ${i} records its seed`);
    assert.equal(take.continuedFrom, null);
  }
});

test('enqueue continues from the previous pick', () => {
  const h = harness();
  const src = h.finished('MOTION-E01-01');
  h.service.setTier({ shotId: 'MOTION-E01-01', takeId: src.id, tier: 'pick' });
  const r = h.service.enqueue('MOTION-E01-02', 1);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(h.queued[0].workflow['500'].inputs.value, true);
  assert.equal(h.queued[0].workflow['501'].inputs.clip, `h3_context/${src.context}.jpg [output]`);
  assert.deepEqual(h.store.readShot('MOTION-E01-02').takes[0].continuedFrom, { shotId: 'MOTION-E01-01', takeId: src.id });
});

test('enqueue limits count to 1-16', () => {
  const h = harness();
  assert.equal(h.service.enqueue('MOTION-E01-01', 40).takeIds.length, 16);
  assert.equal(h.service.enqueue('MOTION-E01-03', 0).takeIds.length, 1);
});

test('setTier pick demotes the old pick', () => {
  const h = harness();
  const a = h.finished('MOTION-E01-01');
  const b = h.finished('MOTION-E01-01');
  h.service.setTier({ shotId: 'MOTION-E01-01', takeId: a.id, tier: 'pick' });
  h.service.setTier({ shotId: 'MOTION-E01-01', takeId: b.id, tier: 'pick' });
  const tiers = Object.fromEntries(h.store.readShot('MOTION-E01-01').takes.map((t) => [t.id, t.tier]));
  assert.deepEqual(tiers, { [a.id]: 'cand', [b.id]: 'pick' });
});

test('trash with dependents asks first, then trashes video and context', async () => {
  const h = harness();
  const src = h.finished('MOTION-E01-01');
  h.store.updateTake('MOTION-E01-01', src.id, { tier: 'pick' });
  h.finished('MOTION-E01-02', { continuedFrom: { shotId: 'MOTION-E01-01', takeId: src.id } });
  const ask = await h.service.setTier({ shotId: 'MOTION-E01-01', takeId: src.id, tier: 'trash' });
  assert.deepEqual(ask, { ok: false, needsConfirm: true, message: '镜头 02 接的是这一条，删掉后它们的接续来源就没了。仍然删掉？' });
  assert.equal(h.trashed.length, 0);
  const done = await h.service.setTier({ shotId: 'MOTION-E01-01', takeId: src.id, tier: 'trash', confirmed: true });
  assert.equal(done.ok, true);
  assert.deepEqual(h.trashed.sort(), [
    path.join(h.outputDir, 'h3_context', `${src.context}.jpg`),
    path.join(h.outputDir, 'h3_context', `${src.context}.safetensors`),
    path.join(h.outputDir, 'video', `${src.outputKey}_00001_.mp4`),
  ].sort());
  assert.equal(h.store.readShot('MOTION-E01-01').takes[0].tier, 'trash');
});

test('trash failure leaves the tier unchanged', async () => {
  const h = harness({ trashFails: true });
  const t = h.finished('MOTION-E01-01');
  const r = await h.service.setTier({ shotId: 'MOTION-E01-01', takeId: t.id, tier: 'trash' });
  assert.equal(r.ok, false);
  assert.match(r.message, /文件正被占用/);
  assert.equal(h.store.readShot('MOTION-E01-01').takes[0].tier, '');
});

test('a take still generating cannot be trashed', async () => {
  const h = harness();
  const t = h.store.addTake('MOTION-E01-01', { status: 'running' });
  const r = await h.service.setTier({ shotId: 'MOTION-E01-01', takeId: t.id, tier: 'trash' });
  assert.deepEqual(r, { ok: false, message: '这一条还在生成，先在任务列表里取消它' });
});

test('detail lists continuation options including old kept shots', () => {
  const h = harness();
  const src = h.finished('MOTION-E01-01');
  h.store.updateTake('MOTION-E01-01', src.id, { tier: 'pick' });
  fs.writeFileSync(path.join(h.outputDir, 'h3_context', 'clip_7-2.safetensors'), 'l');
  fs.writeFileSync(path.join(h.outputDir, 'h3_context', 'clip_7-2.jpg'), 'j');
  fs.writeFileSync(path.join(h.outputDir, 'h3_context', 'kept.json'), JSON.stringify({ version: 1, shots: { '7-2': { video: 'video/old.mp4', originalStem: 'clip_x', keptAt: 1 } } }));
  const options = h.service.detail('MOTION-E01-03').continuation.options;
  assert.deepEqual(options.map((o) => o.label), ['不接', '接上一镜', '接 镜头 01', '旧版保留 · 分镜 7-2']);
  assert.deepEqual(options[2].choice, { mode: 'shot', shotId: 'MOTION-E01-01' });
  assert.deepEqual(options[3].choice, { mode: 'legacy', legacyShot: '7-2' });
});

test('timeline covers the episode', () => {
  const h = harness();
  const t = h.finished('MOTION-E01-01');
  h.store.updateTake('MOTION-E01-01', t.id, { tier: 'pick' });
  const tl = h.service.timeline('E01', 'black');
  assert.equal(tl.ok, true);
  assert.deepEqual(tl.segments.map((s) => [s.shotId, s.kind, s.duration]), [['MOTION-E01-01', 'pick', 5], ['MOTION-E01-02', 'gap', 4.5], ['MOTION-E01-03', 'gap', 6]]);
});

test('usedContexts lists continuation files of every take that is not trashed', async () => {
  const h = harness();
  const a = h.finished('MOTION-E01-01');
  const b = h.finished('MOTION-E01-02');
  h.store.updateTake('MOTION-E01-02', b.id, { tier: 'trash' });
  h.store.addTake('MOTION-E01-03', { status: 'queued' });
  assert.deepEqual([...h.service.usedContexts()], [a.context]);
  h.setProject(null);
  assert.deepEqual([...h.service.usedContexts()], []);
});

test('usedContexts says it is unsure while a record is damaged', () => {
  const h = harness();
  h.finished('MOTION-E01-01');
  assert.equal(h.service.usedContexts().unsure, false);
  fs.writeFileSync(path.join(h.dir, '.blackbox', 'shots', 'MOTION-E01-02.json'), '{broken');
  assert.equal(h.service.usedContexts().unsure, true);
});

test('a damaged manual-shot file is reported with the episodes', () => {
  const h = harness();
  fs.mkdirSync(path.join(h.dir, '.blackbox'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, '.blackbox', 'manual-shots.json'), 'nope');
  assert.ok(h.service.episodes().warnings.some((w) => /手动镜头/.test(w)));
});

test('ids that are not shot ids are refused, not written', async () => {
  const h = harness();
  const draft = { templateId: 'minimax-h3-wenwu-cont', values: {}, continuation: { mode: 'none' } };
  assert.equal(h.service.saveDraft('../../evil', draft).ok, false);
  assert.equal((await h.service.setTier({ shotId: '../x', takeId: 'y', tier: 'pick' })).ok, false);
  assert.equal(fs.existsSync(path.join(h.dir, 'evil.json')), false);
});

test('no project gives the noProject answer', async () => {
  const h = harness();
  h.setProject(null);
  const no = { ok: false, noProject: true, message: '请先选择或新建一个剧本项目' };
  assert.deepEqual(h.service.episodes(), no);
  assert.deepEqual(h.service.detail('MOTION-E01-01'), no);
  assert.deepEqual(h.service.enqueue('MOTION-E01-01', 1), no);
  assert.deepEqual(await h.service.setTier({ shotId: 'x', takeId: 'y', tier: 'pick' }), no);
});
