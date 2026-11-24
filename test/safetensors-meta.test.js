const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSafetensorsMeta } = require('../src/safetensors-meta');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cl-st-'));

// Builds a minimal .safetensors file: 8-byte little-endian header length, JSON header, fake tensor bytes.
function makeFile(header, { claimedLength } = {}) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(claimedLength === undefined ? json.length : claimedLength));
  const file = path.join(tmp(), 'm.safetensors');
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.alloc(64)]));
  return file;
}

test('reads modelspec title and description from __metadata__', () => {
  const f = makeFile({
    __metadata__: { 'modelspec.title': '我的 LoRA', 'modelspec.description': '让皮肤更真实' },
    'w.weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] },
  });
  assert.deepEqual(readSafetensorsMeta(f), { title: '我的 LoRA', description: '让皮肤更真实' });
});

test('a header with no metadata gives nothing', () => {
  const f = makeFile({ 'w.weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] } });
  assert.equal(readSafetensorsMeta(f), null);
});

test('metadata without a title or description gives nothing', () => {
  const f = makeFile({ __metadata__: { format: 'pt', ss_seed: '1' } });
  assert.equal(readSafetensorsMeta(f), null);
});

test('only a title is fine, the description is empty', () => {
  const f = makeFile({ __metadata__: { 'modelspec.title': 'Only title' } });
  assert.deepEqual(readSafetensorsMeta(f), { title: 'Only title', description: '' });
});

test('an absurdly large claimed header is refused without reading it', () => {
  const f = makeFile({ __metadata__: { 'modelspec.title': 'x' } }, { claimedLength: 50 * 1024 * 1024 });
  assert.equal(readSafetensorsMeta(f), null);
});

test('a claimed header longer than the file is refused', () => {
  const f = makeFile({ __metadata__: { 'modelspec.title': 'x' } }, { claimedLength: 100000 });
  assert.equal(readSafetensorsMeta(f), null);
});

test('garbage, a tiny file, and a missing file all give null instead of throwing', () => {
  const d = tmp();
  const garbage = path.join(d, 'g.safetensors');
  fs.writeFileSync(garbage, Buffer.from('this is definitely not a safetensors file at all'));
  assert.equal(readSafetensorsMeta(garbage), null);
  const tiny = path.join(d, 't.safetensors');
  fs.writeFileSync(tiny, 'abc');
  assert.equal(readSafetensorsMeta(tiny), null);
  assert.equal(readSafetensorsMeta(path.join(d, 'missing.safetensors')), null);
});
