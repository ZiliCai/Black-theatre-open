// Finding what one take produced. Every take runs with its own name prefix (bb_<take id>), so its continuation
// file and video are found by name instead of being guessed from modification times.
const fs = require('node:fs');
const path = require('node:path');
const { resolveInside } = require('./safe-path');
const { CLIP_DIR } = require('./clip-sync');

// The continuation file saved by the take: <key>_<stamp>_.safetensors with its .jpg beside it. Newest wins.
function findContext(outputDir, outputKey) {
  const dir = path.join(outputDir, CLIP_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  // take ids use '-' and never '_', so "<key>_" cannot also be the start of another take's key
  const found = names
    .filter((name) => name.startsWith(`${outputKey}_`) && name.endsWith('.safetensors'))
    .map((name) => name.slice(0, -'.safetensors'.length))
    .filter((stem) => names.includes(`${stem}.jpg`))
    .map((stem) => ({ stem, mtime: fs.statSync(path.join(dir, `${stem}.safetensors`)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].stem : null;
}

// The video a take saved, found by its name when ComfyUI no longer remembers the run (relative path or null).
function findVideo(outputDir, outputKey) {
  let names;
  try {
    names = fs.readdirSync(path.join(outputDir, 'video'));
  } catch {
    return null;
  }
  const own = names.filter((n) => n.startsWith(`${outputKey}_`) && /\.(mp4|m4v|mov|webm|mkv)$/i.test(n)).sort();
  return own.length ? `video/${own[own.length - 1]}` : null;
}

// Absolute paths of the files a take owns that are still there: video, continuation latent and its picture, its
// upscaled video, or the image of an image take.
function takeFiles(outputDir, take) {
  const rels = [];
  if (take.video) rels.push(take.video);
  if (take.upscale && take.upscale.video) rels.push(take.upscale.video);
  if (take.image) rels.push(take.image);
  if (take.context) rels.push(`${CLIP_DIR}/${take.context}.safetensors`, `${CLIP_DIR}/${take.context}.jpg`);
  return rels
    .map((rel) => resolveInside(outputDir, rel))
    .filter((abs) => {
      try {
        return abs && fs.statSync(abs).isFile();
      } catch {
        return false;
      }
    });
}

// A run can save more than one video (hybrid also saves a first-pass comparison); the take's own is named after it.
function pickVideo(videos, outputKey) {
  if (!videos || !videos.length) return null;
  const own = videos.find((v) => path.posix.basename(v.relPath).startsWith(`${outputKey}_`));
  return (own || videos[0]).relPath;
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

// The picture an image take saved: the history output named after it, else the newest file by that name in ref/.
function pickImage(outputs, outputKey) {
  for (const output of Object.values(outputs || {})) {
    for (const item of (output && output.images) || []) {
      const filename = String((item && item.filename) || '');
      if (item.type === 'temp' || item.type === 'input' || /[\\/]/.test(filename) || !IMAGE_FILE.test(filename)) continue;
      const parts = [...String(item.subfolder || '').split(/[\\/]+/), filename].filter(Boolean);
      if (parts.some((part) => part === '..' || part === '.')) continue;
      if (filename.startsWith(`${outputKey}_`)) return parts.join('/');
    }
  }
  return null;
}

function findImage(outputDir, outputKey) {
  let names;
  try {
    names = fs.readdirSync(path.join(outputDir, 'ref'));
  } catch {
    return null;
  }
  const own = names.filter((n) => n.startsWith(`${outputKey}_`) && IMAGE_FILE.test(n)).sort();
  return own.length ? `ref/${own[own.length - 1]}` : null;
}

module.exports = { findContext, findVideo, takeFiles, pickVideo, pickImage, findImage };
