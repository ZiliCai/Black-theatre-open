// Story documents of a script project: plain .md / .txt files in the project's docs folder. Lists, reads, saves
// (with history and change detection), creates, renames, searches. Plain Node, no Electron.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveInside } = require('./safe-path');
const { removeFile } = require('./fs-safe');

const MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_KEEP = 30;
const MAX_DEPTH = 2; // the docs folder itself + two levels of sub-folders
const MAX_NAME = 120;
const SEARCH_LIMIT = 200;
const SNIPPETS_PER_FILE = 3;
const HISTORY_DIR = '.history';
const DOC_EXT = /\.(md|txt)$/i;
const HISTORY_ID = /^(\d{8}-\d{6})(?:-(\d+))?\.(md|txt)$/;
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const two = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
const posix = (p) => p.split(path.sep).join('/');
const byName = (a, b) => a.localeCompare(b, 'zh', { numeric: true });
// Files of a folder come before its sub-folders; names compare the way a person reads numbers (2 before 10).
function byPath(a, b) {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xFile = i === x.length - 1;
    const yFile = i === y.length - 1;
    if (xFile !== yFile) return xFile ? -1 : 1;
    const c = byName(x[i], y[i]);
    if (c !== 0) return c;
  }
  return x.length - y.length;
}

// First match wins: a file called "分镜头设定" is a storyboard, "大纲与细纲" a detailed outline.
function guessCategory(name) {
  if (/分镜/.test(name)) return '分镜头';
  if (/细纲/.test(name)) return '细纲';
  if (/大纲/.test(name)) return '大纲';
  if (/设定/.test(name)) return '故事设定';
  return '其他';
}

// ---------- listing ----------
function listDocs(docsDir, project) {
  if (!docsDir || !fs.existsSync(docsDir)) return { exists: false, docs: [] };
  const saved = (project && project.docs) || {};
  const docs = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) visit(full, depth + 1);
      } else if (e.isFile() && DOC_EXT.test(e.name)) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        const relPath = posix(path.relative(docsDir, full));
        docs.push({ relPath, name: e.name, category: saved[relPath] || guessCategory(e.name), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  visit(docsDir, 0);
  docs.sort((a, b) => byPath(a.relPath, b.relPath));
  return { exists: true, docs };
}

// ---------- reading ----------
function decode(buf) {
  let bom = false;
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    body = buf.subarray(3);
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), bom, utf8: true };
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), bom, utf8: false };
  }
}

function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

const normalizeEol = (text) => text.replace(/\r\n?/g, '\n');

// Validated absolute path of a document inside docsDir, or { error }.
function docPath(docsDir, relPath) {
  const abs = resolveInside(docsDir, relPath);
  if (!abs || !DOC_EXT.test(abs)) return { error: '不是设定文档(只支持 .md 和 .txt,且必须在设定文件夹里)' };
  if (path.relative(docsDir, abs).split(path.sep).some((part) => part.startsWith('.'))) return { error: '不能打开隐藏文件夹里的文件' };
  return { abs };
}

function readDoc(docsDir, relPath) {
  const p = docPath(docsDir, relPath);
  if (p.error) return { ok: false, message: p.error };
  let st;
  try {
    st = fs.statSync(p.abs);
  } catch {
    return { ok: false, message: `找不到文件:${relPath}` };
  }
  if (!st.isFile()) return { ok: false, message: `不是文件:${relPath}` };
  if (st.size > MAX_BYTES) return { ok: false, message: '文件超过 2 MB,启动器不打开它' };
  const raw = fs.readFileSync(p.abs);
  const d = decode(raw);
  return {
    ok: true,
    relPath,
    content: normalizeEol(d.text),
    version: sha1(raw),
    eol: eolOf(d.text),
    bom: d.bom,
    readOnly: !d.utf8,
    readOnlyReason: d.utf8 ? '' : '这个文件不是 UTF-8 编码(可能是 GBK),为避免存坏只能查看,不能编辑',
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

// ---------- history ----------
const historyDirOf = (docsDir, relPath) => path.join(docsDir, HISTORY_DIR, relPath.replace(DOC_EXT, ''));

const historyKey = (id) => {
  const m = HISTORY_ID.exec(id);
  return m ? `${m[1]}-${String(m[2] || 1).padStart(6, '0')}` : '';
};

function historyIds(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => HISTORY_ID.test(n)).sort((a, b) => historyKey(a).localeCompare(historyKey(b)));
  } catch {
    return [];
  }
}

