// What a remote ComfyUI needs that a local one finds on its own: the pictures and continuation files a graph
// reads from the output folder go up before the run, the files it wrote come back after it, and model names
// are matched to what the server has. Plain Node; the ComfyUI API is passed in (src/comfy-api.js).
const fs = require('node:fs');
const path = require('node:path');
const { removeFile } = require('./fs-safe');
const { resolveInside } = require('./safe-path');

const OUTPUT_TAG = ' [output]';
const MODEL_FILE = /\.(safetensors|gguf|pth|pt|ckpt|bin|sft)$/i;
const CONTEXT_PICTURE = /^h3_context\/.+\.jpg$/i;

const slash = (p) => String(p).replace(/\\/g, '/');
const baseName = (p) => slash(p).split('/').pop();

// Files in the output folder the graph reads ("ref/x.png [output]"). A continuation picture brings the
// latent saved beside it, which is what the next shot really continues from.
function outputRefs(graph) {
  const found = new Set();
  for (const node of Object.values(graph || {})) {
    for (const value of Object.values((node && node.inputs) || {})) {
      if (typeof value !== 'string' || !value.endsWith(OUTPUT_TAG)) continue;
      const rel = slash(value.slice(0, -OUTPUT_TAG.length).trim());
      if (!rel || rel === 'None') continue;
      found.add(rel);
      if (CONTEXT_PICTURE.test(rel)) found.add(rel.replace(/\.jpg$/i, '.safetensors'));
    }
  }
  return [...found];
}

// Every model file the server has, folder by folder: { loras: ['a.safetensors', 'sub/b.safetensors'], ... }
async function remoteModels(api) {
  const folders = await api.modelFolders();
  const out = {};
  for (const folder of folders) {
    try {
      const names = await api.models(folder);
      if (names.length) out[folder] = names;
    } catch {
      // a folder that cannot be listed simply offers nothing
    }
  }
  return out;
}

// Points every model name in the graph at a file the server has: the same name, else the same file in another
// subfolder (qwen/x.safetensors -> x.safetensors), else the server's stand-in from swaps (by file name).
// Returns a new graph and the names nothing could be found for.
function remapModels(graph, available, swaps = {}) {
  const all = [...new Set(Object.values(available || {}).flat().map(slash))];
  const byBase = new Map();
  for (const name of all) {
    const key = baseName(name).toLowerCase();
    if (!byBase.has(key)) byBase.set(key, name);
  }
  const exact = new Set(all);
  const swapByBase = new Map(Object.entries(swaps || {}).map(([from, to]) => [baseName(from).toLowerCase(), to]));
  const resolve = (value) => {
    const name = slash(value);
    if (exact.has(name)) return name;
    const same = byBase.get(baseName(name).toLowerCase());
    if (same) return same;
    const swap = swapByBase.get(baseName(name).toLowerCase());
    if (swap) return exact.has(slash(swap)) ? slash(swap) : byBase.get(baseName(swap).toLowerCase()) || null;
    return null;
  };

  const out = JSON.parse(JSON.stringify(graph || {}));
  const missing = new Set();
  const changes = [];
  for (const node of Object.values(out)) {
    for (const [input, value] of Object.entries((node && node.inputs) || {})) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value) || value.endsWith(OUTPUT_TAG)) continue;
      const found = resolve(value);
      if (!found) missing.add(value);
      else if (found !== value) {
        // ComfyUI on Linux names subfolders with "/", which is also what it accepts back
        node.inputs[input] = found;
        changes.push({ from: value, to: found });
      }
    }
  }
  return { graph: out, missing: [...missing], changes };
}

// Uploads what the graph reads and the server lacks or has in another size. Files missing on this computer
// are left out: ComfyUI then names them, the same as it would for a local run.
async function pushInputs({ graph, outputDir, api }) {
  const uploaded = [];
  for (const rel of outputRefs(graph)) {
    const abs = resolveInside(outputDir, rel);
    let size;
    try {
      size = abs ? fs.statSync(abs).size : null;
    } catch {
      size = null;
    }
    if (size === null) continue;
    if ((await api.outputSize(rel)) === size) continue;
    await api.uploadOutput(rel, abs);
    uploaded.push(rel);
  }
  return uploaded;
}

// Files a run reads from ComfyUI's input folder ([{ rel, abs }], a video to upscale, say): uploaded when the
// ComfyUI there lacks them or has another size. Local and remote alike, since neither reads this computer's
// output folder by name. A file missing here is an error: the run could only fail without it.
async function pushInputFiles({ files, api }) {
  const uploaded = [];
  for (const { rel, abs } of files || []) {
    let size;
    try {
      size = fs.statSync(abs).size;
    } catch {
      throw new Error(`本机找不到要用的文件:${abs}`);
    }
    if ((await api.outputSize(rel, 'input')) === size) continue;
    await api.uploadOutput(rel, abs, 'input');
    uploaded.push(rel);
  }
  return uploaded;
}

// The files a run lists in its history ({ images|gifs|videos|audio: [{ filename, subfolder, type }] }), as paths
// inside the output folder. A continuation picture brings its latent.
function historyFiles(outputs) {
  const found = new Set();
  for (const output of Object.values(outputs || {})) {
    for (const list of Object.values(output || {})) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item.filename !== 'string' || item.type !== 'output') continue;
        const rel = slash(item.subfolder ? `${item.subfolder}/${item.filename}` : item.filename);
        found.add(rel);
        if (CONTEXT_PICTURE.test(rel)) found.add(rel.replace(/\.jpg$/i, '.safetensors'));
      }
    }
  }
  return [...found];
}

// The continuation file a take saved on the server (its picture and the latent beside it), found by the take's
// name prefix. Newest first, like the local finder in take-outputs.js.
async function contextFiles(api, outputKey) {
  if (!outputKey || typeof api.contextClips !== 'function') return [];
  let clips;
  try {
    clips = await api.contextClips();
  } catch {
    return []; // no H3 Motion Context on the server: nothing of this kind to fetch
  }
  const own = clips.map((c) => slash(c.replace(/ \[output\]$/, ''))).find((rel) => rel.startsWith(`h3_context/${outputKey}_`) && rel.endsWith('.jpg'));
  return own ? [own, own.replace(/\.jpg$/i, '.safetensors')] : [];
}

// Brings a finished run's files to the same place in this computer's output folder: what its history lists,
// plus its continuation file. Each is written to .part first, so a broken download never looks like a
// finished file. Throws on the first one that fails.
async function pullOutputs({ outputs, outputDir, api, outputKey = null }) {
  const fetched = [];
  const wanted = [...new Set([...historyFiles(outputs), ...(await contextFiles(api, outputKey))])];
  for (const rel of wanted) {
    const abs = resolveInside(outputDir, rel);
    if (!abs) continue;
    const size = await api.outputSize(rel);
    if (size === null) continue; // listed but not kept on the server (a preview): nothing to fetch
    try {
      if (fs.statSync(abs).size === size) continue;
    } catch {
      // not here yet
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const part = `${abs}.part`;
    await api.downloadOutput(rel, part);
    if (fs.statSync(part).size !== size) {
      removeFile(part);
      throw new Error(`${rel} 没下载完整`);
    }
    fs.renameSync(part, abs);
    fetched.push(rel);
  }
  return fetched;
}

module.exports = { outputRefs, remoteModels, remapModels, pushInputs, pushInputFiles, historyFiles, contextFiles, pullOutputs };
