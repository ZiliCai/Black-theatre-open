const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertBinding(graph, binding, label) {
  if (!binding || typeof binding.node !== 'string' || typeof binding.input !== 'string') {
    throw new Error(`模板绑定无效:${label}`);
  }
  const node = graph[binding.node];
  if (!node || !node.inputs || !has(node.inputs, binding.input)) {
    throw new Error(`模板绑定的节点字段不存在:${label} → ${binding.node}.${binding.input}`);
  }
}

function valueAt(graph, binding) {
  return graph[binding.node].inputs[binding.input];
}

function loadTemplate(templateDir) {
  const manifest = readJson(path.join(templateDir, 'template.json'));
  if (manifest.schemaVersion !== 2 || !manifest.id || !manifest.workflowFile) {
    throw new Error('模板需要 schemaVersion 2、id 和 workflowFile');
  }
  const workflowPath = path.join(templateDir, manifest.workflowFile);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(workflowPath)).digest('hex');
  if (manifest.workflowHash !== `sha256:${hash}`) {
    throw new Error(`工作流哈希与模板声明不一致:${manifest.id}`);
  }
  const graph = readJson(workflowPath);
  if (!graph || Array.isArray(graph) || typeof graph !== 'object') {
    throw new Error('API 工作流必须是节点对象');
  }
  manifest.bindings = manifest.bindings || {};
  manifest.referenceSlots = manifest.referenceSlots || [];
  manifest.extensions = manifest.extensions || [];
  manifest.turboModels = manifest.turboModels || [];
  manifest.defaults = manifest.defaults || {};
  manifest.outputs = manifest.outputs || {};
  for (const [key, binding] of Object.entries(manifest.bindings)) assertBinding(graph, binding, key);
  for (const [key, binding] of Object.entries(manifest.outputs)) assertBinding(graph, binding, `outputs.${key}`);
  for (const slot of manifest.referenceSlots) {
    assertBinding(graph, slot.binding, slot.id);
    if (slot.switchBinding) assertBinding(graph, slot.switchBinding, `${slot.id}.switch`);
  }
  for (const extension of manifest.extensions) assertBinding(graph, extension.binding, extension.id);
  const chain = manifest.loraChain;
  if (chain) {
    for (const nodeId of [chain.rootNode, chain.turboNode, ...(chain.stockNodes || [])]) {
      if (nodeId && !graph[nodeId]) throw new Error(`LoRA 节点不存在:${nodeId}`);
    }
    if (chain.nonTurboTarget) assertBinding(graph, chain.nonTurboTarget, 'nonTurboTarget');
    if (chain.tailBinding) assertBinding(graph, chain.tailBinding, 'tailBinding');
    if (!chain.nonTurboTarget && !chain.tailBinding) throw new Error('LoRA 链需要 nonTurboTarget 或 tailBinding');
  }
  if (!(manifest.aspects || []).some((a) => a.id === manifest.defaults.aspect)) {
    throw new Error('模板默认宽高比不存在');
  }
  return { dir: templateDir, manifest, graph };
}

function templateForm(template) {
  const { manifest: m, graph } = template;
  const bindings = m.bindings;
  const read = (key, fallback) => (bindings[key] ? valueAt(graph, bindings[key]) : fallback);
  const turboEnabled = bindings.turboEnabled ? !!valueAt(graph, bindings.turboEnabled) : false;
  const turboSteps = read('turboSteps', null);
  const fullSteps = read('fullSteps', null);
  const steps = bindings.steps ? valueAt(graph, bindings.steps) : (turboEnabled ? turboSteps : fullSteps);
  const references = m.referenceSlots.slice(0, m.defaults.referenceCount).map((slot) => valueAt(graph, slot.binding));
  const loras = m.loraChain
    ? m.loraChain.stockNodes.map((nodeId) => ({
      name: graph[nodeId].inputs.lora_name,
      strength: graph[nodeId].inputs.strength_model,
    }))
    : [];
  const extensions = {};
  for (const extension of m.extensions) extensions[extension.id] = !!valueAt(graph, extension.binding);
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    kind: m.kind,
    limits: m.limits,
    defaults: {
      prompt: read('prompt', ''),
      seedMode: m.defaults.seedMode || 'random',
      seed: 1,
      turboEnabled,
      turboModel: read('turboLora', ''),
      steps,
      fullSteps: fullSteps ?? steps,
      duration: read('duration', m.defaults.duration ?? 5),
      aspect: m.defaults.aspect,
      megapixels: read('megapixels', m.defaults.megapixels ?? 1),
      continuationEnabled: read('continuationEnabled', false),
      continuationClip: read('continuationClip', ''),
      references,
      loras,
      extensions,
    },
    capabilities: {
      turbo: !!bindings.turboEnabled,
      continuation: !!bindings.continuationEnabled,
      loraChain: !!m.loraChain,
    },
    turboModels: m.turboModels,
    resources: m.resources,
    aspects: m.aspects.map(({ id, label, w, h }) => ({ id, label, w, h })),
    referenceSlots: m.referenceSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      picture: slot.picture,
      defaultValue: valueAt(graph, slot.binding),
    })),
    extensions: m.extensions.map(({ id, label, description }) => ({ id, label, description })),
  };
}

function listTemplates(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const templates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let manifest;
    try {
      manifest = readJson(path.join(dir, 'template.json'));
    } catch {
      continue;
    }
    templates.push({
      id: typeof manifest.id === 'string' && manifest.id ? manifest.id : entry.name,
      dirName: entry.name,
      name: manifest.name || entry.name,
      version: manifest.version || '',
      kind: manifest.kind || '',
      compatible: manifest.schemaVersion === 2,
    });
  }
  templates.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.name.localeCompare(b.name, 'zh-CN'));
  return templates;
}

module.exports = { loadTemplate, templateForm, valueAt, listTemplates };
