// Reads the user's saved workflows and lists where their save nodes write (relative to the output dir).
const fs = require('node:fs');
const path = require('node:path');

const SAVE_TYPES = {
  SaveImage: '图片',
  SaveVideo: '视频',
  VHS_VideoCombine: '视频',
  SaveAnimatedWEBP: '视频',
  SaveAnimatedPNG: '视频',
  SaveLatent: '潜空间',
  MiniMaxH3MotionContextSaveLatent: '接续数据',
};

const MAX_DEPTH = 2; // the folder itself + two levels of sub-folders
const IGNORED = /backup|\.bak/i;

function readPrefix(node) {
  const wv = node.widgets_values;
  if (Array.isArray(wv)) return typeof wv[0] === 'string' ? wv[0] : '';
  if (wv && typeof wv === 'object' && typeof wv.filename_prefix === 'string') return wv.filename_prefix;
  return '';
}

function describeSave(node) {
  const prefix = readPrefix(node);
  const slash = prefix.replace(/\\/g, '/');
  const cut = slash.lastIndexOf('/');
  return {
    nodeId: node.id,
    type: node.type,
    kind: SAVE_TYPES[node.type],
    title: node.title || '',
    prefix,
    folder: cut === -1 ? '' : slash.slice(0, cut),
    namePrefix: cut === -1 ? slash : slash.slice(cut + 1),
    linked: (node.inputs || []).some((i) => i.name === 'filename_prefix' && i.link !== null && i.link !== undefined),
    muted: node.mode === 2 || node.mode === 4,
  };
}

function collectFiles(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) collectFiles(full, depth + 1, out);
    } else if (e.isFile() && /\.json$/i.test(e.name) && !IGNORED.test(e.name)) {
      out.push(full);
    }
  }
}

function scanWorkflowSaves(workflowsDir) {
  const files = [];
  collectFiles(workflowsDir, 0, files);

  const workflows = [];
  let unreadable = 0;
  for (const file of files) {
    let data;
    let mtime = 0;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      unreadable++;
      continue;
    }
    const saves = (Array.isArray(data.nodes) ? data.nodes : [])
      .filter((n) => n && SAVE_TYPES[n.type])
      .map(describeSave);
    if (saves.length) {
      workflows.push({ name: path.basename(file), relPath: path.relative(workflowsDir, file), mtime, saves });
    }
  }
  workflows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { workflows, unreadable };
}

module.exports = { scanWorkflowSaves };
