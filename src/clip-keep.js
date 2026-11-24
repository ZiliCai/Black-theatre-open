// Keeping a take: on the finished-work page a video you are happy with is kept for a shot (1-4), and the clip
// it was made with is renamed clip_1-4 so the next shot can continue from it by name. Keeping another take for
// the same shot, or un-keeping, gives the old clip its original name back. What was renamed from what is
// recorded in h3_context/kept.json. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');
const { kindOf, readMediaMeta } = require('./media-meta');
const { resolveInside } = require('./safe-path');
const { listClips, madeWithClips, CLIP_DIR, SHOT_STEM, TOLERANCE_MS, MAX_GAP_MS } = require('./clip-sync');

const KEPT_FILE = 'kept.json';
const SHOT = /^\d{1,3}-\d{1,4}[a-z]?$/;
const VIDEO_OF_CLIP = /^(.+)_\d{5}_$/; // video/clip_1013-122909_00001_.mp4 was saved by the run that saved clip_1013-122909_

const shotStem = (shot) => `clip_${shot}`;

// "1-4", "1－4", " 1 - 4 " -> "1-4". null = not a shot number.
function normalizeShot(text) {
  const s = String(text ?? '').replace(/[\s]/g, '').replace(/[－—–_]/g, '-').toLowerCase();
  return SHOT.test(s) ? s : null;
}

const clipDir = (root) => path.join(root, CLIP_DIR);
const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// The record, cleaned: an entry whose clip_<shot> file is gone (deleted, or a keep that never finished) is dropped.
function readKept(root) {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(path.join(clipDir(root), KEPT_FILE), 'utf8'));
  } catch {
    data = null;
  }
  const shots = {};
  const raw = data && typeof data.shots === 'object' && data.shots ? data.shots : {};
  for (const [shot, e] of Object.entries(raw)) {
    if (!SHOT.test(shot) || !e || typeof e.video !== 'string' || typeof e.originalStem !== 'string') continue;
    if (!exists(path.join(clipDir(root), `${shotStem(shot)}.safetensors`))) continue;
    shots[shot] = { video: e.video, originalStem: e.originalStem, keptAt: Number(e.keptAt) || 0 };
  }
  return { version: 1, shots };
}

function writeKept(root, kept) {
  const file = path.join(clipDir(root), KEPT_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// { 'video/clip_..._00001_.mp4': '1-4', ... } for the page.
function keptByVideo(root) {
  if (!root || !fs.existsSync(clipDir(root))) return {};
  const out = {};
  for (const [shot, e] of Object.entries(readKept(root).shots)) out[e.video] = shot;
  return out;
}

// The clip a video was made with: same name first (videos saved through the clip node's video_prefix), else
// the newest clip saved shortly before it, the way the clip sync pairs them. Clips already kept for a shot
// belong to their own video and are never matched.
function findClip(root, relPath, mtimeMs, readMeta) {
  if (!madeWithClips(path.join(root, relPath), readMeta)) return null;
  const clips = listClips(root).filter((c) => !SHOT_STEM.test(c.stem));
  const have = new Set(clips.map((c) => c.stem));
  const base = path.basename(relPath, path.extname(relPath));
  const named = VIDEO_OF_CLIP.exec(base);
  if (named) for (const stem of [named[1], `${named[1]}_`]) if (have.has(stem)) return stem;
  let best = null;
  for (const c of clips) if (c.mtimeMs <= mtimeMs + TOLERANCE_MS) best = c; // oldest first: the last fit is the newest
  return best && mtimeMs - best.mtimeMs <= MAX_GAP_MS ? best.stem : null;
}

const busy = (e) => (e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)
  ? '文件正被占用(可能是 ComfyUI 正在读取它),稍后再试'
  : (e && e.message) || '改名失败');

// Renames stem.safetensors (and stem.jpg when there is one) to `to`. Undoes itself if the picture fails.
function renameClip(root, from, to, rename) {
  const dir = clipDir(root);
  if (exists(path.join(dir, `${to}.safetensors`))) throw new Error(`已经有一个 ${to}.safetensors,没有覆盖它`);
  rename(path.join(dir, `${from}.safetensors`), path.join(dir, `${to}.safetensors`));
  if (exists(path.join(dir, `${from}.jpg`))) {
    try {
      rename(path.join(dir, `${from}.jpg`), path.join(dir, `${to}.jpg`));
    } catch (e) {
      rename(path.join(dir, `${to}.safetensors`), path.join(dir, `${from}.safetensors`));
      throw e;
    }
  }
}

function checkVideo(root, relPath) {
  const abs = typeof relPath === 'string' ? resolveInside(root, relPath) : null;
  if (!abs || kindOf(abs) !== 'video') return { error: '只能保留视频' };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { error: '视频不存在' };
    return { mtimeMs: st.mtimeMs };
  } catch {
    return { error: '视频不存在' };
  }
}

