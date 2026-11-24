// Turns the "prompt" ComfyUI embeds in every output (the API-format node graph) into a few facts
// a person can read: seed, steps, LoRAs, story text, reference pictures, which clip of a chain it is.
// Everything is best effort: a workflow this does not know simply yields nulls and empty lists.
const MAX_HOPS = 24;
const MAX_TEXT = 4000;
const SUMMARY_CHARS = 160;
const MAX_NUMBER = 1e300; // anything bigger than this was Infinity once

// Python's json module writes bare NaN / Infinity, which JSON.parse rejects. Turn those tokens (outside
// of strings) into null and try again.
function stripNonFinite(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    const m = /^(?:NaN|-?Infinity)/.exec(text.slice(i, i + 9));
    if (m) {
      out += 'null';
      i += m[0].length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function parseLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON.parse(stripNonFinite(text));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const isRef = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';
const isNode = (n) => !!n && typeof n === 'object' && typeof n.class_type === 'string' && !!n.inputs && typeof n.inputs === 'object';

function createReader(graph) {
  const nodeOf = (id) => {
    const n = graph[String(id)];
    return isNode(n) ? n : null;
  };

  // The node that really feeds a link: switches are looked through to the branch they currently pick.
  function resolveNode(ref, hops = 0) {
    if (!isRef(ref) || hops > MAX_HOPS) return null;
    const node = nodeOf(ref[0]);
    if (!node) return null;
    if (node.class_type !== 'ComfySwitchNode') return node;
    const on = resolveValue(node.inputs.switch, hops + 1);
    return resolveNode(on ? node.inputs.on_true : node.inputs.on_false, hops + 1);
  }

  // A plain value, or the value of the primitive / switch node a link points at.
  function resolveValue(v, hops = 0) {
    if (!isRef(v)) return v === undefined ? null : v;
    if (hops > MAX_HOPS) return null;
    const node = resolveNode(v, hops + 1);
    if (!node || !/^Primitive/.test(node.class_type)) return null;
    return resolveValue(node.inputs.value, hops + 1);
  }

  const ofClass = (...names) => Object.keys(graph).map((id) => nodeOf(id)).filter((n) => n && names.includes(n.class_type));
  return { nodeOf, resolveNode, resolveValue, ofClass };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_NUMBER ? v : null);
const text = (v) => (typeof v === 'string' && v ? v : null);

// "summary:" line of the H3 story format, else the first part of the text.
function summaryOf(story) {
  if (!story) return null;
  const m = /(?:^|\n)summary:[ \t]*\n?([^\n]+)/.exec(story);
  const line = (m ? m[1] : story).replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS)}…` : line;
}

function summarizePrompt(input) {
  const graph = typeof input === 'string' ? parseLoose(input) : input && typeof input === 'object' ? input : null;
  if (!graph || !Object.values(graph).some(isNode)) return null;
  const r = createReader(graph);
  const val = (node, key) => (node ? r.resolveValue(node.inputs[key]) : null);

  // sampler pieces: the custom-sampler graph spreads them over nodes, KSampler keeps them in one
  const custom = r.ofClass('SamplerCustomAdvanced', 'SamplerCustom')[0] || null;
  const ks = r.ofClass('KSampler', 'KSamplerAdvanced')[0] || null;
  const noiseNode = (custom && r.resolveNode(custom.inputs.noise)) || r.ofClass('RandomNoise')[0] || null;
  const sigmaNode = (custom && r.resolveNode(custom.inputs.sigmas)) || r.ofClass('BasicScheduler')[0] || null;
  const samplerNode = (custom && r.resolveNode(custom.inputs.sampler)) || r.ofClass('KSamplerSelect')[0] || null;

  const seed = finite(val(noiseNode, 'noise_seed')) ?? finite(val(ks, 'seed')) ?? finite(val(ks, 'noise_seed'));
  const steps = finite(val(sigmaNode, 'steps')) ?? finite(val(ks, 'steps'));
  const sampler = text(val(samplerNode, 'sampler_name')) ?? text(val(ks, 'sampler_name'));
  const scheduler = text(val(sigmaNode, 'scheduler')) ?? text(val(ks, 'scheduler'));

  // model chain, sampler side first: LoRAs are collected on the way back to the loader
  const loras = [];
  let unet = null;
  let ref = (sigmaNode && sigmaNode.inputs.model) || (ks && ks.inputs.model) || null;
  for (let hop = 0; ref && hop < MAX_HOPS; hop++) {
    const node = r.resolveNode(ref);
    if (!node) break;
    const lora = text(val(node, 'lora_name'));
    if (lora) loras.push(lora);
    const name = text(val(node, 'unet_name')) ?? text(val(node, 'ckpt_name'));
    if (name) {
      unet = name;
      break;
    }
    ref = node.inputs.model;
  }
  loras.reverse();

  // story text
  const h3 = r.ofClass('MiniMaxH3ReferenceToVideo')[0] || null;
  let story = text(val(h3, 'prompt'));
  if (!story && ks) story = text(val(r.resolveNode(ks.inputs.positive), 'text'));
  if (!story) story = text(val(r.ofClass('CLIPTextEncode')[0], 'text'));
  if (story && story.length > MAX_TEXT) story = `${story.slice(0, MAX_TEXT)}…`;

  // reference pictures that are actually connected
  const refs = [];
  if (h3) {
    const keys = Object.keys(h3.inputs).filter((k) => k.startsWith('ref_images.')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const key of keys) {
      const name = text(val(r.resolveNode(h3.inputs[key]), 'image'));
      if (name) refs.push(name.replace(/\s*\[(?:output|input|temp)\]\s*$/, ''));
    }
  }

  // clip chain
  const guider = r.ofClass('BasicGuider')[0] || null;
  const ctx = guider ? r.resolveNode(guider.inputs.conditioning) : null;
  const continued = !!ctx && ctx.class_type === 'MiniMaxH3MotionContext';
  const loadNode = continued ? r.resolveNode(ctx.inputs.context_latent) : null;
  const saved = finite(val(r.ofClass('MiniMaxH3MotionContextSaveLatent')[0], 'clip_index'));
  const from = finite(val(loadNode, 'clip_index'));

  return {
    seed, steps, sampler, scheduler, unet, loras,
    turbo: loras.some((l) => /turbo/i.test(l)),
    promptText: story,
    summary: summaryOf(story),
    refs,
    continued,
    continueFrom: continued && from > 0 ? from : null,
    clipIndex: saved > 0 ? saved : null,
  };
}

module.exports = { parseLoose, summarizePrompt };
