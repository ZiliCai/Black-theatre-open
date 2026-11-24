// Script projects: one folder per script, with output\ and input\ that ComfyUI is pointed at, a docs folder
// for the story documents, and a small project.json. Plain Node, no Electron. Existing files are never changed.
const fs = require('node:fs');
const path = require('node:path');
const { resolveInside, sameDir } = require('./safe-path');
const { removeFile } = require('./fs-safe');

const PROJECT_FILE = 'project.json';
const DEFAULT_DOCS_DIR = '剧本';
const CATEGORIES = ['故事设定', '大纲', '细纲', '分镜头', '其他'];
const MAX_NAME = 60;
const MIN_DOCS_TO_SUGGEST = 3;
const DOC_EXT = /\.(md|txt)$/i;

const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function validateProjectName(raw) {
  const fail = (message) => ({ ok: false, name: '', message });
  if (typeof raw !== 'string') return fail('请输入剧本名');
  const name = raw.trim();
  if (!name) return fail('请输入剧本名');
  if ([...name].length > MAX_NAME) return fail(`剧本名太长(最多 ${MAX_NAME} 个字)`);
  if (BAD_CHARS.test(name)) return fail('剧本名不能包含 \\ / : * ? " < > | 这些字符');
  if (name === '.' || name === '..' || name.endsWith('.')) return fail('剧本名不能是 . 或以点结尾');
  if (RESERVED.test(name)) return fail(`「${name}」是 Windows 保留名,请换一个`);
  return { ok: true, name, message: '' };
}

const isUsableAbsolute = (dir) => typeof dir === 'string' && !!dir && path.win32.isAbsolute(dir) && !/^[A-Za-z]:[\\/]?$/.test(dir);
const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p) => fs.existsSync(p);

function projectPaths(dir, project) {
  const docs = resolveInside(dir, (project && project.docsDir) || DEFAULT_DOCS_DIR) || path.join(dir, DEFAULT_DOCS_DIR);
  return { dir, output: path.join(dir, 'output'), input: path.join(dir, 'input'), docs };
}

// ---------- project.json ----------
function normalize(raw, dir) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const docsDir = typeof r.docsDir === 'string' && r.docsDir.trim() && resolveInside(dir, r.docsDir.trim()) ? r.docsDir.trim() : DEFAULT_DOCS_DIR;
  const docs = {};
  if (r.docs && typeof r.docs === 'object' && !Array.isArray(r.docs)) {
    for (const [k, v] of Object.entries(r.docs)) if (typeof v === 'string' && CATEGORIES.includes(v)) docs[k] = v;
  }
  return {
    version: 1,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : path.basename(dir),
    created: typeof r.created === 'string' ? r.created : '',
    docsDir,
    docs,
  };
}

// Writes the whole file through a temporary file, so a crash never leaves half a project.json.
function writeProject(dir, project) {
  const final = path.join(dir, PROJECT_FILE);
  const tmpFile = path.join(dir, `.${PROJECT_FILE}.tmp-${process.pid}`);
  fs.writeFileSync(tmpFile, JSON.stringify(project, null, 2), 'utf8');
  try {
    fs.renameSync(tmpFile, final);
  } catch (e) {
    removeFile(tmpFile);
    throw e;
  }
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// Reads project.json. A broken file is moved aside and replaced by defaults (never silently overwritten).
function readProject(dir, { now = () => new Date() } = {}) {
  if (!isDirectory(dir)) return { ok: false, missing: true, message: `找不到项目文件夹:${dir}` };
  const file = path.join(dir, PROJECT_FILE);
  if (!exists(file)) return { ok: true, initialized: false, project: normalize(null, dir) };
  try {
    return { ok: true, initialized: true, project: normalize(JSON.parse(fs.readFileSync(file, 'utf8')), dir) };
  } catch {
    const backup = path.join(dir, `${PROJECT_FILE}.损坏-${stamp(now())}`);
    try {
      fs.renameSync(file, backup);
      const project = normalize(null, dir);
      writeProject(dir, project);
      return { ok: true, initialized: true, repaired: true, backup, project };
    } catch (e) {
      return { ok: false, message: `项目文件 project.json 损坏,且无法修复:${e.message}` };
    }
  }
}

// Like readProject, but never writes anything (used for listings).
function peekProject(dir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')), dir);
  } catch {
    return normalize(null, dir);
  }
}

