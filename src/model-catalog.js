// Scans <ComfyUI>\models and describes every model: category, tags, title, short description.
const fs = require('node:fs');
const path = require('node:path');
const { RULES } = require('./model-rules');
const { readSafetensorsMeta } = require('./safetensors-meta');

const MIN_BYTES = 1024 * 1024;
const MAX_DEPTH = 3;
const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|onnx|engine|bin)$/i;

const CATEGORY_ORDER = ['主模型', 'LoRA', '文本编码器', 'VAE', '大语言模型', '放大 / 画质'];
const FOLDER_CATEGORY = {
  diffusion_models: '主模型', unet: '主模型', checkpoints: '主模型',
  loras: 'LoRA',
  text_encoders: '文本编码器', clip: '文本编码器',
  vae: 'VAE', vae_approx: 'VAE',
  llm: '大语言模型',
  seedvr2: '放大 / 画质', upscale_models: '放大 / 画质', latent_upscale_models: '放大 / 画质',
};

const categoryOf = (folder) => FOLDER_CATEGORY[folder.toLowerCase()] || folder;

// Format / precision tags from the file name (these are facts about the file, not guesses).
function formatTags(name) {
  const n = name.toLowerCase();
  const tags = [];
  if (n.endsWith('.gguf')) tags.push('GGUF');
  const quant = name.match(/(?:^|[-_.])((?:UD-)?I?Q\d(?:_[A-Z0-9]+)*)(?=[-_.]|$)/i);
  if (quant && n.endsWith('.gguf')) tags.push(quant[1].replace(/^UD-/i, '').toUpperCase());
  if (/int8/.test(n)) tags.push('INT8');
  if (/fp8/.test(n)) tags.push('FP8');
  if (/nvfp4/.test(n)) tags.push('NVFP4');
  if (/bf16/.test(n)) tags.push('BF16');
  else if (/fp16/.test(n)) tags.push('FP16');
  if (/fp32/.test(n)) tags.push('FP32');
  if (n.endsWith('.onnx')) tags.push('ONNX');
  if (n.endsWith('.engine')) tags.push('TensorRT');
  return tags;
}

// Keyword guesses for files no rule knows. Always labelled as guesses.
const GUESS_KEYWORDS = [
  [/i2v|t2v|ref2v|fl2v|ref2va|fl2va|wan|video|minimax[-_]?h3/, '视频生成'],
  [/qwen[-_]?image|z[-_]?image|flux|sdxl/, '图像生成'],
  [/turbo|lightning|lcm|distill|\d+[-_]?step/, '加速'],
  [/realism|realistic/, '写实'],
];
const FAMILY_GUESS = [
  [/minimax|h3/, 'MiniMax H3'],
  [/qwen[-_]?image/, 'Qwen-Image'],
  [/wan/, 'Wan'],
];

const uniq = (list) => [...new Set(list)];
const resolve = (v, m, name) => (typeof v === 'function' ? v(m, name) : v);

function findRule(relPath, name) {
  const folder = relPath.split('/')[0];
  const haystack = name.toLowerCase();
  for (const rule of RULES) {
    if (rule.categories && !rule.categories.map((c) => c.toLowerCase()).includes(folder.toLowerCase())) continue;
    const m = haystack.match(rule.match);
    if (m) return { rule, m };
  }
  return null;
}

function describeModel({ relPath, sizeBytes }) {
  const name = path.posix.basename(relPath);
  const folder = relPath.split('/')[0];
  const category = categoryOf(folder);
  const base = { name, relPath, folder, category, sizeBytes };
  const fmt = formatTags(name);

  const hit = findRule(relPath, name);
  if (hit) {
    const { rule, m } = hit;
    const funcTags = [...rule.tags, ...(rule.tagsFn ? rule.tagsFn(m) : [])];
    return {
      ...base,
      family: rule.familyFn ? rule.familyFn(name) : rule.family || '',
      tags: uniq([...funcTags, ...(category === 'LoRA' ? ['LoRA'] : []), ...fmt]),
      title: resolve(rule.title, m, name),
      desc: resolve(rule.desc, m, name),
      source: 'rule',
    };
  }

  const lower = name.toLowerCase();
  const func = GUESS_KEYWORDS.filter(([re]) => re.test(lower)).map(([, tag]) => tag);
  const family = (FAMILY_GUESS.find(([re]) => re.test(lower)) || [null, ''])[1];
  const tags = uniq([...func, ...(category === 'LoRA' ? ['LoRA'] : []), ...fmt]);
  const label = tags.length ? tags.join('、') : category;
  return {
    ...base,
    family,
    tags,
    title: name.replace(/\.(safetensors|gguf|ckpt|pt|pth|onnx|engine|bin)$/i, ''),
    desc: `${label}(推测:根据文件夹和文件名判断,不一定准确)`,
    source: 'guess',
  };
}

function collect(dir, depth, relBase, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) collect(full, depth + 1, rel, out);
    } else if (e.isFile()) {
      out.push({ full, rel });
    }
  }
}

function scanModels(modelsDir, { readMeta = readSafetensorsMeta } = {}) {
  const files = [];
  collect(modelsDir, 1, '', files);

  // .onnx.data is the weight blob of an .onnx: fold its size into the .onnx entry.
  const dataSize = new Map();
  for (const f of files) {
    if (/\.onnx\.data$/i.test(f.rel)) dataSize.set(f.rel.slice(0, -5).toLowerCase(), fs.statSync(f.full).size);
  }

  const models = [];
  for (const f of files) {
    if (!MODEL_EXT.test(f.rel) || /\.onnx\.data$/i.test(f.rel)) continue;
    let st;
    try {
      st = fs.statSync(f.full);
    } catch {
      continue;
    }
    const sizeBytes = st.size + (dataSize.get(f.rel.toLowerCase()) || 0);
    if (sizeBytes < MIN_BYTES) continue;

    let model = { ...describeModel({ relPath: f.rel, sizeBytes }), mtime: st.mtimeMs };
    if (model.source === 'guess' && /\.safetensors$/i.test(f.rel)) {
      let meta = null;
      try {
        meta = readMeta(f.full);
      } catch {
        meta = null; // one unreadable header must not stop the scan
      }
      if (meta) {
        model = {
          ...model,
          source: 'metadata',
          title: meta.title || model.title,
          desc: meta.description || (meta.title ? `${model.tags.join('、') || model.category}(来自文件头)` : model.desc),
        };
      }
    }
    models.push(model);
  }

  const order = (c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  models.sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category) || a.relPath.localeCompare(b.relPath));

  return { models, count: models.length, totalBytes: models.reduce((sum, m) => sum + m.sizeBytes, 0) };
}

module.exports = { describeModel, scanModels, formatTags, CATEGORY_ORDER };
