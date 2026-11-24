// Electron main process: window, IPC, status polling, error-badge counting.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, protocol, safeStorage, screen, shell } = require('electron');
const { Readable } = require('node:stream');
const pkg = require('./package.json');
const { loadConfig, saveConfig, validateConfig } = require('./src/config');
const { buildArgs } = require('./src/args');
const { createRuntime } = require('./src/runtime');
const { createTail, lastLines } = require('./src/logtail');
const { buildReport } = require('./src/errors');
const {
  alertFromChunk, alertFromLog, exitAlert, mergeAlert, shouldNotify, createExitWatcher, createBurstBuffer,
} = require('./src/alerts');
const { effectiveDirs, checkDir, dirStats } = require('./src/dirs');
const { scanWorkflowSaves } = require('./src/workflow-saves');
const { scanModels } = require('./src/model-catalog');
const { createScanner, resolveInside, trashEntries, parseRange, mimeOf } = require('./src/gallery');
const { kindOf } = require('./src/media-meta');
const { planSync, trashClips } = require('./src/clip-sync');
const { keepTake, unkeepTake, keptByVideo, continuationShots } = require('./src/clip-keep');
const { createProjectService } = require('./src/project-service');
const { createWorkflowService } = require('./src/workflow-service');
const { listTemplates } = require('./src/workflow-template');
const { testLlm, optimizeLlm, completeLlm, onUsage } = require('./src/llm-api');
const { createUsageLog } = require('./src/llm-usage');
const { buildOptimizerMessages, parseOptimizedText } = require('./src/prompt-optimizers');
const { rewriteShotPrompt, rewritePicture } = require('./src/prompt-rewrite');
const { composeShot } = require('./src/shot-compose');
const { createScriptChat } = require('./src/script-chat');
const { createScriptBreakdown } = require('./src/script-breakdown');
const { listCards } = require('./src/asset-cards');
const { createSceneService } = require('./src/scene-service');
const sceneAi = require('./src/scene-ai');
const docsLib = require('./src/docs');
const { listScriptShots, importScriptShot, reviseScriptShotPrompt } = require('./src/script-shots');
const projects = require('./src/projects');
const { migrateLegacyUserData } = require('./src/legacy-migrate');
const { createGenerationQueue } = require('./src/generation-queue');
const { createShotService } = require('./src/shot-service');
const { createUpscaleService, createUpscaleStore } = require('./src/upscale');
const { createTakeStore } = require('./src/take-store');
const { createAssetService } = require('./src/asset-service');
const { createAssetStore } = require('./src/asset-store');
const { createRemoteTarget, testServer } = require('./src/remote-target');
const { normalizeServer, validateServer } = require('./src/remote-servers');
const fmt = require('./renderer/format');

// media:// lets the page show pictures and videos from the folder being browsed (file:// is not allowed
// from the page's own origin). Must be declared before the app is ready.
// corsEnabled: the play-through reads a shot's sound through Web Audio, which loads the video in CORS mode
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const SMOKE = process.argv.includes('--smoke');
// test-only code is loaded only for --smoke, so a mistake in it can never stop a normal start
const runSmoke = SMOKE ? require('./smoke').runSmoke : null;
const STATUS_EVERY_MS = 3000;
const LOG_EVERY_MS = 500;
const MODELS_CACHE_MS = 60000;
const REPORT_LOG_LINES = 3000;

let win = null;
let config = null;
let configFile = null;
let runtime = null;
let polling = false;
let lastStatus = null;
let tail = null;
let tailPath = null;
let currentAlert = null;
let lastNotifiedAt = null;
let modelsCache = null;
let projectService = null;
let workflowService = null;
let generationQueue = null;
let shotService = null;
let assetService = null;
let scriptChat = null;
let scriptBreakdown = null;
let usageLog = null;
let sceneService = null;
let sceneBuilding = false;
let upscaleService = null;
let remoteTarget = null; // rendering on a remote GPU server, when the config names one
let galleryRoot = null; // the folder the finished-work page is looking at; media:// serves only from here
let workflowMediaRoot = null;
let startupNotice = ''; // one-time message for the page, e.g. settings brought over from the old app folder
const gallery = createScanner();
const workflowAssets = createScanner({ readMeta: () => null });
const exitWatcher = createExitWatcher({ now: Date.now });
const burst = createBurstBuffer();
const smokeNotifications = []; // in --smoke runs, notifications are recorded instead of shown

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const comfyDir = () => path.join(config.workdir, 'ComfyUI');

// ---------- config ----------
const LLM_KEY_ACCOUNT = 'comfyui-launcher-llm-api-key';
const llmSecretFile = () => path.join(app.getPath('userData'), 'secrets.json');
function readLlmSecrets() {
  try { return JSON.parse(fs.readFileSync(llmSecretFile(), 'utf8')); } catch { return {}; }
}
function writeLlmSecrets(secrets) {
  fs.mkdirSync(path.dirname(llmSecretFile()), { recursive: true });
  fs.writeFileSync(llmSecretFile(), JSON.stringify(secrets, null, 2), 'utf8');
}
function setLlmSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用');
  const secrets = readLlmSecrets();
  secrets[LLM_KEY_ACCOUNT] = safeStorage.encryptString(value).toString('base64');
  writeLlmSecrets(secrets);
}
function clearLlmSecret() {
  const secrets = readLlmSecrets();
  delete secrets[LLM_KEY_ACCOUNT];
  writeLlmSecrets(secrets);
}
async function llmKey() {
  try {
    const encrypted = readLlmSecrets()[LLM_KEY_ACCOUNT];
    return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
  } catch {
    return '';
  }
}

function sanitizeConfigPatch(patch) {
  const out = {};
  if (typeof patch.workdir === 'string') out.workdir = patch.workdir.trim();
  if (patch.port !== undefined) out.port = Number(patch.port);
  if (typeof patch.logPath === 'string') out.logPath = patch.logPath.trim();
  if (patch.flags && typeof patch.flags === 'object') {
    out.flags = {};
    for (const k of ['lowvram', 'disablePinnedMemory']) {
      if (typeof patch.flags[k] === 'boolean') out.flags[k] = patch.flags[k];
    }
    if (patch.flags.reserveVram !== undefined) out.flags.reserveVram = Number(patch.flags.reserveVram);
    if (typeof patch.flags.extraArgs === 'string') out.flags.extraArgs = patch.flags.extraArgs;
  }
  if (patch.llm && typeof patch.llm === 'object') {
    out.llm = {};
    for (const key of ['baseUrl', 'model', 'optimizer']) {
      if (typeof patch.llm[key] === 'string') out.llm[key] = patch.llm[key].trim();
    }
  }
  if (patch.llmApiKey !== undefined) out.llmApiKey = String(patch.llmApiKey);
  if (patch.llmClearApiKey) out.llmClearApiKey = true;
  return out;
}

const applyConfig = (patch) => {
  config = { ...config, ...patch, flags: { ...config.flags, ...(patch.flags || {}) } };
  modelsCache = null;
};
const configPayload = async () => ({
  config: { ...config, llm: { ...config.llm, apiKeySet: !!(await llmKey()) } },
  validation: validateConfig(config),
});

// ---------- status ----------
async function pollStatus() {
  if (polling) return; // never let slow probes pile up
  polling = true;
  try {
    // a remote ComfyUI's own folders mean nothing here: the project's folders stay as configured
    const s = remoteTarget.server() ? await remoteTarget.status() : await runtime.getStatus();
    s.dirs = effectiveDirs({ workdir: config.workdir, config, argv: s.argv });
    lastStatus = s;
    send('status', s);
    if (exitWatcher.observe(s.state)) raise(exitAlert(Date.now()));
  } catch (e) {
    send('status', { state: 'error', message: `读取状态失败:${e.message}` });
  } finally {
    polling = false;
  }
}

// ---------- error alert (the log itself is never shown) ----------
function setAlert(next) {
  currentAlert = next;
  send('alert', currentAlert);
}

