const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readMediaMeta } = require('../src/media-meta');

const FIX = path.join(__dirname, 'fixtures', 'media');
const SAMPLE_MP4 = path.join(FIX, 'sample-h3.mp4'); // 64x48, 0.5 s, ComfyUI-style prompt/workflow tags

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-meta-'));

// ---------- helpers that build files byte by byte ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const ihdr = (w, h) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8; d[9] = 2;
  return pngChunk('IHDR', d);
};
const text = (key, value) => pngChunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
const itext = (key, value, compressed = false) => pngChunk('iTXt', Buffer.concat([
  Buffer.from(key, 'latin1'), Buffer.from([0, compressed ? 1 : 0, 0, 0, 0]),
  compressed ? zlib.deflateSync(Buffer.from(value, 'utf8')) : Buffer.from(value, 'utf8'),
]));
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...chunks) => Buffer.concat([PNG_SIG, ihdr(10, 20), ...chunks, pngChunk('IEND', Buffer.alloc(0))]);

function writeTmp(name, buf) {
  const file = path.join(tmp(), name);
  fs.writeFileSync(file, buf);
  return file;
}

// ---------- mp4 ----------
test('mp4: reads size, length and the prompt / workflow tags ComfyUI embeds', () => {
  const m = readMediaMeta(SAMPLE_MP4);
  assert.equal(m.kind, 'video');
  assert.equal(m.width, 64);
  assert.equal(m.height, 48);
  assert.ok(Math.abs(m.duration - 0.5) < 0.1, `duration ${m.duration}`);
  // Python writes bare NaN into these, so the text is not strict JSON; prompt-summary has the tolerant parser
  assert.match(m.tags.prompt, /"class_type":\s*"SaveVideo"/);
  assert.equal(m.tags.workflow, '{"nodes":[]}');
});

test('mp4: Chinese text inside the tags survives', () => {
  const m = readMediaMeta(SAMPLE_MP4);
  assert.ok(m.tags.prompt.includes('角色甲_00001_.png'));
});

test('mp4: finds the tags when the moov box comes after mdat', () => {
  const src = fs.readFileSync(SAMPLE_MP4);
  const boxes = [];
  for (let i = 0; i + 8 <= src.length;) {
    const size = src.readUInt32BE(i);
    boxes.push({ type: src.toString('latin1', i + 4, i + 8), buf: src.subarray(i, i + size) });
    i += size;
  }
  const by = (t) => boxes.find((b) => b.type === t).buf;
  const file = writeTmp('moov-last.mp4', Buffer.concat([by('ftyp'), by('mdat'), by('moov')]));
  const m = readMediaMeta(file);
  assert.equal(m.width, 64);
  assert.match(m.tags.prompt, /"class_type":\s*"SaveVideo"/);
});

test('mp4: a file with no embedded tags still gives size and length', () => {
  // ffmpeg without +use_metadata_tags drops unknown keys, which is what a non-ComfyUI video looks like
  const src = fs.readFileSync(SAMPLE_MP4);
  const moovAt = src.indexOf(Buffer.from('moov')) - 4;
  const moovSize = src.readUInt32BE(moovAt);
  const udtaAt = src.indexOf(Buffer.from('udta'), moovAt) - 4;
  const udtaSize = src.readUInt32BE(udtaAt);
  const stripped = Buffer.concat([src.subarray(0, udtaAt), src.subarray(udtaAt + udtaSize)]);
  stripped.writeUInt32BE(moovSize - udtaSize, moovAt); // shrink moov by the removed udta
  const m = readMediaMeta(writeTmp('plain.mp4', stripped));
  assert.equal(m.width, 64);
  assert.deepEqual(m.tags, {});
});

test('mp4: truncated, garbage, empty and missing files give an empty result, never throw', () => {
  const src = fs.readFileSync(SAMPLE_MP4);
  for (const buf of [src.subarray(0, 100), Buffer.from('not a video at all'), Buffer.alloc(0), src.subarray(0, 60)]) {
    const m = readMediaMeta(writeTmp('bad.mp4', buf));
    assert.deepEqual(m.tags, {});
  }
  assert.deepEqual(readMediaMeta(path.join(tmp(), 'nope.mp4')).tags, {});
});

test('mp4: a box whose size runs past the end of the file stops the walk instead of looping', () => {
  const evil = Buffer.alloc(16);
  evil.writeUInt32BE(0xffffffff - 4, 0); // claims a ~4 GB box
  evil.write('moov', 4, 'latin1');
  assert.deepEqual(readMediaMeta(writeTmp('evil.mp4', evil)).tags, {});
  const zero = Buffer.alloc(16);
  zero.write('free', 4, 'latin1'); // size 0 = "to end of file"
  assert.deepEqual(readMediaMeta(writeTmp('zero.mp4', zero)).tags, {});
});

// ---------- png ----------
test('png: reads size and the tEXt prompt / workflow chunks', () => {
  const file = writeTmp('a.png', png(text('prompt', '{"3":{"class_type":"KSampler"}}'), text('workflow', '{"nodes":[]}')));
  const m = readMediaMeta(file);
  assert.equal(m.kind, 'image');
  assert.equal(m.width, 10);
  assert.equal(m.height, 20);
  assert.equal(m.tags.prompt, '{"3":{"class_type":"KSampler"}}');
  assert.equal(m.tags.workflow, '{"nodes":[]}');
});

test('png: iTXt (UTF-8) chunks work, compressed or not', () => {
  const m = readMediaMeta(writeTmp('b.png', png(itext('prompt', '{"名字":"中文"}'), itext('workflow', '{"a":"银"}', true))));
  assert.equal(m.tags.prompt, '{"名字":"中文"}');
  assert.equal(m.tags.workflow, '{"a":"银"}');
});

test('png: other text keys are ignored and a plain png has no tags', () => {
  assert.deepEqual(readMediaMeta(writeTmp('c.png', png(text('Software', 'x')))).tags, {});
  assert.deepEqual(readMediaMeta(writeTmp('d.png', png())).tags, {});
});

test('png: a damaged file gives an empty result', () => {
  assert.deepEqual(readMediaMeta(writeTmp('e.png', png(text('prompt', '{}')).subarray(0, 30))).tags, {});
  assert.deepEqual(readMediaMeta(writeTmp('f.png', Buffer.from('nope'))).tags, {});
});

test('other extensions are not read', () => {
  assert.deepEqual(readMediaMeta(writeTmp('g.txt', Buffer.from('hi'))), { kind: null, tags: {} });
});
