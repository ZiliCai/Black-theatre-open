// Filling an image template (Qwen-Image 2.1 text-to-image or image-to-image) for one take: its prompt, seed, size or
// the picture it starts from, and a unique output name. Plain Node, no Electron.
const crypto = require('node:crypto');
const { validReference } = require('./workflow-compile');

const clone = (value) => JSON.parse(JSON.stringify(value));
const setValue = (graph, binding, value) => { graph[binding.node].inputs[binding.input] = value; };

// The model family a template loads: switching between families is when ComfyUI should free its memory.
function familyOf(manifest) {
  if (manifest && typeof manifest.family === 'string' && manifest.family) return manifest.family;
  return manifest && manifest.kind === 'image' ? 'qwen-image' : 'h3';
}

// input: { prompt, aspect, seed?, image? } where image is "<path in the output folder> [output]".
// outputKey: the take's unique ASCII name; the picture is saved as ref/<outputKey>_00001_.png.
function compileImage(template, input = {}, { outputKey = null } = {}) {
  const { manifest: m, graph: original } = template;
  const bindings = m.bindings || {};
  const errors = [];
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const maxChars = (m.limits && m.limits.promptMaxChars) || 20000;
  if (!prompt.trim()) errors.push('提示词不能为空');
  if (prompt.length > maxChars) errors.push(`提示词不能超过 ${maxChars} 字`);
  let width = null;
  let height = null;
  if (bindings.width) {
    const aspect = (m.aspects || []).find((a) => a.id === input.aspect);
    if (!aspect) errors.push('未知的尺寸');
    else ({ w: width, h: height } = aspect);
  }
  const image = typeof input.image === 'string' ? input.image.trim() : '';
  if (bindings.image && !validReference(image)) errors.push('请选择一张输出目录里的图作为基础');
  if (outputKey !== null && !/^[A-Za-z0-9_-]+$/.test(String(outputKey))) errors.push('输出名只能是字母、数字、下划线和短横线');
  if (errors.length) return { ok: false, errors };

  const given = Number(input.seed);
  const seed = Number.isSafeInteger(given) && given >= 0 ? given : crypto.randomBytes(6).readUIntBE(0, 6);
  const graph = clone(original);
  setValue(graph, bindings.prompt, prompt);
  if (bindings.seed) setValue(graph, bindings.seed, seed);
  if (bindings.width) setValue(graph, bindings.width, width);
  if (bindings.height) setValue(graph, bindings.height, height);
  if (bindings.image) setValue(graph, bindings.image, image);
  if (outputKey && m.outputs && m.outputs.imagePrefix) setValue(graph, m.outputs.imagePrefix, `ref/${outputKey}`);
  return { ok: true, workflow: graph, seed, width, height };
}

module.exports = { compileImage, familyOf };
