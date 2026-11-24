const crypto = require('node:crypto');
const { templateForm } = require('./workflow-template');
const { dimensions, resolutionTier, frameCount } = require('../renderer/workflow-math');
const { ensureNoSubtitles } = require('./prompt-hygiene');

const clone = (value) => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function setValue(graph, binding, value) {
  graph[binding.node].inputs[binding.input] = value;
}

function diffWorkflow(before, after) {
  const changes = [];
  const nodeIds = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => Number(a) - Number(b));
  for (const nodeId of nodeIds) {
    const a = before[nodeId];
    const b = after[nodeId];
    if (!a || !b) {
      const node = a || b;
      changes.push({
        kind: a ? 'node-removed' : 'node-added',
        nodeId,
        title: (node._meta && node._meta.title) || node.class_type || nodeId,
        before: a ? a.class_type : undefined,
        after: b ? b.class_type : undefined,
      });
      continue;
    }
    const inputs = new Set([...Object.keys(a.inputs || {}), ...Object.keys(b.inputs || {})]);
    for (const input of inputs) {
      const oldValue = a.inputs && a.inputs[input];
      const newValue = b.inputs && b.inputs[input];
      if (equal(oldValue, newValue)) continue;
      changes.push({
        kind: 'input',
        nodeId,
        title: (b._meta && b._meta.title) || b.class_type || nodeId,
        input,
        before: oldValue,
        after: newValue,
      });
    }
  }
  return changes;
}