function addToHistory(docsDir, relPath, abs, now) {
  const dir = historyDirOf(docsDir, relPath);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(abs).toLowerCase();
  const stamp = stampOf(now());
  let id = `${stamp}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, id)); n++) id = `${stamp}-${n}${ext}`;
  fs.copyFileSync(abs, path.join(dir, id));
  const all = historyIds(dir);
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) removeFile(path.join(dir, old));
  return id;
}

function listHistory(docsDir, relPath) {
  const dir = historyDirOf(docsDir, relPath);
  if (!resolveInside(docsDir, path.join(HISTORY_DIR, relPath.replace(DOC_EXT, '')) + '.x')) return [];
  return historyIds(dir).reverse().map((id) => {
    const m = HISTORY_ID.exec(id);
    const s = m[1];
    const time = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, id)).size;
    } catch {
      size = 0;
    }
    return { id, time: time.toISOString(), size };
  });
}

function readHistory(docsDir, relPath, id) {
  if (typeof id !== 'string' || !HISTORY_ID.test(id)) return { ok: false, message: '不是有效的历史版本' };
  const p = docPath(docsDir, relPath);
  if (p.error) return { ok: false, message: p.error };
  const file = path.join(historyDirOf(docsDir, relPath), id);
  try {
    const raw = fs.readFileSync(file);
    const d = decode(raw);
    return { ok: true, id, content: normalizeEol(d.text), readOnly: !d.utf8 };
  } catch {
    return { ok: false, message: '这个历史版本已经不存在' };
  }
}

// ---------- saving ----------
function atomicWrite(abs, buf) {
  const tmpFile = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}`);
  fs.writeFileSync(tmpFile, buf);
  try {
    fs.renameSync(tmpFile, abs);
  } catch (e) {
    removeFile(tmpFile);
    throw e;
  }
}

// expectVersion is the fingerprint the page got when it opened the file. If the file on disk is no longer that,
// somebody else changed it: nothing is written unless overwrite is set.
function saveDoc({ docsDir, relPath, content, expectVersion, overwrite = false, now = () => new Date() }) {
  const p = docPath(docsDir, relPath);
  if (p.error) return { ok: false, message: p.error };
  if (typeof content !== 'string') return { ok: false, message: '没有要保存的内容' };
  let raw;
  try {
    raw = fs.readFileSync(p.abs);
  } catch {
    return { ok: false, gone: true, message: '文件已经不在原来的位置了(被删除或改名),没有保存' };
  }
  const current = sha1(raw);
  if (!overwrite && current !== expectVersion) return { ok: false, conflict: true, currentVersion: current, message: '文件在你打开之后被别人改过了' };
  const old = decode(raw);
  if (!old.utf8) return { ok: false, message: '这个文件不是 UTF-8 编码,不能编辑' };

  const eol = eolOf(old.text);
  let text = normalizeEol(content);
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  const body = Buffer.from(text, 'utf8');
  if (body.length > MAX_BYTES) return { ok: false, message: '内容超过 2 MB,无法保存' };
  const buf = old.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  if (buf.equals(raw)) return { ok: true, unchanged: true, version: current };

  try {
    addToHistory(docsDir, relPath, p.abs, now);
    atomicWrite(p.abs, buf);
  } catch (e) {
    return { ok: false, message: `保存失败:${e.message}` };
  }
  const st = fs.statSync(p.abs);
  return { ok: true, version: sha1(buf), mtimeMs: st.mtimeMs, size: st.size };
}

