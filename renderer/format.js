// Pure display helpers. Loaded as a plain <script> in the page and required by node:test.
(function (root) {
  const GB = 1024 ** 3;

  const missing = (n) => n === null || n === undefined || Number.isNaN(n);

  function formatGB(bytes) {
    return missing(bytes) ? '—' : `${(bytes / GB).toFixed(1)} GB`;
  }

  function formatMB(mb) {
    if (missing(mb)) return '—';
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < GB) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / GB).toFixed(1)} GB`;
  }

  const STATES = {
    running: { text: '运行中', tone: 'ok' },
    starting: { text: '启动中…', tone: 'warn' },
    stopped: { text: '未运行', tone: 'idle' },
    'port-busy': { text: '端口被占用', tone: 'bad' },
    timeout: { text: '启动超时', tone: 'bad' },
    error: { text: '读取状态失败', tone: 'bad' },
    'remote-connecting': { text: '正在连服务器…', tone: 'warn' },
    'remote-down': { text: '连不上服务器', tone: 'bad' },
    'remote-stopped': { text: '服务器上未运行', tone: 'idle' },
  };

  function stateInfo(state) {
    return STATES[state] ? { ...STATES[state] } : { text: String(state), tone: 'idle' };
  }

  // Keeps the last N complete lines plus the line still being written. A "\r" inside a
  // line means "overwrite from the start" (progress bars), so only the text after it is shown.
  function createLogBuffer(maxLines) {
    let lines = [];
    let pending = '';
    const clean = (s) => {
      const t = s.replace(/\r+$/, '');
      const i = t.lastIndexOf('\r');
      return i === -1 ? t : t.slice(i + 1);
    };
    return {
      append(chunk) {
        const parts = (pending + chunk).split('\n');
        pending = parts.pop();
        for (const p of parts) lines.push(clean(p));
        if (lines.length > maxLines) lines = lines.slice(-maxLines);
      },
      init(initial) {
        lines = initial.slice(-maxLines);
        pending = '';
      },
      text() {
        return (pending ? lines.concat(clean(pending)) : lines).join('\n');
      },
    };
  }

  // ---------- v2: gauges, relative time, paths ----------
  const EPS = 1e-9;

  function percent(used, total) {
    if (!total || missing(used)) return 0;
    return Math.min(100, Math.max(0, (used / total) * 100));
  }

  // Gauge colour for GPU memory / computer RAM: amber from 75%, red from 90%.
  function usageTone(pct) {
    if (missing(pct)) return 'idle';
    if (pct >= 90) return 'bad';
    if (pct >= 75) return 'warn';
    return 'ok';
  }

  // ComfyUI's own memory relative to the whole computer's RAM: amber from 60%, red from 80%.
  function procMemTone(procMB, ramTotalBytes) {
    if (missing(procMB) || !ramTotalBytes) return 'idle';
    const ratio = (procMB * 1024 * 1024) / ramTotalBytes;
    if (ratio >= 0.8 - EPS) return 'bad';
    if (ratio >= 0.6 - EPS) return 'warn';
    return 'ok';
  }

  function formatAgo(timestampMs, nowMs) {
    if (!timestampMs) return '—';
    const s = Math.max(0, (nowMs - timestampMs) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 30 * 86400) return `${Math.floor(s / 86400)} 天前`;
    return `${Math.floor(s / (30 * 86400))} 个月前`;
  }

  // How the GPU memory gauge should look. While jobs run or wait, the usual warning colours apply. With an
  // empty queue, high usage is just ComfyUI keeping models loaded for the next run, so it stays calm and
  // (from 25% of the card, i.e. more than the desktop's own baseline) explains itself with a note.
  const HOLDING_FROM_PCT = 25;
  function vramView({ used, total, queueRunning, queuePending }) {
    if (!total || missing(used)) return { pct: 0, tone: 'idle', holdingModels: false };
    const raw = percent(used, total);
    const pct = Math.round(raw * 10) / 10;
    const queueKnown = !missing(queueRunning) && !missing(queuePending);
    if (!(queueKnown && queueRunning === 0 && queuePending === 0)) return { pct, tone: usageTone(raw), holdingModels: false };
    return { pct, tone: 'calm', holdingModels: raw >= HOLDING_FROM_PCT - EPS };
  }

  // 'F:\a\b\output' -> { head: 'F:\a\b\', tail: 'output' } so the UI can emphasise the last folder.
  function formatPathParts(p) {
    const trimmed = String(p || '').replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (cut === -1) return { head: '', tail: trimmed };
    return { head: trimmed.slice(0, cut + 1), tail: trimmed.slice(cut + 1) };
  }

  const api = {
    formatGB, formatMB, formatBytes, stateInfo, createLogBuffer,
    percent, usageTone, procMemTone, formatAgo, formatPathParts, vramView,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LauncherFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
