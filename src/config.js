const fs = require('node:fs');
const path = require('node:path');
const { normalizeServer } = require('./remote-servers');

function defaultConfig() {
  return {
    workdir: 'C:\\BlackBox\\ComfyUI_windows_portable',
    port: 8188,
    flags: {
      lowvram: true,
      reserveVram: 2.5,
      disablePinnedMemory: true,
      extraArgs: '',
    },
    logPath: 'C:\\BlackBox\\comfyui_boot.log',
    outputDir: '', // '' = ComfyUI default (<workdir>\ComfyUI\output)
    inputDir: '', // '' = ComfyUI default (<workdir>\ComfyUI\input)
    projectsRoot: 'C:\\BlackBox\\projects', // where new script projects are created
    projects: [], // folders of the script projects the launcher knows about
    activeProject: '', // '' = no project: the output / input folders are set by hand
    workflowTemplate: 'minimax-h3-hybrid', // folder name inside workflow-templates
    target: 'local', // where takes render: 'local', or the id of one of the servers below
    servers: [], // remote GPU servers reached over SSH (src/remote-servers.js)
    llm: {
      baseUrl: '',
      model: '',
      optimizer: 'refine',
    },
  };
}

const DIR_LABELS = { outputDir: '输出目录', inputDir: '输入目录' };

function checkDirSetting(key, value) {
  if (!value) return null;
  if (/^[A-Za-z]:[\\/]?$/.test(value)) return `${DIR_LABELS[key]}不能是磁盘根目录:${value}`;
  if (!path.win32.isAbsolute(value)) return `${DIR_LABELS[key]}必须是绝对路径(如 D:\\输出):${value}`;
  return null;
}

function validateConfig(cfg) {
  const errors = [];

  if (!cfg.workdir || !fs.existsSync(cfg.workdir) || !fs.statSync(cfg.workdir).isDirectory()) {
    errors.push(`工作目录不存在:${cfg.workdir}`);
  } else {
    const python = path.join(cfg.workdir, 'python_embeded', 'python.exe');
    const main = path.join(cfg.workdir, 'ComfyUI', 'main.py');
    if (!fs.existsSync(python)) errors.push(`找不到 ${python}`);
    if (!fs.existsSync(main)) errors.push(`找不到 ${main}`);
  }

  const { port } = cfg;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`端口无效:${String(port)}(需要 1~65535 的整数)`);
  }

  const rv = cfg.flags && cfg.flags.reserveVram;
  if (typeof rv !== 'number' || !Number.isFinite(rv) || rv < 0) {
    errors.push(`保留显存无效:${String(rv)}(需要不小于 0 的数字)`);
  }

  for (const key of ['outputDir', 'inputDir']) {
    const problem = checkDirSetting(key, cfg[key]);
    if (problem) errors.push(problem);
  }

  if (cfg.projectsRoot && !path.win32.isAbsolute(cfg.projectsRoot)) {
    errors.push(`项目根目录必须是绝对路径(如 D:\\剧本):${cfg.projectsRoot}`);
  }
  // a project folder that has gone missing is not an error here: ComfyUI can still start without it

  return { ok: errors.length === 0, errors };
}

function loadConfig(file) {
  const defaults = defaultConfig();
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaults;
  }
  if (!saved || typeof saved !== 'object') return defaults;
  const merged = { ...defaults, ...saved, flags: { ...defaults.flags, ...(saved.flags || {}) }, llm: { ...defaults.llm, ...(saved.llm || {}) } };
  // old files have no project fields, and a hand-edited file may have the wrong types
  merged.projects = Array.isArray(saved.projects) ? saved.projects.filter((p) => typeof p === 'string') : defaults.projects;
  if (typeof merged.activeProject !== 'string') merged.activeProject = defaults.activeProject;
  if (typeof merged.projectsRoot !== 'string' || !merged.projectsRoot) merged.projectsRoot = defaults.projectsRoot;
  if (typeof merged.workflowTemplate !== 'string' || !merged.workflowTemplate) merged.workflowTemplate = defaults.workflowTemplate;
  merged.servers = Array.isArray(saved.servers) ? saved.servers.map(normalizeServer).filter((s) => s.id) : defaults.servers;
  if (typeof merged.target !== 'string' || (merged.target !== 'local' && !merged.servers.some((s) => s.id === merged.target))) merged.target = 'local';
  for (const key of ['baseUrl', 'model', 'optimizer']) {
    if (typeof merged.llm[key] !== 'string') merged.llm[key] = defaults.llm[key];
  }
  return merged;
}

function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { defaultConfig, validateConfig, loadConfig, saveConfig };