// ---------- create / rename / trash ----------
function checkFileName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return { ok: false, message: '请输入文档名' };
  if (n.length > MAX_NAME) return { ok: false, message: `文档名太长(最多 ${MAX_NAME} 个字)` };
  if (BAD_NAME.test(n)) return { ok: false, message: '文档名不能包含 \\ / : * ? " < > | 这些字符' };
  if (n.startsWith('.') || n.endsWith('.')) return { ok: false, message: '文档名不能以点开头或结尾' };
  if (RESERVED.test(n)) return { ok: false, message: `「${n}」是 Windows 保留名,请换一个` };
  const ext = path.extname(n);
  if (ext && !DOC_EXT.test(n) && /\.[A-Za-z0-9]{1,5}$/.test(n)) return { ok: false, message: '只能新建 .md 或 .txt 文档' };
  return { ok: true, name: n };
}

function createDoc({ docsDir, name }) {
  const c = checkFileName(name);
  if (!c.ok) return c;
  const file = DOC_EXT.test(c.name) ? c.name : `${c.name}.md`;
  const abs = path.join(docsDir, file);
  try {
    fs.mkdirSync(docsDir, { recursive: true });
    if (fs.existsSync(abs)) return { ok: false, message: `已经有一个叫「${file}」的文档了` };
    fs.writeFileSync(abs, `# ${file.replace(DOC_EXT, '')}\n\n`, 'utf8');
  } catch (e) {
    return { ok: false, message: `无法新建文档:${e.message}` };
  }
  return { ok: true, relPath: file, message: '' };
}

function renameDoc({ docsDir, relPath, newName }) {
  const p = docPath(docsDir, relPath);
  if (p.error) return { ok: false, message: p.error };
  const c = checkFileName(newName);
  if (!c.ok) return c;
  if (!fs.existsSync(p.abs)) return { ok: false, message: `找不到文件:${relPath}` };
  const ext = path.extname(p.abs);
  const file = DOC_EXT.test(c.name) ? c.name : `${c.name}${ext}`;
  const target = path.join(path.dirname(p.abs), file);
  if (fs.existsSync(target)) return { ok: false, message: `已经有一个叫「${file}」的文档了` };
  const newRel = posix(path.relative(docsDir, target));
  try {
    fs.renameSync(p.abs, target);
    const oldHist = historyDirOf(docsDir, relPath);
    if (fs.existsSync(oldHist)) {
      const newHist = historyDirOf(docsDir, newRel);
      fs.mkdirSync(path.dirname(newHist), { recursive: true });
      if (!fs.existsSync(newHist)) fs.renameSync(oldHist, newHist);
    }
  } catch (e) {
    return { ok: false, message: `改名失败:${e.message}` };
  }
  return { ok: true, relPath: newRel, message: '' };
}

async function trashDoc({ docsDir, relPath, trash }) {
  const p = docPath(docsDir, relPath);
  if (p.error) return { ok: false, message: p.error };
  let st = null;
  try {
    st = fs.statSync(p.abs);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) return { ok: false, message: `找不到文件:${relPath}` };
  try {
    await trash(p.abs);
  } catch (e) {
    return { ok: false, message: e.message || '无法移到回收站' };
  }
  return { ok: true, message: '' };
}

// ---------- search ----------
function searchDocs(docsDir, query, { limit = SEARCH_LIMIT } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const doc of listDocs(docsDir, null).docs) {
    if (results.length >= limit) break;
    if (doc.size > MAX_BYTES) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(docsDir, doc.relPath));
    } catch {
      continue;
    }
    const d = decode(raw);
    if (!d.utf8) continue;
    const lines = normalizeEol(d.text).split('\n');
    const hay = `${doc.relPath}\n${d.text}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const matches = [];
    let total = 0;
    lines.forEach((line, i) => {
      const l = line.toLowerCase();
      if (words.some((w) => l.includes(w))) {
        total++;
        if (matches.length < SNIPPETS_PER_FILE) matches.push({ line: i + 1, text: line.length > 200 ? `${line.slice(0, 200)}…` : line });
      }
    });
    results.push({ relPath: doc.relPath, matches, total });
  }
  return results;
}

module.exports = {
  MAX_BYTES, HISTORY_KEEP, guessCategory, listDocs, readDoc, saveDoc, createDoc, renameDoc, trashDoc,
  listHistory, readHistory, searchDocs,
};
