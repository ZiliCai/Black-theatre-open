// Works out what to show on the status cards. All side effects are injected so it is testable.
const { isOurComfy } = require('./comfy-process');

const START_TIMEOUT_MS = 60000;

const settle = async (promise) => {
  try {
    return await promise;
  } catch {
    return null;
  }
};

async function getStatus({ config, api, probe, memoryOf, launch, isAlive, now }) {
  const [stats, queue, listener] = await Promise.all([
    settle(api.systemStats()),
    settle(api.queue()),
    settle(probe(config.port)),
  ]);

  const ours = listener ? isOurComfy(listener.commandLine, config.workdir, listener.executablePath) : false;
  const launchedAlive = !!(launch && isAlive(launch.pid));
  const pid = listener ? listener.pid : launchedAlive ? launch.pid : null;
  const reachable = stats !== null || queue !== null;

  let state;
  let message = '';
  if (reachable) {
    state = 'running';
    if (!ours) message = `端口 ${config.port} 上运行的不是本工作目录启动的 ComfyUI`;
  } else if (listener && !ours) {
    state = 'port-busy';
    message = `端口 ${config.port} 被其他程序占用(PID ${listener.pid})`;
  } else if (listener || launchedAlive) {
    state = 'starting';
  } else {
    state = 'stopped';
    if (launch) message = 'ComfyUI 进程已退出,请查看日志';
  }

  if (state === 'starting' && launch && now() - launch.startedAt > START_TIMEOUT_MS) {
    state = 'timeout';
    message = '启动超过 60 秒仍无响应,请查看日志';
  }

  let processMemMB = null;
  if (pid !== null) processMemMB = await settle(memoryOf(pid));

  return {
    state,
    pid,
    ours,
    message,
    deviceName: stats ? stats.deviceName : null,
    argv: stats && stats.argv ? stats.argv : null,
    vramTotal: stats ? stats.vramTotal : null,
    vramFree: stats ? stats.vramFree : null,
    ramTotal: stats ? stats.ramTotal : null,
    ramFree: stats ? stats.ramFree : null,
    queueRunning: queue ? queue.running : null,
    queuePending: queue ? queue.pending : null,
    processMemMB,
  };
}

module.exports = { getStatus, START_TIMEOUT_MS };
