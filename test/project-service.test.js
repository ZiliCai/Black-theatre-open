const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectService } = require('../src/project-service');
const { removeTree } = require('../src/fs-safe');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-svc-'));
const NOW = () => new Date('2026-10-11T03:00:00.000Z');

// A service wired to an in-memory config, like main.js wires it to the saved one.
function setup(extra = {}) {
  const root = tmp();
  const state = { config: { projectsRoot: root, projects: [], activeProject: '', outputDir: 'F:\\old\\out', inputDir: '', ...extra }, saves: 0, trashed: [] };
  const service = createProjectService({
    getConfig: () => state.config,
    setConfig: (patch) => { state.config = { ...state.config, ...patch }; state.saves++; },
    trash: async (p) => { state.trashed.push(p); },
    now: NOW,
  });
  return { root, state, service };
}

// ---------- projects ----------
test('creating a project adds it to the known list and, when asked, switches to it', async () => {
  const { root, state, service } = setup();
  const r = await service.create({ name: '穿越时空', activate: true });
  assert.equal(r.ok, true, r.message);
  const dir = path.join(root, '穿越时空');
  assert.deepEqual(state.config.projects, [dir]);
  assert.equal(state.config.activeProject, dir);
  assert.equal(state.config.outputDir, path.join(dir, 'output'));
  assert.equal(state.config.inputDir, path.join(dir, 'input'));
});

test('creating without activating leaves the current folders alone', async () => {
  const { state, service } = setup();
  const r = await service.create({ name: '甲', activate: false });
  assert.equal(r.ok, true);
  assert.equal(state.config.activeProject, '');
  assert.equal(state.config.outputDir, 'F:\\old\\out');
  assert.equal(state.config.projects.length, 1);
});

test('a bad or duplicate name is refused and nothing is saved', async () => {
  const { state, service } = setup();
  await service.create({ name: '甲', activate: false });
  const saves = state.saves;
  assert.equal((await service.create({ name: '甲', activate: false })).ok, false);
  assert.equal((await service.create({ name: 'a/b', activate: false })).ok, false);
  assert.equal(state.saves, saves);
  assert.equal(state.config.projects.length, 1);
});

test('the list shows names, the active one, and what each folder holds', async () => {
  const { state, service } = setup();
  await service.create({ name: '甲', activate: false });
  const b = await service.create({ name: '乙', activate: true });
  fs.writeFileSync(path.join(b.dir, 'output', 'x.mp4'), '12345');
  const r = await service.list();
  assert.equal(r.ok, true);
  assert.equal(r.root, state.config.projectsRoot);
  assert.deepEqual(r.projects.map((p) => [p.name, p.active, p.exists]), [['甲', false, true], ['乙', true, true]]);
  assert.equal(r.projects[1].stats.fileCount, 2); // x.mp4 and project.json
  assert.equal(r.activeMissing, false);
});

test('switching points ComfyUI at the project and remembers it', async () => {
  const { state, service } = setup();
  const a = await service.create({ name: '甲', activate: false });
  const b = await service.create({ name: '乙', activate: false });
  assert.equal((await service.switchTo(a.dir)).ok, true);
  assert.equal(state.config.outputDir, path.join(a.dir, 'output'));
  assert.equal((await service.switchTo(b.dir)).ok, true);
  assert.equal(state.config.activeProject, b.dir);
  assert.equal(state.config.outputDir, path.join(b.dir, 'output'));
});

test('switching to a folder that is gone is refused and the config does not change', async () => {
  const { root, state, service } = setup();
  const before = { ...state.config };
  const r = await service.switchTo(path.join(root, '没了'));
  assert.equal(r.ok, false);
  assert.deepEqual(state.config, before);
});

test('leaving the project keeps the folders ComfyUI uses', async () => {
  const { state, service } = setup();
  const a = await service.create({ name: '甲', activate: true });
  const r = await service.leave();
  assert.equal(r.ok, true);
  assert.equal(state.config.activeProject, '');
  assert.equal(state.config.outputDir, path.join(a.dir, 'output'));
});

