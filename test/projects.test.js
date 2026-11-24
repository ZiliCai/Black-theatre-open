const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/projects');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-proj-'));
const NOW = () => new Date('2026-10-11T03:00:00.000Z');
const read = (f) => fs.readFileSync(f, 'utf8');

// every file under dir with its content, to prove nothing existing was touched
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { out[path.relative(dir, full) + path.sep] = 'dir'; walk(full); } else out[path.relative(dir, full)] = read(full);
    }
  };
  walk(dir);
  return out;
}

// ---------- names ----------
test('a normal Chinese or English project name is accepted and trimmed', () => {
  assert.deepEqual(P.validateProjectName('  穿越时空  '), { ok: true, name: '穿越时空', message: '' });
  assert.equal(P.validateProjectName('Time Travel 2').ok, true);
  assert.equal(P.validateProjectName('第十三封信（长篇）').ok, true);
});

test('names Windows cannot use as a folder are refused with a reason', () => {
  for (const bad of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'x\u0001y', '.', '..', 'name.', 'CON', 'con', 'NUL.txt', 'COM1', 'lpt9', 'a'.repeat(61)]) {
    const r = P.validateProjectName(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.message, JSON.stringify(bad));
  }
  assert.equal(P.validateProjectName(null).ok, false);
  assert.equal(P.validateProjectName(42).ok, false);
});

// ---------- create ----------
test('creating a project makes the folder layout and a project.json', () => {
  const root = tmp();
  const r = P.createProject({ root, name: '穿越时空', now: NOW });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.dir, path.join(root, '穿越时空'));
  for (const sub of ['output', 'input', '剧本']) assert.ok(fs.statSync(path.join(r.dir, sub)).isDirectory(), sub);
  const json = JSON.parse(read(path.join(r.dir, 'project.json')));
  assert.deepEqual(json, { version: 1, name: '穿越时空', created: '2026-10-11T03:00:00.000Z', docsDir: '剧本', docs: {} });
});

test('creating makes the projects root when it does not exist yet', () => {
  const root = path.join(tmp(), 'deep', 'projects');
  assert.equal(P.createProject({ root, name: 'a', now: NOW }).ok, true);
  assert.ok(fs.existsSync(path.join(root, 'a', 'output')));
});

test('creating refuses an existing folder and a bad name, and writes nothing', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '已有'));
  const r1 = P.createProject({ root, name: '已有', now: NOW });
  assert.equal(r1.ok, false);
  assert.match(r1.message, /导入/);
  assert.deepEqual(fs.readdirSync(path.join(root, '已有')), []);
  const r2 = P.createProject({ root, name: 'a/b', now: NOW });
  assert.equal(r2.ok, false);
  assert.deepEqual(fs.readdirSync(root), ['已有']);
});

test('creating needs an absolute root that is not a drive root', () => {
  assert.equal(P.createProject({ root: 'relative/dir', name: 'a', now: NOW }).ok, false);
  assert.equal(P.createProject({ root: 'C:\\', name: 'a', now: NOW }).ok, false);
  assert.equal(P.createProject({ root: '', name: 'a', now: NOW }).ok, false);
});

// ---------- inspect + import ----------
function makeExisting() {
  const dir = path.join(tmp(), '穿越时空');
  fs.mkdirSync(path.join(dir, 'Minimax剧本'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ref'));
  fs.mkdirSync(path.join(dir, '声音'));
  for (const n of ['01_故事设定.md', '02_分集大纲.md', '03_制作规划.md', '04_第1集分镜.md']) fs.writeFileSync(path.join(dir, 'Minimax剧本', n), `# ${n}\n内容\n`);
  fs.writeFileSync(path.join(dir, 'ref', '角色.png'), 'png');
  fs.writeFileSync(path.join(dir, '第一集剧本.txt'), '剧本');
  return dir;
}

test('inspect previews an import without writing anything, and suggests the folder full of documents', () => {
  const dir = makeExisting();
  const before = snapshot(dir);
  const r = P.inspectFolder(dir);
  assert.equal(r.ok, true);
  assert.equal(r.isProject, false);
  assert.equal(r.suggestedDocsDir, 'Minimax剧本');
  assert.deepEqual(r.willCreate.sort(), ['output', 'input', 'project.json'].sort());
  assert.deepEqual(snapshot(dir), before);
});

test('inspect does not suggest a folder with fewer than three documents', () => {
  const dir = path.join(tmp(), 'p');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), 'x');
  fs.writeFileSync(path.join(dir, 'notes', 'b.md'), 'x');
  const r = P.inspectFolder(dir);
  assert.equal(r.suggestedDocsDir, '');
  assert.ok(r.willCreate.includes('剧本'));
});

