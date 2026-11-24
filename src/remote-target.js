// Rendering on a remote server: keeps the tunnel pointed at the server the config names, says which port
// ComfyUI is on, answers the status cards, and gives the queue its upload / fetch steps. Plain Node.
const { createApi } = require('./comfy-api');
const { activeServer } = require('./remote-servers');
const { createTunnel, runRemote: realRunRemote } = require('./remote-tunnel');
const { remoteModels, remapModels, pushInputs, pullOutputs } = require('./remote-sync');

// a ComfyUI just after the instance boots reads its plugins and models from a cold disk, so give it time
const START_WAIT_MS = 180000;
// tmux saying the session is already there: ComfyUI was started before (maybe by an earlier click) and is
// most likely still loading, so wait for it instead of failing
const ALREADY_STARTED = /duplicate session|already running|already in use/i;

const settle = async (promise) => {
  try {
    return await promise;
  } catch {
    return null;
  }
};

function createRemoteTarget({
  getConfig, tunnel = null, makeApi = (port, timeoutMs) => createApi({ port, timeoutMs }), runRemote = realRunRemote,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, onChange = () => {},
}) {
  let models = null; // what the server has, read once per connection
  const link = tunnel || createTunnel({ onChange: (s) => { models = null; onChange(s); } });

  const server = () => activeServer(getConfig());

  async function availableModels(api, { fresh = false } = {}) {
    if (!models || fresh) models = await remoteModels(api);
    return models;
  }

  // Model names the server lacks, after matching by file name and the server's own stand-ins.
  async function remap(workflow, api) {
    const s = server();
    let r = remapModels(workflow, await availableModels(api), s ? s.modelSwaps : {});
    // a model put on the server since the list was read
    if (r.missing.length) r = remapModels(workflow, await availableModels(api, { fresh: true }), s ? s.modelSwaps : {});
    return r;
  }

  const transfer = {
    async prepare(job, api) {
      const { graph, missing } = await remap(job.workflow, api);
      if (missing.length) throw new Error(`服务器上缺这些模型:${missing.join('、')}。先传上去，或者在 设置 → 远程 GPU → 修改 → 模型替换 里写上服务器上用来代替的模型`);
      try {
        await pushInputs({ graph, outputDir: job.outputDir, api });
      } catch (e) {
        throw new Error(`参考图没能传到服务器:${e.message}`);
      }
      return { workflow: graph };
    },
    async collect(job, api, outputs) {
      await pullOutputs({ outputs, outputDir: job.outputDir, api, outputKey: job.kind === 'image' || job.kind === 'upscale' ? null : job.outputKey });
    },
  };

  return {
    server,
    // Follow the config: open the tunnel to the chosen server, or close it when rendering is local again.
    sync() {
      link.use(server());
    },
    retry: () => link.retry(),
    close: () => link.close(),
    tunnel: () => link.snapshot(),
    // The port ComfyUI answers on from here: the tunnel's end when remote (0 while it is down, so nothing ever
    // reaches a local ComfyUI by mistake), else the configured local port.
    port() {
      if (!server()) return getConfig().port;
      return link.port() || 0;
    },
    // what the queue uses; null for a local ComfyUI
    transfer: () => (server() ? transfer : null),

    // The status card for a remote server. Same fields as the local one (src/status.js).
    async status() {
      const s = server();
      const t = link.snapshot();
      const base = {
        remote: true, serverName: s ? s.name : '', tunnel: t, pid: null, ours: true, argv: null, remoteArgv: null,
        deviceName: null, vramTotal: null, vramFree: null, ramTotal: null, ramFree: null,
        queueRunning: null, queuePending: null, processMemMB: null,
      };
      if (t.state !== 'open') {
        return { ...base, state: t.state === 'down' ? 'remote-down' : 'remote-connecting', message: t.message || '正在连接服务器…' };
      }
      const api = makeApi(link.port(), 4000);
      const [stats, queue] = await Promise.all([settle(api.systemStats()), settle(api.queue())]);
      if (!stats && !queue) return { ...base, state: 'remote-stopped', message: '服务器连上了，但上面的 ComfyUI 没在运行' };
      return {
        ...base,
        state: 'running',
        message: '',
        remoteArgv: stats ? stats.argv : null,
        deviceName: stats ? stats.deviceName : null,
        vramTotal: stats ? stats.vramTotal : null,
        vramFree: stats ? stats.vramFree : null,
        ramTotal: stats ? stats.ramTotal : null,
        ramFree: stats ? stats.ramFree : null,
        queueRunning: queue ? queue.running : null,
        queuePending: queue ? queue.pending : null,
      };
    },

    // Runs the server's start command, then waits until ComfyUI answers through the tunnel.
    async startComfy() {
      const s = server();
      if (!s) return { ok: false, message: '现在是本机出片' };
      if (!s.startCommand) return { ok: false, message: '这台服务器没有填“启动 ComfyUI 的命令”，请在设置 → 远程 GPU 里补上' };
      const port = link.port();
      if (port && await settle(makeApi(port, 4000).systemStats())) return { ok: true, noop: true, message: '服务器上的 ComfyUI 已在运行' };
      const r = await runRemote(s, s.startCommand, { timeoutMs: 30000 });
      const already = !r.ok && ALREADY_STARTED.test(`${r.stderr || ''} ${r.message || ''}`);
      if (!r.ok && !already) return { ok: false, message: r.message };
      const until = now() + START_WAIT_MS;
      while (now() < until) {
        const p = link.port();
        if (p && await settle(makeApi(p, 4000).systemStats())) return { ok: true, message: '服务器上的 ComfyUI 已启动' };
        await sleep(3000);
      }
      if (already) return { ok: false, message: '服务器上的 ComfyUI 之前已经启动过，但 3 分钟内还没响应：可能卡住了，可以查看服务器上的日志，或者在服务器上结束那个 tmux 会话后再启动' };
      return { ok: false, message: '启动命令发出去了，但 3 分钟内 ComfyUI 还没响应：可以稍后再看，或者查看服务器上的日志' };
    },
  };
}

// Checks a server profile step by step for the settings page: ssh, ComfyUI on it, the graphics card.
async function testServer(server, { runRemote = realRunRemote } = {}) {
  const steps = [];
  const login = await runRemote(server, 'echo blackbox-ok', { timeoutMs: 20000 });
  steps.push({ label: 'SSH 登录', ok: login.ok && login.stdout.includes('blackbox-ok'), detail: login.ok ? '钥匙可用' : login.message });
  if (!steps[0].ok) return { ok: false, steps };
  const probe = await runRemote(server,
    `curl -s -m 4 http://127.0.0.1:${server.comfyPort}/system_stats || wget -q -T 4 -O - http://127.0.0.1:${server.comfyPort}/system_stats`,
    { timeoutMs: 20000 });
  let stats = null;
  try {
    stats = probe.ok ? JSON.parse(probe.stdout) : null;
  } catch {
    stats = null;
  }
  const dev = stats && stats.devices && stats.devices[0];
  steps.push({
    label: 'ComfyUI', ok: !!stats,
    detail: stats ? `版本 ${(stats.system && stats.system.comfyui_version) || '未知'}` : `端口 ${server.comfyPort} 上没有 ComfyUI 在运行${server.startCommand ? '（可以用“启动 ComfyUI”）' : ''}`,
  });
  if (dev) steps.push({ label: '显卡', ok: true, detail: `${String(dev.name || '').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '')} · ${(dev.vram_total / 2 ** 30).toFixed(0)} GB` });
  return { ok: steps.every((s) => s.ok), steps };
}

module.exports = { createRemoteTarget, testServer };