function validReference(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const text = value.trim();
  if (!text.endsWith(' [output]')) return false;
  const rel = text.slice(0, -' [output]'.length);
  if (!rel || rel.length > 260 || rel.startsWith('/') || rel.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel) || /[<>:"|?*\x00-\x1F]/.test(rel)) return false;
  if (rel.split('/').includes('..')) return false;
  return /\.(png|jpe?g|webp)$/i.test(rel);
}

function validContinuation(value) {
  return validReference(value) && /^h3_context\/[A-Za-z0-9_-]+\.jpg \[output]$/.test(value.trim());
}

function validModelName(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const text = value.trim();
  if (text.length > 260 || text.startsWith('/') || text.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(text) || /[<>:"|?*\x00-\x1F]/.test(text)) return false;
  if (text.split('/').includes('..')) return false;
  return /\.safetensors$/i.test(text);
}

function randomSeed() {
  return crypto.randomBytes(6).readUIntBE(0, 6);
}

function applyReferences(graph, manifest, references) {
  const slots = manifest.referenceSlots || [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const enabled = i < references.length;
    if (enabled) {
      setValue(graph, slot.binding, references[i]);
    } else if (slot.switchBinding) {
      delete graph[slot.binding.node];
      delete graph[slot.switchBinding.node].inputs.on_true;
    } else {
      const nodeId = slot.binding.node;
      delete graph[nodeId];
      for (const node of Object.values(graph)) {
        for (const [input, value] of Object.entries(node.inputs || {})) {
          if (Array.isArray(value) && String(value[0]) === String(nodeId)) delete node.inputs[input];
        }
      }
    }
    if (slot.switchBinding) setValue(graph, slot.switchBinding, enabled);
  }
}

function applyLoraChain(graph, manifest, loras) {
  const chain = manifest.loraChain;
  let previous = chain.rootNode;
  for (let i = 0; i < loras.length; i++) {
    const nodeId = chain.stockNodes[i] || String(chain.newNodeStart + i - chain.stockNodes.length);
    if (!graph[nodeId]) {
      graph[nodeId] = {
        inputs: {},
        class_type: 'LoraLoaderModelOnly',
        _meta: { title: `附加 LoRA ${i + 1}` },
      };
    }
    graph[nodeId].inputs = {
      lora_name: loras[i].name,
      strength_model: loras[i].strength,
      model: [previous, 0],
    };
    previous = nodeId;
  }
  for (let i = loras.length; i < chain.stockNodes.length; i++) delete graph[chain.stockNodes[i]];
  if (chain.tailBinding) {
    setValue(graph, chain.tailBinding, [previous, 0]);
    return;
  }
  graph[chain.turboNode].inputs.model = [previous, 0];
  setValue(graph, chain.nonTurboTarget, [previous, 0]);
}

// outputKey: a unique, ASCII name for this one run, so its video and continuation file can be found by name.
function compileWorkflow(template, input = {}, { outputKey = null } = {}) {
  const { manifest: m, graph: original } = template;
  const bindings = m.bindings || {};
  const limits = m.limits || {};
  const form = templateForm(template);
  const defaults = form.defaults;
  const values = {
    ...defaults,
    ...(input && typeof input === 'object' ? input : {}),
    references: Array.isArray(input && input.references) ? input.references : defaults.references,
    loras: Array.isArray(input && input.loras) ? input.loras : defaults.loras,
    extensions: { ...defaults.extensions, ...((input && input.extensions) || {}) },
  };
  const errors = [];
  // a video prompt always carries the one no-subtitles sentence, whichever way it was written
  const prompt = ensureNoSubtitles(typeof values.prompt === 'string' ? values.prompt : '');
  const promptMaxChars = limits.promptMaxChars ?? 200000;
  if (bindings.prompt) {
    if (!prompt.trim()) errors.push('提示词不能为空');
    if (prompt.length > promptMaxChars) errors.push(`提示词不能超过 ${promptMaxChars} 字符`);
  }

  if (!['random', 'fixed'].includes(values.seedMode)) errors.push('种子模式只能是 random 或 fixed');
  let seed = null;
  if (values.seedMode === 'fixed') {
    seed = Number(values.seed);
    if (!Number.isSafeInteger(seed) || seed < 0) errors.push('固定种子必须是非负安全整数');
  }

  const turboEnabled = bindings.turboEnabled ? !!values.turboEnabled : false;
  const turboModel = typeof values.turboModel === 'string' ? values.turboModel.trim() : '';
  if (turboEnabled && !(m.turboModels || []).some((model) => model.value === turboModel)) errors.push('所选 Turbo 模型不在模板兼容列表中');
  const stepsBound = !!(bindings.steps || bindings.turboSteps || bindings.fullSteps);
  const steps = Number(stepsBound ? values.steps : defaults.steps);
  const stepsMin = limits.stepsMin ?? 1;
  const stepsMax = limits.stepsMax ?? 200;
  if (stepsBound && (!Number.isInteger(steps) || steps < stepsMin || steps > stepsMax)) {
    errors.push(`步数必须是 ${stepsMin}–${stepsMax} 的整数`);
  }

  const durationBound = !!bindings.duration;
  const duration = Number(durationBound ? values.duration : defaults.duration);
  const durationMin = limits.durationMin ?? 0.25;
  const durationMax = limits.durationMax ?? 30;
  if (durationBound && (!Number.isFinite(duration) || duration < durationMin || duration > durationMax)) {
    errors.push(`时长必须在 ${durationMin}–${durationMax} 秒之间`);
  }
  const aspect = m.aspects.find((a) => a.id === values.aspect);
  if (!aspect) errors.push('未知宽高比');
  const megapixelsBound = !!bindings.megapixels;
  const megapixels = Number(megapixelsBound ? values.megapixels : defaults.megapixels);
  const megapixelsMin = limits.megapixelsMin ?? 0.1;
  const megapixelsMax = limits.megapixelsMax ?? 16;
  if (megapixelsBound && (!Number.isFinite(megapixels) || megapixels < megapixelsMin || megapixels > megapixelsMax)) {
    errors.push(`百万像素必须在 ${megapixelsMin}–${megapixelsMax} 之间`);
  }

  const slots = m.referenceSlots || [];
  const references = Array.isArray(values.references) ? values.references.map((v) => typeof v === 'string' ? v.trim() : '') : [];
  if (!slots.length && references.length) errors.push('模板不支持参考图');
  if (slots.length) {
    // H3 takes zero reference images too (the prompt alone, or the previous clip when continuing).
    if (references.length > (limits.maxReferences ?? slots.length)) {
      errors.push(`参考图数量必须在 0–${limits.maxReferences ?? slots.length} 之间`);
    }
    references.forEach((value, i) => {
      if (!validReference(value)) errors.push(`参考图 ${i + 1} 不是有效的 ComfyUI output 图片`);
    });
  }
  const hasContinuation = !!(bindings.continuationEnabled && bindings.continuationClip);
  const continuationEnabled = hasContinuation ? !!values.continuationEnabled : false;
  const continuationClip = hasContinuation && typeof values.continuationClip === 'string' ? values.continuationClip.trim() : '';
  if (continuationEnabled && !validContinuation(continuationClip)) errors.push('请选择有效的接续分镜 clip');

  const loras = m.loraChain && Array.isArray(values.loras) ? values.loras : [];
  if (loras.length > (limits.maxLoras ?? 0)) errors.push(`附加 LoRA 最多 ${limits.maxLoras} 个`);
  loras.forEach((lora, i) => {
    if (!lora || !validModelName(lora.name)) errors.push(`附加 LoRA ${i + 1} 的文件名无效`);
    const strength = Number(lora && lora.strength);
    if (!Number.isFinite(strength) || strength < 0 || strength > 2) errors.push(`附加 LoRA ${i + 1} 的强度必须在 0–2 之间`);
  });
  if (errors.length) return { ok: false, errors };

  if (values.seedMode === 'random') seed = randomSeed();
  const normalizedLoras = loras.map((lora) => ({ name: lora.name.trim(), strength: Number(lora.strength) }));
  const graph = clone(original);
  if (bindings.prompt) setValue(graph, bindings.prompt, prompt);
  if (bindings.seed) setValue(graph, bindings.seed, seed);
  if (bindings.turboEnabled) setValue(graph, bindings.turboEnabled, turboEnabled);
  if (bindings.turboLora) setValue(graph, bindings.turboLora, turboModel);
  if (bindings.steps) setValue(graph, bindings.steps, steps);
  else {
    const stepBinding = turboEnabled ? bindings.turboSteps : bindings.fullSteps;
    if (stepBinding) setValue(graph, stepBinding, steps);
  }
  // The graph turns seconds into frames itself, rounding up to the next 17k+5 step, so 5.2s (124.8 frames, the
  // 124-frame step written rounded) came out 141 frames. It gets the exact length of the step chosen here instead.
  if (bindings.duration) setValue(graph, bindings.duration, frameCount(duration) / 24);
  if (bindings.aspect) setValue(graph, bindings.aspect, aspect.nodeRatio);
  if (bindings.megapixels) setValue(graph, bindings.megapixels, megapixels);
  if (bindings.continuationEnabled) setValue(graph, bindings.continuationEnabled, continuationEnabled);
  if (bindings.continuationClip) setValue(graph, bindings.continuationClip, continuationClip);
  if (slots.length) applyReferences(graph, m, references);
  if (m.loraChain) applyLoraChain(graph, m, normalizedLoras);
  const enabledExtensions = {};
  for (const extension of m.extensions || []) {
    const enabled = !!values.extensions[extension.id];
    enabledExtensions[extension.id] = enabled;
    setValue(graph, extension.binding, enabled);
  }
  if (outputKey) {
    if (m.outputs.contextPrefix) setValue(graph, m.outputs.contextPrefix, `h3_context/${outputKey}`);
    if (m.outputs.videoPrefix) setValue(graph, m.outputs.videoPrefix, `video/${outputKey}`);
  }

  const { width, height } = dimensions(aspect, megapixels);
  const changes = diffWorkflow(original, graph);
  return {
    ok: true,
    workflow: graph,
    apiJson: JSON.stringify(graph, null, 2),
    changes,
    summary: {
      template: `${m.name} · v${m.version}`,
      outputKey,
      turboEnabled,
      turboModel: turboEnabled ? ((m.turboModels || []).find((model) => model.value === turboModel) || {}).label : '不启用 Turbo',
      turboModelValue: turboEnabled ? turboModel : null,
      steps,
      duration,
      frames: frameCount(duration),
      aspect: aspect.label,
      width,
      height,
      tier: resolutionTier(width, height),
      megapixels,
      continuationEnabled,
      continuation: continuationEnabled ? continuationClip : '',
      references: references.map((value, i) => ({ picture: (slots[i] || {}).picture, value })),
      loras: m.loraChain ? normalizedLoras : [],
      extensions: (m.extensions || []).map((extension) => ({ label: extension.label, enabled: enabledExtensions[extension.id] })),
      seedMode: values.seedMode,
      promptChars: prompt.length,
      changedFields: changes.length,
      changedNodes: new Set(changes.map((c) => c.nodeId)).size,
    },
  };
}

module.exports = {
  compileWorkflow,
  diffWorkflow,
  dimensions,
  resolutionTier,
  frameCount,
  validModelName,
  validReference,
  validContinuation,
  applyLoraChain,
};
