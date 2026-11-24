const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeModel, scanModels, CATEGORY_ORDER } = require('../src/model-catalog');
const { RULES } = require('../src/model-rules');

const MB = 1024 * 1024;

// ---------- real file names from the user's models folder ----------
// [relative path, expected source, category, family, tags that must be present, regex the title must match]
const REAL = [
  ['diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'rule', '主模型', 'MiniMax H3', ['视频生成', '参考图', '带音频', 'INT8'], /Ref2VA/],
  ['diffusion_models/H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'rule', '主模型', 'MiniMax H3', ['视频生成', '首尾帧', 'INT8'], /FL2VA/],
  ['unet/MiniMax-H3-Ref2VA-Q3_K_M.gguf', 'rule', '主模型', 'MiniMax H3', ['视频生成', 'GGUF', 'Q3_K_M'], /Ref2VA/],
  ['unet/MiniMax-H3-FL2VA-Q3_K_M.gguf', 'rule', '主模型', 'MiniMax H3', ['视频生成', 'GGUF', 'Q3_K_M'], /FL2VA/],
  ['diffusion_models/H3/minimaxH3Singularity_prunedInt8.safetensors', 'guess', '主模型', 'MiniMax H3', ['视频生成', 'INT8'], /minimaxH3Singularity/],
  ['diffusion_models/qwen_image_2.1_int8_convrot.safetensors', 'rule', '主模型', 'Qwen-Image 2.1', ['图像生成', '图像编辑', 'INT8'], /Qwen-Image 2\.1/],
  ['diffusion_models/qwen-image-2.1-UC-Q4_K_M.gguf', 'rule', '主模型', 'Qwen-Image 2.1', ['图像生成', 'GGUF', 'Q4_K_M'], /Qwen-Image 2\.1/],
  ['diffusion_models/qwen_image_2.1_turbo_Q8_0.gguf', 'rule', '主模型', 'Qwen-Image 2.1', ['图像生成', '加速', 'GGUF', 'Q8_0'], /Turbo/],
  ['loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['加速', 'LoRA', '首尾帧', 'BF16'], /4 步/],
  ['loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['加速', 'LoRA', '首尾帧'], /8 步/],
  ['loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['加速', 'LoRA', '首尾帧'], /8 步/],
  ['loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['加速', 'LoRA', '参考图'], /4 步/],
  ['loras/minimax_h3_turbo_v4_step600_ema.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['加速', 'LoRA'], /Turbo v4/],
  ['loras/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['加速', 'LoRA'], /Turbo v4/],
  ['loras/h3-realism-people-t2v-i2v-r2v.safetensors', 'rule', 'LoRA', 'MiniMax H3', ['写实', 'LoRA'], /写实/],
  ['text_encoders/qwen3vl_32b_minimax_h3-Q4_K_M.gguf', 'rule', '文本编码器', 'MiniMax H3', ['文本编码', 'GGUF', 'Q4_K_M'], /H3 文本编码器/],
  ['text_encoders/qwen/qwen3vl_32b_minimax_h3_int8_convrot.safetensors', 'rule', '文本编码器', 'MiniMax H3', ['文本编码', 'INT8'], /H3 文本编码器/],
  ['text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'rule', '文本编码器', 'MiniMax H3', ['文本编码', 'NVFP4'], /H3 文本编码器/],
  ['text_encoders/qwen3vl_8b_int8_convrot.safetensors', 'rule', '文本编码器', 'Qwen-Image 2.1', ['文本编码', 'INT8'], /Qwen3-VL 8B/],
  ['text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'rule', '文本编码器', 'Wan 2.2', ['文本编码', 'FP8'], /UMT5/],
  ['vae/H3/minimax_h3_video_vae_fp16.safetensors', 'rule', 'VAE', 'MiniMax H3', ['VAE', 'FP16'], /视频 VAE/],
  ['vae/minimax_h3_audio_vae_fp32.safetensors', 'rule', 'VAE', 'MiniMax H3', ['VAE', 'FP32'], /音频 VAE/],
  ['vae/minimax_h3_vae_decoder.engine', 'rule', 'VAE', 'MiniMax H3', ['VAE', 'TensorRT'], /解码/],
  ['vae/minimax_h3_vae_encoder.engine', 'rule', 'VAE', 'MiniMax H3', ['VAE', 'TensorRT'], /编码/],
  ['vae/minimax_h3_vae_decoder.onnx', 'rule', 'VAE', 'MiniMax H3', ['VAE', 'ONNX'], /解码/],
  ['vae/minimax_h3_vae_encoder.onnx', 'rule', 'VAE', 'MiniMax H3', ['VAE', 'ONNX'], /编码/],
  ['vae/qwen_image_2.1_vae_bf16.safetensors', 'rule', 'VAE', 'Qwen-Image 2.1', ['VAE', 'BF16'], /Qwen-Image/],
  ['vae/wan_2.1_vae.safetensors', 'rule', 'VAE', 'Wan 2.2', ['VAE'], /Wan/],
  ['LLM/Qwen3.8-27B-Q3_K_M.gguf', 'rule', '大语言模型', 'Qwen 3.8 LLM', ['大语言模型', 'GGUF', 'Q3_K_M'], /Qwen3\.8 27B/],
  ['LLM/Qwen3.8-27B-UD-Q4_K_M.gguf', 'rule', '大语言模型', 'Qwen 3.8 LLM', ['大语言模型', 'GGUF'], /Qwen3\.8 27B/],
  ['LLM/Qwen3.8-27B-UD-Q5_K_M.gguf', 'rule', '大语言模型', 'Qwen 3.8 LLM', ['大语言模型', 'GGUF'], /Qwen3\.8 27B/],
  ['LLM/Qwen3.8-mmproj-BF16.gguf', 'rule', '大语言模型', 'Qwen 3.8 LLM', ['多模态', 'BF16'], /mmproj/],
  ['LLM/3.5mmproj-BF16.gguf', 'rule', '大语言模型', 'Qwen 3.5 LLM', ['多模态', 'BF16'], /mmproj/],
  ['LLM/Qwen3.5-4B-Q4_K_M.gguf', 'rule', '大语言模型', 'Qwen 3.5 LLM', ['大语言模型', 'GGUF'], /4B/],
  ['SEEDVR2/seedvr2_ema_3b-Q8_0.gguf', 'rule', '放大 / 画质', 'SeedVR2', ['画质放大', 'GGUF', 'Q8_0'], /SeedVR2/],
  ['SEEDVR2/ema_vae_fp16.safetensors', 'rule', '放大 / 画质', 'SeedVR2', ['VAE', 'FP16'], /SeedVR2 VAE/],
  ['latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors', 'rule', '放大 / 画质', 'MiniMax H3', ['画质放大', 'FP16'], /潜空间/],
];

for (const [rel, source, category, family, tags, title] of REAL) {
  test(`describes ${rel}`, () => {
    const m = describeModel({ relPath: rel, sizeBytes: 123 });
    assert.equal(m.source, source, `source of ${rel}`);
    assert.equal(m.category, category);
    assert.equal(m.family, family);
    for (const t of tags) assert.ok(m.tags.includes(t), `${rel} should be tagged "${t}", got ${JSON.stringify(m.tags)}`);
    assert.match(m.title, title);
    assert.ok(m.desc.length > 10, 'every entry needs a real description');
    assert.equal(m.name, path.posix.basename(rel));
    assert.equal(m.sizeBytes, 123);
  });
}

// ---------- details of specific descriptions ----------
const desc = (rel) => describeModel({ relPath: rel, sizeBytes: 1 }).desc;

test('Turbo LoRA descriptions say the step count, the mode and the resolution', () => {
  assert.match(desc('loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors'), /4 步.*首尾帧.*768p|768p.*4 步/s);
  assert.match(desc('loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'), /v0\.1/);
  assert.match(desc('loras/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors'), /精简/);
  assert.match(desc('loras/minimax_h3_turbo_v4_step600_ema.safetensors'), /8 步/);
});

test('NVFP4 encoder says it only speeds up on newer cards', () => {
  assert.match(desc('text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'), /RTX 50/);
});

test('the TensorRT engine says it is tied to the card; the ONNX says it is the source', () => {
  assert.match(desc('vae/minimax_h3_vae_decoder.engine'), /显卡/);
  assert.match(desc('vae/minimax_h3_vae_decoder.onnx'), /重新生成|重建/);
});

test('the Qwen Turbo mentions how to load it', () => {
  assert.match(desc('diffusion_models/qwen_image_2.1_turbo_Q8_0.gguf'), /UnetLoaderGGUF/);
});

// ---------- guessing ----------
test('an unknown checkpoint is a guess, says so, and still gets format tags and a category', () => {
  const m = describeModel({ relPath: 'checkpoints/someDreamModel_v3_fp16.safetensors', sizeBytes: 1 });
  assert.equal(m.source, 'guess');
  assert.equal(m.category, '主模型');
  assert.ok(m.tags.includes('FP16'));
  assert.match(m.desc, /推测/);
  assert.equal(m.title, 'someDreamModel_v3_fp16');
});

test('an unknown LoRA is tagged LoRA', () => {
  const m = describeModel({ relPath: 'loras/unknown_style_lora.safetensors', sizeBytes: 1 });
  assert.equal(m.source, 'guess');
  assert.equal(m.category, 'LoRA');
  assert.ok(m.tags.includes('LoRA'));
});

test('keywords in an unknown name give function and format tags', () => {
  const m = describeModel({ relPath: 'diffusion_models/something_i2v_turbo_Q4_K_M.gguf', sizeBytes: 1 });
  for (const t of ['视频生成', '加速', 'GGUF', 'Q4_K_M']) assert.ok(m.tags.includes(t), `missing ${t}: ${m.tags}`);
});

test('an unknown top-level folder becomes its own category', () => {
  assert.equal(describeModel({ relPath: 'controlnet/foo.safetensors', sizeBytes: 1 }).category, 'controlnet');
});

test('every rule has tags, a title and a description (data sanity)', () => {
  assert.ok(RULES.length >= 25);
  for (const r of RULES) {
    assert.ok(r.match instanceof RegExp);
    assert.ok(Array.isArray(r.tags) && r.tags.length > 0, `tags of ${r.match}`);
    assert.ok(r.title && r.desc, `title/desc of ${r.match}`);
  }
});

// ---------- scanning a real folder tree ----------
function sparse(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

function makeModels() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-models-'));
  sparse(path.join(root, 'diffusion_models', 'a.safetensors'), 5 * MB);
  sparse(path.join(root, 'diffusion_models', 'H3', 'b.gguf'), 5 * MB);
  sparse(path.join(root, 'loras', 'x.safetensors'), 2 * MB);
  sparse(path.join(root, 'vae', 'minimax_h3_vae_decoder.onnx'), 2 * MB);
  sparse(path.join(root, 'vae', 'minimax_h3_vae_decoder.onnx.data'), 3 * MB);
  sparse(path.join(root, 'vae', 'minimax_h3_vae_decoder.engine'), 2 * MB);
  sparse(path.join(root, 'text_encoders', 'tiny.safetensors'), MB / 2); // < 1 MB: ignored
  fs.mkdirSync(path.join(root, 'empty_folder'));
  fs.writeFileSync(path.join(root, 'loras', 'readme.txt'), 'x'.repeat(2 * MB));
  fs.writeFileSync(path.join(root, 'loras', 'config.json'), 'x'.repeat(2 * MB));
  sparse(path.join(root, 'loras', 'a', 'b', 'c', 'd', 'too_deep.safetensors'), 2 * MB); // depth > 3
  return root;
}

test('scans models, ignoring small files, non-model files and anything too deep', () => {
  const r = scanModels(makeModels(), { readMeta: () => null });
  assert.deepEqual(r.models.map((m) => m.relPath).sort(), [
    'diffusion_models/H3/b.gguf', 'diffusion_models/a.safetensors', 'loras/x.safetensors',
    'vae/minimax_h3_vae_decoder.engine', 'vae/minimax_h3_vae_decoder.onnx',
  ]);
  assert.equal(r.count, 5);
});

test('the .onnx.data file is folded into its .onnx, and totals add up', () => {
  const r = scanModels(makeModels(), { readMeta: () => null });
  const onnx = r.models.find((m) => m.name === 'minimax_h3_vae_decoder.onnx');
  assert.equal(onnx.sizeBytes, 5 * MB);
  assert.equal(r.totalBytes, (5 + 5 + 2 + 5 + 2) * MB);
});

test('models come out grouped in category order, then by path', () => {
  const r = scanModels(makeModels(), { readMeta: () => null });
  const cats = r.models.map((m) => m.category);
  const order = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? 999 : i; };
  assert.deepEqual(cats, [...cats].sort((a, b) => order(a) - order(b)));
  assert.deepEqual(cats.filter((c, i) => cats.indexOf(c) === i), ['主模型', 'LoRA', 'VAE']);
});

test('entries carry a modified time and forward-slash relative paths', () => {
  const r = scanModels(makeModels(), { readMeta: () => null });
  for (const m of r.models) {
    assert.ok(m.mtime > 0);
    assert.equal(m.relPath.includes('\\'), false);
  }
});

test('file-header metadata is used for an unknown safetensors, and marked as such', () => {
  const root = makeModels();
  const r = scanModels(root, { readMeta: (f) => (f.endsWith('x.safetensors') ? { title: '我的风格 LoRA', description: '来自文件头的简介' } : null) });
  const x = r.models.find((m) => m.name === 'x.safetensors');
  assert.equal(x.source, 'metadata');
  assert.equal(x.title, '我的风格 LoRA');
  assert.equal(x.desc, '来自文件头的简介');
  assert.ok(x.tags.includes('LoRA'));
});

test('a built-in rule beats the file header', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-models-'));
  sparse(path.join(root, 'loras', 'h3-realism-people-t2v-i2v-r2v.safetensors'), 2 * MB);
  const r = scanModels(root, { readMeta: () => ({ title: 'realism_people_v1…', description: '' }) });
  assert.equal(r.models[0].source, 'rule');
  assert.match(r.models[0].title, /写实/);
});

test('a header reader that throws does not break the scan', () => {
  const r = scanModels(makeModels(), { readMeta: () => { throw new Error('disk error'); } });
  assert.equal(r.count, 5);
});

test('the real header reader works end to end on a padded file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-models-'));
  const header = Buffer.from(JSON.stringify({ __metadata__: { 'modelspec.title': 'Real Header Title' } }), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  fs.mkdirSync(path.join(root, 'loras'));
  fs.writeFileSync(path.join(root, 'loras', 'real.safetensors'), Buffer.concat([len, header, Buffer.alloc(2 * MB)]));
  const r = scanModels(root);
  assert.equal(r.models[0].source, 'metadata');
  assert.equal(r.models[0].title, 'Real Header Title');
});

test('a missing models folder gives an empty result', () => {
  assert.deepEqual(scanModels(path.join(os.tmpdir(), 'cl-none-' + Date.now())), { models: [], count: 0, totalBytes: 0 });
});

test('Chinese and spaces in folder and file names are fine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-models-'));
  sparse(path.join(root, 'loras', '我的 文件夹', '风格 一号.safetensors'), 2 * MB);
  const r = scanModels(root, { readMeta: () => null });
  assert.equal(r.models[0].relPath, 'loras/我的 文件夹/风格 一号.safetensors');
  assert.equal(r.models[0].name, '风格 一号.safetensors');
});

// ---------- live-preview decoders (models/vae_approx) ----------
test('taeh3 is the H3 live-preview decoder used by the workflow\'s preview node', () => {
  const m = describeModel({ relPath: 'vae_approx/taeh3.safetensors', sizeBytes: 5 * MB });
  assert.equal(m.source, 'rule');
  assert.equal(m.category, 'VAE');
  assert.equal(m.family, 'MiniMax H3');
  assert.ok(m.tags.includes('实时预览'));
  assert.match(m.title, /H3/);
});

test('the TAESD family are recognised as preview decoders, not guessed', () => {
  for (const f of ['taesd_decoder', 'taesd_encoder', 'taesdxl_decoder', 'taesdxl_encoder', 'taef1_decoder', 'taef1_encoder']) {
    const m = describeModel({ relPath: `vae_approx/${f}.safetensors`, sizeBytes: 5 * MB });
    assert.equal(m.source, 'rule', f);
    assert.ok(m.tags.includes('实时预览'), f);
    assert.match(m.desc, /预览/);
  }
});

test('the TAESD title says which model family it previews', () => {
  const t = (f) => describeModel({ relPath: `vae_approx/${f}.safetensors`, sizeBytes: 1 }).title;
  assert.match(t('taesd_decoder'), /SD/);
  assert.match(t('taesdxl_decoder'), /SDXL/);
  assert.match(t('taef1_decoder'), /Flux/);
  assert.match(t('taesd_encoder'), /编码/);
  assert.match(t('taesd_decoder'), /解码/);
});
