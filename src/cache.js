// "Clear cache" = ask a running ComfyUI to free models + empty <workdir>\ComfyUI\temp.
// It must never touch output, input, models, user (workflows) or custom_nodes.
const fs = require('node:fs');
const path = require('node:path');
const { removeTree } = require('./fs-safe');

function entrySize(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 0; // never follow links
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((sum, name) => sum + entrySize(path.join(p, name)), 0);
}

function defaultRemove(p) {
  removeTree(p); // not fs.rmSync: it kills the process on Chinese file names (see fs-safe.js)
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase(); // Windows paths are case-insensitive

function clearTemp(workdir, { remove = defaultRemove } = {}) {
  const comfyDir = path.join(workdir, 'ComfyUI');
  const target = path.join(comfyDir, 'temp');

  if (!fs.existsSync(comfyDir) || !fs.statSync(comfyDir).isDirectory()) {
    return { ok: false, freedBytes: 0, skipped: 0, message: `找不到 ComfyUI 目录:${comfyDir}` };
  }

  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, freedBytes: 0, skipped: 0, message: 'temp 目录不存在,无需清理' };
    return { ok: false, freedBytes: 0, skipped: 0, message: `无法读取 temp:${e.message}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, freedBytes: 0, skipped: 0, message: `拒绝清理:temp 是符号链接或 Junction(${target})` };
  }
  if (!st.isDirectory()) {
    return { ok: false, freedBytes: 0, skipped: 0, message: `拒绝清理:temp 不是目录(${target})` };
  }
  if (!same(fs.realpathSync(target), path.join(fs.realpathSync(comfyDir), 'temp'))) {
    return { ok: false, freedBytes: 0, skipped: 0, message: `拒绝清理:temp 的真实位置不在 ComfyUI 目录内(${target})` };
  }

  let freedBytes = 0;
  let skipped = 0;
  for (const name of fs.readdirSync(target)) {
    const p = path.join(target, name);
    let size = 0;
    try {
      size = entrySize(p);
      remove(p);
      freedBytes += size;
    } catch {
      skipped++;
    }
  }
  return { ok: true, freedBytes, skipped, message: '' };
}

async function clearCache({ workdir, running, api, remove }) {
  let freedModels = false;
  const notes = [];

  if (running && api) {
    try {
      await api.free();
      freedModels = true;
    } catch (e) {
      notes.push(`调用 ComfyUI 释放接口失败:${e.message}`);
    }
  }

  const t = clearTemp(workdir, { remove });
  if (!t.ok) {
    return { ok: false, freedModels, freedBytes: 0, skipped: 0, message: [...notes, t.message].join(';') };
  }
  if (t.message) notes.push(t.message);
  if (t.skipped) notes.push(`有 ${t.skipped} 个文件被占用,已跳过`);
  return { ok: true, freedModels, freedBytes: t.freedBytes, skipped: t.skipped, message: notes.join(';') };
}

module.exports = { clearTemp, clearCache };