test('inspect picks the folder with the most documents when there are several', () => {
  const dir = path.join(tmp(), 'p');
  for (const [sub, n] of [['小', 3], ['大', 5]]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, sub, `d${i}.md`), 'x');
  }
  assert.equal(P.inspectFolder(dir).suggestedDocsDir, '大');
});

test('inspect refuses things that are not a usable folder', () => {
  const f = path.join(tmp(), 'file.txt');
  fs.writeFileSync(f, 'x');
  assert.equal(P.inspectFolder(f).ok, false);
  assert.equal(P.inspectFolder(path.join(tmp(), 'missing')).ok, false);
  assert.equal(P.inspectFolder('C:\\').ok, false);
  assert.equal(P.inspectFolder('relative').ok, false);
});

test('importing only adds what is missing and leaves every existing file untouched', () => {
  const dir = makeExisting();
  const before = snapshot(dir);
  const r = P.importProject({ dir, docsDir: 'Minimax剧本', now: NOW });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.created.sort(), ['input', 'output', 'project.json']);
  const after = snapshot(dir);
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, `${k} changed`);
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before)).sort(), ['input' + path.sep, 'output' + path.sep, 'project.json']);
  assert.equal(JSON.parse(read(path.join(dir, 'project.json'))).docsDir, 'Minimax剧本');
  assert.equal(JSON.parse(read(path.join(dir, 'project.json'))).name, '穿越时空');
  assert.equal(fs.existsSync(path.join(dir, '剧本')), false, 'the default docs folder is not created when another one is used');
});

test('importing is idempotent: a second import creates nothing and keeps the project data', () => {
  const dir = makeExisting();
  P.importProject({ dir, docsDir: 'Minimax剧本', now: NOW });
  const p = P.readProject(dir).project;
  p.docs['02_分集大纲.md'] = '大纲';
  P.writeProject(dir, p);
  const before = snapshot(dir);
  const r = P.importProject({ dir, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.created, []);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(P.readProject(dir).project.docs['02_分集大纲.md'], '大纲');
});

test('importing without a docs choice creates the default docs folder', () => {
  const dir = path.join(tmp(), 'empty-ish');
  fs.mkdirSync(dir);
  const r = P.importProject({ dir, now: NOW });
  assert.deepEqual(r.created.sort(), ['input', 'output', 'project.json', '剧本']);
});

test('importing refuses a docs folder that is not inside the project', () => {
  const dir = makeExisting();
  for (const bad of ['../outside', 'C:\\Windows', '/etc']) {
    const r = P.importProject({ dir, docsDir: bad, now: NOW });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(fs.existsSync(path.join(dir, 'project.json')), false);
});

// ---------- project.json ----------
test('readProject fills in missing fields and keeps what is there', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: '甲', docs: { 'a.md': '大纲' } }));
  const r = P.readProject(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.project, { version: 1, name: '甲', created: '', docsDir: '剧本', docs: { 'a.md': '大纲' } });
});

test('readProject ignores categories that are not one of the five', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ docs: { 'a.md': '大纲', 'b.md': '乱写', 'c.md': 5 } }));
  assert.deepEqual(P.readProject(dir).project.docs, { 'a.md': '大纲' });
});

