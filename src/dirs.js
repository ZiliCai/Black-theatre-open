// Input / output directory logic: which folder ComfyUI really uses, validation, usage stats.
const fs = require('node:fs');
const path = require('node:path');

const w = path.win32;
const FLAGS = { output: '--output-directory', input: '--input-directory' };
const KEYS = { output: 'outputDir', input: 'inputDir' };

const sameDir = (a, b) => w.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === w.resolve(b).replace(/[\\/]+$/, '').toLowerCase();

// Value of "--flag value" or "--flag=value" in an argv list, else null.
function parseArgvDir(argv, flag) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) return i + 1 < argv.length ? argv[i + 1] : null;
    if (typeof a === 'string' && a.startsWith(flag + '=')) return a.slice(flag.length + 1) || null;
  }
  return null;
}

function defaultDirs(workdir) {
  return { output: w.join(workdir, 'ComfyUI', 'output'), input: w.join(workdir, 'ComfyUI', 'input') };
}

// What ComfyUI actually uses. While it is running the truth is the argv it was started with;
// when the saved config differs from that, the change is "pending" until the next restart.
function effectiveDirs({ workdir, config, argv }) {
  const defs = defaultDirs(workdir);
  const out = {};
  for (const k of ['output', 'input']) {
    const configured = config[KEYS[k]] || '';
    const configuredPath = configured || defs[k];
    if (Array.isArray(argv)) {
      const flagged = parseArgvDir(argv, FLAGS[k]);
      const runningPath = flagged ? w.resolve(workdir, flagged) : defs[k];
      out[k] = { path: runningPath, source: 'running', pending: !sameDir(runningPath, configuredPath), configuredPath };
    } else {
      out[k] = { path: configuredPath, source: configured ? 'config' : 'default', pending: false, configuredPath };
    }
  }
  return out;
}

// Is this a folder ComfyUI can use? Creates it (with parents) only when asked to.
function checkDir(dir, { create = false } = {}) {
  const fail = (message) => ({ ok: false, created: false, message });
  if (!dir || typeof dir !== 'string') return fail('请选择一个文件夹');
  if (/^[A-Za-z]:[\\/]?$/.test(dir)) return fail(`不能是磁盘根目录:${dir}`);
  if (!w.isAbsolute(dir)) return fail(`必须是绝对路径:${dir}`);

  let created = false;
  let st = null;
  try {
    st = fs.statSync(dir);
  } catch {
    st = null;
  }
  if (st && !st.isDirectory()) return fail(`这不是文件夹:${dir}`);
  if (!st) {
    if (!create) return fail(`文件夹不存在:${dir}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
    } catch (e) {
      return fail(`无法创建文件夹:${e.message}`);
    }
  }

  const probe = path.join(dir, `.launcher-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (e) {
    return fail(`文件夹不可写:${e.message}`);
  }
  return { ok: true, created, message: '' };
}

// Size / file count / newest file. Bounded so a huge output folder cannot stall the UI.
async function dirStats(dir, { maxFiles = 20000, maxMs = 3000 } = {}) {
  const empty = { exists: false, sizeBytes: 0, fileCount: 0, latestMtime: 0, approximate: false };
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) return empty;
  } catch {
    return empty;
  }

  const started = Date.now();
  const stack = [dir];
  let sizeBytes = 0;
  let fileCount = 0;
  let latestMtime = 0;
  let approximate = false;
  let seen = 0;

  walk: while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (fileCount >= maxFiles || Date.now() - started >= maxMs) {
        approximate = true;
        break walk;
      }
      if (++seen % 200 === 0) await new Promise((r) => setImmediate(r)); // let the UI breathe
      if (entry.isSymbolicLink()) continue; // never follow links out of the folder
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = await fs.promises.lstat(full);
          sizeBytes += st.size;
          fileCount++;
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        } catch {
          /* file vanished while scanning */
        }
      }
    }
  }
  return { exists: true, sizeBytes, fileCount, latestMtime, approximate };
}

module.exports = { parseArgvDir, defaultDirs, effectiveDirs, checkDir, dirStats };
