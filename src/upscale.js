// Upscaling a chosen take with SeedVR2: the settings that fit the graphics card, the filled-in workflow, and the
// take's `upscale` record that the queue writes to. The upscaled video sits beside the original (video/upscaled/),
// which is never touched. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');
const { loadTemplate } = require('./workflow-template');
const { createTakeStore } = require('./take-store');
const { estimateRun } = require('./run-estimate');

const UPSCALE_TEMPLATE = 'seedvr2-upscale';
const UPSCALED_DIR = 'video/upscaled';
const INPUT_DIR = 'blackbox'; // inside ComfyUI's input folder, where the original goes for the run to read
const GB = 2 ** 30;

const QUALITIES = [
  { id: '720p', resolution: 720, minVramGB: 0 },
  { id: '1080p', resolution: 1080, minVramGB: 0 },
  { id: '1440p', resolution: 1440, minVramGB: 16 },
];
const DEFAULT_QUALITY = '1080p';

const gbOf = (vramTotal) => (Number(vramTotal) > 0 ? Number(vramTotal) / GB : 0);

// The sizes this card can take. Unknown memory (ComfyUI not answering) counts as a small card.
function qualitiesFor(vramTotal) {
  return QUALITIES.filter((q) => gbOf(vramTotal) >= q.minVramGB).map((q) => q.id);
}

// Everything but the size follows the card's memory. The small-card row is what ran on a 3080 10GB for months;
// the big-card row keeps the whole model on the card and works on more frames at a time.
function upscaleSettings(vramTotal, quality = DEFAULT_QUALITY) {
  const q = QUALITIES.find((x) => x.id === quality);
  if (!q) return null;
  const gb = gbOf(vramTotal);
  const base = { quality: q.id, resolution: q.resolution };
  if (gb >= 20) return { ...base, blocksToSwap: 0, batchSize: 21, overlap: 4, tile: 768 };
  if (gb >= 14) return { ...base, blocksToSwap: 16, batchSize: 13, overlap: 3, tile: 512 };
  return { ...base, blocksToSwap: 32, batchSize: 9, overlap: 3, tile: 512 };
}

const loadUpscaleTemplate = (templatesDir) => loadTemplate(path.join(templatesDir, UPSCALE_TEMPLATE));

// where the original is put in ComfyUI's input folder ("blackbox/bb_x_00001_.mp4")
const inputNameFor = (video) => `${INPUT_DIR}/${path.posix.basename(String(video).replace(/\\/g, '/'))}`;
const upscaleKey = (take) => `${take.outputKey}_up`;

function compileUpscale(template, { inputName, settings, outputKey }) {
  const { manifest: m, graph } = template;
  const b = m.bindings;
  const out = JSON.parse(JSON.stringify(graph));
  const set = (binding, value) => { out[binding.node].inputs[binding.input] = value; };
  set(b.video, inputName);
  set(b.resolution, settings.resolution);
  set(b.batchSize, settings.batchSize);
  set(b.overlap, settings.overlap);
  set(b.blocksToSwap, settings.blocksToSwap);
  set(b.encodeTile, settings.tile);
  set(b.decodeTile, settings.tile);
  set(m.outputs.videoPrefix, `${UPSCALED_DIR}/${outputKey}`);
  return out;
}

// The upscaled video a run saved, found by its name when ComfyUI no longer remembers the run.
function findUpscaled(outputDir, outputKey) {
  let names;
  try {
    names = fs.readdirSync(path.join(outputDir, ...UPSCALED_DIR.split('/')));
  } catch {
    return null;
  }
  const own = names.filter((n) => n.startsWith(`${outputKey}_`) && /\.(mp4|m4v|mov|webm|mkv)$/i.test(n)).sort();
  // VHS keeps a silent copy beside the one with the sound ("-audio"): the one with the sound is the result
  const best = own.filter((n) => /-audio\.\w+$/i.test(n)).pop() || own.pop();
  return best ? `${UPSCALED_DIR}/${best}` : null;
}

// The take store as the queue sees it for upscale jobs: each take's `upscale` record stands in for the take,
// so queueing, running, finishing and resuming after a restart work as they do for a take itself.
function createUpscaleStore(projectDir) {
  const takes = createTakeStore(projectDir);
  return {
    listShotIds: () => takes.listShotIds(),
    readShot(shotId) {
      const read = takes.readShot(shotId);
      return { ...read, takes: read.takes.filter((t) => t.upscale && typeof t.upscale === 'object').map((t) => ({ ...t.upscale, id: t.id })) };
    },
    updateTake(shotId, takeId, patch) {
      const take = takes.readShot(shotId).takes.find((t) => t.id === takeId);
      if (!take) return null;
      const { id, ...rest } = patch;
      return takes.updateTake(shotId, takeId, { upscale: { ...(take.upscale || {}), ...rest } });
    },
  };
}