test('a folder without project.json reads as a plain folder named after itself', () => {
  const dir = path.join(tmp(), '某剧');
  fs.mkdirSync(dir);
  const r = P.readProject(dir);
  assert.equal(r.ok, true);
  assert.equal(r.project.name, '某剧');
  assert.equal(r.initialized, false);
});

test('a corrupt project.json is backed up, then replaced by defaults', () => {
  const dir = path.join(tmp(), '坏了');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not json');
  const r = P.readProject(dir, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.equal(r.project.name, '坏了');
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('project.json.损坏-'));
  assert.equal(backups.length, 1);
  assert.equal(read(path.join(dir, backups[0])), '{ not json');
  assert.equal(JSON.parse(read(path.join(dir, 'project.json'))).name, '坏了');
});

test('a missing folder reads as missing', () => {
  const r = P.readProject(path.join(tmp(), 'gone'));
  assert.equal(r.ok, false);
  assert.equal(r.missing, true);
});

test('writeProject leaves no temporary file behind and replaces the old content', () => {
  const dir = tmp();
  P.writeProject(dir, { version: 1, name: 'a', created: '', docsDir: '剧本', docs: {} });
  P.writeProject(dir, { version: 1, name: 'b', created: '', docsDir: '剧本', docs: {} });
  assert.deepEqual(fs.readdirSync(dir), ['project.json']);
  assert.equal(JSON.parse(read(path.join(dir, 'project.json'))).name, 'b');
});

test('renameProject changes only the display name', () => {
  const root = tmp();
  const { dir } = P.createProject({ root, name: '旧名', now: NOW });
  const r = P.renameProject(dir, '新名');
  assert.equal(r.ok, true);
  assert.equal(P.readProject(dir).project.name, '新名');
  assert.ok(fs.existsSync(path.join(root, '旧名')), 'the folder keeps its name');
  assert.equal(P.renameProject(dir, 'a/b').ok, false);
  assert.equal(P.readProject(dir).project.name, '新名');
});

// ---------- paths ----------
test('projectPaths follows docsDir and refuses one that escapes the project', () => {
  const dir = path.join(tmp(), 'p');
  assert.deepEqual(P.projectPaths(dir, { docsDir: 'Minimax剧本' }), {
    dir, output: path.join(dir, 'output'), input: path.join(dir, 'input'), docs: path.join(dir, 'Minimax剧本'),
  });
  assert.equal(P.projectPaths(dir, null).docs, path.join(dir, '剧本'));
  assert.equal(P.projectPaths(dir, { docsDir: '../evil' }).docs, path.join(dir, '剧本'));
  assert.equal(P.projectPaths(dir, { docsDir: 'C:\\x' }).docs, path.join(dir, '剧本'));
});

// ---------- known list + switching ----------
test('the known list ignores case and trailing slashes when adding and removing', () => {
  let list = [];
  list = P.addKnown(list, 'C:\\BlackBox\\projects\\A');
  list = P.addKnown(list, 'c:\\blackbox\\projects\\a\\');
  assert.equal(list.length, 1);
  list = P.addKnown(list, 'C:\\BlackBox\\projects\\B');
  assert.equal(list.length, 2);
  assert.deepEqual(P.removeKnown(list, 'c:\\blackbox\\projects\\A'), ['C:\\BlackBox\\projects\\B']);
  assert.deepEqual(P.addKnown(undefined, 'D:\\x'), ['D:\\x']);
});

test('switching to a project points ComfyUI at its output and input folders', () => {
  const root = tmp();
  const { dir } = P.createProject({ root, name: '甲', now: NOW });
  const r = P.switchPatch(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { activeProject: dir, outputDir: path.join(dir, 'output'), inputDir: path.join(dir, 'input') });
});

test('switching recreates a missing output or input folder', () => {
  const root = tmp();
  const { dir } = P.createProject({ root, name: '甲', now: NOW });
  fs.rmdirSync(path.join(dir, 'input'));
  const r = P.switchPatch(dir);
  assert.equal(r.ok, true);
  assert.ok(fs.statSync(path.join(dir, 'input')).isDirectory());
});

