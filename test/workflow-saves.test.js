const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanWorkflowSaves } = require('../src/workflow-saves');

// Node shapes copied from the user's real workflows.
const saveVideo = (id, prefix, mode = 0) => ({
  id, type: 'SaveVideo', mode, title: null,
  inputs: [{ name: 'video', link: 567 }, { name: 'filename_prefix', link: null, widget: { name: 'filename_prefix' } }],
  widgets_values: [prefix, 'auto', 'auto', 'auto'],
});
const saveImageLinked = (id, title) => ({
  id, type: 'SaveImage', mode: 2, title,
  inputs: [{ name: 'images', link: 509 }, { name: 'filename_prefix', link: 510, widget: { name: 'filename_prefix' } }],
  widgets_values: ['ref_'],
});
const vhs = (id, prefix) => ({
  id, type: 'VHS_VideoCombine', mode: 0, inputs: [],
  widgets_values: { frame_rate: 24, loop_count: 0, filename_prefix: prefix, format: 'video/h264-mp4' },
});
const ctxLatent = (id, prefix) => ({
  id, type: 'MiniMaxH3MotionContextSaveLatent', mode: 0, title: '保存本段 · clip_index = 这是第几段',
  inputs: [{ name: 'latent', link: 581 }, { name: 'filename_prefix', link: null, widget: { name: 'filename_prefix' } }],
  widgets_values: [prefix, 1],
});
const other = (id) => ({ id, type: 'KSampler', mode: 0, inputs: [], widgets_values: [1, 'randomize', 20] });

function makeDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-wf-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('a SaveVideo prefix with a folder is split into folder and file-name prefix', () => {
  const dir = makeDir({ 'a.json': { nodes: [saveVideo(92, 'video/minimax-h3-demo')] } });
  const r = scanWorkflowSaves(dir);
  assert.equal(r.workflows.length, 1);
  assert.equal(r.workflows[0].name, 'a.json');
  assert.deepEqual(r.workflows[0].saves, [{
    nodeId: 92, type: 'SaveVideo', kind: '视频', title: '', prefix: 'video/minimax-h3-demo',
    folder: 'video', namePrefix: 'minimax-h3-demo', linked: false, muted: false,
  }]);
});

test('a prefix wired from another node is flagged as linked', () => {
  const dir = makeDir({ 'a.json': { nodes: [saveImageLinked(208, '保存参考图')] } });
  const s = scanWorkflowSaves(dir).workflows[0].saves[0];
  assert.equal(s.kind, '图片');
  assert.equal(s.linked, true);
  assert.equal(s.title, '保存参考图');
  assert.equal(s.muted, true);
});

test('VHS_VideoCombine keeps its prefix in a dictionary', () => {
  const dir = makeDir({ 'a.json': { nodes: [vhs(5, 'h3')] } });
  const s = scanWorkflowSaves(dir).workflows[0].saves[0];
  assert.deepEqual([s.kind, s.prefix, s.folder, s.namePrefix], ['视频', 'h3', '', 'h3']);
});

test('the H3 continuation-data node is labelled and its folder is found', () => {
  const dir = makeDir({ 'a.json': { nodes: [ctxLatent(338, 'h3_context/clip')] } });
  const s = scanWorkflowSaves(dir).workflows[0].saves[0];
  assert.deepEqual([s.kind, s.folder, s.namePrefix], ['接续数据', 'h3_context', 'clip']);
});

test('Windows-style backslashes in a prefix are treated as folder separators', () => {
  const dir = makeDir({ 'a.json': { nodes: [saveVideo(1, 'video\\sub\\clip')] } });
  const s = scanWorkflowSaves(dir).workflows[0].saves[0];
  assert.deepEqual([s.folder, s.namePrefix], ['video/sub', 'clip']);
});

test('muted and bypassed save nodes are flagged, active ones are not', () => {
  const dir = makeDir({ 'a.json': { nodes: [saveVideo(1, 'a', 0), saveVideo(2, 'b', 2), saveVideo(3, 'c', 4)] } });
  assert.deepEqual(scanWorkflowSaves(dir).workflows[0].saves.map((s) => s.muted), [false, true, true]);
});

test('non-save nodes are ignored and workflows without any save node are left out', () => {
  const dir = makeDir({ 'a.json': { nodes: [other(1)] }, 'b.json': { nodes: [other(1), saveVideo(2, 'x')] } });
  assert.deepEqual(scanWorkflowSaves(dir).workflows.map((w) => w.name), ['b.json']);
});

test('backup copies of workflows are not listed', () => {
  const dir = makeDir({
    'minimax-h3-demo.json': { nodes: [saveVideo(1, 'x')] },
    'minimax-h3-demo.backup_pre_split.json': { nodes: [saveVideo(1, 'x')] },
    'old.bak.json': { nodes: [saveVideo(1, 'x')] },
  });
  assert.deepEqual(scanWorkflowSaves(dir).workflows.map((w) => w.name), ['minimax-h3-demo.json']);
});

test('sub-folders are searched two levels deep, no deeper', () => {
  const dir = makeDir({
    'top.json': { nodes: [saveVideo(1, 'x')] },
    '课程工作流/one.json': { nodes: [saveVideo(1, 'x')] },
    '课程工作流/more/two.json': { nodes: [saveVideo(1, 'x')] },
    '课程工作流/more/deeper/three.json': { nodes: [saveVideo(1, 'x')] },
  });
  const names = scanWorkflowSaves(dir).workflows.map((w) => w.relPath.replace(/\\/g, '/')).sort();
  assert.deepEqual(names, ['top.json', '课程工作流/more/two.json', '课程工作流/one.json']);
});

test('a corrupt workflow is counted, not fatal; other files are ignored', () => {
  const dir = makeDir({
    'good.json': { nodes: [saveVideo(1, 'x')] },
    'broken.json': '{ not json',
    'notes.txt': 'hello',
  });
  const r = scanWorkflowSaves(dir);
  assert.equal(r.workflows.length, 1);
  assert.equal(r.unreadable, 1);
});

test('a missing workflows folder gives an empty result', () => {
  assert.deepEqual(scanWorkflowSaves(path.join(os.tmpdir(), 'cl-none-' + Date.now())), { workflows: [], unreadable: 0 });
});

test('each workflow carries its file modification time', () => {
  const dir = makeDir({
    'old.json': { nodes: [saveVideo(1, 'x')] },
    'new.json': { nodes: [saveVideo(1, 'y')] },
  });
  fs.utimesSync(path.join(dir, 'old.json'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(path.join(dir, 'new.json'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  const byName = Object.fromEntries(scanWorkflowSaves(dir).workflows.map((w) => [w.name, w.mtime]));
  assert.equal(byName['old.json'], new Date('2026-01-01T00:00:00Z').getTime());
  assert.equal(byName['new.json'], new Date('2026-10-01T00:00:00Z').getTime());
});

test('workflows are sorted by name', () => {
  const dir = makeDir({
    'b.json': { nodes: [saveVideo(1, 'x')] },
    'a.json': { nodes: [saveVideo(1, 'x')] },
  });
  assert.deepEqual(scanWorkflowSaves(dir).workflows.map((w) => w.name), ['a.json', 'b.json']);
});
