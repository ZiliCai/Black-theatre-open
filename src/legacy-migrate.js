// The app was renamed comfyui-launcher -> blackbox-theater, which moved Electron's data folder and left the
// DeepSeek settings and the project list behind. Bring them over once (a marker file remembers that it ran);
// the old folder is only read. The API key is not copied: it was encrypted with a secret that belongs to the
// old folder's profile, so the new app could not read it anyway; the user is asked to enter it again.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');

const MARKER = 'migrated-from-comfyui-launcher';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function migrateLegacyUserData({ fromDir, toDir }) {
  const old = readJson(path.join(fromDir, 'config.json'));
  if (!old || fs.existsSync(path.join(toDir, MARKER))) return { moved: [], message: '' };
  const configFile = path.join(toDir, 'config.json');
  const config = loadConfig(configFile);
  const moved = [];

  const oldLlm = old.llm && typeof old.llm === 'object' ? old.llm : null;
  if (!config.llm.baseUrl && oldLlm && typeof oldLlm.baseUrl === 'string' && oldLlm.baseUrl) {
    config.llm = { ...config.llm, ...oldLlm };
    moved.push('llm');
  }

  const known = new Set(config.projects.map((p) => path.resolve(p).toLowerCase()));
  const extra = (Array.isArray(old.projects) ? old.projects : [])
    .filter((p) => typeof p === 'string' && !known.has(path.resolve(p).toLowerCase()));
  if (extra.length) {
    config.projects = [...config.projects, ...extra];
    moved.push('projects');
  }

  fs.mkdirSync(toDir, { recursive: true });
  if (moved.length) saveConfig(configFile, config);
  fs.writeFileSync(path.join(toDir, MARKER), `${new Date().toISOString()}\n`);
  if (!moved.length) return { moved, message: '' };
  const parts = [];
  if (moved.includes('llm')) parts.push('DeepSeek 设置');
  if (extra.length) parts.push(`${extra.length} 个项目`);
  const keyNote = moved.includes('llm') && fs.existsSync(path.join(fromDir, 'secrets.json')) ? '（API 密钥需要在 设置 · 常规 里重新填写一次）' : '';
  return { moved, message: `已从旧版本搬来 ${parts.join('和 ')}${keyNote}` };
}

module.exports = { migrateLegacyUserData, MARKER };
