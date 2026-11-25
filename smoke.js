// `electron . --smoke`: boots the real window + preload + page and drives the whole UI against fakes.
// Hermetic: a temp ComfyUI folder, a temp script project, a fake ComfyUI HTTP server and a fake LLM, all on
// this machine. LAUNCHER_DEMO_SHOT=<dir> also saves screenshots (fake data only, the window stays off-screen).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { net } = require('electron');
const projects = require('./src/projects');

const MB = 1024 * 1024;
const FIXTURES = path.join(__dirname, 'test', 'fixtures');
const API = [
  'getConfig', 'setConfig', 'start', 'stop', 'restart', 'clearCache', 'copyReport', 'dismissAlert', 'listProjects', 'switchProject',
  'listDocs', 'readDoc', 'saveDoc', 'getGallery', 'getModels', 'getDirs', 'testLlm', 'reviseWorkflowPrompt',
  'shotEpisodes', 'shotDetail', 'saveShotDraft', 'writeShotPrompt', 'enqueueTakes', 'setTakeTier', 'createManualShot', 'composeShot', 'deleteShot', 'shotTimeline',
  'assetCards', 'assetDetail', 'saveAssetDraft', 'enqueuePictures', 'setPictureTier', 'setMainPicture', 'relabelPicture', 'unkeepPicture', 'adoptPicture', 'assetSets',
  'loadBreakdown', 'startBreakdown', 'updateBreakdown', 'writeBreakdown', 'stopBreakdown', 'discardBreakdown',
  'queueSnapshot', 'cancelTake', 'cancelAllTakes', 'retryQueue', 'onStatus', 'onAlert', 'onQueue', 'onNotice',
];
// the people-and-places list the 素材 page reads its cards from
const PEOPLE_AND_PLACES = [
  '# 人物与场景', '', '## 画风', '', '写实电影质感，地铁站里冷白的灯光。', '',
  '## 人物', '', '| 代号 | 人物 | 外形 |', '|---|---|---|', '| LX30 | 林夏（30 岁） | 短发，深灰色工装外套 |', '',
  '## 场景', '', '| 代号 | 场景 | 要画进去的东西 |', '|---|---|---|', '| DT-ZT | 地铁站台 | 空荡的站台，冷白灯管 |', '',
].join('\n');
const PAGES = ['shots', 'script', 'gallery', 'assets', 'settings'];
const MOTION = [
  '# 第一集 · 镜头提示词', '',
  '## MOTION-E01-01 · 林夏走下台阶', '- 时长：4s', '- 输入参考图：', '  - PLAN-LX30（顺序：1）· IMG-LX30《林夏 角色板》（用途：身份）', '### 可复制提示词', '> 林夏走下昏暗的地铁台阶。', '',
  '## MOTION-E01-02 · 站台回头', '- 时长：5s', '- 接续上一镜：是', '### 可复制提示词', '> 她在站台上缓慢回头。', '',
  '## MOTION-E01-03 · 列车进站', '- 时长：4.5s', '### 可复制提示词', '> 列车进站，强光掠过站台。', '',
].join('\n');

function sparse(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

// A tiny fake portable folder: enough for the config check, one LoRA and one saved workflow.
function makeFakeWorkdir(root) {
  const workdir = path.join(root, 'portable');
  const comfy = path.join(workdir, 'ComfyUI');
  fs.mkdirSync(path.join(workdir, 'python_embeded'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'python_embeded', 'python.exe'), '');
  fs.mkdirSync(path.join(comfy, 'output'), { recursive: true });
  fs.writeFileSync(path.join(comfy, 'main.py'), '');
  fs.mkdirSync(path.join(comfy, 'input'));
  sparse(path.join(comfy, 'models', 'loras', 'minimax_h3_turbo_v4_step600_ema.safetensors'), 2 * MB);
  fs.mkdirSync(path.join(comfy, 'user', 'default', 'workflows'), { recursive: true });
  return workdir;
}

// A script project with three MOTION shots and two reference pictures in its output folder. A second project
// gets the same shot ids with its own prompts.
function makeProject(root, name = '地铁惊魂') {
  const made = projects.createProject({ root: path.join(root, '剧本项目'), name });
  if (!made.ok) throw new Error(made.message);
  fs.writeFileSync(path.join(made.dir, '剧本', 'MOTION-E01.md'), name === '地铁惊魂' ? MOTION : MOTION.replace(/> [^\n]+/g, (line) => `> ${name}的镜头：${line.slice(2)}`));
  fs.writeFileSync(path.join(made.dir, '剧本', '01_世界观.md'), '# 世界观\n\n地铁站深处有一扇门。\n\n- **林夏**：三十岁，工程师\n');
  if (name === '地铁惊魂') fs.writeFileSync(path.join(made.dir, '剧本', '02_人物与场景.md'), PEOPLE_AND_PLACES);
  // a small whitebox: a ticket hall and a platform room, one camera
  fs.mkdirSync(path.join(made.dir, '白模'), { recursive: true });
  fs.writeFileSync(path.join(made.dir, '白模', '地铁站.scene.json'), JSON.stringify({
    version: 1, name: '地铁站', code: 'DT-BM', levelHeight: 4, templates: {}, outdoor: [], slopes: [], lines: [], labels: [], people: [{ name: '林夏', lv: 0, x: 3, z: 3 }],
    rooms: [
      { name: '售票厅', lv: 0, x: [0, 10], z: [0, 8], openings: [{ name: '闸机口', side: 'e', from: 3, to: 5, kind: 'door' }, { name: '入口', side: 'n', from: 4, to: 6, kind: 'door' }],
        furniture: [{ name: '售票机', x: [0.2, 1.2], z: [0.2, 0.8], h: 1.8, kind: 'metal' }] },
      { name: '站台', lv: 0, x: [10, 30], z: [0, 8], furniture: [{ name: '长椅', x: [2, 4], z: [0.3, 0.8], h: 0.45, kind: 'wood' }] },
    ],
    cameras: [{ name: '闸机口看站台', pos: [8, 1.6, 4], target: [25, 1.5, 4], fov: 60 }],
  }, null, 1));
  for (const name of ['ref/林夏_定妆.png', 'ref/地铁站台.png', 'ref/DT-ZT_站台夜.png']) {
    fs.mkdirSync(path.join(made.dir, 'output', 'ref'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'media', 'sample.png'), path.join(made.dir, 'output', name));
  }
  return made.dir;
}

// Answers like ComfyUI for /system_stats, /queue, /prompt, /history, /interrupt and /free. A submitted run
// "finishes" after a moment by writing the files a real run would write: the video and the continuation latent +
// picture, or for an image run (saved under ref/) the picture.
function fakeComfy({ outputDir }) {
  const state = { prompts: [], history: {}, interrupted: 0, freed: 0 };
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/system_stats') {
      // started with the project's folders, like a ComfyUI restarted after switching to the project
      const argv = ['main.py', '--output-directory', outputDir, '--input-directory', path.join(path.dirname(outputDir), 'input')];
      return send(200, { system: { ram_total: 64 * 1024 * MB, ram_free: 40 * 1024 * MB, argv }, devices: [{ name: 'cuda:0 Fake GPU', vram_total: 24 * 1024 * MB, vram_free: 14 * 1024 * MB }] });
    }
    if (req.url === '/queue') return send(200, { queue_running: [], queue_pending: [] });
    if (req.url === '/interrupt') { state.interrupted++; return send(200, {}); }
    if (req.url === '/free') { state.freed++; return send(200, {}); }
    if (req.url.startsWith('/history/')) {
      const id = decodeURIComponent(req.url.slice('/history/'.length));
      return send(200, state.history[id] ? { [id]: state.history[id] } : {});
    }
    if (req.url === '/prompt' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const graph = JSON.parse(body).prompt;
        const id = `smoke-${state.prompts.length + 1}`;
        state.prompts.push({ id, graph });
        const prefixes = Object.values(graph).map((n) => n.inputs && n.inputs.filename_prefix).filter((p) => typeof p === 'string');
        const picture = prefixes.find((p) => p.startsWith('ref/bb_'));
        if (picture) {
          const name = `${picture.slice('ref/'.length)}_00001_.png`;
          setTimeout(() => {
            fs.copyFileSync(path.join(FIXTURES, 'media', 'sample.png'), path.join(outputDir, 'ref', name));
            state.history[id] = { status: { status_str: 'success' }, outputs: { 8: { images: [{ filename: name, subfolder: 'ref', type: 'output' }] } } };
          }, 300);
          return send(200, { prompt_id: id });
        }
        const key = (prefixes.find((p) => p.startsWith('h3_context/')) || 'h3_context/bb_unknown').slice('h3_context/'.length);
        setTimeout(() => {
          fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
          fs.mkdirSync(path.join(outputDir, 'h3_context'), { recursive: true });
          const sample = key.includes('-02-') ? 'sample-orange.mp4' : 'sample-h3.mp4';
          fs.copyFileSync(path.join(FIXTURES, 'media', sample), path.join(outputDir, 'video', `${key}_00001_.mp4`));
          fs.writeFileSync(path.join(outputDir, 'h3_context', `${key}_1026-120000_.safetensors`), 'latent');
          fs.copyFileSync(path.join(FIXTURES, 'media', 'sample.png'), path.join(outputDir, 'h3_context', `${key}_1026-120000_.jpg`));
          state.history[id] = { status: { status_str: 'success' }, outputs: { 364: { gifs: [{ filename: `${key}_00001_.mp4`, subfolder: 'video', type: 'output' }] } } };
        }, 300);
        send(200, { prompt_id: id });
      });
      return undefined;
    }
    return send(404, {});
  });
  return { server, state };
}