function notify(alert) {
  if (SMOKE) {
    smokeNotifications.push({ title: alert.title, body: alert.sub });
    return;
  }
  if (win && !win.isDestroyed()) win.flashFrame(true); // flashes the taskbar button until the window is focused
  if (Notification.isSupported()) {
    const n = new Notification({ title: `黑箱剧场 · ${alert.title}`, body: '点击回到启动器,然后点「复制报错」' });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    n.show();
  }
}

function raise(incoming) {
  if (!incoming) return;
  setAlert(mergeAlert(currentAlert, incoming));
  const now = Date.now();
  const focused = !!(win && !win.isDestroyed() && win.isFocused());
  if (shouldNotify({ windowFocused: focused, lastNotifiedAt, now })) {
    lastNotifiedAt = now;
    notify(currentAlert);
  }
}

// New log text arrives twice a second; a multi-line error can be cut in two, so analyse whole bursts.
function ingestLog(chunk) {
  const text = burst.push(chunk);
  if (text) raise(alertFromChunk(text, Date.now()));
}

function pumpLog() {
  if (!tail || tailPath !== config.logPath) {
    tailPath = config.logPath;
    tail = createTail(tailPath, { fromEnd: true });
    return;
  }
  ingestLog(tail.readNew());
}

// When the launcher opens: an error since ComfyUI's last start is still worth showing.
function checkLogOnOpen() {
  const found = alertFromLog(lastLines(config.logPath, REPORT_LOG_LINES));
  if (found) setAlert(mergeAlert(currentAlert, found));
}

function copyReport() {
  if (!fs.existsSync(config.logPath)) return { ok: false, found: false, message: '还没有日志文件,没有可复制的内容' };
  const s = lastStatus || {};
  const stateText = s.state ? `${fmt.stateInfo(s.state).text}${s.pid ? `(PID ${s.pid})` : ''}` : '';
  const report = buildReport({
    lines: lastLines(config.logPath, REPORT_LOG_LINES),
    meta: {
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      version: pkg.version,
      stateText,
      args: buildArgs(config).join(' '),
      vramText: s.vramTotal ? `${fmt.formatGB(s.vramTotal - s.vramFree)} / ${fmt.formatGB(s.vramTotal)}` : '',
      ramText: s.ramTotal ? `${fmt.formatGB(s.ramTotal - s.ramFree)} / ${fmt.formatGB(s.ramTotal)}` : '',
    },
  });
  clipboard.writeText(report.text);
  setAlert(null);
  return {
    ok: true,
    found: report.found,
    message: report.found ? '已复制报错,直接粘贴即可' : '没发现明确报错,已复制最近 60 行日志',
  };
}

// ---------- directories ----------
async function dirsPayload() {
  const eff = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv });
  const [outStats, inStats] = await Promise.all([dirStats(eff.output.path), dirStats(eff.input.path)]);
  return {
    output: { ...eff.output, stats: outStats },
    input: { ...eff.input, stats: inStats },
    saves: scanWorkflowSaves(path.join(comfyDir(), 'user', 'default', 'workflows')),
    running: !!(lastStatus && lastStatus.state === 'running'),
    project: activeProjectInfo(),
  };
}

// The script project in use, for the pages that must say "this is decided by the project".
function activeProjectInfo() {
  const dir = config.activeProject;
  if (!dir || !fs.existsSync(dir)) return null;
  return { dir, name: projects.peekProject(dir).name };
}

function activeScriptPaths() {
  const active = activeProjectInfo();
  if (!active) return null;
  const project = projects.peekProject(active.dir);
  return { projectDir: active.dir, docsDir: projects.projectPaths(active.dir, project).docs };
}

function workflowImagePayload(outputPath) {
  workflowMediaRoot = outputPath;
  const scan = workflowAssets.scan(outputPath, { maxFiles: 1000 });
  const images = scan.entries.filter((e) => e.kind === 'image').map((e) => ({ value: `${e.relPath} [output]`, label: e.relPath }));
  return { path: outputPath, images, continuations: continuationShots(outputPath), missing: scan.missing, truncated: scan.truncated };
}

function workflowFormPayload() {
  const result = workflowService.form();
  if (!result.ok) return result;
  const outputPath = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv }).output.path;
  const assets = workflowImagePayload(outputPath);
  const loras = scanModels(path.join(comfyDir(), 'models')).models
    .filter((m) => m.category === 'LoRA')
    .map((m) => ({ value: m.relPath.replace(/^loras\//, ''), label: m.title }));
  const paths = activeScriptPaths();
  const script = paths
    ? listScriptShots(paths)
    : { ok: false, noProject: true, shots: [], aspectRatio: '', message: '请先在“项目”页选择一个剧本项目' };
  const shots = (script.shots || []).map((shot) => ({
    id: shot.id, episode: shot.episode, sequence: shot.sequence, title: shot.title, shotId: shot.shotId,
    duration: shot.duration, continuePrevious: shot.continuePrevious, source: shot.source,
  }));
  return { ...result, assets: { ...assets, loras }, script: { ...script, shots } };
}

function workflowShotImport(shotId) {
  const paths = activeScriptPaths();
  if (!paths) return { ok: false, noProject: true, message: '请先在“项目”页选择一个剧本项目' };
  const form = workflowService.form();
  if (!form.ok) return form;
  const outputPath = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv }).output.path;
  const cards = assetService ? assetService.mains() : {};
  const result = importScriptShot({ ...paths, outputDir: outputPath, shotId, maxReferences: form.form.limits.maxReferences, cards });
  if (!result.ok) return result;
  return { ...result, assets: workflowImagePayload(outputPath) };
}

// Every project change is answered with fresh folder info, so the page can show "restart to apply" right away.
const withDirs = async (r) => (r && r.ok ? { ...r, dirs: await dirsPayload() } : r);

// ---------- shots ----------
// The project the shot page works in: its folder, its script documents and the folder ComfyUI writes to.
function shotProject() {
  const paths = activeScriptPaths();
  if (!paths) return null;
  return { dir: paths.projectDir, docsDir: paths.docsDir, outputDir: effectiveOutputDir() };
}

// Takes are recorded in the active project, so it cannot change while any are waiting or running.
function queueBlocksSwitch() {
  if (!generationQueue || !generationQueue.busy()) return null;
  const n = generationQueue.snapshot().jobs.length;
  return { ok: false, message: `还有 ${n} 个任务在排队或生成，等完成或取消后再切换项目` };
}

function resumeTakes() {
  const project = shotProject();
  if (!project) return;
  generationQueue.resume({ projectDir: project.dir, outputDir: project.outputDir, store: createTakeStore(project.dir) })
    .then(() => generationQueue.resume({ projectDir: project.dir, outputDir: project.outputDir, store: createAssetStore(project.dir), kind: 'image' }))
    .then(() => generationQueue.resume({ projectDir: project.dir, outputDir: project.outputDir, store: createUpscaleStore(project.dir), kind: 'upscale' }))
    .catch(() => { /* ComfyUI not reachable yet: the takes stay as they are until the next start */ });
}

async function setTakeTier(args) {
  let r = await shotService.setTier(args || {});
  if (r.needsConfirm) {
    let go = SMOKE; // the smoke run answers its own question
    if (!SMOKE) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['取消', '仍然删掉'], defaultId: 0, cancelId: 0, title: '确认', message: r.message,
        detail: '视频和接续文件会移到回收站，可以从回收站恢复。',
      });
      go = response === 1;
    }
    r = go ? await shotService.setTier({ ...args, confirmed: true }) : { ok: false, cancelled: true, message: '已取消' };
  }
  return r;
}

// A shot taken off the episode, after the user has seen what it takes with it.
async function deleteShot(args) {
  let r = await shotService.deleteShot(args || {});
  if (r.needsConfirm) {
    let go = SMOKE; // the smoke run answers its own question
    if (!SMOKE) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['取消', '删掉镜头'], defaultId: 0, cancelId: 0, title: '删除镜头', message: r.message,
        detail: '视频移到回收站，可以从回收站恢复；镜头记录另存在项目的 .blackbox/deleted 里。',
      });
      go = response === 1;
    }
    r = go ? await shotService.deleteShot({ ...args, confirmed: true }) : { ok: false, cancelled: true, message: '已取消' };
  }
  return r;
}