function renameProject(dir, newName) {
  const v = validateProjectName(newName);
  if (!v.ok) return { ok: false, message: v.message };
  const r = readProject(dir);
  if (!r.ok) return { ok: false, message: r.message };
  try {
    writeProject(dir, { ...r.project, name: v.name });
  } catch (e) {
    return { ok: false, message: `无法保存:${e.message}` };
  }
  return { ok: true, name: v.name, message: '' };
}

// ---------- document categories and the docs folder (kept in project.json) ----------
function updateProject(dir, change) {
  const r = readProject(dir);
  if (!r.ok) return { ok: false, message: r.message };
  const project = change(r.project);
  if (project.error) return { ok: false, message: project.error };
  try {
    writeProject(dir, project);
  } catch (e) {
    return { ok: false, message: `无法保存项目信息:${e.message}` };
  }
  return { ok: true, project, message: '' };
}

function setDocCategory(dir, relPath, category) {
  if (!CATEGORIES.includes(category)) return { ok: false, message: `类别必须是:${CATEGORIES.join('、')}` };
  return updateProject(dir, (p) => ({ ...p, docs: { ...p.docs, [relPath]: category } }));
}

function moveDocKey(dir, oldRel, newRel) {
  return updateProject(dir, (p) => {
    if (!(oldRel in p.docs)) return p;
    const { [oldRel]: category, ...rest } = p.docs;
    return { ...p, docs: { ...rest, [newRel]: category } };
  });
}

function dropDocKey(dir, relPath) {
  return updateProject(dir, (p) => {
    const { [relPath]: _gone, ...rest } = p.docs;
    return { ...p, docs: rest };
  });
}

function setDocsDir(dir, docsDir) {
  if (typeof docsDir !== 'string' || !docsDir.trim() || !resolveInside(dir, docsDir.trim())) {
    return { ok: false, message: `设定文件夹必须在项目文件夹里面:${docsDir}` };
  }
  return updateProject(dir, (p) => ({ ...p, docsDir: docsDir.trim() }));
}

// ---------- create / import ----------
function createProject({ root, name, now = () => new Date() }) {
  const v = validateProjectName(name);
  if (!v.ok) return { ok: false, message: v.message };
  if (!isUsableAbsolute(root)) return { ok: false, message: '项目根目录必须是绝对路径,且不能是磁盘根目录' };
  const dir = path.join(root, v.name);
  try {
    fs.mkdirSync(root, { recursive: true });
    if (exists(dir)) return { ok: false, message: `已经有一个叫「${v.name}」的文件夹了。要把它当作项目,请用「导入已有文件夹」` };
    fs.mkdirSync(dir);
    for (const sub of ['output', 'input', DEFAULT_DOCS_DIR]) fs.mkdirSync(path.join(dir, sub));
    const project = { version: 1, name: v.name, created: now().toISOString(), docsDir: DEFAULT_DOCS_DIR, docs: {} };
    writeProject(dir, project);
    return { ok: true, dir, project, message: '' };
  } catch (e) {
    return { ok: false, message: `无法创建项目:${e.message}` };
  }
}

// The sub-folder holding the most documents (at least three) is the likely docs folder.
function suggestDocsDir(dir) {
  let best = { name: '', count: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'output' || e.name === 'input') continue;
    let count = 0;
    try {
      count = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }).filter((f) => f.isFile() && DOC_EXT.test(f.name)).length;
    } catch {
      count = 0;
    }
    if (count > best.count) best = { name: e.name, count };
  }
  return best.count >= MIN_DOCS_TO_SUGGEST ? best.name : '';
}