test('forgetting a project removes it from the list but never touches its files, and it clears the marker if it was active', async () => {
  const { state, service } = setup();
  const a = await service.create({ name: '甲', activate: true });
  fs.writeFileSync(path.join(a.dir, 'output', 'keep.mp4'), 'x');
  const r = await service.forget(a.dir);
  assert.equal(r.ok, true);
  assert.deepEqual(state.config.projects, []);
  assert.equal(state.config.activeProject, '');
  assert.ok(fs.existsSync(path.join(a.dir, 'output', 'keep.mp4')));
  assert.ok(fs.existsSync(path.join(a.dir, 'project.json')));
});

test('renaming changes the display name only', async () => {
  const { service } = setup();
  const a = await service.create({ name: '甲', activate: false });
  assert.equal((await service.rename(a.dir, '新名字')).ok, true);
  assert.equal((await service.list()).projects[0].name, '新名字');
  assert.ok(fs.existsSync(a.dir));
});

test('importing a folder previews first, then adds only what is missing', async () => {
  const { state, service } = setup();
  const dir = path.join(tmp(), '穿越时空');
  fs.mkdirSync(path.join(dir, 'Minimax剧本'), { recursive: true });
  for (const n of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(dir, 'Minimax剧本', n), '# x\n');
  const preview = await service.inspectImport(dir);
  assert.equal(preview.ok, true);
  assert.equal(preview.suggestedDocsDir, 'Minimax剧本');
  assert.equal(fs.existsSync(path.join(dir, 'project.json')), false);
  const r = await service.importFolder({ dir, docsDir: 'Minimax剧本', activate: false });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(state.config.projects, [dir]);
  assert.ok(fs.existsSync(path.join(dir, 'output')));
  assert.equal(fs.existsSync(path.join(dir, '剧本')), false);
  const docs = await service.docsList();
  assert.equal(docs.ok, false); // not active yet
  await service.switchTo(dir);
  assert.equal((await service.docsList()).docs.length, 3);
});

test('a project that has gone missing is flagged, and the active marker is reported', async () => {
  const { root, service } = setup();
  const a = await service.create({ name: '甲', activate: true });
  removeTree(a.dir);
  const r = await service.list();
  assert.equal(r.projects[0].exists, false);
  assert.equal(r.activeMissing, true);
  assert.equal(path.dirname(a.dir), root);
});

// ---------- documents ----------
test('documents need an active project', async () => {
  const { service } = setup();
  for (const r of [await service.docsList(), await service.docsRead('a.md'), await service.docsCreate({ name: 'a', category: '大纲' })]) {
    assert.equal(r.ok, false);
    assert.equal(r.noProject, true);
  }
});

test('create a document with a category, see it listed, edit it, and see the history', async () => {
  const { service } = setup();
  await service.create({ name: '甲', activate: true });
  const made = await service.docsCreate({ name: '第二集分镜', category: '分镜头' });
  assert.equal(made.ok, true, made.message);
  let list = await service.docsList();
  assert.deepEqual(list.docs.map((d) => [d.relPath, d.category]), [['第二集分镜.md', '分镜头']]);
  assert.equal(list.exists, true);
  const open = await service.docsRead('第二集分镜.md');
  const saved = await service.docsSave({ relPath: '第二集分镜.md', content: '# 新内容\n', version: open.version });
  assert.equal(saved.ok, true);
  assert.equal((await service.docsHistory('第二集分镜.md')).history.length, 1);
  list = await service.docsList();
  assert.equal(list.docs[0].size, Buffer.byteLength('# 新内容\n')); // the size is in bytes
});

