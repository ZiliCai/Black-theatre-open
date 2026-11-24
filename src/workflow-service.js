const crypto = require('node:crypto');
const { loadTemplate, templateForm } = require('./workflow-template');
const { compileWorkflow } = require('./workflow-compile');
const { buildBudget } = require('./workflow-budget');
const { createApi } = require('./comfy-api');
const { createRunProgress, createWebSocketTracker, isTerminal } = require('./run-progress');

function createWorkflowService({ getTemplateDir, getConfig, apiFactory, trackerFactory, getBudgetContext, now, idFactory }) {
  let template = null;
  let progress = null;
  let activeRun = null;
  let tracker = null;
  let historyTimer = null;
  let historyPolling = false;
  const clock = now || Date.now;
  const makeApi = (port) => apiFactory ? apiFactory(port) : createApi({ port });
  const makeTracker = (options) => trackerFactory ? trackerFactory(options) : createWebSocketTracker(options);
  const current = () => {
    if (!template) template = loadTemplate(getTemplateDir());
    return template;
  };

  function cleanup() {
    if (tracker) tracker.close();
    tracker = null;
    if (historyTimer) clearInterval(historyTimer);
    historyTimer = null;
  }

  function finish(status, extra = {}) {
    if (!progress) return;
    progress.finish(status, extra);
    if (isTerminal(activeRun) && (status !== 'succeeded' || activeRun.outputs)) cleanup();
  }

  async function pollHistory() {
    const run = activeRun;
    const waitingForOutputs = run && run.status === 'succeeded' && !run.outputs;
    if (historyPolling || !run || (isTerminal(run) && !waitingForOutputs)) return;
    historyPolling = true;
    try {
      const data = await makeApi(getConfig().port).history(run.promptId);
      if (activeRun !== run) return;
      const entry = data[run.promptId];
      if (!entry) return;
      const status = entry.status && entry.status.status_str;
      if (status === 'success') finish('succeeded', { outputs: entry.outputs || entry });
      else if (status === 'error') finish('failed', { error: (entry.status && entry.status.message) || 'ComfyUI 执行失败' });
      else if (status === 'interrupted') finish('cancelled');
    } catch {
      // The websocket remains the primary progress channel; history is retried on the next tick.
    } finally {
      historyPolling = false;
    }
  }

  return {
    form() {
      try {
        return { ok: true, form: templateForm(current()) };
      } catch (e) {
        return { ok: false, errors: [e.message] };
      }
    },
    switchTemplate() {
      if (activeRun && !isTerminal(activeRun)) return { ok: false, errors: ['生成任务进行中，请等待完成或取消后再切换工作流'] };
      template = null;
      try {
        return { ok: true, form: templateForm(current()) };
      } catch (e) {
        return { ok: false, errors: [e.message] };
      }
    },
    preview(values) {
      try {
        const result = compileWorkflow(current(), values);
        if (result.ok && getBudgetContext) {
          result.budget = buildBudget({ template: current(), summary: result.summary, context: getBudgetContext() });
        }
        return result;
      } catch (e) {
        return { ok: false, errors: [e.message] };
      }
    },
    async start(values) {
      if (activeRun && !isTerminal(activeRun)) return { ok: false, errors: ['已有生成任务正在进行，请等待完成'] };
      let compiled;
      try {
        compiled = compileWorkflow(current(), values);
      } catch (e) {
        return { ok: false, errors: [e.message] };
      }
      if (!compiled.ok) return compiled;
      if (activeRun && isTerminal(activeRun)) cleanup();
      const config = getConfig();
      const api = makeApi(config.port);
      let stats;
      try {
        stats = await api.systemStats();
      } catch (e) {
        return { ok: false, errors: [`ComfyUI 未运行或无法连接，请先启动:${e.message}`] };
      }
      const clientId = idFactory ? idFactory() : crypto.randomUUID();
      let response;
      try {
        response = await api.prompt(compiled.workflow, { clientId });
      } catch (e) {
        return { ok: false, errors: [`提交生成失败:${e.message}`] };
      }
      if (!response || !response.prompt_id) return { ok: false, errors: ['ComfyUI 没有返回 prompt_id'] };
      progress = createRunProgress(response.prompt_id, clock);
      activeRun = progress.state;
      activeRun.createdAt = clock();
      activeRun.summary = compiled.summary;
      activeRun.clientId = clientId;
      if (Array.isArray(stats.argv)) {
        const at = stats.argv.indexOf('--preview-method');
        activeRun.previewMethod = at >= 0 ? stats.argv[at + 1] : 'none';
      }
      tracker = makeTracker({
        port: config.port,
        promptId: response.prompt_id,
        clientId,
        onEvent: (message) => {
          if (!progress) return;
          progress.event(message);
          if (isTerminal(activeRun)) {
            if (activeRun.status === 'succeeded' && !activeRun.outputs) pollHistory();
            else cleanup();
          }
        },
      });
      historyTimer = setInterval(pollHistory, 2500);
      return { ok: true, run: activeRun };
    },
    run() {
      return { ok: true, run: activeRun };
    },
    async cancel() {
      if (!activeRun || isTerminal(activeRun)) return { ok: false, message: '当前没有可取消的任务' };
      try {
        await makeApi(getConfig().port).interrupt();
        activeRun.status = 'cancelling';
        return { ok: true, run: activeRun };
      } catch (e) {
        return { ok: false, message: `取消失败:${e.message}` };
      }
    },
    close: cleanup,
  };
}

module.exports = { createWorkflowService };
