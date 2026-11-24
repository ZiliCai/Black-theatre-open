// Reads size, length and the "prompt" / "workflow" text ComfyUI embeds in its mp4 and png files.
// Plain byte parsing, no ffmpeg needed. Never throws: anything unreadable gives an empty result.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MP4_EXT = new Set(['.mp4', '.m4v', '.mov']);
const WANTED_TAGS = new Set(['prompt', 'workflow']);
const MAX_MOOV = 32 * 1024 * 1024; // a moov holding a ComfyUI workflow is ~100 KB; this is only a sanity cap
const MAX_TEXT = 8 * 1024 * 1024;

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return n === length ? buf : buf.subarray(0, n);
}

// ---------- mp4 ----------
// Child boxes of buf[start, end). Stops quietly at the first box that does not fit.
function* boxes(buf, start, end) {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) return;
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) return;
    yield { type: buf.toString('latin1', i + 4, i + 8), start: i + header, end: i + size };
    i += size;
  }
}

const child = (buf, parent, type) => {
  for (const b of boxes(buf, parent.start, parent.end)) if (b.type === type) return b;
  return null;
};

function movieDuration(buf, mvhd) {
  const v = buf[mvhd.start];
  const at = mvhd.start + 4;
  if (v === 1 && mvhd.end >= at + 28) return Number(buf.readBigUInt64BE(at + 20)) / buf.readUInt32BE(at + 16);
  if (v === 0 && mvhd.end >= at + 16) return buf.readUInt32BE(at + 12) / buf.readUInt32BE(at + 8);
  return null;
}

function trackSize(buf, tkhd) {
  const at = tkhd.start + (buf[tkhd.start] === 1 ? 88 : 76); // width and height are 16.16 fixed-point numbers
  if (tkhd.end < at + 8) return null;
  const width = buf.readUInt32BE(at) / 65536;
  const height = buf.readUInt32BE(at + 4) / 65536;
  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
}

// moov/udta/meta (or moov/meta): a "keys" table names the tags, "ilst" holds the values by key number.
function readTags(buf, meta, tags) {
  const inner = { start: meta.start + 4, end: meta.end }; // meta is a "full box": 4 bytes of version/flags first
  const keys = child(buf, inner, 'keys');
  const ilst = child(buf, inner, 'ilst');
  if (!keys || !ilst) return;
  const names = [];
  let at = keys.start + 8;
  const count = keys.end >= keys.start + 8 ? buf.readUInt32BE(keys.start + 4) : 0;
  for (let n = 0; n < count && at + 8 <= keys.end; n++) {
    const size = buf.readUInt32BE(at);
    if (size < 8 || at + size > keys.end) break;
    names.push(buf.toString('utf8', at + 8, at + size));
    at += size;
  }
  for (const item of boxes(buf, ilst.start, ilst.end)) {
    // an ilst entry's "type" field is really the 1-based number of its key
    const name = names[buf.readUInt32BE(item.start - 4) - 1];
    if (!WANTED_TAGS.has(name)) continue;
    const data = child(buf, item, 'data');
    if (data && data.end > data.start + 8) tags[name] = buf.toString('utf8', data.start + 8, data.end);
  }
}

function readMp4(file) {
  const out = { kind: 'video', tags: {} };
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    let pos = 0;
    while (pos + 8 <= total) {
      const head = readAt(fd, pos, 16);
      if (head.length < 8) break;
      let size = head.readUInt32BE(0);
      let header = 8;
      if (size === 1 && head.length >= 16) {
        size = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (size === 0) {
        size = total - pos;
      }
      if (size < header || pos + size > total) break;
      if (head.toString('latin1', 4, 8) === 'moov') {
        if (size > MAX_MOOV) break;
        const buf = readAt(fd, pos, size);
        const moov = { start: header, end: size };
        const mvhd = child(buf, moov, 'mvhd');
        if (mvhd) out.duration = movieDuration(buf, mvhd);
        for (const trak of boxes(buf, moov.start, moov.end)) {
          if (trak.type !== 'trak' || out.width) continue;
          const tkhd = child(buf, trak, 'tkhd');
          const sz = tkhd && trackSize(buf, tkhd);
          if (sz) Object.assign(out, sz);
        }
        const udta = child(buf, moov, 'udta');
        const meta = (udta && child(buf, udta, 'meta')) || child(buf, moov, 'meta');
        if (meta) readTags(buf, meta, out.tags);
        break;
      }
      pos += size;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

// ---------- png ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodeText(type, data) {
  const nul = data.indexOf(0);
  if (nul < 1) return null;
  const key = data.toString('latin1', 0, nul);
  if (!WANTED_TAGS.has(key)) return null;
  if (type === 'tEXt') return { key, value: data.toString('latin1', nul + 1) };
  // iTXt: keyword NUL, compression flag, method, language NUL, translated keyword NUL, text
  const compressed = data[nul + 1] === 1;
  const langEnd = data.indexOf(0, nul + 3);
  const transEnd = langEnd === -1 ? -1 : data.indexOf(0, langEnd + 1);
  if (transEnd === -1) return null;
  const body = data.subarray(transEnd + 1);
  return { key, value: (compressed ? zlib.inflateSync(body) : body).toString('utf8') };
}

function readPng(file) {
  const out = { kind: 'image', tags: {} };
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    if (!readAt(fd, 0, 8).equals(PNG_SIG)) return out;
    let pos = 8;
    let first = true;
    while (pos + 12 <= total) {
      const head = readAt(fd, pos, 8);
      const size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (pos + 12 + size > total) break;
      if (first) {
        if (type !== 'IHDR' || size < 8) break;
        const ihdr = readAt(fd, pos + 8, 8);
        out.width = ihdr.readUInt32BE(0);
        out.height = ihdr.readUInt32BE(4);
        first = false;
      } else if ((type === 'tEXt' || type === 'iTXt') && size <= MAX_TEXT) {
        let decoded = null;
        try {
          decoded = decodeText(type, readAt(fd, pos + 8, size));
        } catch {
          decoded = null;
        }
        if (decoded) out.tags[decoded.key] = decoded.value;
      } else if (type === 'IEND') {
        break;
      }
      pos += 12 + size;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function readMediaMeta(file) {
  const kind = kindOf(file);
  if (!kind) return { kind: null, tags: {} };
  const ext = path.extname(file).toLowerCase();
  try {
    if (MP4_EXT.has(ext)) return readMp4(file);
    if (ext === '.png') return readPng(file);
  } catch {
    // fall through: an unreadable file is listed without details
  }
  return { kind, tags: {} };
}

module.exports = { readMediaMeta, kindOf, VIDEO_EXT, IMAGE_EXT };
