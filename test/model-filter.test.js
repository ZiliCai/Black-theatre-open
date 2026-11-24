const test = require('node:test');
const assert = require('node:assert/strict');
const { filterModels, collectTags, groupByCategory } = require('../renderer/model-filter');

const M = (name, category, tags, extra = {}) => ({
  name, relPath: `${category}/${name}`, category, tags, title: extra.title || name, desc: extra.desc || '', family: extra.family || '',
  sizeBytes: extra.sizeBytes || 1, source: extra.source || 'rule',
});
const LIST = [
  M('h3_ref2va.safetensors', '主模型', ['视频生成', '参考图', 'INT8'], { title: 'H3 参考图转视频(Ref2VA)', family: 'MiniMax H3', desc: '带声音的视频' }),
  M('qwen_image.safetensors', '主模型', ['图像生成', '图像编辑'], { title: 'Qwen-Image 2.1 图像模型', family: 'Qwen-Image 2.1' }),
  M('turbo4.safetensors', 'LoRA', ['加速', 'LoRA'], { title: 'H3 Turbo 加速 LoRA(4 步)', family: 'MiniMax H3' }),
  M('wan_vae.safetensors', 'VAE', ['VAE'], { title: 'Wan VAE' }),
];

test('no filter returns everything, in order', () => {
  assert.deepEqual(filterModels(LIST, {}).map((m) => m.name), LIST.map((m) => m.name));
});

test('search matches name, title, description, family and tags, ignoring case', () => {
  assert.deepEqual(filterModels(LIST, { query: 'ref2va' }).map((m) => m.name), ['h3_ref2va.safetensors']);
  assert.deepEqual(filterModels(LIST, { query: '带声音' }).map((m) => m.name), ['h3_ref2va.safetensors']);
  assert.deepEqual(filterModels(LIST, { query: 'qwen-image' }).map((m) => m.name), ['qwen_image.safetensors']);
  assert.deepEqual(filterModels(LIST, { query: '加速' }).map((m) => m.name), ['turbo4.safetensors']);
  assert.deepEqual(filterModels(LIST, { query: 'WAN' }).map((m) => m.name), ['wan_vae.safetensors']);
});

test('several search words must all match', () => {
  assert.deepEqual(filterModels(LIST, { query: 'h3 加速' }).map((m) => m.name), ['turbo4.safetensors']);
  assert.deepEqual(filterModels(LIST, { query: 'h3 不存在' }), []);
});

test('a tag filter keeps only models with that tag', () => {
  assert.deepEqual(filterModels(LIST, { tag: '视频生成' }).map((m) => m.name), ['h3_ref2va.safetensors']);
  assert.deepEqual(filterModels(LIST, { tag: 'LoRA' }).map((m) => m.name), ['turbo4.safetensors']);
});

test('a category filter keeps only that category', () => {
  assert.deepEqual(filterModels(LIST, { category: '主模型' }).map((m) => m.name), ['h3_ref2va.safetensors', 'qwen_image.safetensors']);
});

test('tag, category and search combine', () => {
  assert.deepEqual(filterModels(LIST, { category: '主模型', tag: '图像编辑', query: 'qwen' }).map((m) => m.name), ['qwen_image.safetensors']);
  assert.deepEqual(filterModels(LIST, { category: 'LoRA', tag: '视频生成' }), []);
});

test('collectTags counts and sorts by popularity, then name', () => {
  const tags = collectTags(LIST);
  const byName = Object.fromEntries(tags.map((t) => [t.tag, t.count]));
  assert.equal(byName['视频生成'], 1);
  assert.equal(byName.VAE, 1);
  for (let i = 1; i < tags.length; i++) {
    assert.ok(tags[i - 1].count > tags[i].count || (tags[i - 1].count === tags[i].count && tags[i - 1].tag.localeCompare(tags[i].tag, 'zh') <= 0));
  }
});

test('collectTags on a filtered list only counts what is shown', () => {
  const tags = collectTags(filterModels(LIST, { category: 'LoRA' }));
  assert.deepEqual(tags.map((t) => t.tag).sort(), ['LoRA', '加速']);
});

test('groupByCategory keeps the incoming category order and totals the size', () => {
  const groups = groupByCategory([
    M('a', '主模型', [], { sizeBytes: 10 }), M('b', '主模型', [], { sizeBytes: 5 }), M('c', 'LoRA', [], { sizeBytes: 2 }),
  ]);
  assert.deepEqual(groups.map((g) => [g.category, g.models.length, g.sizeBytes]), [['主模型', 2, 15], ['LoRA', 1, 2]]);
});

test('an empty list gives no groups and no tags', () => {
  assert.deepEqual(groupByCategory([]), []);
  assert.deepEqual(collectTags([]), []);
  assert.deepEqual(filterModels([], { query: 'x' }), []);
});