async function setPictureTier(args) {
  let r = await assetService.setTier(args || {});
  if (r.needsConfirm) {
    let go = SMOKE; // the smoke run answers its own question
    if (!SMOKE) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['取消', '仍然删掉'], defaultId: 0, cancelId: 0, title: '确认', message: r.message,
        detail: '图片会移到回收站，可以从回收站恢复。',
      });
      go = response === 1;
    }
    r = go ? await assetService.setTier({ ...args, confirmed: true }) : { ok: false, cancelled: true, message: '已取消' };
  }
  return r;
}


// ---------- finished work ----------
const effectiveOutputDir = () =>
  effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv }).output.path;

function galleryList(opts) {
  const defaultRoot = effectiveOutputDir();
  let root = defaultRoot;
  if (opts && typeof opts.root === 'string' && opts.root.trim()) {
    root = opts.root.trim();
    let isDir = false;
    try {
      isDir = path.win32.isAbsolute(root) && fs.statSync(root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { ok: false, message: `不是可以查看的文件夹:${root}` }; // looking only: no write test, unlike the output-folder setting
  }
  galleryRoot = root;
  const result = gallery.scan(root);
  return { ok: true, root, defaultRoot, isDefault: path.resolve(root).toLowerCase() === path.resolve(defaultRoot).toLowerCase(), scannedAt: Date.now(), kept: keptByVideo(root), ...result };
}

// Keeping a take renames clips inside the folder being browsed, the same folder the relPath came from.
function galleryKeep(opts) {
  if (!galleryRoot) return { ok: false, message: '还没有打开成品页' };
  const { relPath, shot } = opts || {};
  // files named bb_<take> belong to the shot page; renaming them would break its takes
  const owned = takeOwned();
  return keepTake({ root: galleryRoot, relPath: String(relPath || ''), shot: String(shot || ''), isOwned: (stem) => stem.startsWith('bb_') || owned(stem) });
}

function galleryUnkeep(opts) {
  if (!galleryRoot) return { ok: false, message: '还没有打开成品页' };
  return unkeepTake({ root: galleryRoot, relPath: String((opts && opts.relPath) || '') });
}

// Serves files for the page: media://local/<path inside the folder being browsed>. Anything else is refused.
// Range requests are answered by hand because that is how a video player seeks.
async function serveMedia(request) {
  let rel = '';
  let host = '';
  try {
    const url = new URL(request.url);
    host = url.host;
    rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    rel = '';
  }
  const root = host === 'workflow' ? workflowMediaRoot : host === 'project' ? (shotProject() || {}).outputDir : galleryRoot;
  const abs = root && kindOf(rel) ? resolveInside(root, rel) : null;
  if (!abs) return new Response('forbidden', { status: 403 });
  let size;
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    return new Response('not found', { status: 404 });
  }
  // the page reads a shot's sound through Web Audio (levelling across cuts), which needs the CORS header
  const headers = { 'Content-Type': mimeOf(abs), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const range = parseRange(request.headers.get('range'), size);
  if (range && range.unsatisfiable) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status: range ? 206 : 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), { status: range ? 206 : 200, headers });
}

async function galleryTrash(relPaths) {
  if (!galleryRoot) return { ok: false, message: '还没有打开成品页' };
  const list = Array.isArray(relPaths) ? relPaths.filter((x) => typeof x === 'string') : [];
  if (!list.length) return { ok: false, message: '没有选中任何文件' };
  if (!SMOKE) { // the smoke run removes its own throw-away files without asking
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '移到回收站'],
      defaultId: 0,
      cancelId: 0,
      title: '确认',
      message: `把选中的 ${list.length} 个文件移到回收站?`,
      detail: '可以在回收站里恢复。续写用的 h3_context 数据不会被动。',
    });
    if (response !== 1) return { ok: false, cancelled: true, message: '已取消' };
  }
  const r = await trashEntries({
    root: galleryRoot,
    relPaths: list,
    trash: SMOKE ? (p) => fs.promises.rm(p) : (p) => shell.trashItem(p),
  });
  const message = r.failed.length
    ? `已移到回收站 ${r.trashed.length} 个,${r.failed.length} 个失败:${r.failed[0].message}`
    : `已移到回收站 ${r.trashed.length} 个`;
  return { ok: r.trashed.length > 0, message, ...r };
}

// ---------- clip folder sync ----------
const comfyBusy = () => !!(lastStatus && lastStatus.queueRunning > 0);

// Continuation files the shot page's takes own. While a record is unreadable, every take-named file counts.
function takeOwned() {
  const used = shotService.usedContexts();
  return (stem) => used.has(stem) || (used.unsure && String(stem).startsWith('bb_'));
}

function clipPlan(opts) {
  const includeSlots = !!(opts && opts.includeSlots);
  const root = effectiveOutputDir();
  const plan = planSync({ root, generating: comfyBusy() || generationQueue.busy(), includeSlots });
  // the shot page knows exactly which continuation files its takes own: those are never offered for removal
  const owned = takeOwned();
  const inUse = (plan.remove || []).filter((c) => owned(c.stem));
  if (inUse.length) {
    plan.remove = plan.remove.filter((c) => !owned(c.stem));
    plan.removeBytes = plan.remove.reduce((n, c) => n + (c.bytes || 0), 0);
    plan.held = [...(plan.held || []), ...inUse.map((c) => ({ ...c, reason: '镜头页的抽卡还在用' }))];
  }
  return { ok: true, root, includeSlots, generating: comfyBusy(), ...plan };
}

async function clipTrash({ stems, includeSlots }) {
  const owned = takeOwned();
  const list = Array.isArray(stems) ? stems.filter((x) => typeof x === 'string' && !owned(x)) : [];
  if (!list.length) return { ok: false, message: '没有要清除的 clip' };
  const r = await trashClips({
    root: effectiveOutputDir(),
    stems: list,
    generating: comfyBusy(),
    includeSlots: !!includeSlots,
    trash: SMOKE ? (p) => fs.promises.rm(p) : (p) => shell.trashItem(p),
  });
  let message = `已把 ${r.trashed.length} 个 clip 移到回收站`;
  if (r.failed.length) message += `,${r.failed.length} 个失败:${r.failed[0].message}`;
  if (r.skipped.length) message += `,${r.skipped.length} 个已不在清除名单里,没有动`;
  return { ok: r.trashed.length > 0, message, ...r };
}

const DIR_KEY = { output: 'outputDir', input: 'inputDir' };
const DIR_TITLE = { output: '选择输出目录(成片和图片保存到这里)', input: '选择输入目录(参考图从这里读取)' };

// ---------- confirmation for stop / restart ----------
async function withConfirm(action) {
  let r = await action({ confirmed: false });
  if (r.needsConfirm) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '仍然继续'],
      defaultId: 0,
      cancelId: 0,
      title: '确认',
      message: r.message,
      detail: '确定要继续吗?',
    });
    r = response === 1 ? await action({ confirmed: true }) : { ok: false, message: '已取消' };
  }
  return r;
}

const afterAction = async (r) => {
  pollStatus();
  return r;
};

