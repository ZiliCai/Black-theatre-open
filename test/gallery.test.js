const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScanner, resolveInside, trashEntries } = require('../src/gallery');

const SAMPLE_MP4 = path.join(__dirname, 'fixtures', 'media', 'sample-h3.mp4');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-gal-'));
  for (const [rel, spec] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, spec.data ?? 'x');
    const t = new Date(spec.time ?? 1_700_000_000_000);
    fs.utimesSync(full, t, t);
  }
  return root;
}

// ---------- scanning ----------
test('lists videos and images newest first, with kind, size and folder', () => {
  const root = makeTree({
    'video/a_00001_.mp4': { time: 1_000_000_000_000 },
    'video/a_00002_.mp4': { time: 3_000_000_000_000, data: 'abcd' },
    'ref_x_00001_.png': { time: 2_000_000_000_000 },
  });
  const r = createScanner().scan(root);
  assert.deepEqual(r.entries.map((e) => e.relPath), ['video/a_00002_.mp4', 'ref_x_00001_.png', 'video/a_00001_.mp4']);
  const first = r.entries[0];
  assert.equal(first.kind, 'video');
  assert.equal(first.name, 'a_00002_.mp4');
  assert.equal(first.folder, 'video');
  assert.equal(first.size, 4);
  assert.equal(r.entries[1].kind, 'image');
  assert.equal(r.entries[1].folder, '');
  assert.equal(r.truncated, false);
  assert.equal(r.missing, false);
});

test('ignores files that are not pictures or videos, empty files, hidden folders and placeholder files', () => {
  const root = makeTree({
    'ok.png': {},
    'h3_context/clip_00001.safetensors': {},
    'notes.txt': {},
    'empty.mp4': { data: '' },
    '.hidden/secret.png': {},
    '_output_images_will_be_put_here': {},
  });
  assert.deepEqual(createScanner().scan(root).entries.map((e) => e.relPath), ['ok.png']);
});

test('goes down at most three folders deep', () => {
  const root = makeTree({ 'a/b/c/ok.png': {}, 'a/b/c/d/too-deep.png': {} });
  assert.deepEqual(createScanner().scan(root).entries.map((e) => e.relPath), ['a/b/c/ok.png']);
});

test('stops at the file limit and says so', () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`p${i}.png`] = { time: 1_700_000_000_000 + i * 1000 };
  const r = createScanner().scan(makeTree(files), { maxFiles: 5 });
  assert.equal(r.entries.length, 5);
  assert.equal(r.truncated, true);
});

test('a folder that does not exist is reported as missing, not an error', () => {
  const r = createScanner().scan(path.join(os.tmpdir(), 'cl-gal-does-not-exist'));
  assert.deepEqual(r.entries, []);
  assert.equal(r.missing, true);
});

test('a real mp4 carries its size, length and generation details', () => {
  const root = makeTree({});
  fs.copyFileSync(SAMPLE_MP4, path.join(root, 'clip.mp4'));
  const [e] = createScanner().scan(root).entries;
  assert.equal(e.width, 64);
  assert.equal(e.height, 48);
  assert.ok(Math.abs(e.duration - 0.5) < 0.1);
  assert.equal(e.params.steps, 16);
  assert.equal(e.params.clipIndex, 1);
});

test('a file with no details is still listed, with params null', () => {
  const [e] = createScanner().scan(makeTree({ 'plain.png': {} })).entries;
  assert.equal(e.params, null);
});

test('details are read once per file version and re-read when the file changes', () => {
  const root = makeTree({ 'a.mp4': {} });
  let reads = 0;
  const scanner = createScanner({ readMeta: () => { reads++; return { kind: 'video', tags: {} }; } });
  scanner.scan(root);
  scanner.scan(root);
  assert.equal(reads, 1);
  const file = path.join(root, 'a.mp4');
  fs.writeFileSync(file, 'changed content');
  scanner.scan(root);
  assert.equal(reads, 2);
});

test('one unreadable file does not stop the scan', () => {
  const root = makeTree({ 'a.png': {}, 'b.png': {} });
  const scanner = createScanner({ readMeta: (f) => { if (f.endsWith('a.png')) throw new Error('boom'); return { kind: 'image', tags: {} }; } });
  assert.equal(scanner.scan(root).entries.length, 2);
});

