// What the red "ComfyUI 出错了" banner says and when it shows. Pure logic, tested in test/alerts.test.js.
const { extractErrors } = require('./errors');

// Higher wins when alerts are merged: a logged crash explains more than "the process disappeared".
const SEVERITY = { crash: 5, fatal: 4, exit: 3, validation: 2, error: 1 };
const TITLES = {
  crash: 'ComfyUI 崩溃了',
  fatal: 'ComfyUI 启动失败',
  exit: 'ComfyUI 意外退出了',
  validation: '工作流校验失败',
  error: 'ComfyUI 出现报错',
};

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function build({ kind, count, at }) {
  const parts = [at ? clock(at) : '本次运行期间'];
  if (count > 1) parts.push(`共 ${count} 处`);
  return { kind, count, at, title: TITLES[kind], sub: parts.join(' · ') };
}

const severest = (blocks) => blocks.reduce((best, b) => (SEVERITY[b.kind] > SEVERITY[best] ? b.kind : best), blocks[0].kind);

// New log text -> an alert, or null when it holds nothing but harmless noise.
function alertFromChunk(text, now) {
  if (!text) return null;
  const { real } = extractErrors(text.split(/\r?\n/));
  if (!real.length) return null;
  return build({ kind: severest(real), count: real.length, at: now });
}

// When the launcher opens: errors since ComfyUI's most recent start are still relevant.
function alertFromLog(lines) {
  const current = extractErrors(lines).real.filter((b) => b.run === 'current');
  if (!current.length) return null;
  return build({ kind: severest(current), count: current.length, at: null });
}

const exitAlert = (now) => build({ kind: 'exit', count: 1, at: now });

function mergeAlert(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return build({
    kind: SEVERITY[incoming.kind] > SEVERITY[existing.kind] ? incoming.kind : existing.kind,
    count: existing.count + incoming.count,
    at: incoming.at || existing.at,
  });
}

const NOTIFY_GAP_MS = 60000;

// Desktop notification: only when the window is not in front, and at most one per minute.
function shouldNotify({ windowFocused, lastNotifiedAt, now, gapMs = NOTIFY_GAP_MS }) {
  if (windowFocused) return false;
  return lastNotifiedAt === null || lastNotifiedAt === undefined || now - lastNotifiedAt >= gapMs;
}

// Fires once when ComfyUI goes from running to stopped without the launcher having asked for it.
const EXPECT_STOP_GRACE_MS = 60000;
function createExitWatcher({ now }) {
  let previous = null;
  let expectedUntil = 0;
  return {
    expectStop() {
      expectedUntil = now() + EXPECT_STOP_GRACE_MS;
    },
    observe(state) {
      const was = previous;
      previous = state;
      return was === 'running' && state === 'stopped' && now() >= expectedUntil;
    },
  };
}

// The log is read twice a second, so one multi-line error can arrive in two reads. This holds text
// back until a read brings nothing new, then hands over the whole burst for a single analysis.
function createBurstBuffer() {
  let pending = '';
  return {
    push(text) {
      if (text) {
        pending += text;
        return null;
      }
      if (!pending) return null;
      const burst = pending;
      pending = '';
      return burst;
    },
  };
}

module.exports = {
  alertFromChunk, alertFromLog, exitAlert, mergeAlert, shouldNotify, createExitWatcher, createBurstBuffer,
};
