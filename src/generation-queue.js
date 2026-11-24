// Takes waiting to be generated. They go to ComfyUI one at a time, so each one's progress, preview and outputs
// are its own; every change is written to the take's record in its project. Video takes (kind 'video') belong to
// a shot, image takes (kind 'image') to an asset card; job.shotId names either. An upscale (kind 'upscale') is
// written to the `upscale` record of the take it enlarges. Plain Node, no Electron.
const crypto = require('node:crypto');
const { createApi } = require('./comfy-api');
const { createRunProgress, createWebSocketTracker, outputVideos, isTerminal } = require('./run-progress');
const { createTakeStore } = require('./take-store');
const { createAssetStore } = require('./asset-store');
const { findContext, findVideo, pickVideo, pickImage, findImage } = require('./take-outputs');
const { readMediaMeta: realReadMediaMeta } = require('./media-meta');
const { resolveInside } = require('./safe-path');
const { pushInputFiles } = require('./remote-sync');
const { createUpscaleStore, findUpscaled } = require('./upscale');

const LOST = 'ComfyUI 中途退出或无法连接，这一条没有生成完';
const FETCH_FAILED = '服务器上已经出片，但没能取回本机';

function createGenerationQueue({
  apiFactory, trackerFactory, getPort, now = Date.now, onChange = () => {}, readMediaMeta = realReadMediaMeta,
  storeFor = (projectDir, kind) => (kind === 'image' ? createAssetStore(projectDir) : kind === 'upscale' ? createUpscaleStore(projectDir) : createTakeStore(projectDir)), idFactory = () => crypto.randomUUID(), historyEveryMs = 2500,
  // history checks in a row that find the run neither finished nor in ComfyUI's queue before it is given up
  maxMisses = 12,
  // how often a running take's overall progress is pushed out, so the bar also moves between ComfyUI's events
  tickEveryMs = 1000,
  // A ComfyUI on another machine: { prepare(job, api) -> { workflow }, collect(job, api, outputs) }, both may throw.
  // null when ComfyUI runs here and shares this computer's folders.
  getRemote = () => null,
  // where takes render now ('local' or a server id), written on each take so run times are compared like for like
  getTargetId = () => 'local',
}) {
  const makeApi = (port) => (apiFactory ? apiFactory(port) : createApi({ port }));
  const makeTracker = (options) => (trackerFactory ? trackerFactory(options) : createWebSocketTracker(options));
  let jobs = []; // the running one first, then the waiting ones in order
  let active = null;
  let paused = false;
  let message = '';
  let lastFamily = null; // the model family ComfyUI ran last, as far as this queue knows

  const changed = () => onChange(snapshot());
  // A record that cannot be written (a busy file on OneDrive) must never stop the queue itself.
  const record = (job, patch) => {
    try {
      storeFor(job.projectDir, job.kind).updateTake(job.shotId, job.takeId, patch);
    } catch (e) {
      job.recordError = e.message;
    }
  };

  // What a finished run left behind: its video (named after the take), continuation file and real length, or for
  // an image take its picture and size, or for an upscale the bigger video and its size.
  function resultOf(kind, outputDir, outputKey, outputs) {
    if (kind === 'upscale') {
      const video = (outputs && pickVideo(outputVideos(outputs), outputKey)) || findUpscaled(outputDir, outputKey);
      const abs = video ? resolveInside(outputDir, video) : null;
      const meta = (abs && readMediaMeta(abs)) || {};
      return { video, width: meta.width || null, height: meta.height || null, durationSec: Number.isFinite(meta.duration) ? meta.duration : null };
    }
    if (kind === 'image') {
      const image = (outputs && pickImage(outputs, outputKey)) || findImage(outputDir, outputKey);
      const abs = image ? resolveInside(outputDir, image) : null;
      const meta = abs ? readMediaMeta(abs) : null;
      return { image, width: (meta && meta.width) || null, height: (meta && meta.height) || null };
    }
    const video = (outputs && pickVideo(outputVideos(outputs), outputKey)) || findVideo(outputDir, outputKey);
    let durationSec = null;
    if (video) {
      const abs = resolveInside(outputDir, video);
      const meta = abs ? readMediaMeta(abs) : null;
      if (meta && Number.isFinite(meta.duration)) durationSec = meta.duration;
    }
    return { video, context: findContext(outputDir, outputKey), durationSec };
  }

  function stopWatching(job) {
    if (job.tracker) job.tracker.close();
    if (job.timer) clearInterval(job.timer);
    if (job.ticker) clearInterval(job.ticker);
    job.tracker = null;
    job.timer = null;
    job.ticker = null;
  }

  // The job leaves the queue, its record says how it ended, and the next one may start.
  function settle(job, patch, { pause = '' } = {}) {
    if (job.finished) return;
    job.finished = true;
    stopWatching(job);
    record(job, { completedAt: now(), ...patch });
    jobs = jobs.filter((j) => j !== job);
    if (active === job) active = null;
    if (pause) {
      paused = true;
      message = pause;
    }
    changed();
    pump();
  }

  // A remote run's files come back to this computer before the take counts as done. When that fails the queue
  // waits with the take still running; 重试 fetches again.
  async function collect(job) {
    const remote = getRemote();
    if (!remote || job.collected) return true;
    job.collecting = true;
    changed();
    try {
      await remote.collect(job, makeApi(getPort()), job.progress.state.outputs || {});
      job.collected = true;
      return true;
    } catch (e) {
      paused = true;
      message = `${FETCH_FAILED}:${e.message}。连上服务器后点重试`;
      job.awaitingFetch = true;
      stopWatching(job);
      changed();
      return false;
    } finally {
      job.collecting = false;
    }
  }

  async function finish(job) {
    const run = job.progress.state;
    if (run.status === 'succeeded') {
      if (job.finished || job.collecting || !(await collect(job))) return;
      const timing = job.progress.timing();
      settle(job, { status: 'succeeded', error: null, ...resultOf(job.kind, job.outputDir, job.outputKey, run.outputs), ...(timing ? { timing } : {}) });
    } else if (run.status === 'failed') settle(job, { status: 'failed', error: run.error || 'ComfyUI 执行失败' });
    else settle(job, { status: 'cancelled' });
  }

  // History is the backstop for the websocket. A run that is neither finished nor waiting in ComfyUI for a while
  // (ComfyUI crashed, or was restarted and forgot it) is given up instead of showing 生成中 forever.
  async function pollHistory(job) {
    if (job.finished || job.polling || job.collecting || job.awaitingFetch || !job.promptId) return;
    job.polling = true;
    try {
      const api = makeApi(getPort());
      const entry = (await api.history(job.promptId))[job.promptId];
      if (job.finished) return;
      const status = entry && entry.status && entry.status.status_str;
      if (status === 'success') job.progress.finish('succeeded', { outputs: entry.outputs || {} });
      else if (status === 'error') job.progress.finish('failed', { error: (entry.status && entry.status.message) || 'ComfyUI 执行失败' });
      else if (status === 'interrupted') job.progress.finish('cancelled');
      if (isTerminal(job.progress.state)) {
        finish(job);
        return;
      }
      if ((await api.queuePrompts()).includes(job.promptId)) job.misses = 0;
      else job.misses = (job.misses || 0) + 1;
    } catch {
      job.misses = (job.misses || 0) + 1;
    } finally {
      job.polling = false;
    }
    if (!job.finished && job.misses >= maxMisses) settle(job, { status: 'failed', error: LOST }, { pause: LOST });
  }

  // Follow a run that is already in ComfyUI: progress over the websocket, history as the backstop.
  function watch(job, port, clientId) {
    job.progress = createRunProgress(job.promptId, now, {
      startedAt: job.startedAt || null, estimate: job.estimate || null, nodeCount: job.workflow ? Object.keys(job.workflow).length : 0,
    });
    job.tracker = makeTracker({
      port, promptId: job.promptId, clientId,
      onEvent: (event) => {
        if (job.finished) return;
        job.progress.event(event);
        const run = job.progress.state;
        if (!isTerminal(run)) changed();
        else if (run.status === 'succeeded' && !run.outputs) pollHistory(job);
        else finish(job);
      },
    });
    job.timer = setInterval(() => pollHistory(job), historyEveryMs);
    job.ticker = setInterval(changed, tickEveryMs);
    for (const t of [job.timer, job.ticker]) if (t.unref) t.unref(); // never keeps the process alive on its own
  }

  async function submit(job) {
    const port = getPort();
    const api = makeApi(port);
    try {
      await api.systemStats();
    } catch (e) {
      if (!job.cancelled) settle(job, { status: 'failed', error: `ComfyUI 未运行或无法连接，请先启动:${e.message}` }, { pause: `ComfyUI 未运行或无法连接，请先启动:${e.message}` });
      return;
    }
    if (job.cancelled) return;
    // Files the run reads from ComfyUI's input folder (the video to upscale) go there first, local or remote.
    if (job.inputFiles && job.inputFiles.length) {
      try {
        await pushInputFiles({ files: job.inputFiles, api });
      } catch (e) {
        if (!job.cancelled) settle(job, { status: 'failed', error: `原片没能交给 ComfyUI:${e.message}` }, { pause: `原片没能交给 ComfyUI:${e.message}` });
        return;
      }
      if (job.cancelled) return;
    }
    // A remote server gets the pictures it reads and model names it knows before the run is sent.
    let workflow = job.workflow;
    const remote = getRemote();
    if (remote) {
      try {
        ({ workflow } = await remote.prepare(job, api));
      } catch (e) {
        if (!job.cancelled) settle(job, { status: 'failed', error: e.message }, { pause: e.message });
        return;
      }
      if (job.cancelled) return;
    }
    // Pictures and videos use different models that do not fit in memory together: unload before switching.
    if (job.family && lastFamily && job.family !== lastFamily) {
      try {
        await api.free();
      } catch {
        // ComfyUI then unloads on its own as memory runs out; the run is still worth trying
      }
      if (job.cancelled) return;
    }
    const clientId = idFactory();
    let response;
    try {
      response = await api.prompt(workflow, { clientId });
    } catch (e) {
      // the answer may be what was lost, not the run: one that ComfyUI has is taken as sent, not sent again
      let arrived = null;
      try { arrived = api.promptByClient ? await api.promptByClient(clientId) : null; } catch { arrived = null; }
      if (arrived) response = { prompt_id: arrived };
      else {
        if (!job.cancelled) settle(job, { status: 'failed', error: `提交生成失败:${e.message}` }, { pause: `提交生成失败:${e.message}` });
        return;
      }
    }
    const promptId = response && response.prompt_id;
    if (job.cancelled) { // cancelled while it was being sent: take it back out of ComfyUI
      if (promptId) api.forget(promptId).then(() => api.interrupt()).catch(() => {});
      return;
    }
    if (!promptId) {
      settle(job, { status: 'failed', error: 'ComfyUI 没有返回 prompt_id' }, { pause: 'ComfyUI 没有返回 prompt_id' });
      return;
    }
    job.promptId = promptId;
    job.startedAt = now();
    if (job.family) lastFamily = job.family;
    record(job, { status: 'running', promptId, startedAt: job.startedAt, renderedOn: getTargetId() });
    watch(job, port, clientId);
    changed();
  }

  function pump() {
    if (paused || active) return;
    const next = jobs[0];
    if (!next) return;
    active = next;
    submit(next);
  }

  function snapshot() {
    return {
      busy: jobs.length > 0,
      paused,
      message,
      jobs: jobs.map((job) => {
        const run = job.progress ? job.progress.state : null;
        const whole = job.progress ? job.progress.overall(now()) : null;
        return {
          takeId: job.takeId,
          shotId: job.shotId,
          kind: job.kind || 'video',
          projectDir: job.projectDir,
          status: run ? (job.cancelling ? 'cancelling' : job.collecting || job.awaitingFetch ? 'fetching' : run.status) : 'queued',
          value: run ? run.value : 0,
          max: run ? run.max : 0,
          // the whole run as one bar (0–1) and the time left of all of it; value/max are the current node's steps
          progress: whole ? whole.progress : 0,
          stage: whole ? whole.stage : 'queued',
          elapsedMs: whole ? whole.elapsedMs : 0,
          remainingMs: whole ? whole.remainingMs : (job.estimate ? job.estimate.totalMs : null),
          preview: run ? run.preview : null,
        };
      }),
    };
  }

  async function cancel(takeId) {
    const job = jobs.find((j) => j.takeId === takeId);
    if (!job) return { ok: false, message: '没有这个任务' };
    if (!job.promptId) { // waiting, or still being sent
      job.cancelled = true;
      settle(job, { status: 'cancelled' });
      return { ok: true, message: '已取消' };
    }
    try {
      await makeApi(getPort()).interrupt();
      job.cancelling = true;
      changed();
      return { ok: true, message: '正在取消…' };
    } catch {
      // ComfyUI is gone: nothing left to stop there, so the take simply ends here
      settle(job, { status: 'cancelled' });
      return { ok: true, message: '已取消（ComfyUI 没有响应）' };
    }
  }

  return {
    enqueue(newJobs) {
      for (const job of newJobs) {
        record(job, { status: 'queued' });
        jobs.push({ ...job });
      }
      changed();
      pump();
    },
    cancel,
    async cancelAll() {
      for (const job of jobs.filter((j) => j !== active)) {
        job.cancelled = true;
        job.finished = true;
        record(job, { status: 'cancelled', completedAt: now() });
      }
      jobs = active ? [active] : [];
      const r = active ? await cancel(active.takeId) : { ok: true, message: '' };
      changed();
      return { ok: r.ok, message: r.ok ? '已全部取消' : r.message };
    },
    retry() {
      paused = false;
      message = '';
      changed();
      if (active && active.awaitingFetch) {
        const job = active;
        job.awaitingFetch = false;
        finish(job);
        return;
      }
      pump();
    },
    snapshot,
    busy: () => jobs.length > 0,
    pollActive: () => (active ? pollHistory(active) : Promise.resolve()),

    // After a restart. ComfyUI runs on its own, so a run may have finished meanwhile (history, or its files by
    // name), may still be running (followed again), or is gone. Unreachable ComfyUI: leave every take as it is.
    async resume({ projectDir, outputDir, store, kind = 'video' }) {
      const api = makeApi(getPort());
      let inQueue;
      try {
        inQueue = await api.queuePrompts();
      } catch {
        return;
      }
      for (const shotId of store.listShotIds()) {
        for (const take of store.readShot(shotId).takes) {
          if (take.status !== 'queued' && take.status !== 'running') continue;
          if (jobs.some((j) => j.takeId === take.id)) continue;
          const update = (patch) => { try { store.updateTake(shotId, take.id, patch); } catch { /* tried again next start */ } };
          if (!take.promptId) {
            update({ status: 'interrupted', error: '软件关闭时这一条还没交给 ComfyUI' });
            continue;
          }
          let entry;
          try {
            entry = (await api.history(take.promptId))[take.promptId] || null;
          } catch {
            continue;
          }
          const status = entry && entry.status && entry.status.status_str;
          if (status === 'success') {
            const remote = getRemote();
            if (remote) {
              try {
                await remote.collect({ kind, projectDir, outputDir, shotId, takeId: take.id, outputKey: take.outputKey }, api, entry.outputs || {});
              } catch {
                continue; // fetched on a later start, when the server can be reached
              }
            }
            update({ status: 'succeeded', error: null, ...resultOf(kind, outputDir, take.outputKey, entry.outputs || {}) });
          } else if (status === 'error') {
            update({ status: 'failed', error: (entry.status && entry.status.message) || 'ComfyUI 执行失败' });
          } else if (inQueue.includes(take.promptId) && !active) {
            const job = { kind, projectDir, outputDir, shotId, takeId: take.id, outputKey: take.outputKey, promptId: take.promptId, startedAt: take.startedAt || null };
            jobs.unshift(job);
            active = job;
            watch(job, getPort(), idFactory());
          } else if (!inQueue.includes(take.promptId)) {
            const found = resultOf(kind, outputDir, take.outputKey, null);
            if (found.video || found.image) update({ status: 'succeeded', error: null, ...found });
            else update({ status: 'interrupted', error: '软件关闭时这一条还没生成完' });
          }
        }
      }
      changed();
    },
  };
}

module.exports = { createGenerationQueue };
