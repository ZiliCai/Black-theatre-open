const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const isTerminal = (state) => !!(state && TERMINAL_STATES.has(state.status));
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv)$/i;

function outputVideos(outputs) {
  const videos = [];
  for (const output of Object.values(outputs || {})) {
    if (!output || typeof output !== 'object') continue;
    for (const key of ['videos', 'images', 'gifs']) {
      for (const item of output[key] || []) {
        const filename = String(item && item.filename || '');
        if (!item || !VIDEO_FILE.test(filename) || item.type === 'input' || /[\\/]/.test(filename)) continue;
        const parts = [...String(item.subfolder || '').split(/[\\/]+/), filename].filter(Boolean);
        if (parts.some((part) => part === '..' || part === '.')) continue;
        const relPath = parts.join('/');
        if (!videos.some((video) => video.relPath === relPath)) videos.push({ relPath, name: parts[parts.length - 1] });
      }
    }
  }
  return videos;
}

function decodePreview(data, promptId) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 8) return null;
  const event = buf.readUInt32BE(0);
  if (event === 1) {
    const format = buf.readUInt32BE(4);
    return {
      prompt_id: promptId,
      node: null,
      mime: format === 2 ? 'image/png' : 'image/jpeg',
      data: buf.subarray(8).toString('base64'),
    };
  }
  if (event !== 4) return null;
  const metadataLength = buf.readUInt32BE(4);
  const imageAt = 8 + metadataLength;
  if (imageAt > buf.length) return null;
  const metadata = JSON.parse(buf.subarray(8, imageAt).toString('utf8'));
  return {
    prompt_id: metadata.prompt_id || promptId,
    node: metadata.node_id || null,
    mime: metadata.image_type || 'image/jpeg',
    data: buf.subarray(imageAt).toString('base64'),
  };
}

// The bar's ceiling until ComfyUI says the run is done: an estimate running out never shows a full bar.
const CAP = 0.95;
// Without a past run's breakdown: the guessed share of a run before the first step, and after the last one.
const PREP_SHARE = 0.25;
const TAIL_SHARE = 0.12;

