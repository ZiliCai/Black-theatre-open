// Wires the pure modules to the real system. main.js and the integration test both use this.
const { createController } = require('./controller');
const { createApi } = require('./comfy-api');
const { getStatus } = require('./status');
const { clearCache } = require('./cache');
const system = require('./system');

function createRuntime({ getConfig }) {
  const controller = createController({
    getConfig,
    makeApi: (port) => createApi({ port }),
    probe: system.probePort, // fresh on purpose: stop must never act on a cached identity
    starter: system.startComfy,
    killer: system.killProcess,
    waitPortFree: system.waitPortFree,
    now: Date.now,
  });
  const cachedProbe = system.createCachedProbe();

  return {
    controller,
    getStatus() {
      const config = getConfig();
      return getStatus({
        config,
        api: createApi({ port: config.port }),
        probe: cachedProbe,
        memoryOf: system.memoryOfPid,
        launch: controller.getLaunch(),
        isAlive: system.isAlive,
        now: Date.now,
      });
    },
    async clearCache() {
      const config = getConfig();
      const api = createApi({ port: config.port, timeoutMs: 30000 });
      const running = await api.systemStats().then(() => true, () => false);
      return clearCache({ workdir: config.workdir, running, api });
    },
  };
}

module.exports = { createRuntime };