function registerIpc() {
  ipcMain.handle('config:get', () => configPayload());
  ipcMain.handle('config:set', async (_e, patch) => {
    const { llmApiKey, llmClearApiKey, ...clean } = sanitizeConfigPatch(patch || {});
    if (llmApiKey) setLlmSecret(llmApiKey);
    if (llmClearApiKey) clearLlmSecret();
    applyConfig(clean);
    saveConfig(configFile, config);
    pollStatus();
    return configPayload();
  });
  // what the language model has been used for and what it cost
  ipcMain.handle('llm:usage', () => usageLog.summary());
  ipcMain.handle('llm:prices', (_e, prices) => (prices === null ? usageLog.resetPrices() : usageLog.setPrices(prices)));
  ipcMain.handle('llm:test', async () => {
    try { return await testLlm(config.llm, await llmKey()); } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('llm:optimize', async (_e, { text, optimizer, context, focus }) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, message: '提示词不能为空' };
    try {
      const messages = buildOptimizerMessages({ optimizer, text, context, focus });
      const raw = await optimizeLlm(config.llm, await llmKey(), { ...messages, purpose: '提示词优化' });
      return { ok: true, text: parseOptimizedText(raw) };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('workdir:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 ComfyUI_windows_portable 文件夹',
      defaultPath: config.workdir,
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  const REMOTE_ONLY_START = { ok: false, message: '现在是在远程服务器上出片：服务器上的 ComfyUI 不从这里停止或重启，需要的话到服务器上操作' };
  ipcMain.handle('proc:start', async () => afterAction(remoteTarget.server() ? await remoteTarget.startComfy() : await runtime.controller.start()));
  ipcMain.handle('proc:stop', async () => {
    if (remoteTarget.server()) return REMOTE_ONLY_START;
    exitWatcher.expectStop();
    return afterAction(await withConfirm((o) => runtime.controller.stop(o)));
  });
  ipcMain.handle('proc:restart', async () => {
    if (remoteTarget.server()) return REMOTE_ONLY_START;
    exitWatcher.expectStop();
    return afterAction(await withConfirm((o) => runtime.controller.restart(o)));
  });
  ipcMain.handle('cache:clear', async () => (remoteTarget.server()
    ? { ok: false, message: '清缓存只对本机的 ComfyUI 有用' } : afterAction(await runtime.clearCache())));

  ipcMain.handle('open:ui', () => {
    const port = remoteTarget.port();
    if (!port) return; // the tunnel is down: there is nothing to open
    shell.openExternal(`http://127.0.0.1:${port}`);
  });

  // ---------- remote GPU servers ----------
  const remotePayload = () => ({ ok: true, target: config.target, servers: config.servers, tunnel: remoteTarget.tunnel() });
  const saveRemote = (patch) => {
    applyConfig(patch);
    saveConfig(configFile, config);
    remoteTarget.sync();
    pollStatus();
    return remotePayload();
  };
  ipcMain.handle('remote:get', () => remotePayload());
  ipcMain.handle('remote:save', (_e, raw) => {
    const server = normalizeServer(raw || {});
    const v = validateServer(server);
    if (!v.ok) return { ok: false, message: v.errors.join(';') };
    const existing = config.servers.some((s) => s.id === server.id);
    if (!existing) server.id = `srv-${crypto.randomUUID().slice(0, 8)}`;
    // a server in use changing under a running take would send its files to the wrong place
    if (existing && config.target === server.id) {
      const busy = queueBlocksSwitch();
      if (busy) return busy;
    }
    const servers = existing ? config.servers.map((s) => (s.id === server.id ? server : s)) : [...config.servers, server];
    return { ...saveRemote({ servers }), saved: server.id };
  });
  ipcMain.handle('remote:delete', (_e, { id } = {}) => {
    if (config.target === id) {
      const busy = queueBlocksSwitch();
      if (busy) return busy;
    }
    return saveRemote({ servers: config.servers.filter((s) => s.id !== id), target: config.target === id ? 'local' : config.target });
  });
  ipcMain.handle('remote:use', (_e, { id } = {}) => {
    const target = id && config.servers.some((s) => s.id === id) ? id : 'local';
    if (target === config.target) return remotePayload();
    const busy = queueBlocksSwitch();
    if (busy) return { ...busy, message: busy.message.replace('切换项目', '换出片的地方') };
    return saveRemote({ target });
  });
  ipcMain.handle('remote:test', async (_e, raw) => {
    const server = normalizeServer(raw || {});
    const v = validateServer(server);
    if (!v.ok) return { ok: false, steps: [], message: v.errors.join(';') };
    return testServer(server);
  });
  ipcMain.handle('remote:retry', () => {
    remoteTarget.retry();
    return remotePayload();
  });
  ipcMain.handle('open:log', () => shell.showItemInFolder(config.logPath));
  ipcMain.handle('report:copy', () => copyReport());
  ipcMain.handle('alert:dismiss', () => {
    setAlert(null);
    return { ok: true, message: '' };
  });

  ipcMain.handle('dirs:get', () => dirsPayload());
  ipcMain.handle('dirs:pick', async (_e, { which }) => {
    if (!DIR_KEY[which]) return null;
    const eff = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv });
    const r = await dialog.showOpenDialog(win, {
      title: DIR_TITLE[which],
      defaultPath: eff[which].configuredPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dirs:set', async (_e, { which, path: chosen }) => {
    if (!DIR_KEY[which]) return { ok: false, message: '未知的目录类型' };
    let message = '已恢复默认位置';
    if (chosen) {
      const check = checkDir(chosen, { create: true });
      if (!check.ok) return { ok: false, message: check.message };
      message = check.created ? '已创建文件夹并保存新位置' : '已保存新位置';
    }
    applyConfig({ [DIR_KEY[which]]: chosen || '' });
    saveConfig(configFile, config);
    await pollStatus();
    return { ok: true, message, payload: await dirsPayload() };
  });
  ipcMain.handle('dirs:open', async (_e, { which }) => {
    if (!DIR_KEY[which]) return { ok: false, message: '未知的目录类型' };
    const eff = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv });
    const err = await shell.openPath(eff[which].path);
    return err ? { ok: false, message: `无法打开:${err}` } : { ok: true, message: '' };
  });

  ipcMain.handle('clipboard:write', (_e, { text }) => {
    if (typeof text !== 'string' || !text) return { ok: false, message: '没有可复制的内容' };
    clipboard.writeText(text.slice(0, 100000));
    return { ok: true, message: '已复制' };
  });
  ipcMain.handle('gallery:list', (_e, opts) => galleryList(opts));
  ipcMain.handle('gallery:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要查看的文件夹(只是查看,不会改变输出目录)',
      defaultPath: galleryRoot || effectiveOutputDir(),
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('gallery:trash', (_e, { relPaths }) => galleryTrash(relPaths));
  ipcMain.handle('clips:plan', (_e, opts) => clipPlan(opts));
  ipcMain.handle('clips:trash', (_e, opts) => clipTrash(opts || {}));
  ipcMain.handle('clips:keep', (_e, opts) => galleryKeep(opts));
  ipcMain.handle('clips:unkeep', (_e, opts) => galleryUnkeep(opts));
  ipcMain.handle('gallery:reveal', (_e, { relPath }) => {
    const abs = galleryRoot && kindOf(String(relPath || '')) ? resolveInside(galleryRoot, String(relPath)) : null;
    if (!abs) return { ok: false, message: '路径不在当前查看的文件夹内' };
    shell.showItemInFolder(abs);
    return { ok: true, message: '' };
  });
  ipcMain.handle('gallery:open', async () => {
    if (!galleryRoot) return { ok: false, message: '还没有打开成品页' };
    const err = await shell.openPath(galleryRoot);
    return err ? { ok: false, message: `无法打开:${err}` } : { ok: true, message: '' };
  });

  ipcMain.handle('models:scan', (_e, opts) => {
    const now = Date.now();
    if (!(opts && opts.force) && modelsCache && now - modelsCache.at < MODELS_CACHE_MS) return modelsCache.data;
    const result = scanModels(path.join(comfyDir(), 'models'));
    modelsCache = { at: now, data: { ok: true, ...result, scannedAt: now } };
    return modelsCache.data;
  });
  ipcMain.handle('models:reveal', (_e, { relPath }) => {
    const root = path.resolve(comfyDir(), 'models');
    const target = path.resolve(root, String(relPath || ''));
    if (!target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return { ok: false, message: '路径不在 models 目录内' };
    shell.showItemInFolder(target);
    return { ok: true, message: '' };
  });

  // ---------- fixed workflow previews and generation ----------
  ipcMain.handle('workflow:form', () => workflowFormPayload());
  ipcMain.handle('templates:list', () => ({
    ok: true,
    current: config.workflowTemplate,
    templates: listTemplates(path.join(__dirname, 'workflow-templates')).filter((t) => t.kind !== 'image' && t.kind !== 'upscale'),
  }));
  ipcMain.handle('templates:set', (_e, { id } = {}) => {
    const found = listTemplates(path.join(__dirname, 'workflow-templates')).find((t) => t.dirName === id);
    if (!found || found.kind === 'image' || found.kind === 'upscale') return { ok: false, errors: ['未找到该工作流模板'] };
    if (!found.compatible) return { ok: false, errors: [`「${found.name}」是旧版模板，尚未升级到当前表单格式`] };
    const previous = config.workflowTemplate;
    config.workflowTemplate = found.dirName;
    const switched = workflowService.switchTemplate();
    if (!switched.ok) {
      config.workflowTemplate = previous;
      return switched;
    }
    saveConfig(configFile, config);
    return { ok: true, current: found.dirName };
  });
  ipcMain.handle('workflow:import-shot', (_e, { shotId } = {}) => workflowShotImport(shotId));
  // an AI rewrite carries out the remark and then tidies the result; tidyOnly is the 整理 button
  // aroundShotId: the shot page's shot, for its neighbours only (the page saves the result itself)
  ipcMain.handle('workflow:revise', async (_e, { text, feedback, context, shotId, aroundShotId, tidyOnly = false } = {}) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, message: '当前提示词不能为空' };
    if (!tidyOnly && (typeof feedback !== 'string' || !feedback.trim())) return { ok: false, message: '请先填写不满意的地方' };
    const paths = shotId ? activeScriptPaths() : null;
    if (shotId && !paths) return { ok: false, message: '当前没有可写回的剧本项目' };
    try {
      const key = await llmKey();
      const own = shotId || aroundShotId;
      const r = await rewriteShotPrompt({
        text, feedback: String(feedback || '').trim(), tidyOnly: !!tidyOnly,
        // where everyone is in this shot's blocking, when a whitebox scene has it
        context: own ? { ...(context || {}), blocking: shotService.blockingBrief(String(own)) } : context,
        // the shots around it, so the rewrite keeps them joined up and names the ones that must follow
        around: (shotId || aroundShotId) && !tidyOnly ? shotService.around(String(shotId || aroundShotId)) : undefined,
        llm: (messages) => optimizeLlm(config.llm, key, { ...messages, purpose: '镜头改写' }),
      });
      if (r.refuse) return { ok: false, message: r.refuse };
      if (!shotId) return { ok: true, text: r.text, note: r.note, warnings: r.warnings, affects: r.affects, fileUpdated: false };
      const saved = reviseScriptShotPrompt({ ...paths, shotId, expectedPrompt: text, prompt: r.text });
      if (!saved.ok) return saved;
      shotService.clearLink(String(shotId));
      return { ok: true, text: r.text, note: r.note, warnings: r.warnings, affects: r.affects, fileUpdated: true, source: saved.source };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  // a shot that has to follow another one's change: rewritten with the remark the first rewrite wrote for it,
  // and saved where its prompt lives
  ipcMain.handle('shots:revise-linked', async (_e, { shotId, remark } = {}) => {
    const id = String(shotId || '');
    if (!String(remark || '').trim()) return { ok: false, message: '没有修改说明' };
    const target = shotService.revisionTarget(id);
    if (!target.ok) return target;
    if (!target.text.trim()) return { ok: false, message: '这一镜还没有提示词' };
    try {
      const key = await llmKey();
      const r = await rewriteShotPrompt({
        text: target.text, feedback: String(remark).trim(), context: target.context, around: shotService.around(id),
        llm: (messages) => optimizeLlm(config.llm, key, { ...messages, purpose: '连带改写' }),
      });
      if (r.refuse) return { ok: false, message: r.refuse };
      const saved = shotService.writePrompt(id, { expected: target.text, prompt: r.text });
      if (!saved.ok) return saved;
      return { ok: true, note: r.note, warnings: r.warnings, affects: r.affects };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  // a shot brought in line with its blocking: the rewrite is told the facts (context.blocking) and what disagrees
  ipcMain.handle('shots:fit-blocking', async (_e, { shotId } = {}) => {
    const id = String(shotId || '');
    if (!shotService.blockingBrief(id)) return { ok: false, message: '这一镜还没有站位（在场景页给它排站位）' };
    const target = shotService.revisionTarget(id);
    if (!target.ok) return target;
    const found = [...shotService.blockingCheck(id), ...shotService.pictureCheck(id)];
    const remark = [
      '按这一镜的站位核对整条提示词：画面左右、谁正脸谁背影、谁近谁远、人身后是窗还是墙，和站位不一致的地方改成站位的样子；站位里在画面外的人不写进画面。景别、动作、台词和时长不变。',
      '参考图里的每个人在 subject_definitions 里都要有一条 <Subject k> 指向他的 <Picture n>，场景图也有一条写成地点；图号照下面的参考图顺序，不要把场景图写成人。',
      shotService.referenceText(id),
      found.length ? `软件查出来不一致的：${found.join('；')}` : '',
    ].filter(Boolean).join('\n');
    try {
      const key = await llmKey();
      const r = await rewriteShotPrompt({
        text: target.text, feedback: remark, context: target.context, around: shotService.around(id),
        llm: (messages) => optimizeLlm(config.llm, key, { ...messages, purpose: '按站位改写' }),
      });
      if (r.refuse) return { ok: false, message: r.refuse };
      const saved = shotService.writePrompt(id, { expected: target.text, prompt: r.text });
      if (!saved.ok) return saved;
      return { ok: true, note: r.note, warnings: [...r.warnings, ...shotService.blockingCheck(id), ...shotService.pictureCheck(id)], affects: r.affects };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  // talking the whole script over: documents in front, the conversation after; edits are applied one by one
  // ---------- 场景（白模）: the scene file is data; the AI proposes, the page shows it, the user applies ----------
  const sceneLlm = async (messages) => completeLlm(config.llm, await llmKey(), { ...messages, purpose: '场景白模' });
  const sceneDocs = (relPaths) => {
    const paths = activeScriptPaths();
    if (!paths) return [];
    return (Array.isArray(relPaths) ? relPaths : []).map((relPath) => ({ relPath, r: docsLib.readDoc(paths.docsDir, String(relPath)) }))
      .filter((d) => d.r.ok && !d.r.readOnly).map((d) => ({ relPath: d.relPath, content: d.r.content }));
  };
  const proposal = (r) => (r.ok ? { ...r, built: sceneService.build(r.scene).built } : r);
  ipcMain.handle('scene:list', () => sceneService.list());
  ipcMain.handle('scene:open', (_e, { id } = {}) => sceneService.open(String(id || '')));
  ipcMain.handle('scene:build', (_e, { scene, setup } = {}) => sceneService.build(scene || {}, setup ? String(setup) : undefined));
  // 「E01-014~023」 or 「E01-015, E01-017」 → shot ids
  const shotSpec = (spec) => String(spec || '').split(/[,，、\s]+/).filter(Boolean).flatMap((part) => {
    const m = /^(?:MOTION-)?([A-Z]\w*)-(\d+)(?:\s*[~～–—-]\s*(\d+))?$/i.exec(part.trim());
    if (!m) return [];
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => `MOTION-${m[1].toUpperCase()}-${String(from + i).padStart(m[2].length, '0')}`);
  });
  // the script's own words on blocking: sections whose heading says 站位 and that name one of the shots
  const blockingNotes = (shotIds) => {
    const paths = activeScriptPaths();
    if (!paths) return '';
    const nos = shotIds.map((id) => id.slice(-3));
    const out = [];
    for (const d of docsLib.listDocs(paths.docsDir).docs || []) {
      const r = docsLib.readDoc(paths.docsDir, d.relPath);
      if (!r.ok) continue;
      for (const section of String(r.content).split(/\n(?=#{1,3} )/)) {
        if (/^#{1,3} .*站位/.test(section) && nos.some((n) => section.includes(n))) out.push(section.trim());
      }
    }
    return out.join('\n\n');
  };
  // blocking for a stretch of shots, laid out by the model from their prompts and the script's notes
  ipcMain.handle('scene:block', async (_e, { scene, name, room, shots, remark } = {}) => {
    const ids = shotSpec(shots);
    const found = shotService.prompts(ids);
    if (!found.length) return { ok: false, message: '没找到这些镜头（写成 E01-014~023 或 E01-015, E01-017）' };
    if (!String(name || '').trim()) return { ok: false, message: '先给站位起个名字' };
    try {
      const r = await sceneAi.blockShots({
        scene, name: String(name).trim(), room: String(room || ''), shots: found, notes: blockingNotes(found.map((s) => s.id)), remark: String(remark || ''), llm: sceneLlm,
      });
      if (!r.ok) return r;
      const b = sceneService.build(r.scene, r.setup.name);
      return { ...r, built: b.built, problems: b.problems, left: r.problems };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('scene:create', (_e, { name } = {}) => sceneService.create(name));
  ipcMain.handle('scene:save', (_e, { id, scene, version, overwrite } = {}) => sceneService.save(String(id || ''), scene, version, { overwrite: !!overwrite }));
  // a blocking camera's picture is named after the location card its shot uses, so that card takes it as the base
  // of its image-to-image picture
  const shotCard = (shots) => {
    const ids = shots.map((s) => (/^(MOTION|HAND)-/i.test(String(s)) ? String(s) : `MOTION-${s}`).toUpperCase());
    for (const s of shotService.prompts(ids)) {
      const place = (s.references || []).find((r) => /地理|场景/.test(r.use || ''));
      if (place) return place.id.replace(/^IMG-/, '');
    }
    return '';
  };
  ipcMain.handle('scene:shot', (_e, args = {}) => sceneService.saveShot(args, shotCard));
  ipcMain.handle('scene:edit', async (_e, { scene, remark, focus } = {}) => {
    if (!String(remark || '').trim()) return { ok: false, message: '先说要怎么改' };
    try {
      return proposal(await sceneAi.editScene({ scene, remark: String(remark).trim(), focus: String(focus || ''), llm: sceneLlm }));
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('scene:furnish', async (_e, { scene, room, remark, docs } = {}) => {
    try {
      return proposal(await sceneAi.furnishRoom({ scene, roomName: String(room || ''), remark: String(remark || ''), docs: sceneDocs(docs), llm: sceneLlm }));
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  // building a whole scene from the documents takes a few minutes; the page hears how far it got
  ipcMain.handle('scene:generate', async (_e, { name, docs, remark } = {}) => {
    if (sceneBuilding) return { ok: false, message: '已经在搭一个场景了' };
    const id = String(name || '').trim();
    const chosen = sceneDocs(docs);
    if (!chosen.length) return { ok: false, message: '至少选一篇设定文档' };
    const list = sceneService.list();
    if (!list.ok) return list;
    if (list.scenes.some((s) => s.id === id)) return { ok: false, message: `已经有一个叫「${id}」的场景了` };
    sceneBuilding = true;
    try {
      const r = await sceneAi.buildFromDocs({ name: id, docs: chosen, remark: String(remark || ''), llm: sceneLlm, onProgress: (p) => send('scene-progress', p) });
      if (!r.ok) return r;
      const made = sceneService.create(id, { ...r.scene, sources: chosen.map((d) => d.relPath) }); // a room redone later reads the same documents
      return made.ok ? { ...made, skipped: r.skipped } : made;
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      sceneBuilding = false;
    }
  });

  ipcMain.handle('script-chat:load', () => scriptChat.load());
  ipcMain.handle('script-chat:docs', (_e, { relPaths } = {}) => scriptChat.setDocs(relPaths));
  ipcMain.handle('script-chat:send', (_e, { text } = {}) => scriptChat.send(text));
  ipcMain.handle('script-chat:apply', (_e, { messageId, editId } = {}) => scriptChat.apply(String(messageId || ''), String(editId || '')));
  ipcMain.handle('script-chat:undo', (_e, { messageId, editId } = {}) => scriptChat.undo(String(messageId || ''), String(editId || '')));
  ipcMain.handle('script-chat:shots-done', (_e, { messageId } = {}) => scriptChat.shotsDone(String(messageId || '')));
  ipcMain.handle('script-chat:clear', () => scriptChat.clear());
  // ---------- a whole script into shots ----------
  ipcMain.handle('breakdown:load', () => scriptBreakdown.load());
  ipcMain.handle('breakdown:start', (_e, { relPaths, granularity } = {}) => scriptBreakdown.start(relPaths, { granularity }));
  ipcMain.handle('breakdown:update', (_e, { plan } = {}) => scriptBreakdown.update(plan));
  ipcMain.handle('breakdown:write', () => scriptBreakdown.write());
  ipcMain.handle('breakdown:stop', () => scriptBreakdown.stop());
  ipcMain.handle('breakdown:discard', () => scriptBreakdown.discard());
  ipcMain.handle('shots:link-note', (_e, { shotId, from, reason, remark } = {}) => shotService.noteLink(String(shotId || ''), { from, reason, remark }));
  ipcMain.handle('shots:link-clear', (_e, { shotId } = {}) => shotService.clearLink(String(shotId || '')));
  ipcMain.handle('workflow:preview', (_e, values) => workflowService.preview(values));
  ipcMain.handle('workflow:start', async (_e, values) => {
    const dirs = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv });
    if (dirs.output.pending || dirs.input.pending) return { ok: false, errors: ['存储目录刚刚更改，请先重启 ComfyUI，再开始生成'] };
    return workflowService.start(values);
  });
  ipcMain.handle('workflow:run', () => workflowService.run());
  ipcMain.handle('workflow:cancel', () => workflowService.cancel());

  // ---------- shots and the generation queue ----------
  ipcMain.handle('shots:episodes', () => shotService.episodes());
  ipcMain.handle('shots:detail', (_e, { shotId } = {}) => shotService.detail(String(shotId || '')));
  ipcMain.handle('shots:draft', (_e, { shotId, draft } = {}) => shotService.saveDraft(String(shotId || ''), draft));
  ipcMain.handle('shots:prompt', (_e, { shotId, expected, prompt } = {}) => shotService.writePrompt(String(shotId || ''), { expected: String(expected ?? ''), prompt: String(prompt ?? '') }));
  ipcMain.handle('shots:enqueue', (_e, { shotId, count } = {}) => {
    const dirs = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv });
    if (dirs.output.pending || dirs.input.pending) return { ok: false, errors: ['存储目录刚刚更改，请先重启 ComfyUI，再开始生成'] };
    return shotService.enqueue(String(shotId || ''), count);
  });
  ipcMain.handle('shots:tier', (_e, { shotId, takeId, tier } = {}) => setTakeTier({ shotId: String(shotId || ''), takeId: String(takeId || ''), tier: String(tier ?? '') }));
  ipcMain.handle('shots:manual', (_e, { episode, title, after, anchor, place } = {}) => shotService.createManual({ episode, title, after, anchor, place }));
  ipcMain.handle('shots:delete', (_e, { shotId } = {}) => deleteShot({ shotId: String(shotId || '') }));
  // a new shot from the user's few words: the AI writes its prompt and settings, then it is made like a hand-made one
  ipcMain.handle('shots:compose', async (_e, { episode, title, anchor, place, description } = {}) => {
    if (!String(description || '').trim()) return { ok: false, message: '先写一句这一镜想拍什么' };
    const where = shotService.composeContext({ episode, anchor, place });
    if (!where.ok) return where;
    try {
      const key = await llmKey();
      const r = await composeShot({
        description, title: String(title || '').trim(), cards: where.cards, previous: where.previous, next: where.next, maxReferences: where.maxReferences,
        llm: (messages) => completeLlm(config.llm, key, { ...messages, purpose: '新建镜头' }),
      });
      if (!r.ok) return r;
      const made = shotService.createComposed({ episode, anchor, place, title: String(title || '').trim() || r.title || '新镜头', prompt: r.prompt, duration: r.duration, codes: r.codes, continues: r.continue });
      if (!made.ok) return made;
      return { ...made, note: r.note, warnings: r.warnings };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('upscale:options', () => upscaleService.options());
  ipcMain.handle('upscale:enqueue', (_e, { shotId, takeId, quality } = {}) => upscaleService.enqueue({ shotId: String(shotId || ''), takeId: String(takeId || ''), quality: String(quality || '1080p') }));
  ipcMain.handle('upscale:episode', (_e, { episode, quality } = {}) => upscaleService.enqueueEpisode({ episodeId: String(episode || ''), quality: String(quality || '1080p') }));
  ipcMain.handle('shots:timeline', (_e, { episode, gapMode } = {}) => shotService.timeline(String(episode || ''), ['black', 'cand', 'skip'].includes(gapMode) ? gapMode : 'black'));
  // ---------- asset cards ----------
  const code = (v) => String(v || '').toUpperCase();
  ipcMain.handle('assets:cards', () => assetService.cards());
  ipcMain.handle('assets:detail', (_e, { code: c } = {}) => assetService.detail(code(c)));
  ipcMain.handle('assets:draft', (_e, { code: c, draft } = {}) => assetService.saveDraft(code(c), draft));
  ipcMain.handle('assets:enqueue', (_e, { code: c, count } = {}) => {
    const dirs = effectiveDirs({ workdir: config.workdir, config, argv: lastStatus && lastStatus.argv });
    if (dirs.output.pending || dirs.input.pending) return { ok: false, errors: ['存储目录刚刚更改，请先重启 ComfyUI，再开始生成'] };
    return assetService.enqueue(code(c), count);
  });
  ipcMain.handle('assets:tier', (_e, { code: c, takeId, tier, label } = {}) => setPictureTier({ code: code(c), takeId: String(takeId || ''), tier: String(tier ?? ''), label: String(label ?? '') }));
  ipcMain.handle('assets:main', (_e, { code: c, image } = {}) => assetService.setMain(code(c), String(image || '')));
  ipcMain.handle('assets:label', (_e, { code: c, image, label } = {}) => assetService.relabel(code(c), String(image || ''), String(label ?? '')));
  ipcMain.handle('assets:unkeep', (_e, { code: c, image } = {}) => assetService.unkeep(code(c), String(image || '')));
  ipcMain.handle('assets:adopt', (_e, { code: c, relPath } = {}) => assetService.adopt(code(c), String(relPath || '')));
  ipcMain.handle('assets:sets', () => assetService.sets());
  // a one-line remark about the pictures ("让他稍微帅一点") edits the card's wish and its copy of the appearance;
  // the page saves them like typing
  ipcMain.handle('assets:revise', async (_e, { code: c, ask, look, mode, feedback, base, tidyOnly = false } = {}) => {
    if (!tidyOnly && (typeof feedback !== 'string' || !feedback.trim())) return { ok: false, message: '请先说说想怎么改' };
    const detail = assetService.detail(code(c));
    if (!detail.ok) return detail;
    // a base picture taken from a blocking camera: what that camera sees, so the wish names only what is in view
    const plate = /白模_((?:MOTION|HAND)-[A-Z0-9]+-\d+)/i.exec(String(base || detail.draft.base || ''));
    const seen = plate && mode === 'i2i' ? sceneService.factsFor(plate[1].toUpperCase()) : null;
    if (seen && seen.facts && seen.facts.camera && !tidyOnly) {
      const things = seen.facts.things.map((t) => `「${t.name}」（${t.from === t.to ? `画面${t.from}` : `画面${t.from}到${t.to}`}）`);
      feedback = `${feedback}\n基础图是这个机位拍的（白模算的）：${things.length ? `画面里看得到 ${things.join('、')}` : '画面里没有家具'}。外形描述和想要的图里只写这些看得到的东西和它们在画面里的位置；机位背后、画面外的东西（别的墙、别处的家具）一样都不要写。`;
    }
    try {
      const key = await llmKey();
      // the shots that show the card: the script's and those whose draft uses one of its pictures
      const using = [...new Set([...(detail.appearances || []), ...detail.set.flatMap((s) => s.usedBy || [])])];
      const r = await rewritePicture({
        card: detail.card, mode: mode === 'i2i' ? 'i2i' : 't2i', ask: String(ask ?? ''), look: typeof look === 'string' ? look : detail.look.text,
        feedback: String(feedback || '').trim(), tidyOnly: !!tidyOnly, users: tidyOnly ? undefined : shotService.users(using),
        llm: (messages) => optimizeLlm(config.llm, key, { ...messages, purpose: '素材改写' }),
      });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('queue:snapshot', () => generationQueue.snapshot());
  ipcMain.handle('queue:cancel', (_e, { takeId } = {}) => generationQueue.cancel(String(takeId || '')));
  ipcMain.handle('queue:cancel-all', () => generationQueue.cancelAll());
  ipcMain.handle('queue:retry', () => {
    generationQueue.retry();
    return { ok: true, message: '' };
  });

  // ---------- script projects ----------
  const svc = () => projectService;
  ipcMain.handle('projects:list', () => svc().list());
  ipcMain.handle('projects:create', async (_e, { name, activate }) => {
    if (activate !== false && queueBlocksSwitch()) return queueBlocksSwitch();
    return withDirs(await svc().create({ name, activate: activate !== false }));
  });
  ipcMain.handle('projects:inspect', (_e, { dir }) => svc().inspectImport(dir));
  ipcMain.handle('projects:import', async (_e, { dir, docsDir, activate }) => {
    if (activate !== false && queueBlocksSwitch()) return queueBlocksSwitch();
    return withDirs(await svc().importFolder({ dir, docsDir, activate: activate !== false }));
  });
  ipcMain.handle('projects:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要导入的剧本文件夹(只会新增 output、input 等,不会改动里面已有的文件)',
      defaultPath: config.projectsRoot,
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('projects:switch', async (_e, { dir }) => {
    if (queueBlocksSwitch()) return queueBlocksSwitch();
    const r = await withDirs(await svc().switchTo(dir));
    if (r && r.ok) resumeTakes();
    return r;
  });
  ipcMain.handle('projects:leave', async () => queueBlocksSwitch() || withDirs(await svc().leave()));
  ipcMain.handle('projects:forget', async (_e, { dir }) => withDirs(await svc().forget(dir)));
  ipcMain.handle('projects:rename', (_e, { dir, name }) => svc().rename(dir, name));
  ipcMain.handle('projects:open', async (_e, { dir }) => {
    if (!config.projects.some((d) => path.resolve(d).toLowerCase() === path.resolve(String(dir || '')).toLowerCase())) return { ok: false, message: '这不是已知的项目' };
    const err = await shell.openPath(dir);
    return err ? { ok: false, message: `无法打开:${err}` } : { ok: true, message: '' };
  });

  // ---------- script documents ----------
  ipcMain.handle('docs:list', () => svc().docsList());
  ipcMain.handle('docs:read', (_e, { relPath }) => svc().docsRead(relPath));
  ipcMain.handle('docs:save', (_e, args) => svc().docsSave(args));
  ipcMain.handle('docs:create', (_e, args) => svc().docsCreate(args));
  ipcMain.handle('docs:rename', (_e, args) => svc().docsRename(args));
  ipcMain.handle('docs:category', (_e, args) => svc().docsSetCategory(args));
  ipcMain.handle('docs:history', (_e, { relPath }) => svc().docsHistory(relPath));
  ipcMain.handle('docs:history-read', (_e, { relPath, id }) => svc().docsHistoryRead(relPath, id));
  ipcMain.handle('docs:search', (_e, { query }) => svc().docsSearch(query));
  ipcMain.handle('docs:ensure-folder', () => svc().docsEnsureFolder());
  ipcMain.handle('docs:trash', async (_e, { relPath }) => {
    if (!SMOKE) { // the smoke run removes its own throw-away files without asking
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['取消', '移到回收站'],
        defaultId: 0,
        cancelId: 0,
        title: '确认',
        message: `把「${relPath}」移到回收站?`,
        detail: '可以在回收站里恢复。它的历史版本仍保留在设定文件夹的 .history 里。',
      });
      if (response !== 1) return { ok: false, cancelled: true, message: '已取消' };
    }
    return svc().docsTrash({ relPath });
  });
  ipcMain.handle('docs:pick-folder', async () => {
    const current = await svc().docsFolderPath();
    const r = await dialog.showOpenDialog(win, {
      title: '选择设定文件夹(必须在项目文件夹里面)',
      defaultPath: current || config.activeProject || config.projectsRoot,
      properties: ['openDirectory'],
    });
    return r.canceled ? { ok: false, cancelled: true, message: '' } : svc().docsSetFolder(r.filePaths[0]);
  });
  ipcMain.handle('docs:reveal', async (_e, { relPath }) => {
    if (relPath) {
      const file = await svc().docsFilePath(relPath);
      if (!file) return { ok: false, message: '路径不在设定文件夹内' };
      shell.showItemInFolder(file);
      return { ok: true, message: '' };
    }
    const folder = await svc().docsFolderPath();
    if (!folder) return { ok: false, message: '还没有选择剧本项目' };
    const err = await shell.openPath(folder);
    return err ? { ok: false, message: `无法打开:${err}` } : { ok: true, message: '' };
  });
}

// offscreen: for screenshot runs. The page is painted (so it can be captured) but the window sits outside
// every display, cannot take focus and has no taskbar button: fake demo data must never reach the user's screen.
function createWindow({ show, offscreen = false }) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    show,
    ...(offscreen ? { x: -4000, y: 0, focusable: false, skipTaskbar: true } : {}),
    title: '黑箱剧场',
    icon: path.join(__dirname, 'renderer', 'assets', 'app-icon.png'),
    backgroundColor: '#141517',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1b1c1f', symbolColor: '#9a9ba3', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.on('focus', () => win.flashFrame(false));
  // the page is built by `npm run build` into ui/dist; LAUNCHER_DEV_URL points at the Vite dev server instead
  if (process.env.LAUNCHER_DEV_URL) win.loadURL(process.env.LAUNCHER_DEV_URL);
  else win.loadFile(path.join(__dirname, 'ui', 'dist', 'index.html'));
  return win;
}

// ---------- screenshots for the smoke run (only used with --smoke) ----------
async function capture(file) {
  let image = null;
  for (let attempt = 1; attempt <= 6 && !image; attempt++) {
    try {
      image = await win.webContents.capturePage();
    } catch (e) {
      if (attempt === 6) throw e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
}

// The single-instance lock is per userData folder; smoke runs get their own so they can run
// next to a launcher window the user already has open.
if (SMOKE) {
  app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cl-smoke-userdata-')));
  if (process.env.LAUNCHER_DEMO_SHOT) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    configFile = SMOKE
      ? path.join(app.getPath('temp'), `cl-smoke-${process.pid}.json`)
      : path.join(app.getPath('userData'), 'config.json');
    if (!SMOKE) {
      try {
        startupNotice = migrateLegacyUserData({ fromDir: path.join(app.getPath('appData'), 'comfyui-launcher'), toDir: app.getPath('userData') }).message;
      } catch (e) {
        startupNotice = `旧版本设置搬迁失败:${e.message}`;
      }
    }
    config = loadConfig(configFile);
    runtime = createRuntime({ getConfig: () => config });
    workflowService = createWorkflowService({
      getTemplateDir: () => {
        const root = path.join(__dirname, 'workflow-templates');
        const chosen = config.workflowTemplate || 'minimax-h3-hybrid';
        const dir = path.join(root, chosen);
        return fs.existsSync(path.join(dir, 'template.json')) ? dir : path.join(root, 'minimax-h3-hybrid');
      },
      getConfig: () => config,
      getBudgetContext: () => ({
        vramTotal: lastStatus && lastStatus.vramTotal,
        reserveVram: config.flags.reserveVram,
        ramTotal: lastStatus && lastStatus.ramTotal,
        ramFree: lastStatus && lastStatus.ramFree,
        models: scanModels(path.join(comfyDir(), 'models')).models,
      }),
    });
    projectService = createProjectService({
      getConfig: () => config,
      setConfig: (patch) => {
        applyConfig(patch);
        saveConfig(configFile, config);
        pollStatus();
      },
      trash: SMOKE ? (p) => fs.promises.rm(p) : (p) => shell.trashItem(p),
    });
    remoteTarget = createRemoteTarget({
      getConfig: () => config,
      onChange: (tunnel) => {
        send('remote', tunnel);
        pollStatus();
        if (tunnel.state === 'open' && !SMOKE) resumeTakes(); // runs that finished while the link was down
      },
    });
    generationQueue = createGenerationQueue({
      getPort: () => remoteTarget.port(), getRemote: () => remoteTarget.transfer(), getTargetId: () => config.target || 'local', onChange: (snapshot) => send('queue', snapshot),
    });
    shotService = createShotService({
      getProject: shotProject,
      templatesDir: path.join(__dirname, 'workflow-templates'),
      queue: generationQueue,
      trash: SMOKE ? (p) => fs.promises.rm(p) : (p) => shell.trashItem(p),
      getTargetId: () => config.target || 'local',
      // the script's 输入参考图 become each card's main picture
      getCardMains: () => (assetService ? assetService.mains() : {}),
      getBlocking: (shotId) => (sceneService ? sceneService.factsFor(shotId) : null),
      getCards: () => (assetService ? assetService.brief() : []),
    });
    upscaleService = createUpscaleService({
      getProject: shotProject,
      templatesDir: path.join(__dirname, 'workflow-templates'),
      queue: generationQueue,
      // the card that renders now: the server's when remote (its status carries the server's numbers)
      getVram: () => lastStatus && lastStatus.vramTotal,
      getTargetId: () => config.target || 'local',
      picks: (episodeId) => shotService.picks(episodeId),
    });
    assetService = createAssetService({
      getProject: shotProject,
      templatesDir: path.join(__dirname, 'workflow-templates'),
      queue: generationQueue,
      trash: SMOKE ? (p) => fs.promises.rm(p) : (p) => shell.trashItem(p),
    });
    sceneService = createSceneService({ getProjectDir: () => (activeScriptPaths() || {}).projectDir });
    usageLog = createUsageLog({ dir: app.getPath('userData') });
    onUsage((u) => usageLog.record(u));
    scriptChat = createScriptChat({
      getPaths: activeScriptPaths,
      listShotIds: () => {
        const r = shotService.episodes();
        return r.ok ? r.episodes.flatMap((e) => e.shots.map((s) => s.id)) : [];
      },
      llm: async (messages) => completeLlm(config.llm, await llmKey(), { ...messages, purpose: '剧本讨论' }),
    });
    scriptBreakdown = createScriptBreakdown({
      getPaths: activeScriptPaths,
      getCards: () => (assetService ? assetService.brief() : []),
      getStyle: () => {
        const paths = activeScriptPaths();
        const listed = paths ? listCards({ docsDir: paths.docsDir }) : null;
        return (listed && listed.cards[0] && listed.cards[0].style) || '';
      },
      llm: async (messages) => completeLlm(config.llm, await llmKey(), messages),
    });
    registerIpc();
    protocol.handle('media', serveMedia);

    if (SMOKE) {
      // A GUI-subsystem Electron on Windows may not print to a piped console, so also write to a file.
      const report = (line) => {
        console.log(line);
        if (process.env.LAUNCHER_SMOKE_OUT) fs.writeFileSync(process.env.LAUNCHER_SMOKE_OUT, line + '\n');
      };
      const shooting = !!process.env.LAUNCHER_DEMO_SHOT;
      createWindow({ show: shooting, offscreen: shooting });
      return runSmoke({
        app, clipboard, report,
        fail: (msg) => { report(`SMOKE FAIL: ${msg}`); app.exit(1); },
        getWin: () => win,
        getConfig: () => config,
        setConfig: (patch) => applyConfig(patch),
        runtime, pollStatus, send,
        ingestLog, checkLogOnOpen,
        getNotifications: () => smokeNotifications,
        isOnUsersScreen: () => {
          if (!win || win.isDestroyed() || !win.isVisible()) return false;
          const b = win.getBounds();
          return screen.getAllDisplays().some((d) => {
            const a = d.bounds;
            return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
          });
        },
        simulateExit: () => {
          exitWatcher.observe('running');
          if (exitWatcher.observe('stopped')) raise(exitAlert(Date.now()));
        },
        capture,
      });
    }

    createWindow({ show: true });
    remoteTarget.sync();
    if (!remoteTarget.server()) resumeTakes(); // remote: once the tunnel is open
    win.webContents.once('did-finish-load', () => {
      checkLogOnOpen();
      pollStatus();
      if (startupNotice) send('notice', { message: startupNotice });
    });
    setInterval(pollStatus, STATUS_EVERY_MS);
    setInterval(pumpLog, LOG_EVERY_MS);
  });

  app.on('window-all-closed', () => app.quit()); // ComfyUI itself is detached and keeps running
  app.on('will-quit', () => { if (remoteTarget) remoteTarget.close(); }); // the tunnel's ssh must not outlive the app
}