// One ComfyUI run. `estimate` ({ totalMs, firstStepMs?, tailMs? }, see run-estimate.js) is how long past runs of
// the same kind took; `startedAt` is when it was sent, the moment those past times are measured from; `nodeCount`
// is the size of the workflow, for the rough guess used when there is no estimate.
function createRunProgress(promptId, now = Date.now, { startedAt = null, estimate = null, nodeCount = 0 } = {}) {
  const state = {
    promptId,
    status: 'queued',
    value: 0,
    max: 0,
    currentNode: null,
    stepMs: null,
    averageStepMs: null,
    remainingMs: null,
    startedAt: null,
    completedAt: null,
    error: null,
    outputs: null,
    videos: [],
    preview: null,
    note: null,
    firstStepAt: null,
    lastStepAt: null,
  };
  let last = null;
  const durations = [];
  const nodesRun = new Set();
  let cached = 0;
  let shown = 0; // the bar only moves forward
  let stepBase = null; // a sampler's first step: its rate is measured from there, as that step also loads the model

  // The whole run as one bar: elapsed ÷ (elapsed + what is left). What is left comes from the sampler's step rate
  // while it counts steps, and from past runs before and after that. No past runs: steps fill 10%–90% of the bar.
  function overall(at = now()) {
    const from = startedAt ?? state.startedAt;
    const elapsedMs = from === null ? 0 : Math.max(0, at - from);
    const stage = state.max > 0 ? 'steps' : state.lastStepAt ? 'tail' : 'prep';
    if (state.status === 'succeeded') return { progress: 1, remainingMs: 0, elapsedMs, stage: 'done' };
    if (from === null || state.status === 'queued') return { progress: 0, remainingMs: estimate ? estimate.totalMs : null, elapsedMs, stage: 'queued' };
    const rate = stepBase && state.max > 0 && state.value > stepBase.value ? (state.lastStepAt - stepBase.at) / (state.value - stepBase.value) : null;
    const stepsLeftMs = rate && state.max > state.value ? Math.max(rate * (state.max - state.value) - (at - state.lastStepAt), 0) : null;
    let remainingMs = null;
    let fraction;
    if (estimate) {
      const prep = estimate.firstStepMs || estimate.totalMs * PREP_SHARE;
      const tail = estimate.tailMs || estimate.totalMs * TAIL_SHARE;
      if (stage === 'prep') remainingMs = Math.max(prep - elapsedMs, 0) + (estimate.totalMs - prep);
      else if (stage === 'steps') remainingMs = stepsLeftMs !== null ? stepsLeftMs + tail : Math.max(estimate.totalMs - elapsedMs, tail);
      else remainingMs = Math.max(tail - (at - state.lastStepAt), 0);
      fraction = elapsedMs + remainingMs > 0 ? elapsedMs / (elapsedMs + remainingMs) : 0;
    } else {
      const nodes = nodeCount > 0 ? Math.min(1, (cached + Math.max(nodesRun.size - 1, 0)) / nodeCount) : 0;
      if (stage === 'prep') fraction = 0.1 * nodes;
      else if (stage === 'steps') fraction = 0.1 + 0.8 * (state.value / state.max);
      else fraction = 0.9 + 0.05 * nodes;
      remainingMs = stepsLeftMs;
    }
    shown = Math.max(shown, Math.min(CAP, fraction));
    return { progress: shown, remainingMs: remainingMs === null ? null : Math.round(remainingMs), elapsedMs, stage };
  }

  // How this run went, so later runs can be estimated: from sending to done, to the first step, after the last.
  function timing() {
    const from = startedAt ?? state.startedAt;
    if (state.status !== 'succeeded' || from === null || !state.completedAt) return null;
    return {
      totalMs: state.completedAt - from,
      firstStepMs: state.firstStepAt ? state.firstStepAt - from : null,
      tailMs: state.lastStepAt ? state.completedAt - state.lastStepAt : null,
    };
  }

  function finish(status, extra = {}) {
    state.status = status;
    state.completedAt = extra.completedAt || now();
    state.remainingMs = status === 'succeeded' ? 0 : state.remainingMs;
    if (extra.error) state.error = extra.error;
    if (extra.outputs !== undefined) {
      state.outputs = extra.outputs;
      state.videos = outputVideos(extra.outputs);
    }
    return state;
  }

  function event(message) {
    const { type, data = {} } = message || {};
    if (data.prompt_id && data.prompt_id !== promptId) return state;
    const at = now();
    if (type === 'execution_start') {
      state.status = 'running';
      state.startedAt = data.timestamp || at;
      last = { value: 0, at, node: null };
    } else if (type === 'executing' && data.node) {
      state.status = 'running';
      state.currentNode = data.node;
      nodesRun.add(data.node);
      state.value = 0;
      state.max = 0;
      state.stepMs = null;
      state.remainingMs = null;
      durations.length = 0;
      last = { value: 0, at, node: data.node };
    } else if (type === 'progress') {
      state.status = 'running';
      const value = Number(data.value) || 0;
      const max = Number(data.max) || 0;
      if (last && last.node === data.node && value === last.value + 1) {
        const elapsed = at - last.at;
        if (elapsed > 0 && elapsed < 60 * 60 * 1000) {
          state.stepMs = elapsed;
          durations.push(elapsed);
          if (durations.length > 20) durations.shift();
          state.averageStepMs = Math.round(durations.reduce((sum, v) => sum + v, 0) / durations.length);
        }
      }
      state.value = value;
      state.max = max;
      if (!state.firstStepAt) state.firstStepAt = at;
      if (!stepBase || stepBase.node !== data.node || value < stepBase.value) stepBase = { node: data.node, at, value };
      state.lastStepAt = at;
      state.remainingMs = state.averageStepMs && max > value ? state.averageStepMs * (max - value) : 0;
      last = { value, at, node: data.node };
    } else if (type === 'execution_cached') {
      cached = Array.isArray(data.nodes) ? data.nodes.length : 0;
    } else if (type === 'preview') {
      state.preview = { data: data.data, mime: data.mime || 'image/jpeg', node: data.node || state.currentNode, updatedAt: at };
    } else if (type === 'execution_success') {
      finish('succeeded', { completedAt: data.timestamp || at });
    } else if (type === 'execution_error') {
      finish('failed', { completedAt: data.timestamp || at, error: data.exception_message || 'ComfyUI 执行失败' });
    } else if (type === 'execution_interrupted') {
      finish('cancelled', { completedAt: data.timestamp || at });
    } else if (type === 'tracker_error') {
      state.note = data.message || '进度连接不可用';
    }
    return state;
  }

  return { state, event, finish, overall, timing };
}

function createWebSocketTracker({ port, promptId, clientId, onEvent, WebSocketClass }) {
  const WS = WebSocketClass || globalThis.WebSocket;
  if (!WS) {
    onEvent({ type: 'tracker_error', data: { prompt_id: promptId, message: '当前环境不支持 WebSocket 进度' } });
    return { close() {} };
  }
  let ws;
  try {
    const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
    ws = new WS(`ws://127.0.0.1:${port}/ws${query}`);
  } catch (e) {
    onEvent({ type: 'tracker_error', data: { prompt_id: promptId, message: e.message } });
    return { close() {} };
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
  ws.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') {
        onEvent(JSON.parse(event.data));
        return;
      }
      const data = event.data;
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(await data.arrayBuffer());
      const preview = decodePreview(bytes, promptId);
      if (preview) onEvent({ type: 'preview', data: preview });
    } catch {
      // Ignore malformed events from other local tooling.
    }
  };
  ws.onerror = () => onEvent({ type: 'tracker_error', data: { prompt_id: promptId, message: '进度连接暂时不可用' } });
  return {
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { createRunProgress, createWebSocketTracker, decodePreview, outputVideos, isTerminal };
