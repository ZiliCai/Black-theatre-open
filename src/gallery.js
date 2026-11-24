// The finished-work page: lists the pictures and videos under a folder (newest first, with the details
// ComfyUI embedded in them) and moves chosen ones to the recycle bin. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');
const { readMediaMeta, kindOf } = require('./media-meta');
const { summarizePrompt } = require('./prompt-summary');
const { resolveInside } = require('./safe-path');

const MAX_DEPTH = 3; // the folder itself + three levels of sub-folders
const DEFAULT_MAX_FILES = 3000; // shown
const WALK_LIMIT = 20000; // looked at, so "newest" is still right in a huge folder
const CACHE_LIMIT = 10000;

const posix = (p) => p.split(path.sep).join('/');
function walk(root, limit) {
  const files = [];
  let hitLimit = false;
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hitLimit) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) visit(full, depth + 1);
      } else if (e.isFile() && kindOf(e.name)) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.size === 0) continue;
        if (files.length >= limit) {
          hitLimit = true;
          return;
        }
        files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  visit(root, 0);
  return { files, hitLimit };
}

function createScanner({ readMeta = readMediaMeta } = {}) {
  const cache = new Map(); // absolute path -> { mtimeMs, size, details }

  function detailsOf(file) {
    const hit = cache.get(file.full);
    if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) return hit.details;
    let meta;
    try {
      meta = readMeta(file.full) || {};
    } catch {
      meta = {};
    }
    const details = {
      width: meta.width ?? null,
      height: meta.height ?? null,
      duration: meta.duration ?? null,
      params: summarizePrompt(meta.tags && meta.tags.prompt),
    };
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(file.full, { mtimeMs: file.mtimeMs, size: file.size, details });
    return details;
  }

  function scan(root, { maxFiles = DEFAULT_MAX_FILES } = {}) {
    if (!root || !fs.existsSync(root)) return { entries: [], truncated: false, missing: true };
    const { files, hitLimit } = walk(root, WALK_LIMIT);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.full.localeCompare(b.full, 'zh'));
    const shown = files.slice(0, maxFiles);
    const entries = shown.map((f) => {
      const rel = posix(path.relative(root, f.full));
      const cut = rel.lastIndexOf('/');
      return {
        relPath: rel,
        name: cut === -1 ? rel : rel.slice(cut + 1),
        folder: cut === -1 ? '' : rel.slice(0, cut),
        kind: kindOf(f.full),
        size: f.size,
        mtimeMs: f.mtimeMs,
        ...detailsOf(f),
      };
    });
    return { entries, truncated: hitLimit || files.length > shown.length, missing: false };
  }

  return { scan };
}

// Sends the chosen files to `trash` (the system recycle bin in the app). Only pictures and videos that
// really are files inside root are touched; one failure never stops the rest.
async function trashEntries({ root, relPaths, trash }) {
  const out = { trashed: [], failed: [] };
  if (!Array.isArray(relPaths)) return out;
  for (const rel of relPaths) {
    const fail = (message) => out.failed.push({ relPath: rel, message });
    const abs = resolveInside(root, rel);
    if (!abs) {
      fail('不在当前查看的文件夹内');
      continue;
    }
    if (!kindOf(abs)) {
      fail('不是图片或视频文件');
      continue;
    }
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      fail('文件不存在');
      continue;
    }
    try {
      await trash(abs);
      out.trashed.push(rel);
    } catch (e) {
      fail(e.message || '无法移到回收站');
    }
  }
  return out;
}

// "Range: bytes=a-b" for a file of `size` bytes. null = no usable single range (send everything),
// { start, end } = send that slice (206), { unsatisfiable: true } = answer 416.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') { // the last N bytes
    const n = Number(m[2]);
    return n === 0 ? { unsatisfiable: true } : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || start > end ? { unsatisfiable: true } : { start, end };
}

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || null;

module.exports = { createScanner, resolveInside, trashEntries, parseRange, mimeOf };