function fakeLlm() {
  return http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end('{}');
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        // a whitebox change: move the bench along the platform
        if (body.includes('你在改一个白模场景')) {
          const ops = { note: '长椅挪到站台中间', ops: [{ op: 'update_furniture', room: '站台', name: '长椅', set: { x: [9, 11] } }] };
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ops) } }] }));
        }
        // blocking for shot 02: Lin Xia on the platform, the camera in front of her
        if (body.includes('排站位')) {
          const setup = {
            people: [{ name: '林夏', card: 'LX30', x: 15, z: 4, facing: 'w' }],
            cameras: [{ name: '02 正面', shots: ['E01-02'], at: { by: '林夏', side: 'front', dist: 3, h: 1.6 }, look: '林夏', fov: 50, expect: { face: ['林夏'] } }],
          };
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ note: '林夏站在站台中间', setup }) } }] }));
        }
        // a new shot written from a few words: its settings and a six-section prompt
        if (body.includes('视频提示词编剧')) {
          const prompt = [
            'subject_definitions:', '<Subject 1> is the woman in a dark grey work jacket on the empty platform.',
            '', 'summary:', 'She looks down the tunnel.', '', 'retention_analysis:', '<Subject 1>: fully_preserved.',
            '', 'detailed_description:', 'Cold white light. [Shot 1] <Subject 1> turns toward the tunnel and holds still.',
            '', 'overall_soundscape:', 'A distant rumble.', '', 'non_diegetic_music:', 'N/A',
          ].join('\n');
          const content = `<note>她望向隧道</note>\n<meta>{"title":"望向隧道","duration":5,"references":[],"continue":false}</meta>\n<prompt>\n${prompt}\n</prompt>`;
          return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        }
        // 剧本拆分镜: the people and places, then the shot list of the one episode
        if (body.includes('短剧的美术统筹')) {
          const cast = { style: '写实电影质感', cards: [{ code: 'LZ', kind: '人物', name: '老周', look: '六十岁，地铁检修工，蓝色工装' }, { code: 'S-SD', kind: '场景', name: '隧道', look: '昏暗的地铁隧道，检修灯' }] };
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(cast) } }] }));
        }
        if (body.includes('短剧的分镜师')) {
          if (!body.includes('拆粗一点')) return res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
          const list = { shots: [
            { title: '老周进隧道', duration: 5, description: '远景，老周提着检修灯走进隧道。', cast: ['S-SD', 'LZ'], continue: false },
            { title: '往深处走', duration: 4, description: '远景，老周往隧道深处走。', cast: ['LZ'], continue: true },
            { title: '看见铁门', duration: 6, description: '远景，老周停下，说「这门怎么开了」。', cast: ['LZ', 'S-SD'], continue: true },
          ] };
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(list) } }] }));
        }
        // the script discussion answers with talk, one document edit and one shot to change
        if (body.includes('编剧搭档')) {
          const talk = [
            '门可以早点出现。',
            '<edit doc="01_世界观.md">', '<find>', '地铁站深处有一扇门。', '</find>', '<replace>', '地铁站深处有一扇锈死的铁门。', '</replace>', '<why>让门更具体</why>', '</edit>',
            '<shots>', 'MOTION-E01-02 | 门要先出现 | 她回头时看见那扇铁门', '</shots>',
          ].join('\n');
          return res.end(JSON.stringify({ choices: [{ message: { content: talk } }] }));
        }
        // a card's wish is rewritten as {ask, note}, a shot's prompt as {prompt, note}
        const reply = body.includes('Qwen-Image')
          ? { ask: '正面定妆，站在站台上，五官端正，眉眼有神', note: '补了五官和眼神' }
          : { prompt: '她惊恐地回头，镜头推近到近景。', note: '加重了害怕，镜头推近' };
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      });
    }
    res.statusCode = 404;
    return res.end();
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function runSmoke(h) {
  const { getWin, setConfig, pollStatus, clipboard, report, fail } = h;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const demoDir = process.env.LAUNCHER_DEMO_SHOT || '';
  const servers = [];
  try {
    const win = getWin();
    if (h.isOnUsersScreen()) return fail('the verification window is visible on the real screen; it must stay hidden or off-screen');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-smoke-'));
    const workdir = makeFakeWorkdir(root);
    const projectDir = makeProject(root);
    const projectB = makeProject(root, '第二部');
    // files of the old way of working: a video kept by clip name, and a clip left without any video
    const legacyVideo = 'video/clip_1026-090000__00001_.mp4';
    fs.mkdirSync(path.join(projectDir, 'output', 'video'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'output', 'h3_context'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'media', 'sample-h3.mp4'), path.join(projectDir, 'output', legacyVideo));
    fs.writeFileSync(path.join(projectDir, 'output', 'h3_context', 'clip_1026-090000_.safetensors'), 'legacy');
    fs.copyFileSync(path.join(FIXTURES, 'media', 'sample.png'), path.join(projectDir, 'output', 'h3_context', 'clip_1026-090000_.jpg'));
    const orphan = path.join(projectDir, 'output', 'h3_context', 'clip_0101-000000_.safetensors');
    fs.writeFileSync(orphan, 'orphan');
    const longAgo = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(orphan, longAgo, longAgo);
    const now = new Date();
    for (const f of [legacyVideo, 'h3_context/clip_1026-090000_.safetensors', 'h3_context/clip_1026-090000_.jpg']) fs.utimesSync(path.join(projectDir, 'output', f), now, now);
    const outputDir = path.join(projectDir, 'output');
    const comfy = fakeComfy({ outputDir });
    const comfyPort = await listen(comfy.server);
    const llm = fakeLlm();
    const llmPort = await listen(llm);
    servers.push(comfy.server, llm);
    const sw = projects.switchPatch(projectDir);
    setConfig({
      workdir, port: comfyPort, logPath: path.join(FIXTURES, 'log-crash.txt'), projects: [projectDir, projectB], ...sw.patch,
      llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'smoke-llm', optimizer: 'refine' },
    });
    await pollStatus();

    await new Promise((resolve) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', resolve) : resolve()));
    const js = async (code) => {
      try {
        return await win.webContents.executeJavaScript(code);
      } catch (e) {
        report(`JS THREW: ${String(code).slice(0, 200)} :: ${e.message}`);
        throw e;
      }
    };
    const waitFor = async (code, ms = 8000, what = code) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(150);
      }
      throw new Error(`timed out waiting for: ${what}`);
    };
    const click = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
    const shot = async (name) => {
      if (!demoDir) return;
      await wait(400);
      await h.capture(path.join(demoDir, `${name}.png`));
    };

    // ---- the bridge and the shell ----
    const keys = await js('typeof window.launcher === "object" ? Object.keys(window.launcher) : null');
    if (!keys) return fail('preload did not expose window.launcher');
    const missing = API.filter((k) => !keys.includes(k));
    if (missing.length) return fail(`window.launcher is missing: ${missing.join(', ')}`);
    await waitFor("!!document.querySelector('.app')", 10000, 'the app shell');
    for (const p of PAGES) {
      await click(`#nav-${p}`);
      await waitFor(`!!document.getElementById('page-${p}')`, 3000, `page-${p} after clicking nav-${p}`);
    }
    await waitFor("document.getElementById('project-pick').textContent.includes('地铁惊魂')", 5000, 'the active project in the top bar');
    await waitFor("document.getElementById('state-badge').textContent.includes('运行中')", 8000, 'ComfyUI shown as running');
    await click('#comfy-status');
    if (!(await js("!!document.getElementById('comfy-menu') && document.getElementById('btn-start').disabled"))) return fail('the ComfyUI menu should open with 启动 disabled while running');
    await shot('shell-comfy-menu');
    await click('#comfy-status');

    // ---- the guide: open on first start, follows the user to each page, closing sticks ----
    await waitFor("!!document.getElementById('guide')", 3000, 'the guide on first start');
    await waitFor("document.getElementById('guide-project')?.classList.contains('done')", 3000, 'an active project ticks the project step');
    await waitFor("document.getElementById('guide-autodl-account')?.classList.contains('open')", 3000, 'a beginner starts at the AutoDL account');
    await shot('guide-start');
    await click('#guide-autodl-rent .g-title');
    await waitFor("[...document.querySelectorAll('#guide-autodl-rent .g-shot img')].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('#guide-autodl-rent .g-num').length >= 4", 3000, 'numbered AutoDL screenshots in the rent step');
    await shot('guide-rent');
    await click('#guide-autodl-rent .g-shot:nth-of-type(2)');
    await waitFor("!!document.querySelector('.g-zoom img')", 3000, 'a screenshot opens at full size');
    await shot('guide-zoom');
    await click('.g-zoom');
    await waitFor("!document.querySelector('.g-zoom')", 3000, 'the full-size screenshot closes');
    await js("[...document.querySelectorAll('#guide-route button')].find((b) => b.textContent === '用自己的显卡').click()");
    await waitFor("!!document.getElementById('guide-local-comfy') && !document.getElementById('guide-autodl-rent')", 3000, 'the own-card route swaps the AutoDL steps');
    await js("[...document.querySelectorAll('#guide-route button')].find((b) => b.textContent.startsWith('租云 GPU')).click()");
    await waitFor("!!document.getElementById('guide-autodl-rent')", 3000, 'back on the AutoDL route');
    await click('#nav-shots');
    await click('#guide-script .g-title');
    await js("[...document.querySelectorAll('#guide-script .g-actions button')].find((b) => b.textContent === '去剧本页').click()");
    await waitFor("!!document.getElementById('page-script')", 3000, 'the guide takes the user to the page of a step');
    await click('#guide-script .g-mark');
    await waitFor("document.getElementById('guide-script').classList.contains('done') && document.getElementById('guide-breakdown').classList.contains('open')", 3000, 'marking a step done opens the next one');
    await shot('guide');
    await click('#nav-guide');
    await waitFor("!document.getElementById('guide') && JSON.parse(localStorage.getItem('blackbox.guide')).open === false", 3000, 'the guide closes and remembers it');

    // ---- error banner from a real crash log ----
    h.ingestLog(fs.readFileSync(path.join(FIXTURES, 'log-crash.txt'), 'utf8'));
    h.ingestLog('');
    await waitFor("!!document.getElementById('alert-banner')", 3000, 'the error banner');
    clipboard.writeText('');
    await click('#btn-alert-copy');
    await waitFor("!document.getElementById('alert-banner')", 3000, 'the banner to clear after copying');
    if (!clipboard.readText().trim()) return fail('copying the error report left the clipboard empty');
    if (!h.getNotifications().length) return fail('an error while the window is not focused should raise a desktop notification');
    // ComfyUI vanishing without being asked to stop is an alert of its own
    h.simulateExit();
    await waitFor("(document.getElementById('alert-banner') || {}).textContent?.length > 0", 3000, 'the banner after ComfyUI exits unexpectedly');
    await click('#btn-alert-dismiss');
    await waitFor("!document.getElementById('alert-banner')", 3000, 'the banner to close');

    // ---- shot page: takes, tiers, continuation, stale marks, timeline ----
    const readTakes = (shotId) => {
      try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'shots', `${shotId}.json`), 'utf8')).takes; } catch { return []; }
    };
    const typeInto = (selector, text) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    // the tier buttons act on the take the big viewer shows: wait until the click has switched it
    const selectTake = async (id) => {
      await click(`[data-take="${id}"]`);
      await waitFor(`document.querySelector('[data-take="${id}"]').classList.contains('on')`, 3000, `take ${id} shown in the viewer`);
    };
    const doneTakes = (n) =>`document.querySelectorAll('#take-strip .take[data-status="succeeded"]').length >= ${n}`;
    await click('#nav-shots');
    await waitFor("document.querySelectorAll('#shot-rows .shot-row').length === 3", 8000, 'three shots listed');
    await click('[data-shot="MOTION-E01-01"]');
    await waitFor("!!document.getElementById('inspector') && document.getElementById('prompt').value.includes('台阶')", 5000, 'shot 01 in the inspector');
    // the script names LX30, whose card has no main picture yet: the shot starts with no pictures (not the template's examples)
    await waitFor("document.querySelectorAll('#refs .ref img').length === 0 && document.querySelectorAll('#refs .ref-missing').length === 0", 5000, "no pictures until the script's card has one");
    await click('#btn-add-ref');
    await waitFor("document.querySelectorAll('.pick-grid button').length >= 2", 5000, 'pictures to pick from the output folder');
    await js("[...document.querySelectorAll('.pick-grid button')].find((b) => b.textContent.startsWith('ref/')).click()");
    await waitFor("document.querySelectorAll('#refs .ref img').length === 1", 5000, 'the picked reference shown');
    const refs = await (async () => { await wait(600); return JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'shots', 'MOTION-E01-01.json'), 'utf8')).draft.values.references; })();
    if (!refs.some((r) => r.startsWith('ref/'))) return fail(`the picked reference was not saved: ${JSON.stringify(refs)}`);
    // the script edited outside: the refresh button brings in the new prompt and length, then it goes back
    const scriptFile = path.join(projectDir, '剧本', 'MOTION-E01.md');
    const scriptText = fs.readFileSync(scriptFile, 'utf8');
    fs.writeFileSync(scriptFile, scriptText.replace('- 时长：4s', '- 时长：5.2s').replace('林夏走下昏暗的地铁台阶。', '林夏走下昏暗的地铁台阶，回头看了一眼。'));
    await click('#btn-shots-refresh');
    await waitFor("document.getElementById('prompt').value.includes('回头看了一眼') && document.getElementById('p-duration').value === '5.2'", 5000, 'the refresh button reading the edited script');
    fs.writeFileSync(scriptFile, scriptText);
    await click('#btn-shots-refresh');
    await waitFor("!document.getElementById('prompt').value.includes('回头看了一眼') && document.getElementById('p-duration').value === '4'", 5000, 'the refresh button reading the script back');
    await shot('shots-empty');
    await typeInto('#take-count', '2');
    await waitFor("document.getElementById('btn-enqueue').textContent.includes('2')", 2000, 'count 2 on the button');
    await click('#btn-enqueue');
    await waitFor("!!document.getElementById('queue-indicator')", 4000, 'the queue indicator while generating');
    await shot('shots-running');
    await waitFor(doneTakes(2), 20000, 'two finished takes for shot 01');
    const [t1, t2] = readTakes('MOTION-E01-01');
    await selectTake(t2.id);
    await click('#btn-tier-pick');
    await waitFor(`document.querySelector('[data-take="${t2.id}"]').dataset.tier === 'pick'`, 4000, 'take 2 picked');
    await selectTake(t1.id);
    await click('#btn-tier-trash');
    await waitFor(`!document.querySelector('[data-take="${t1.id}"]')`, 4000, 'take 1 gone from the strip');
    if (fs.existsSync(path.join(outputDir, t1.video))) {
      const now = readTakes('MOTION-E01-01').find((t) => t.id === t1.id);
      return fail(`trashing a take must remove its video: ${JSON.stringify({ t1, now, files: fs.readdirSync(path.join(outputDir, 'video')) })}`);
    }
    if (fs.existsSync(path.join(outputDir, 'h3_context', `${t1.context}.safetensors`))) return fail('trashing a take must remove its continuation file');
    await shot('shots-picked');

    await click('[data-shot="MOTION-E01-02"]');
    await waitFor("(document.getElementById('continuation-source') || {}).textContent?.includes('接 镜头 01')", 5000, 'shot 02 continuing from shot 01');
    await typeInto('#take-count', '1');
    await waitFor("document.getElementById('btn-enqueue').textContent.includes('1')", 2000, 'count 1 on the button');
    const before = comfy.state.prompts.length;
    await click('#btn-enqueue');
    await waitFor(doneTakes(1), 15000, 'a finished take for shot 02');
    const sent = comfy.state.prompts[before].graph;
    const pick1 = readTakes('MOTION-E01-01').find((t) => t.tier === 'pick');
    if (sent['500'].inputs.value !== true || sent['501'].inputs.clip !== `h3_context/${pick1.context}.jpg [output]`) {
      return fail(`shot 02 should continue from shot 01's pick, sent ${JSON.stringify(sent['501'].inputs)} / ${JSON.stringify(sent['500'].inputs)}`);
    }
    const s2take = readTakes('MOTION-E01-02')[0];
    await selectTake(s2take.id);
    await click('#btn-tier-pick');
    await waitFor(`document.querySelector('[data-take="${s2take.id}"]').dataset.tier === 'pick'`, 4000, 'shot 02 take picked');
    await waitFor("!!document.querySelector('#track .clip[data-shot=\"MOTION-E01-02\"] .link')", 5000, 'the link mark between shot 01 and 02');
    await shot('shots-continued');

    // picking another take in shot 01 makes shot 02's take out of date
    await click('[data-shot="MOTION-E01-01"]');
    await waitFor(doneTakes(1), 4000, 'shot 01 takes');
    await click('#btn-enqueue');
    await waitFor(doneTakes(2), 15000, 'another finished take for shot 01');
    const t3 = readTakes('MOTION-E01-01').find((t) => t.n === 3);
    await selectTake(t3.id);
    await click('#btn-tier-pick');
    await waitFor(`document.querySelector('[data-take="${t3.id}"]').dataset.tier === 'pick'`, 4000, 'take 3 picked');
    await click('[data-shot="MOTION-E01-02"]');
    await waitFor("!!document.querySelector('#take-strip .take .stale')", 5000, 'the stale mark on shot 02');
    await waitFor("!!document.querySelector('#track .clip[data-shot=\"MOTION-E01-02\"] .stale')", 5000, 'the stale mark on the timeline');

    // timeline: shot 01 and 02 picked, shot 03 a gap; playing moves the playhead
    await waitFor("document.querySelectorAll('#track .clip').length === 3 && document.querySelector('#track .clip[data-shot=\"MOTION-E01-03\"]').dataset.kind === 'gap'", 5000, 'three clips with a gap for shot 03');
    await waitFor("!document.querySelector('#track .clip[data-shot=\"MOTION-E01-02\"] .link')", 3000, 'the link mark to go once shot 01 has another pick');
    await click('#btn-play');
    if (demoDir) {
      const rect = await js(`(() => {
        const screen = document.querySelector('.viewer .screen');
        const videos = [...screen.querySelectorAll('video')];
        const rect = screen.querySelector('canvas').getBoundingClientRect();
        const visible = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (visible !== screen.querySelector('canvas') || videos.length !== 2 ||
            videos.some(v => getComputedStyle(v).opacity !== '0' && v.clientWidth > 1)) return null;
        return rect.toJSON();
      })()`);
      if (!rect) return fail('timeline canvas must be visible with both decoders hidden');
      const center = { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2), width: 1, height: 1 };
      let sawBlue = false;
      let sawOrange = false;
      const deadline = Date.now() + 5000;
      while (!sawOrange && Date.now() < deadline) {
        const frame = await win.webContents.capturePage(center);
        const [blue, green, red] = frame.toBitmap();
        if (blue > red + 30) sawBlue = true;
        if (sawBlue && Math.max(red, green, blue) < 12) return fail('black frame between the two timeline videos');
        sawOrange = sawBlue && red > blue + 100;
      }
      if (!sawOrange) return fail('the timeline did not show the blue and orange videos in order');
    }
    await waitFor("document.getElementById('tl-time').textContent.trim().slice(0, 7) !== '00:00.0'", 6000, 'the playhead to move');
    await shot('shots-playing');
    await click('#btn-play');

    // ---- 素材: cards from the list, text- and image-to-image, keeping, the main picture, the shot import ----
    const readCard = (code) => {
      try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'assets', `${code}.json`), 'utf8')); } catch { return { takes: [], set: [] }; }
    };
    const donePictures = (n) => `document.querySelectorAll('#picture-strip .take[data-status="succeeded"]').length >= ${n}`;
    const freedBefore = comfy.state.freed;
    await click('#nav-assets');
    await waitFor("document.querySelectorAll('#card-rows .card-row').length === 1", 8000, 'one character card from the list');
    await click('[data-card="LX30"]');
    await waitFor("!!document.getElementById('asset-inspector') && document.getElementById('btn-enqueue-pics').textContent.includes('1')", 5000, 'card LX30 in the inspector');
    await typeInto('#pic-ask', '正面定妆，站在站台上');
    // a plain remark rewrites the wish, and the rewritten wish reaches the final prompt
    await typeInto('#pic-feedback', '让她稍微好看一点');
    await waitFor("!document.getElementById('btn-pic-revise').disabled", 2000, 'the picture AI rewrite button');
    await click('#btn-pic-revise');
    await waitFor("document.getElementById('pic-ask').value.includes('眉眼有神') && document.getElementById('pic-prompt').textContent.includes('眉眼有神')", 8000, 'the rewritten wish in the final prompt');
    await typeInto('#pic-count', '2');
    await waitFor("document.getElementById('btn-enqueue-pics').textContent.includes('2')", 2000, 'count 2 on the picture button');
    await click('#btn-enqueue-pics');
    await waitFor(donePictures(2), 20000, 'two finished pictures for LX30');
    const t2iGraph = comfy.state.prompts[comfy.state.prompts.length - 1].graph;
    if (!/写实电影质感[\s\S]*短发[\s\S]*正面定妆/.test(t2iGraph['4'].inputs.prompt)) return fail(`the text-to-image prompt is not style + look + wish: ${t2iGraph['4'].inputs.prompt}`);
    if (t2iGraph['5'].inputs.width !== 1140) return fail('a character card should default to 3:4 (1140 wide)');
    if (comfy.state.freed !== freedBefore + 1) return fail(`ComfyUI should be told to free memory once when pictures follow videos (freed ${comfy.state.freed - freedBefore} times)`);
    const [p1, p2] = readCard('LX30').takes;
    await click(`[data-take="${p1.id}"]`);
    await waitFor(`document.querySelector('[data-take="${p1.id}"]').classList.contains('on')`, 3000, 'picture 1 in the viewer');
    await click('#btn-pic-keep');
    await waitFor("!!document.getElementById('dialog-input')", 3000, 'the label question');
    await typeInto('#dialog-input', '正面定妆');
    await click('#dialog-ok');
    await waitFor("document.querySelectorAll('#kept-set .kept-pic.main').length === 1", 4000, 'the kept picture as main picture');
    if (readCard('LX30').main !== p1.image || readCard('LX30').set[0].label !== '正面定妆') return fail(`keeping did not set the main picture: ${JSON.stringify(readCard('LX30').set)}`);
    await click(`[data-take="${p2.id}"]`);
    await waitFor(`document.querySelector('[data-take="${p2.id}"]').classList.contains('on')`, 3000, 'picture 2 in the viewer');
    await click('#btn-pic-trash');
    await waitFor(`!document.querySelector('[data-take="${p2.id}"]')`, 4000, 'picture 2 gone from the strip');
    if (fs.existsSync(path.join(outputDir, p2.image))) return fail('trashing a picture must remove its file');
    await click('#pic-mode [data-value="i2i"]');
    await waitFor("!!document.getElementById('btn-base')", 3000, 'the base picture for image-to-image');
    await typeInto('#pic-ask', '同一个人，侧面 45°');
    await typeInto('#pic-count', '1');
    await waitFor("document.getElementById('btn-enqueue-pics').textContent.includes('1')", 2000, 'count 1 on the picture button');
    await click('#btn-enqueue-pics');
    await waitFor(donePictures(2), 20000, 'the image-to-image picture');
    const i2iGraph = comfy.state.prompts[comfy.state.prompts.length - 1].graph;
    if (i2iGraph['9'].inputs.image !== `${p1.image} [output]`) return fail(`image-to-image should start from the main picture: ${i2iGraph['9'].inputs.image}`);
    await shot('assets-char');
    await click('#card-kind [data-value="scene"]');
    await waitFor("!!document.querySelector('[data-card=\"DT-ZT\"].on') && !document.getElementById('btn-existing').disabled", 5000, 'scene card DT-ZT with a picture named after it');
    await click('#btn-existing');
    await waitFor("document.querySelectorAll('.c-modal .pick-grid button').length === 1", 3000, 'the one picture named DT-ZT_…');
    await click('.c-modal .pick-grid button');
    await waitFor("document.querySelectorAll('#kept-set .kept-pic.main').length === 1", 4000, 'the adopted picture as main picture');
    if (readCard('DT-ZT').main !== 'ref/DT-ZT_站台夜.png' || !fs.existsSync(path.join(outputDir, 'ref', 'DT-ZT_站台夜.png'))) return fail('adopting must keep the picture where and as it is');
    await shot('assets-scene');
    await click('#nav-shots');
    await click('[data-shot="MOTION-E01-01"]');
    await waitFor("document.getElementById('prompt').value.includes('台阶')", 5000, 'shot 01 again');
    await click('#btn-import-refs');
    await waitFor("document.querySelectorAll('#refs .ref img').length === 1", 5000, 'the card main picture as the reference');
    await wait(700);
    const imported = JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'shots', 'MOTION-E01-01.json'), 'utf8')).draft.values.references;
    if (imported.join() !== `${p1.image} [output]`) return fail(`the script import should hang LX30's main picture: ${JSON.stringify(imported)}`);

    // ---- 成片: the generated videos, the viewer, and a clip clean-up that leaves takes' files alone ----
    await click('#nav-gallery');
    await waitFor("document.querySelectorAll('#gal-grid .gal-card').length >= 3", 8000, 'generated videos on the 成片 page');
    await click('#gal-grid .gal-card');
    await waitFor("!!document.getElementById('gal-viewer')", 3000, 'the viewer');
    await shot('gallery-viewer');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await waitFor("!document.getElementById('gal-viewer')", 3000, 'the viewer to close on Escape');
    await shot('gallery');
    await click('#btn-gal-clips');
    await waitFor("!!document.getElementById('clip-sync')", 5000, 'the clip sync dialog');
    const offered = await js("[...document.querySelectorAll('#clip-sync .clip-box.bad .clip-row .n')].map((n) => n.textContent)");
    const owned = ['MOTION-E01-01', 'MOTION-E01-02'].flatMap(readTakes).filter((t) => t.tier !== 'trash' && t.context).map((t) => t.context);
    const bad = offered.filter((stem) => owned.includes(stem));
    if (bad.length) return fail(`clip sync offered continuation files that takes still use: ${bad.join(', ')}`);
    if (!offered.includes('clip_0101-000000_')) return fail(`clip sync should offer the orphan clip, offered ${offered.join(', ')}`);
    await shot('gallery-clips');
    await click('#btn-clips-trash');
    await waitFor("!document.getElementById('clip-sync')", 5000, 'the clip sync to finish');
    if (fs.existsSync(orphan)) return fail('clip sync did not remove the orphan clip');
    for (const stem of owned) if (!fs.existsSync(path.join(outputDir, 'h3_context', `${stem}.safetensors`))) return fail(`clip sync removed ${stem}, which a take owns`);

    // the old keep / un-keep still renames a legacy clip, and is not offered for the shot page's own videos
    if (await js("[...document.querySelectorAll('#gal-grid .gal-card')].some((c) => c.dataset.rel.includes('/bb_') && c.querySelector('.gal-keep'))")) {
      return fail('a shot-page video offers 保留为分镜');
    }
    await click(`[data-rel="${legacyVideo}"] .gal-keep`);
    await waitFor("!!document.getElementById('keep-shot')", 3000, 'the keep dialog');
    await typeInto('#keep-shot', '1-4');
    await click('#btn-keep-ok');
    const kept = path.join(outputDir, 'h3_context', 'clip_1-4.safetensors');
    await waitFor(`document.querySelector('[data-rel="${legacyVideo}"] .gal-keep').textContent.includes('1-4')`, 5000, 'the kept mark');
    if (!fs.existsSync(kept)) return fail('keeping a legacy video did not rename its clip to clip_1-4');
    await click(`[data-rel="${legacyVideo}"] .gal-keep`);
    await waitFor(`!document.querySelector('[data-rel="${legacyVideo}"] .gal-keep').textContent.includes('1-4')`, 5000, 'the kept mark to go');
    if (fs.existsSync(kept) || !fs.existsSync(path.join(outputDir, 'h3_context', 'clip_1026-090000_.safetensors'))) return fail('un-keeping did not give the clip its date name back');

    // media:// serves only media inside its folder, and answers byte ranges (how a video seeks)
    const firstVideo = readTakes('MOTION-E01-01').find((t) => t.tier === 'pick').video;
    const ranged = await net.fetch(`media://project/${firstVideo}`, { headers: { Range: 'bytes=0-9' } });
    if (ranged.status !== 206 || ranged.headers.get('content-length') !== '10') return fail(`media range request: ${ranged.status} ${ranged.headers.get('content-length')}`);
    for (const bad of ['media://project/../../outside.mp4', 'media://project/.blackbox/shots/MOTION-E01-01.json', 'media://project/%2e%2e/%2e%2e/x.mp4']) {
      const r = await net.fetch(bad);
      if (r.status !== 403 && r.status !== 404) return fail(`media:// served ${bad} (${r.status})`);
    }

    // the play-through levels each shot's sound through Web Audio: a video in CORS mode must load and its sound be readable
    const cors = await js(`new Promise((done) => {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.onloadedmetadata = () => fetch(v.src).then((r) => done(r.ok ? 'ok' : 'fetch ' + r.status), (e) => done('fetch ' + e.message));
      v.onerror = () => done('video error ' + (v.error && v.error.code));
      v.src = ${JSON.stringify(`media://project/${firstVideo}`)};
      setTimeout(() => done('timeout'), 8000);
    })`);
    if (cors !== 'ok') return fail(`a shot's video cannot be read in CORS mode (the play-through's sound levelling): ${cors}`);

    // ---- a prompt edited on the shot page lands in the script document ----
    const motionFile = path.join(projectDir, '剧本', 'MOTION-E01.md');
    await click('#nav-shots');
    await waitFor("document.querySelectorAll('#shot-rows .shot-row').length === 3", 5000, 'the shot list again');
    await click('[data-shot="MOTION-E01-03"]');
    await waitFor("document.getElementById('prompt').value.includes('列车进站')", 5000, 'shot 03 prompt');
    await typeInto('#prompt', '列车进站，强光掠过站台，林夏眯起眼。');
    await js("document.getElementById('prompt').blur()");
    const end = Date.now() + 5000;
    while (!fs.readFileSync(motionFile, 'utf8').includes('林夏眯起眼') && Date.now() < end) await wait(150);
    if (!fs.readFileSync(motionFile, 'utf8').includes('> 列车进站，强光掠过站台，林夏眯起眼。')) return fail('the edited prompt was not written back into the MOTION block');

    // ---- AI 改写: feedback in one line, the LLM's answer replaces the prompt and is written back ----
    await click('[data-shot="MOTION-E01-02"]');
    await waitFor("document.getElementById('prompt').value.includes('回头')", 5000, 'shot 02 prompt');
    await typeInto('#revise-feedback', '表情要害怕一点，镜头再近一些');
    await waitFor("!document.getElementById('btn-revise').disabled", 2000, 'the AI rewrite button');
    await click('#btn-revise');
    await waitFor("document.getElementById('prompt').value.includes('惊恐')", 8000, 'the rewritten prompt');
    const end2 = Date.now() + 5000;
    while (!fs.readFileSync(motionFile, 'utf8').includes('惊恐') && Date.now() < end2) await wait(150);
    if (!fs.readFileSync(motionFile, 'utf8').includes('> 她惊恐地回头，镜头推近到近景。')) return fail('the AI rewrite was not written back into the MOTION block');

    // ---- 新建镜头 with a description: the AI writes it; then it is deleted again ----
    await click('#btn-new-shot');
    await waitFor("!!document.getElementById('new-shot-description')", 3000, 'the new-shot dialog');
    await typeInto('#new-shot-description', '林夏望向隧道深处');
    await waitFor("document.getElementById('btn-new-shot-ok').textContent.includes('AI')", 2000, 'the AI new-shot button');
    await click('#btn-new-shot-ok');
    await waitFor("document.querySelectorAll('#shot-rows .shot-row').length === 4 && document.getElementById('prompt').value.includes('turns toward the tunnel')", 8000, 'the shot the AI wrote');
    const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'manual-shots.json'), 'utf8')).shots;
    if (written.length !== 1 || written[0].title !== '望向隧道') return fail(`the AI shot was not made with its title: ${JSON.stringify(written)}`);
    if (Number(await js("document.querySelector('#shot-rows .shot-row.on').previousElementSibling?.dataset.shot === 'MOTION-E01-02' ? 1 : 0")) !== 1) return fail('the AI shot is not right after the selected shot');
    await click('#btn-delete-shot'); // the smoke run answers the question itself
    await waitFor("document.querySelectorAll('#shot-rows .shot-row').length === 3", 5000, 'the shot deleted');
    if (JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'manual-shots.json'), 'utf8')).shots.length) return fail('the deleted shot is still listed');

    // ---- 剧本: preview, edit, save, external change, unsaved guard ----
    await click('#nav-script');
    await waitFor("document.querySelectorAll('#doc-list .doc-item').length >= 2", 5000, 'the documents of the project');
    await click('[data-doc="MOTION-E01.md"]');
    await waitFor("(document.getElementById('doc-preview') || {}).textContent?.includes('林夏眯起眼')", 5000, 'the preview with the written-back prompt');
    await shot('script-preview');
    await click('#doc-mode [data-value="edit"]');
    await waitFor("!!document.getElementById('doc-editor')", 3000, 'the editor');
    const original = fs.readFileSync(motionFile, 'utf8');
    await typeInto('#doc-editor', `${original}\n<!-- smoke -->\n`);
    await waitFor("!!document.getElementById('doc-dirty')", 3000, 'the unsaved mark');
    await shot('script-edit');
    await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))");
    await waitFor("!document.getElementById('doc-dirty')", 5000, 'Ctrl+S to save');
    if (!fs.readFileSync(motionFile, 'utf8').includes('<!-- smoke -->')) return fail('saving did not write the document');
    // someone else changes the file while there is unsaved text: the save must not overwrite it
    await typeInto('#doc-editor', `${original}\n<!-- mine -->\n`);
    fs.writeFileSync(motionFile, `${original}\n<!-- theirs -->\n`);
    await click('#btn-doc-save');
    await waitFor("!!document.getElementById('doc-notice')", 5000, 'the conflict notice');
    if (!fs.readFileSync(motionFile, 'utf8').includes('<!-- theirs -->')) return fail('a conflicting save overwrote the file');
    // leaving with unsaved text asks first
    await click('#nav-shots');
    await waitFor("!!document.getElementById('dialog')", 3000, 'the unsaved-changes question');
    await click('#dialog [data-choice="discard"]');
    await waitFor("!!document.querySelector('.shots')", 5000, 'the shot page after discarding');

    // ---- 剧本 · AI 讨论: a question, an edit applied to its document and undone, the shots it names ----
    const worldFile = path.join(projectDir, '剧本', '01_世界观.md');
    await click('#nav-script');
    await waitFor("!!document.getElementById('btn-script-chat')", 5000, 'the AI discussion button');
    await click('#btn-script-chat');
    await waitFor("!!document.getElementById('script-chat') && document.getElementById('btn-chat-docs')?.textContent.includes('篇')", 5000, 'the discussion panel');
    await typeInto('#chat-text', '那扇门能不能早点出现？');
    await click('#btn-chat-send');
    await waitFor("!!document.querySelector('#script-chat .chat-edit .btn-apply')", 8000, 'the proposed edit');
    await shot('script-chat');
    await click('#script-chat .chat-edit .btn-apply');
    await waitFor("!!document.querySelector('#script-chat .chat-edit.applied')", 5000, 'the edit marked as applied');
    if (!fs.readFileSync(worldFile, 'utf8').includes('锈死的铁门')) return fail('an applied edit did not reach its document');
    await js("[...document.querySelectorAll('#script-chat .chat-edit button')].find((b) => b.textContent === '撤销').click()");
    await waitFor("!document.querySelector('#script-chat .chat-edit.applied')", 5000, 'the edit undone');
    if (fs.readFileSync(worldFile, 'utf8').includes('锈死')) return fail('undo did not put the document back');
    await click('#script-chat .btn-shots');
    await waitFor("!!document.getElementById('linked-edits') && document.getElementById('linked-edits').textContent.includes('镜头 02')", 5000, 'the shots to change');
    await js("[...document.querySelectorAll('#linked-edits button')].find((b) => b.textContent.includes('先不改')).click()");
    await waitFor("!document.getElementById('linked-edits')", 5000, 'the shots dialog closed');
    const talked = JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'script-chat.json'), 'utf8'));
    if (talked.messages.length !== 2 || !talked.messages[1].shotsDone) return fail('the discussion was not kept with the project');
    if (!JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'link-notes.json'), 'utf8')).notes['MOTION-E01-02']) return fail('a shot left unchanged got no note');
    await click('#btn-script-chat');

    // ---- 剧本 · 拆分镜: a script document into cards and shots, prompts written, documents made ----
    await click('#btn-breakdown');
    await waitFor("!!document.getElementById('btn-bd-start')", 5000, 'the breakdown dialog');
    await js("[...document.querySelectorAll('#breakdown .bd-docs label')].find((l) => l.textContent.includes('01_世界观')).querySelector('input').click()");
    await shot('breakdown-pick');
    await click('#bd-grain [data-value="coarse"]');
    await click('#btn-bd-start');
    await waitFor("!!document.getElementById('btn-bd-write') && document.querySelectorAll('#breakdown .bd-shot').length === 3", 10000, 'the shot list to review');
    // the first two shots made one: both descriptions, both lengths, the person before the place
    await click('#breakdown .bd-shot .bd-merge');
    await waitFor("document.querySelectorAll('#breakdown .bd-shot').length === 2", 3000, 'two shots merged into one');
    await shot('breakdown-review');
    await click('#btn-bd-write');
    await waitFor("!!document.querySelector('#dialog [data-choice=\"ok\"]')", 3000, 'the question before writing');
    await click('#dialog [data-choice="ok"]');
    await waitFor("(document.getElementById('breakdown') || {}).textContent?.includes('都写好了')", 15000, 'every shot written');
    await shot('breakdown-done');
    const splitDoc = path.join(projectDir, '剧本', '分镜', 'MOTION-E02.md');
    const split = fs.existsSync(splitDoc) ? fs.readFileSync(splitDoc, 'utf8') : '';
    if (!split.includes('## MOTION-E02-002 · 看见铁门') || !split.includes('> subject_definitions:') || !split.includes('- 接续上一镜：是')) return fail(`the split episode document is not what the shot page reads:\n${split}`);
    if (!fs.readFileSync(path.join(projectDir, '剧本', '人物与场景（AI 拆分）.md'), 'utf8').includes('| LZ | 老周 |')) return fail('the new cards did not reach their list');
    if (!split.includes('- 时长：') || !split.includes('- 剧情：远景，老周提着检修灯走进隧道。 远景，老周往隧道深处走。')) return fail(`the merged shot is not in the episode document:\n${split}`);
    const splitPlan = JSON.parse(fs.readFileSync(path.join(projectDir, '.blackbox', 'breakdown.json'), 'utf8'));
    if (splitPlan.granularity !== 'coarse' || splitPlan.episodes[0].shots[0].cast.join() !== 'LZ,S-SD') return fail(`the plan lost the granularity or the merged cast order: ${splitPlan.granularity} ${splitPlan.episodes[0].shots[0].cast}`);
    await js("[...document.querySelectorAll('#breakdown footer button')].find((b) => b.textContent.includes('清除')).click()");
    await waitFor("!!document.getElementById('btn-bd-start')", 5000, 'the breakdown cleared');
    await js("[...document.querySelectorAll('#breakdown footer button')].find((b) => b.textContent === '取消').click()");
    await waitFor("!document.getElementById('breakdown')", 3000, 'the breakdown dialog closed');
    // the rest of the run expects the project as it was
    fs.rmSync(path.join(projectDir, '剧本', '分镜'), { recursive: true, force: true });
    fs.rmSync(path.join(projectDir, '剧本', '人物与场景（AI 拆分）.md'), { force: true });

    // ---- 场景: the whitebox drawn, a change asked of the AI shown before it is applied, camera shots saved ----
    const sceneFile = path.join(projectDir, '白模', '地铁站.scene.json');
    await click('#nav-scene');
    await waitFor("!!document.querySelector('#scene-page canvas') && !!document.querySelector('[data-scene=\"地铁站\"].on')", 8000, 'the scene drawn');
    await shot('scene');
    await typeInto('#scene-remark', '长椅挪到站台中间');
    await click('#btn-scene-ask');
    await waitFor("!!document.getElementById('scene-proposal')", 8000, 'the proposed change');
    if (JSON.parse(fs.readFileSync(sceneFile, 'utf8')).rooms[1].furniture[0].x[0] !== 2) return fail('a proposal was saved before it was applied');
    await click('#btn-scene-apply');
    await waitFor("!document.getElementById('scene-proposal')", 5000, 'the change applied');
    if (JSON.parse(fs.readFileSync(sceneFile, 'utf8')).rooms[1].furniture[0].x[0] !== 9) return fail('an applied change did not reach the scene file');
    if (!fs.readdirSync(path.join(projectDir, '白模', '.history', '地铁站')).length) return fail('the replaced scene was not kept in its history');
    await click('#btn-scene-shots');
    const shotFile = path.join(projectDir, 'ref', 'DT-BM1_闸机口看站台.png');
    const until2 = Date.now() + 5000;
    while (!fs.existsSync(shotFile) && Date.now() < until2) await wait(150);
    if (!fs.existsSync(shotFile) || fs.statSync(shotFile).size < 2000) return fail('the camera shot was not saved as a reference image');

    // blocking: the AI lays out shot 02, the page says what its camera sees, the shot page shows it
    await click('.scene-tabs [data-value="blocking"]');
    await typeInto('#blk-name', '站台');
    await js(`(() => { const el = document.getElementById('blk-room'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '站台'); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await typeInto('#blk-shots', 'E01-02');
    await click('#btn-scene-block');
    await waitFor("!!document.getElementById('btn-blocking-apply') && (document.getElementById('scene-facts') || {}).textContent.includes('林夏：画面中间')", 8000, 'the proposed blocking with what its camera sees');
    await shot('scene-blocking');
    await click('#btn-blocking-apply');
    await waitFor("!document.getElementById('btn-blocking-apply')", 5000, 'the blocking applied');
    const setups = JSON.parse(fs.readFileSync(sceneFile, 'utf8')).setups || [];
    if (!setups.length || setups[0].name !== '站台' || setups[0].room !== '站台') return fail('the applied blocking did not reach the scene file');
    await click('#nav-shots');
    await click('[data-shot="MOTION-E01-02"]');
    await waitFor("!!document.getElementById('blocking-facts')?.textContent?.includes('林夏')", 8000, 'the blocking on the shot page');

    // ---- 设置: every tab, the project card, the LLM test ----
    await click('#nav-settings');
    for (const [tab, check] of [
      ['run', "document.getElementById('run-state').textContent.includes('运行中')"],
      ['projects', "document.querySelector('#tab-projects .proj-card.active h3').textContent.includes('地铁惊魂')"],
      ['dirs', "document.querySelector('#tab-dirs .path').textContent.includes('output')"],
      ['models', "document.getElementById('tab-models').textContent.includes('minimax_h3_turbo_v4_step600_ema')"],
      ['general', "document.getElementById('workdir').value.length > 0"],
    ]) {
      await click(`#set-tab-${tab}`);
      await waitFor(`!!document.getElementById('tab-${tab}') && (${check})`, 6000, `settings tab ${tab}`);
      await shot(`settings-${tab}`);
    }
    // the usage card: the price table from DeepSeek's list, editable, and saved where the usage log lives
    await waitFor("!!document.querySelector('#llm-usage .usage-table') && document.getElementById('llm-usage').textContent.includes('deepseek-v4-pro')", 5000, 'the LLM usage card');
    await typeInto('#llm-usage tbody tr:first-child input.price', '0.03');
    await click('#btn-prices-save');
    const priceFile = path.join(h.app.getPath('userData'), 'llm-prices.json');
    const priceUntil = Date.now() + 4000;
    while (!fs.existsSync(priceFile) && Date.now() < priceUntil) await wait(150);
    if (!fs.existsSync(priceFile) || JSON.parse(fs.readFileSync(priceFile, 'utf8')).models[0].hit[0] !== 0.03) return fail('the edited price was not saved');
    await click('#btn-llm-test');
    await waitFor("!!document.getElementById('llm-status')", 6000, 'the LLM test result');
    // the key is kept by the system's secure storage: never in the config, never in plain text
    const secret = 'sk-smoke-do-not-leak-12345';
    await typeInto('#llm-api-key', secret);
    await click('#btn-llm-save');
    await waitFor("document.getElementById('llm-key-status').textContent.includes('已配置')", 5000, 'the key marked as set');
    const configFile = path.join(h.app.getPath('temp'), `cl-smoke-${process.pid}.json`);
    const secrets = path.join(h.app.getPath('userData'), 'secrets.json');
    if (fs.readFileSync(configFile, 'utf8').includes(secret)) return fail('the API key ended up in config.json');
    if (fs.existsSync(secrets) && fs.readFileSync(secrets, 'utf8').includes(secret)) return fail('the API key is stored in plain text');
    // settings are saved as typed
    await typeInto('#reserve-vram', '3');
    const until = Date.now() + 4000;
    while (JSON.parse(fs.readFileSync(configFile, 'utf8')).flags.reserveVram !== 3 && Date.now() < until) await wait(150);
    if (JSON.parse(fs.readFileSync(configFile, 'utf8')).flags.reserveVram !== 3) return fail('a changed setting was not saved to the config file');

    // ---- switching project from the top bar reloads the shot page (same shot ids, different project) ----
    await click('#nav-shots');
    await click('[data-shot="MOTION-E01-01"]');
    await waitFor("document.getElementById('prompt').value.includes('台阶')", 5000, 'project A shot 01');
    await click('#project-pick');
    await waitFor("!!document.getElementById('project-menu')", 3000, 'the project menu');
    await js("[...document.querySelectorAll('#project-menu button')].find((b) => b.textContent.includes('第二部')).click()");
    await waitFor("document.getElementById('prompt').value.includes('第二部')", 6000, "project B's shot 01 after switching");
    await waitFor("document.querySelectorAll('#take-strip .take').length === 0", 3000, "no takes of project A left on screen");

    await shot('shell');
    if (demoDir) { // the smallest window the app allows
      win.setContentSize(1280, 800);
      await wait(600);
      await shot('shots-1280');
      win.setContentSize(1440, 900);
    }
    // Use the real form, IPC, storage and progress polling with only the external services replaced.
    const cloud = require('./src/cloud-onboarding');
    const autodl = require('./src/autodl-setup');
    const check = require('node:assert/strict');
    const samplePassword = 'smoke-instance-only';
    const sampleKey = 'sk-smoke-welcome';
    const runId = 'c'.repeat(32);
    const imageBytes = fs.readFileSync(path.join(FIXTURES, 'media', 'sample.png'));
    let ready = false;
    let stalled = 4;
    let launches = 0;
    let chatChecks = 0;
    const selfcheck = require('./src/setup-selfcheck');
    const runSelfcheck = selfcheck.run;
    // Real local Comfy HTTP endpoints and an isolated reply in place of the paid chat API.
    selfcheck.run = (options) => runSelfcheck({ ...options, probeGpu: () => selfcheck.checkGpu(comfyPort),
      probeChat: (llm, key) => selfcheck.checkChat(llm, key, async () => {
        check.equal(key, sampleKey);
        if (++chatChecks === 1) throw new Error('LLM API HTTP 402');
        return { content: 'OK' };
      }) });
    cloud.verifyDeepSeek = async (key) => { check.equal(key, sampleKey); return cloud.DEEPSEEK; };
    cloud.connectInstance = async (server, password) => {
      check.equal(password, samplePassword);
      check.equal(server.host, 'smoke.seetacloud.com');
      return { ...server, host: '127.0.0.1' };
    };
    autodl.launch = async (_server, _root, plan) => { check.equal(plan.profile, 'image'); launches++; };
    autodl.status = async () => ready ? {
      status: 'ready', phase: 'transfer', file: 'ref/bbt_acceptance_' + runId + '_00001.png', run: runId,
      sha256: require('node:crypto').createHash('sha256').update(imageBytes).digest('hex'), bytes: imageBytes.length, video: false,
    } : { status: 'running', phase: 'models', video: false, message: '正在下载测试模型', since: Date.now() / 1000 - 600,
      download: { total: 8 * 2 ** 30, saved: 2 * 2 ** 30, rate: 8 * 2 ** 20, updated: Date.now() / 1000 },
      activity: { label: '下载 Python 依赖', detail: 'opencv_python_headless（63.7 MB）', bytes: 780 * 2 ** 20, rate: 500 * 1024,
        updated: Date.now() / 1000 - stalled, clock: Date.now() / 1000 } };
    const reload = () => new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.reload();
    });
    setConfig({ cloudWelcome: 'pending' });
    await reload();
    await waitFor("!!document.getElementById('onboard-cloud') && !document.getElementById('nav-settings')", 6000, 'first run opens the setup steps instead of the workspace');
    check.equal(await js("!!document.getElementById('set-tab-welcome')"), false);
    await shot('cloud-welcome');
    await click('#onboard-cloud');
    await waitFor("!!document.getElementById('welcome-login')", 3000, 'the instance step');
    await typeInto('#welcome-login', 'ssh -p 1 root@smoke.seetacloud.com');
    await typeInto('#welcome-password', samplePassword);
    await shot('cloud-welcome-instance');
    await click('#onboard-next');
    await waitFor("!!document.getElementById('welcome-key')", 3000, 'the DeepSeek step');
    await typeInto('#welcome-key', sampleKey);
    await click('#onboard-next');
    await waitFor("!!document.querySelector('#tab-welcome select')", 3000, 'the start step');
    await js("const profileSelect = document.querySelector('#tab-welcome select'); profileSelect.value = 'image'; profileSelect.dispatchEvent(new Event('change', { bubbles: true }))");
    await shot('cloud-welcome-start');
    await click('#welcome-install');
    await waitFor("document.querySelector('.setup-progress')?.textContent.includes('25%') && !!document.querySelector('.shutdown-plan')", 8000, 'one click starts the remote job and shows a download estimate');
    check.equal(launches, 1);
    check.equal(await js("!!document.getElementById('guide')"), true, 'the guide opens once the setup steps hand over to the workspace');
    await waitFor("/opencv_python_headless/.test(document.getElementById('setup-activity')?.textContent) && /780 MB · 500 KB\\/s · 刚刚有进展/.test(document.getElementById('setup-activity').textContent) && /本阶段已进行 10 分钟/.test(document.querySelector('.setup-elapsed')?.textContent)", 8000, 'what the installer is fetching, how fast and for how long');
    check.equal(await js("!!document.querySelector('#autodl-setup [role=alert]')"), false);
    stalled = 400;
    await waitFor("/已经 6 分钟没有任何进展/.test(document.querySelector('#autodl-setup [role=alert]')?.textContent)", 12000, 'a stalled install says so and how to stop paying');
    await click('#nav-guide');
    check.ok(!fs.readFileSync(configFile, 'utf8').includes(samplePassword));
    check.ok(!fs.readFileSync(configFile, 'utf8').includes(sampleKey));
    await shot('cloud-download');
    await reload();
    await waitFor("document.querySelector('.shutdown-plan') && document.querySelector('#tab-remote select')?.value === 'image'", 5000, 'reopen the same installation and workflow');
    const previewDir = path.join(h.app.getPath('userData'), 'autodl-previews');
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, runId + '.png'), imageBytes);
    await click('#nav-script');
    ready = true;
    await waitFor("window.launcher.getConfig().then(({config}) => config.setupReports?.[config.target]?.ok === false)", 20000, 'default self-check runs away from settings');
    check.equal(h.getConfig().cloudWelcome, 'watch');
    await click('#nav-settings');
    await click('#set-tab-remote');
    await waitFor("document.querySelector('.check-report')?.textContent.includes('余额不足')", 6000, 'partial readiness and repair instructions');
    await reload();
    await waitFor("!!document.getElementById('btn-setup-retest')", 6000, 'stored report after reopening');
    check.equal(chatChecks, 1);
    await click('#btn-setup-retest');
    await waitFor("document.querySelector('.setup-progress')?.textContent.includes('已完成全部阶段') && !!document.querySelector('#tab-remote img')", 13000, 'retest succeeds without reinstalling');
    check.equal(chatChecks, 2);
    await shot('cloud-selfcheck');
    check.equal(h.getConfig().cloudWelcome, 'complete');
    check.equal(launches, 1);
    report('SMOKE OK');
    h.app.exit(0);
  } catch (e) {
    fail(e && e.stack ? e.stack : String(e));
  } finally {
    for (const s of servers) s.close();
  }
  return undefined;
}

module.exports = { runSmoke };
