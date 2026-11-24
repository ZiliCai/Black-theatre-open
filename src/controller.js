// Start / stop / restart rules. Every side effect is injected (see test/controller.test.js).
const { validateConfig } = require('./config');
const { isOurComfy } = require('./comfy-process');

const STOP_WAIT_MS = 15000;

function createController({ getConfig, makeApi, probe, starter, killer, waitPortFree, now }) {
  let launch = null;

  async function start() {
    const cfg = getConfig();
    const v = validateConfig(cfg);
    if (!v.ok) return { ok: false, message: v.errors.join(';') };

    const listener = await probe(cfg.port);
    if (listener) {
      if (isOurComfy(listener.commandLine, cfg.workdir, listener.executablePath)) {
        return { ok: true, noop: true, pid: listener.pid, message: `ComfyUI 已在运行(PID ${listener.pid})` };
      }
      return { ok: false, message: `端口 ${cfg.port} 被其他程序占用(PID ${listener.pid}),未启动` };
    }

    try {
      const { pid } = await starter(cfg);
      launch = { pid, startedAt: now() };
      return { ok: true, pid, message: `已启动 ComfyUI(PID ${pid}),正在加载…` };
    } catch (e) {
      return { ok: false, message: `启动失败:${e.message}` };
    }
  }

  async function stop({ confirmed = false } = {}) {
    const cfg = getConfig();
    const listener = await probe(cfg.port);
    if (!listener) {
      launch = null;
      return { ok: true, noop: true, message: 'ComfyUI 未在运行' };
    }
    if (!isOurComfy(listener.commandLine, cfg.workdir, listener.executablePath)) {
      return { ok: false, message: `端口 ${cfg.port} 上的进程不是本工作目录启动的 ComfyUI,拒绝结束(PID ${listener.pid})` };
    }

    if (!confirmed) {
      let q = null;
      try {
        q = await makeApi(cfg.port).queue();
      } catch {
        q = null; // an unresponsive server must still be stoppable
      }
      if (q && q.running + q.pending > 0) {
        return {
          ok: false,
          needsConfirm: true,
          message: `队列中有 ${q.running} 个任务在运行、${q.pending} 个在等待,停止会丢失这些任务`,
        };
      }
    }

    try {
      await killer(listener.pid);
    } catch (e) {
      return { ok: false, message: `结束进程失败:${e.message}` };
    }
    if (!(await waitPortFree(cfg.port, STOP_WAIT_MS))) {
      return { ok: false, message: `已发送结束命令,但端口 ${cfg.port} 在 15 秒内仍未释放` };
    }
    launch = null;
    return { ok: true, message: `已停止(PID ${listener.pid})` };
  }

  async function restart({ confirmed = false } = {}) {
    const stopped = await stop({ confirmed });
    if (!stopped.ok) return stopped;
    const started = await start();
    return started.ok ? { ...started, message: `已重启 ComfyUI(PID ${started.pid}),正在加载…` } : started;
  }

  return { start, stop, restart, getLaunch: () => launch };
}

module.exports = { createController, STOP_WAIT_MS };