// ---------- path guard ----------
test('resolveInside accepts files under the root and refuses everything else', () => {
  const root = path.join(os.tmpdir(), 'cl-root');
  assert.equal(resolveInside(root, 'video/a.mp4'), path.join(root, 'video', 'a.mp4'));
  assert.equal(resolveInside(root, 'video\\a.mp4'), path.join(root, 'video', 'a.mp4'));
  assert.equal(resolveInside(root, '../outside.png'), null);
  assert.equal(resolveInside(root, 'video/../../outside.png'), null);
  assert.equal(resolveInside(root, path.join(os.tmpdir(), 'cl-root-evil', 'a.png')), null);
  assert.equal(resolveInside(root, 'C:\\Windows\\win.ini'), null);
  assert.equal(resolveInside(root, '/etc/passwd'), null);
  assert.equal(resolveInside(root, ''), null);
  assert.equal(resolveInside(root, '.'), null);
  assert.equal(resolveInside(root, 'a\0.png'), null);
  assert.equal(resolveInside(root, 42), null);
});

test('resolveInside is not fooled by a sibling folder that starts with the same letters', () => {
  const root = path.join(os.tmpdir(), 'out');
  assert.equal(resolveInside(root, '../out-two/a.png'), null);
});

// ---------- moving to the recycle bin ----------
test('trashEntries sends the chosen media files to the trash function and nothing else', async () => {
  const root = makeTree({ 'video/a.mp4': {}, 'b.png': {}, 'keep.png': {} });
  const sent = [];
  const r = await trashEntries({ root, relPaths: ['video/a.mp4', 'b.png'], trash: async (p) => { sent.push(p); } });
  assert.deepEqual(sent, [path.join(root, 'video', 'a.mp4'), path.join(root, 'b.png')]);
  assert.deepEqual(r.trashed, ['video/a.mp4', 'b.png']);
  assert.deepEqual(r.failed, []);
});

test('trashEntries refuses paths outside the root, non-media files, folders and missing files', async () => {
  const root = makeTree({ 'notes.txt': {}, 'dir/inner.png': {} });
  const sent = [];
  const r = await trashEntries({
    root,
    relPaths: ['../escape.png', 'notes.txt', 'dir', 'missing.png', 'dir/inner.png'],
    trash: async (p) => { sent.push(p); },
  });
  assert.deepEqual(sent, [path.join(root, 'dir', 'inner.png')]);
  assert.deepEqual(r.trashed, ['dir/inner.png']);
  assert.deepEqual(r.failed.map((f) => f.relPath), ['../escape.png', 'notes.txt', 'dir', 'missing.png']);
  assert.ok(r.failed.every((f) => f.message));
});

test('trashEntries keeps going when one file fails and reports it', async () => {
  const root = makeTree({ 'a.png': {}, 'b.png': {} });
  const r = await trashEntries({
    root, relPaths: ['a.png', 'b.png'],
    trash: async (p) => { if (p.endsWith('a.png')) throw new Error('in use'); },
  });
  assert.deepEqual(r.trashed, ['b.png']);
  assert.deepEqual(r.failed, [{ relPath: 'a.png', message: 'in use' }]);
});

test('trashEntries with nothing selected or a bad list does nothing', async () => {
  const root = makeTree({ 'a.png': {} });
  const trash = async () => { throw new Error('should not be called'); };
  assert.deepEqual(await trashEntries({ root, relPaths: [], trash }), { trashed: [], failed: [] });
  assert.deepEqual(await trashEntries({ root, relPaths: 'a.png', trash }), { trashed: [], failed: [] });
});

// ---------- Range requests (a video player seeks with these) ----------
const { parseRange, mimeOf } = require('../src/gallery');

test('parseRange: a start and an end, an open end, and the last N bytes', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
});

test('parseRange: an end past the file is cut to the file, and a suffix larger than the file is the whole file', () => {
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('parseRange: a start beyond the file cannot be satisfied', () => {
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=2000-3000', 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=50-10', 1000), { unsatisfiable: true });
});

test('parseRange: no header, several ranges, or nonsense mean "send the whole file"', () => {
  for (const h of [null, undefined, '', 'bytes=0-1,5-6', 'items=0-5', 'bytes=abc', 'bytes=-', 'bytes=']) assert.equal(parseRange(h, 1000), null, String(h));
});

test('mimeOf knows the video and picture types and refuses the rest', () => {
  assert.equal(mimeOf('a.MP4'), 'video/mp4');
  assert.equal(mimeOf('a.webm'), 'video/webm');
  assert.equal(mimeOf('a.png'), 'image/png');
  assert.equal(mimeOf('a.jpg'), 'image/jpeg');
  assert.equal(mimeOf('a.txt'), null);
});