// Upscale records of every take in the project, for the time estimate.
function pastUpscales(store) {
  return store.listShotIds().flatMap((id) => store.readShot(id).takes)
    .filter((t) => t.upscale && typeof t.upscale === 'object')
    .map((t) => ({ ...t.upscale, id: t.id }));
}

function createUpscaleService({ getProject, templatesDir, queue, getVram = () => null, getTargetId = () => 'local', picks }) {
  const NO_PROJECT = { ok: false, noProject: true, message: '请先选择或新建一个剧本项目' };

  // Why this take cannot be upscaled now, or '' when it can.
  function refusal(take, quality) {
    if (!take) return '找不到这一条，请刷新';
    if (take.status !== 'succeeded' || !take.video) return '这一条还没生成完成';
    if (take.tier !== 'pick') return '只有选中的那一条能超分';
    const up = take.upscale;
    if (up && (up.status === 'queued' || up.status === 'running')) return '这一条已经在超分了';
    if (up && up.status === 'succeeded' && up.quality === quality && up.video) return `这一条已经超分成 ${quality} 了`;
    return '';
  }

  // Queues the given takes ([{ shotId, take }]), skipping those refused. Returns the queued and skipped counts.
  function queueTakes(project, list, quality) {
    const settings = upscaleSettings(getVram(), quality);
    if (!settings) return { ok: false, message: '不认识这个清晰度' };
    if (!qualitiesFor(getVram()).includes(quality)) return { ok: false, message: `显存不够跑 ${quality}，请选低一档` };
    let template;
    try {
      template = loadUpscaleTemplate(templatesDir);
    } catch (e) {
      return { ok: false, message: `超分模板无法加载:${e.message}` };
    }
    const store = createTakeStore(project.dir);
    const megapixels = (settings.resolution / 1000) ** 2; // grows with the area, which is what the run time follows
    const jobs = [];
    const skipped = [];
    for (const { shotId, take } of list) {
      const why = refusal(take, quality);
      if (why) {
        skipped.push(why);
        continue;
      }
      const outputKey = upscaleKey(take);
      const values = { duration: take.durationSec || null, megapixels };
      const estimate = estimateRun(pastUpscales(store), { templateId: UPSCALE_TEMPLATE, values, renderedOn: getTargetId() });
      // a fresh record: an earlier result at another size is replaced (its file stays in video/upscaled/)
      store.updateTake(shotId, take.id, {
        upscale: { status: 'queued', error: null, quality, resolution: settings.resolution, templateId: UPSCALE_TEMPLATE, values, outputKey, createdAt: Date.now() },
      });
      const inputName = inputNameFor(take.video);
      jobs.push({
        kind: 'upscale', family: template.manifest.family || 'seedvr2', projectDir: project.dir, outputDir: project.outputDir,
        shotId, takeId: take.id, outputKey, estimate,
        workflow: compileUpscale(template, { inputName, settings, outputKey }),
        inputFiles: [{ rel: inputName, abs: path.join(project.outputDir, ...String(take.video).split(/[\\/]/)) }],
      });
    }
    if (jobs.length) queue.enqueue(jobs);
    return { ok: true, queued: jobs.length, skipped: skipped.length, message: !jobs.length && skipped.length ? skipped[0] : '' };
  }

  return {
    // the sizes on offer for the card that renders now
    options: () => ({ ok: true, qualities: qualitiesFor(getVram()), all: QUALITIES.map((q) => q.id), defaultQuality: DEFAULT_QUALITY }),

    enqueue({ shotId, takeId, quality = DEFAULT_QUALITY }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      let take;
      try {
        take = createTakeStore(project.dir).readShot(shotId).takes.find((t) => t.id === takeId);
      } catch {
        take = null;
      }
      const why = refusal(take, quality);
      if (why) return { ok: false, message: why };
      return queueTakes(project, [{ shotId, take }], quality);
    },

    // every chosen take of an episode that is not upscaled to this size yet
    enqueueEpisode({ episodeId, quality = DEFAULT_QUALITY }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const list = picks(episodeId).filter(({ take }) => !refusal(take, quality));
      if (!list.length) return { ok: false, message: `这一集选中的镜头都已经超分成 ${quality} 了，或者还没有选中的` };
      return queueTakes(project, list, quality);
    },
  };
}

module.exports = {
  UPSCALE_TEMPLATE, UPSCALED_DIR, QUALITIES, DEFAULT_QUALITY,
  qualitiesFor, upscaleSettings, loadUpscaleTemplate, compileUpscale, inputNameFor, upscaleKey, findUpscaled,
  createUpscaleStore, createUpscaleService,
};