test('a conflicting save is reported, and overwrite goes through', async () => {
  const { service } = setup();
  const p = await service.create({ name: '甲', activate: true });
  await service.docsCreate({ name: 'a', category: '其他' });
  const open = await service.docsRead('a.md');
  fs.writeFileSync(path.join(p.dir, '剧本', 'a.md'), '别人改的\n');
  const r = await service.docsSave({ relPath: 'a.md', content: '我的\n', version: open.version });
  assert.equal(r.conflict, true);
  assert.equal((await service.docsSave({ relPath: 'a.md', content: '我的\n', version: open.version, overwrite: true })).ok, true);
  assert.equal(fs.readFileSync(path.join(p.dir, '剧本', 'a.md'), 'utf8'), '我的\n');
});

test('changing a category sticks, and renaming carries it to the new name', async () => {
  const { service } = setup();
  const p = await service.create({ name: '甲', activate: true });
  await service.docsCreate({ name: '旧', category: '其他' });
  assert.equal((await service.docsSetCategory({ relPath: '旧.md', category: '大纲' })).ok, true);
  assert.equal((await service.docsSetCategory({ relPath: '旧.md', category: '乱写' })).ok, false);
  const r = await service.docsRename({ relPath: '旧.md', name: '新' });
  assert.equal(r.relPath, '新.md');
  const list = await service.docsList();
  assert.deepEqual(list.docs.map((d) => [d.relPath, d.category]), [['新.md', '大纲']]);
  assert.ok(fs.existsSync(path.join(p.dir, '剧本', '新.md')));
});

test('deleting a document sends it to the trash and forgets its category', async () => {
  const { state, service } = setup();
  const p = await service.create({ name: '甲', activate: true });
  await service.docsCreate({ name: 'a', category: '大纲' });
  const r = await service.docsTrash({ relPath: 'a.md' });
  assert.equal(r.ok, true);
  assert.deepEqual(state.trashed, [path.join(p.dir, '剧本', 'a.md')]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8')).docs, {});
});

test('search goes through the active project, and the history can be read back', async () => {
  const { service } = setup();
  await service.create({ name: '甲', activate: true });
  await service.docsCreate({ name: 'a', category: '其他' });
  let open = await service.docsRead('a.md');
  open = await service.docsSave({ relPath: 'a.md', content: '江渡遇见清嘉\n', version: open.version });
  await service.docsSave({ relPath: 'a.md', content: '换了内容\n', version: open.version });
  assert.deepEqual((await service.docsSearch('清嘉')).results, []); // that text is only in the history now
  assert.equal((await service.docsSearch('换了')).results.length, 1);
  const h = (await service.docsHistory('a.md')).history;
  assert.equal(h.length, 2);
  assert.match((await service.docsHistoryRead('a.md', h[0].id)).content, /江渡/);
});

test('the docs folder can be created when it is missing, and moved to another folder inside the project', async () => {
  const { service } = setup();
  const p = await service.create({ name: '甲', activate: true });
  removeTree(path.join(p.dir, '剧本'));
  assert.equal((await service.docsList()).exists, false);
  assert.equal((await service.docsEnsureFolder()).ok, true);
  assert.equal((await service.docsList()).exists, true);
  fs.mkdirSync(path.join(p.dir, '设定集'));
  const moved = await service.docsSetFolder(path.join(p.dir, '设定集'));
  assert.equal(moved.ok, true, moved.message);
  assert.equal((await service.docsList()).folderName, '设定集');
  assert.equal((await service.docsSetFolder(path.join(tmp(), 'elsewhere'))).ok, false);
  assert.equal((await service.docsSetFolder(p.dir)).ok, false, 'the project folder itself is not a docs folder');
});

test('the page can ask where the docs folder is, for showing it in Explorer', async () => {
  const { service } = setup();
  const p = await service.create({ name: '甲', activate: true });
  assert.equal(await service.docsFolderPath(), path.join(p.dir, '剧本'));
  assert.equal(await service.docsFilePath('a.md'), path.join(p.dir, '剧本', 'a.md'));
  assert.equal(await service.docsFilePath('../x.md'), null);
});
