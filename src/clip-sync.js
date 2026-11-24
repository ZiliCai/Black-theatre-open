// Keeps the saved-clip folder (output/h3_context) in step with the videos you kept. A clip belongs to the video
// ComfyUI wrote right after saving it, so each video is matched to the newest clip saved before it. Clips no
// kept video points at can be moved to the recycle bin. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');
const { kindOf, readMediaMeta } = require('./media-meta');
const { resolveInside } = require('./safe-path');

const CLIP_DIR = 'h3_context';
const MAX_DEPTH = 3;
const MAX_GAP_MS = 2 * 60 * 60 * 1000; // a video made more than this long after the newest earlier clip is not matched to it
const TOLERANCE_MS = 2000; // file times of the clip and the video can disagree by a moment
const SLOT = /^clip_\d{5}$/; // clip_00003: a numbered slot of a chain, not a take
const SHOT_STEM = /^clip_(\d{1,3}-\d{1,4}[a-z]?)$/; // clip_1-4: a take kept for shot 1-4 (see clip-keep.js)
const STEM = /^[A-Za-z0-9_-]+$/;
const SAVES_CLIPS = 'MiniMaxH3MotionContextSaveLatent'; // the node in a workflow that writes the clip files

const posix = (p) => p.split(path.sep).join('/');

function listClips(root) {
  const dir = path.join(root, CLIP_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const have = new Set(names);
  const clips = [];
  for (const name of names) {
    if (!name.endsWith('.safetensors')) continue;
    const stem = name.slice(0, -'.safetensors'.length);
    if (!STEM.test(stem)) continue;
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const files = [name];
    let bytes = st.size;
    if (have.has(`${stem}.jpg`)) {
      try {
        bytes += fs.statSync(path.join(dir, `${stem}.jpg`)).size;
        files.push(`${stem}.jpg`);
      } catch { /* the picture is optional */ }
    }
    clips.push({ stem, files, bytes, mtimeMs: st.mtimeMs, slot: SLOT.test(stem) });
  }
  return clips.sort((a, b) => a.mtimeMs - b.mtimeMs || a.stem.localeCompare(b.stem));
}

// A video made by a workflow that saves clips mentions the saving node in the prompt ComfyUI embedded. One
// whose embedded prompt does not (a SeedVR2 upscale, say) has no clip of its own. Unreadable = assume it does.
function madeWithClips(file, readMeta) {
  let prompt = null;
  try {
    const meta = readMeta(file) || {};
    prompt = meta.tags && typeof meta.tags.prompt === 'string' ? meta.tags.prompt : null;
  } catch {
    prompt = null;
  }
  return prompt === null || prompt.includes(SAVES_CLIPS);
}

function listVideos(root, readMeta) {
  const videos = [];
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
        if (depth < MAX_DEPTH && !(depth === 0 && e.name === CLIP_DIR)) visit(full, depth + 1);
      } else if (e.isFile() && kindOf(e.name) === 'video') {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.size > 0 && madeWithClips(full, readMeta)) videos.push({ relPath: posix(path.relative(root, full)), mtimeMs: st.mtimeMs });
      }
    }
  };
  visit(root, 0);
  return videos;
}

// What would be kept and what would go. `generating` = ComfyUI is working on a job right now: a clip newer
// than every video may belong to that job's video-to-be, so it is left alone. Numbered slots are left alone
// unless includeSlots, because they are chain positions you may have filled on purpose.
function planSync({ root, generating = false, includeSlots = false, readMeta = readMediaMeta }) {
  if (!root || !fs.existsSync(root)) return { missing: true, keep: [], remove: [], held: [], removeBytes: 0 };
  const clips = listClips(root);
  const videos = listVideos(root, readMeta);
  const owned = new Map(clips.map((c) => [c.stem, []]));
  for (const v of videos) {
    let best = null;
    for (const c of clips) if (c.mtimeMs <= v.mtimeMs + TOLERANCE_MS) best = c; // clips are oldest first, the last fit is the newest
    if (best && v.mtimeMs - best.mtimeMs <= MAX_GAP_MS) owned.get(best.stem).push(v.relPath);
  }
  const newestVideo = videos.reduce((m, v) => Math.max(m, v.mtimeMs), -Infinity);
  const plan = { missing: false, keep: [], remove: [], held: [], removeBytes: 0, videoCount: videos.length };
  for (const c of clips) {
    const item = { stem: c.stem, bytes: c.bytes, mtimeMs: c.mtimeMs, slot: c.slot, files: c.files, videos: owned.get(c.stem).sort() };
    const shot = SHOT_STEM.exec(c.stem);
    if (shot) plan.held.push({ ...item, reason: `已保留为分镜 ${shot[1]},不清理` });
    else if (item.videos.length) plan.keep.push(item);
    else if (c.slot && !includeSlots) plan.held.push({ ...item, reason: '固定编号的 clip,默认不动' });
    else if (generating && c.mtimeMs > newestVideo) plan.held.push({ ...item, reason: '正在生成,它的视频可能还没出来' });
    else {
      plan.remove.push(item);
      plan.removeBytes += c.bytes;
    }
  }
  return plan;
}

// Sends the chosen clips (the safetensors file and its picture) to `trash`. Only stems the fresh plan says are
// removable are touched, so a clip that gained a video since the page last looked is never lost.
async function trashClips({ root, stems, generating, includeSlots, trash, readMeta }) {
  const out = { trashed: [], failed: [], skipped: [] };
  if (!Array.isArray(stems)) return out;
  const plan = planSync({ root, generating, includeSlots, readMeta });
  const allowed = new Map(plan.remove.map((c) => [c.stem, c]));
  for (const stem of stems) {
    const clip = typeof stem === 'string' ? allowed.get(stem) : null;
    if (!clip) {
      out.skipped.push(stem);
      continue;
    }
    let failed = null;
    for (const file of clip.files) {
      const abs = resolveInside(path.join(root, CLIP_DIR), file);
      if (!abs) {
        failed = '路径不在 clip 文件夹内';
        break;
      }
      try {
        await trash(abs);
      } catch (e) {
        failed = e.message || '无法移到回收站';
        break;
      }
    }
    if (failed) out.failed.push({ stem, message: failed });
    else out.trashed.push(stem);
  }
  return out;
}

module.exports = { planSync, trashClips, listClips, madeWithClips, CLIP_DIR, SHOT_STEM, TOLERANCE_MS, MAX_GAP_MS };