// Keep `relPath` (a video under root) as the take for `shot`.
// isOwned(stem): true for a continuation file a take of the shot page owns; those are never renamed.
function keepTake({ root, relPath, shot: shotText, readMeta = readMediaMeta, rename = fs.renameSync, now = Date.now, isOwned = () => false }) {
  const shot = normalizeShot(shotText);
  if (!shot) return { ok: false, message: '分镜号要写成 集-镜 的样子,比如 1-4' };
  if (!root || !fs.existsSync(clipDir(root))) return { ok: false, message: '输出目录里没有 h3_context 文件夹' };
  const video = checkVideo(root, relPath);
  if (video.error) return { ok: false, message: video.error };

  const before = readKept(root);
  const already = Object.entries(before.shots).find(([, e]) => e.video === relPath);
  if (already && already[0] === shot) return { ok: true, message: `已经是分镜 ${shot}`, shot, kept: keptByVideo(root) };

  let source;
  let originalStem;
  if (already) {
    source = shotStem(already[0]);
    originalStem = already[1].originalStem;
  } else {
    source = findClip(root, relPath, video.mtimeMs, readMeta);
    if (!source) return { ok: false, message: '找不到这个视频对应的 clip(放大后的视频,或 clip 已被清理)' };
    originalStem = source;
  }
  if (isOwned(source) || isOwned(path.basename(relPath, path.extname(relPath)))) {
    return { ok: false, message: '这是镜头页生成的抽卡，请在镜头页用「选中」来接续，不用保留为分镜' };
  }
  const replaced = before.shots[shot] || null;
  if (!replaced && exists(path.join(clipDir(root), `${shotStem(shot)}.safetensors`))) {
    return { ok: false, message: `已经有一个 ${shotStem(shot)}.safetensors,但没有保留记录。请先手动改名或移走它` };
  }

  // the take that held this shot gives it up first, exactly like an un-keep
  if (replaced) {
    const r = unkeepTake({ root, relPath: replaced.video, rename });
    if (!r.ok) return { ok: false, message: `原来的分镜 ${shot} 没能恢复原名:${r.message}` };
  }
  const mid = readKept(root);
  const after = { version: 1, shots: { ...mid.shots } };
  if (already) delete after.shots[already[0]];
  after.shots[shot] = { video: relPath, originalStem, keptAt: now() };

  // the record goes first: a keep cut short leaves an entry without its clip_<shot>, which readKept drops
  try {
    writeKept(root, after);
    renameClip(root, source, shotStem(shot), rename);
  } catch (e) {
    try { writeKept(root, mid); } catch { /* best effort */ }
    if (replaced) { // put the old take back where it was
      try {
        renameClip(root, replaced.originalStem, shotStem(shot), rename);
        writeKept(root, before);
      } catch { /* best effort */ }
    }
    return { ok: false, message: busy(e) };
  }
  let message = `已保留为分镜 ${shot}:${source}${source === shotStem(shot) ? '' : ` → ${shotStem(shot)}`}`;
  if (replaced) message += `;原来的 ${path.basename(replaced.video)} 的 clip 已恢复为 ${replaced.originalStem}`;
  return { ok: true, message, shot, stem: shotStem(shot), replaced: replaced ? { video: replaced.video, restoredStem: replaced.originalStem } : null, kept: keptByVideo(root) };
}

// Stop keeping `relPath`: its clip gets its original name back.
function unkeepTake({ root, relPath, rename = fs.renameSync }) {
  if (!root || !fs.existsSync(clipDir(root))) return { ok: false, message: '输出目录里没有 h3_context 文件夹' };
  const before = readKept(root);
  const hit = Object.entries(before.shots).find(([, e]) => e.video === relPath);
  if (!hit) return { ok: false, message: '这个视频没有被保留', kept: keptByVideo(root) };
  const [shot, entry] = hit;
  const after = { version: 1, shots: { ...before.shots } };
  delete after.shots[shot];
  try {
    renameClip(root, shotStem(shot), entry.originalStem, rename);
  } catch (e) {
    return { ok: false, message: busy(e) };
  }
  try {
    writeKept(root, after);
  } catch (e) {
    try { renameClip(root, entry.originalStem, shotStem(shot), rename); } catch { /* best effort */ }
    return { ok: false, message: busy(e) };
  }
  return { ok: true, message: `已取消分镜 ${shot} 的保留,clip 恢复为 ${entry.originalStem}`, shot, restoredStem: entry.originalStem, kept: keptByVideo(root) };
}

function continuationShots(root) {
  return Object.entries(readKept(root).shots).map(([shot, entry]) => {
    const preview = `${CLIP_DIR}/${shotStem(shot)}.jpg`;
    return {
      shot,
      video: entry.video,
      clip: `${preview} [output]`,
      preview,
      hasPreview: exists(path.join(root, preview)),
    };
  }).sort((a, b) => a.shot.localeCompare(b.shot, 'zh', { numeric: true }));
}

module.exports = { keepTake, unkeepTake, keptByVideo, normalizeShot, readKept, continuationShots, KEPT_FILE };
