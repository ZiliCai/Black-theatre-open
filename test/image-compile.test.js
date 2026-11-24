const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTemplate, listTemplates } = require('../src/workflow-template');
const { compileImage, familyOf } = require('../src/image-compile');
const { pickImage, findImage, takeFiles } = require('../src/take-outputs');

const templates = path.join(__dirname, '..', 'workflow-templates');
const t2i = () => loadTemplate(path.join(templates, 'qwen-image-t2i'));
const i2i = () => loadTemplate(path.join(templates, 'qwen-image-i2i'));

test('the image templates load and say they are image templates', () => {
  const listed = listTemplates(templates);
  for (const id of ['qwen-image-t2i', 'qwen-image-i2i']) {
    const found = listed.find((t) => t.dirName === id);
    assert.ok(found && found.compatible, id);
    assert.equal(found.kind, 'image');
  }
  assert.equal(familyOf(t2i().manifest), 'qwen-image');
  assert.equal(familyOf(loadTemplate(path.join(templates, 'minimax-h3-wenwu-cont')).manifest), 'h3');
  assert.equal(familyOf({ kind: 'video' }), 'h3');
});

test('text-to-image fills prompt, size, seed and the output name', () => {
  const r = compileImage(t2i(), { prompt: '一位骑行者', aspect: '16:9', seed: 42 }, { outputKey: 'bb_qx-t001-abcd' });
  assert.equal(r.ok, true);
  const g = r.workflow;
  assert.equal(g['4'].inputs.prompt, '一位骑行者');
  assert.deepEqual([g['5'].inputs.width, g['5'].inputs.height], [1664, 928]);
  assert.deepEqual([r.width, r.height], [1664, 928]);
  assert.equal(g['6'].inputs.seed, 42);
  assert.equal(g['8'].inputs.filename_prefix, 'ref/bb_qx-t001-abcd');
  assert.notEqual(t2i().graph['4'].inputs.prompt, '一位骑行者'); // the template itself is untouched
});

test('a missing seed becomes a random one', () => {
  const a = compileImage(t2i(), { prompt: 'x', aspect: '3:4' });
  const b = compileImage(t2i(), { prompt: 'x', aspect: '3:4' });
  assert.ok(Number.isSafeInteger(a.seed) && a.seed >= 0);
  assert.notEqual(a.seed, b.seed);
});

test('image-to-image needs a picture from the output folder', () => {
  assert.deepEqual(compileImage(i2i(), { prompt: '侧面', image: 'C:\\x.png' }).errors, ['请选择一张输出目录里的图作为基础']);
  const r = compileImage(i2i(), { prompt: '侧面', image: 'ref/QX_骑行者_全身.png [output]' }, { outputKey: 'bb_qx-t002-a1b2' });
  assert.equal(r.ok, true);
  assert.equal(r.workflow['9'].inputs.image, 'ref/QX_骑行者_全身.png [output]');
  assert.deepEqual(r.workflow['4'].inputs['images.image_1'], ['9', 0]);
  assert.equal(r.width, null); // the size follows the picture
});

test('empty prompt, unknown size and a non-ASCII output name are refused', () => {
  assert.deepEqual(compileImage(t2i(), { prompt: ' ', aspect: '5:4' }).errors, ['提示词不能为空', '未知的尺寸']);
  assert.equal(compileImage(t2i(), { prompt: 'x', aspect: '1:1' }, { outputKey: 'bb_何遇' }).ok, false);
});

test('pickImage finds the take own picture in history outputs', () => {
  const outputs = {
    8: { images: [
      { filename: 'bb_qx-t001-abcd_00001_.png', subfolder: 'ref', type: 'output' },
      { filename: 'other_00001_.png', subfolder: 'ref', type: 'output' },
    ] },
    9: { images: [{ filename: 'bb_qx-t001-abcd_temp.png', subfolder: '', type: 'temp' }] },
  };
  assert.equal(pickImage(outputs, 'bb_qx-t001-abcd'), 'ref/bb_qx-t001-abcd_00001_.png');
  assert.equal(pickImage(outputs, 'bb_none'), null);
  assert.equal(pickImage({ 1: { images: [{ filename: 'bb_k_1.png', subfolder: '..', type: 'output' }] } }, 'bb_k'), null);
});

test('findImage looks for the take name in ref/ and takeFiles includes the picture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-out-'));
  assert.equal(findImage(dir, 'bb_k1'), null);
  fs.mkdirSync(path.join(dir, 'ref'));
  fs.writeFileSync(path.join(dir, 'ref', 'bb_k1_00001_.png'), 'x');
  fs.writeFileSync(path.join(dir, 'ref', 'bb_k10_00001_.png'), 'x');
  assert.equal(findImage(dir, 'bb_k1'), 'ref/bb_k1_00001_.png');
  assert.deepEqual(takeFiles(dir, { image: 'ref/bb_k1_00001_.png' }), [path.join(dir, 'ref', 'bb_k1_00001_.png')]);
});