test('switching is refused when the folder is gone or the sub-folder cannot be made', () => {
  assert.equal(P.switchPatch(path.join(tmp(), 'gone')).ok, false);
  const root = tmp();
  const { dir } = P.createProject({ root, name: '甲', now: NOW });
  fs.rmdirSync(path.join(dir, 'output'));
  fs.writeFileSync(path.join(dir, 'output'), 'a file is in the way');
  const r = P.switchPatch(dir);
  assert.equal(r.ok, false);
  assert.match(r.message, /output/);
});

test('leaving the project only clears the marker and keeps the folders', () => {
  assert.deepEqual(P.clearPatch(), { activeProject: '' });
});

test('describeProjects lists known folders with name, active flag and whether they still exist', () => {
  const root = tmp();
  const a = P.createProject({ root, name: '甲', now: NOW }).dir;
  const b = P.createProject({ root, name: '乙', now: NOW }).dir;
  const gone = path.join(root, '没了');
  const list = P.describeProjects({ projects: [a, gone, b], activeProject: b });
  assert.deepEqual(list.map((p) => [p.name, p.exists, p.active]), [['甲', true, false], ['没了', false, false], ['乙', true, true]]);
  assert.equal(list[0].dir, a);
  assert.equal(list[0].docsDir, path.join(a, '剧本'));
});

test('describeProjects with nothing known gives an empty list, and a missing active project is flagged', () => {
  assert.deepEqual(P.describeProjects({ projects: [], activeProject: '' }), []);
  assert.deepEqual(P.describeProjects({}), []);
  const root = tmp();
  const gone = path.join(root, '没了');
  const list = P.describeProjects({ projects: [gone], activeProject: gone });
  assert.equal(list[0].active, true);
  assert.equal(list[0].exists, false);
});

// ---------- document categories inside project.json ----------
test('setDocCategory records a category in project.json, and refuses one that is not on the list', () => {
  const { dir } = P.createProject({ root: tmp(), name: '甲', now: NOW });
  assert.equal(P.setDocCategory(dir, '02_分集大纲.md', '细纲').ok, true);
  assert.equal(P.readProject(dir).project.docs['02_分集大纲.md'], '细纲');
  const bad = P.setDocCategory(dir, '02_分集大纲.md', '乱写');
  assert.equal(bad.ok, false);
  assert.equal(P.readProject(dir).project.docs['02_分集大纲.md'], '细纲');
  assert.equal(P.setDocCategory(path.join(tmp(), 'gone'), 'a.md', '大纲').ok, false);
});

test('moveDocKey carries the category to the new name, dropDocKey forgets it', () => {
  const { dir } = P.createProject({ root: tmp(), name: '甲', now: NOW });
  P.setDocCategory(dir, '旧.md', '分镜头');
  P.moveDocKey(dir, '旧.md', '新.md');
  assert.deepEqual(P.readProject(dir).project.docs, { '新.md': '分镜头' });
  P.moveDocKey(dir, '没记录.md', '别的.md'); // nothing recorded: nothing to move
  assert.deepEqual(P.readProject(dir).project.docs, { '新.md': '分镜头' });
  P.dropDocKey(dir, '新.md');
  assert.deepEqual(P.readProject(dir).project.docs, {});
});

test('changing the docs folder of a project keeps the recorded categories', () => {
  const { dir } = P.createProject({ root: tmp(), name: '甲', now: NOW });
  P.setDocCategory(dir, 'a.md', '大纲');
  fs.mkdirSync(path.join(dir, '别处'));
  assert.equal(P.setDocsDir(dir, '别处').ok, true);
  const p = P.readProject(dir).project;
  assert.equal(p.docsDir, '别处');
  assert.equal(p.docs['a.md'], '大纲');
  assert.equal(P.setDocsDir(dir, '../escape').ok, false);
  assert.equal(P.readProject(dir).project.docsDir, '别处');
});