// Preview of an import: what would be added. Writes nothing.
function inspectFolder(dir) {
  if (!isUsableAbsolute(dir)) return { ok: false, message: '请选择一个文件夹(不能是磁盘根目录)' };
  if (!isDirectory(dir)) return { ok: false, message: `不是文件夹或不存在:${dir}` };
  const isProject = exists(path.join(dir, PROJECT_FILE));
  const current = isProject ? peekProject(dir) : null;
  const suggestedDocsDir = isProject ? '' : suggestDocsDir(dir);
  const docsDir = current ? current.docsDir : suggestedDocsDir || DEFAULT_DOCS_DIR;
  const willCreate = [];
  if (!isProject) willCreate.push(PROJECT_FILE);
  for (const sub of ['output', 'input', docsDir]) if (!exists(path.join(dir, sub))) willCreate.push(sub);
  return { ok: true, dir, name: current ? current.name : path.basename(dir), isProject, suggestedDocsDir, docsDir, willCreate };
}

// Adds only what is missing. Existing files and folders are never modified, moved or deleted.
function importProject({ dir, docsDir, now = () => new Date() }) {
  const info = inspectFolder(dir);
  if (!info.ok) return info;
  let chosen = '';
  if (typeof docsDir === 'string' && docsDir.trim()) {
    chosen = docsDir.trim();
    if (!resolveInside(dir, chosen)) return { ok: false, message: `设定文件夹必须在项目文件夹里面:${chosen}` };
  }
  const created = [];
  try {
    const read = readProject(dir, { now });
    if (!read.ok) return read;
    let project = read.project;
    if (!read.initialized) {
      project = { ...project, created: now().toISOString(), docsDir: chosen || info.suggestedDocsDir || DEFAULT_DOCS_DIR };
      writeProject(dir, project);
      created.push(PROJECT_FILE);
    } else if (chosen && chosen !== project.docsDir) {
      project = { ...project, docsDir: chosen };
      writeProject(dir, project);
    }
    for (const sub of ['output', 'input', project.docsDir]) {
      const full = path.join(dir, sub);
      if (!exists(full)) {
        fs.mkdirSync(full, { recursive: true });
        created.push(sub);
      }
    }
    return { ok: true, dir, project, created, repaired: !!read.repaired, message: '' };
  } catch (e) {
    return { ok: false, message: `导入失败:${e.message}` };
  }
}

// ---------- known list, switching ----------
function addKnown(list, dir) {
  const base = Array.isArray(list) ? list : [];
  return base.some((d) => sameDir(d, dir)) ? base.slice() : [...base, dir];
}

const removeKnown = (list, dir) => (Array.isArray(list) ? list : []).filter((d) => !sameDir(d, dir));

// The config change that points ComfyUI at a project's folders. Creates them when they are missing.
function switchPatch(dir) {
  if (!isUsableAbsolute(dir) || !isDirectory(dir)) return { ok: false, message: `找不到项目文件夹:${dir}` };
  const p = projectPaths(dir, null);
  for (const [label, full] of [['output', p.output], ['input', p.input]]) {
    try {
      fs.mkdirSync(full, { recursive: true });
    } catch (e) {
      return { ok: false, message: `无法创建项目里的 ${label} 文件夹:${e.message}` };
    }
    if (!isDirectory(full)) return { ok: false, message: `项目里的 ${label} 不是文件夹:${full}` };
  }
  return { ok: true, patch: { activeProject: dir, outputDir: p.output, inputDir: p.input }, message: '' };
}

const clearPatch = () => ({ activeProject: '' });

function describeProjects(config) {
  const known = Array.isArray(config && config.projects) ? config.projects : [];
  return known.map((dir) => {
    const present = isDirectory(dir);
    const project = present ? peekProject(dir) : normalize(null, dir);
    return {
      dir,
      name: project.name,
      exists: present,
      initialized: present && exists(path.join(dir, PROJECT_FILE)),
      active: !!(config.activeProject && sameDir(config.activeProject, dir)),
      docsDir: projectPaths(dir, project).docs,
      created: project.created,
    };
  });
}

module.exports = {
  PROJECT_FILE, DEFAULT_DOCS_DIR, CATEGORIES,
  validateProjectName, projectPaths, readProject, peekProject, writeProject, renameProject,
  createProject, inspectFolder, importProject, addKnown, removeKnown, switchPatch, clearPatch, describeProjects,
  setDocCategory, moveDocKey, dropDocKey, setDocsDir,
};
