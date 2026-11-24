const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { normalizeServer, validateServer, activeServer, tunnelArgs, commandArgs, explainSsh } = require('../src/remote-servers');
const { outputRefs, remapModels, pushInputs, historyFiles, pullOutputs } = require('../src/remote-sync');
const { createTunnel } = require('../src/remote-tunnel');
const { createRemoteTarget } = require('../src/remote-target');
const { createGenerationQueue } = require('../src/generation-queue');
const { createTakeStore } = require('../src/take-store');
const { loadConfig } = require('../src/config');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const SERVER = normalizeServer({ id: 's1', name: '云服务器', host: '10.0.0.2', port: 20598, user: 'u1', keyFile: 'C:\\k\\id', comfyPort: 8188 });

// ---------- profiles and ssh command lines ----------
test('a saved profile is cleaned up and checked', () => {
  const s = normalizeServer({ id: 'a', name: ' x ', host: 'h', port: '99999', user: 'u', comfyPort: 'abc', extra: 1, modelSwaps: { 'a.safetensors': 'b.safetensors', bad: 3 } });
  assert.equal(s.name, 'x');
  assert.equal(s.port, 22, 'an impossible port falls back to 22');
  assert.equal(s.comfyPort, 8188);
  assert.deepEqual(s.modelSwaps, { 'a.safetensors': 'b.safetensors' });
  assert.equal('extra' in s, false);
  assert.ok(validateServer(SERVER).ok);
  assert.ok(!validateServer(normalizeServer({ name: 'x', host: '-oProxyCommand=calc', user: 'u' })).ok, 'a host that ssh would read as an option is refused');
  assert.ok(!validateServer(normalizeServer({ name: 'x', host: 'h', user: 'u; rm' })).ok);
  assert.ok(!validateServer(normalizeServer({ name: 'x', host: 'h', user: 'u', keyFile: 'id_rsa' })).ok, 'a key file needs its full path');
});

test('the config picks the server to render on, or none', () => {
  assert.equal(activeServer({ target: 'local', servers: [SERVER] }), null);
  assert.equal(activeServer({ target: 'gone', servers: [SERVER] }), null);
  assert.equal(activeServer({ target: 's1', servers: [SERVER] }).host, '10.0.0.2');
});

test('a config naming a server that no longer exists renders locally', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify({ target: 'gone', servers: [{ id: 's1', name: 'x', host: 'h', user: 'u' }, { name: 'no id' }] }));
  const c = loadConfig(file);
  assert.equal(c.target, 'local');
  assert.equal(c.servers.length, 1);
  fs.writeFileSync(file, JSON.stringify({}));
  assert.deepEqual([loadConfig(file).target, loadConfig(file).servers], ['local', []]);
});

test('ssh never asks for a password and only forwards to the server itself', () => {
  const args = tunnelArgs(SERVER, 50123);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('127.0.0.1:50123:127.0.0.1:8188'));
  assert.deepEqual(args.slice(-1), ['u1@10.0.0.2']);
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', 'C:\\k\\id']);
  const run = commandArgs({ ...SERVER, keyFile: '' }, 'echo hi');
  assert.equal(run.includes('-i'), false, 'no key file: ssh uses its own default keys');
  assert.deepEqual(run.slice(-2), ['u1@10.0.0.2', 'echo hi']);
});

test('ssh errors become something the user can act on', () => {
  assert.equal(explainSsh('u@h: Permission denied (publickey,password).').kind, 'auth');
  assert.equal(explainSsh('ssh: connect to host h port 22: Connection timed out').kind, 'unreachable');
  assert.match(explainSsh('Connection refused').message, /没开机/);
  assert.equal(explainSsh('Host key verification failed.').kind, 'hostkey');
  assert.equal(explainSsh('bind [127.0.0.1]:5000: Address already in use').kind, 'port');
  assert.equal(explainSsh('').kind, 'error');
});

// ---------- files and model names ----------
const graph = () => ({
  1: { class_type: 'LoadImageOutput', inputs: { image: 'ref/YS-YK_前方的路.png [output]' } },
  2: { class_type: 'LoadImageOutput', inputs: { image: 'None [output]' } },
  3: { class_type: 'MiniMaxH3MotionContextPickLatent', inputs: { clip: 'h3_context/bb_a_1101-0101_.jpg [output]' } },
  4: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen\\qwen3vl_32b_nvfp4.safetensors' } },
  5: { class_type: 'VAELoader', inputs: { vae_name: 'H3/video_vae.safetensors' } },
  6: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'look.safetensors', model: ['5', 0] } },
  7: { class_type: 'UNETLoader', inputs: { unet_name: 'missing.gguf' } },
});

test('the files a graph reads from the output folder, with the latent beside a continuation picture', () => {
  assert.deepEqual(outputRefs(graph()).sort(), [
    'h3_context/bb_a_1101-0101_.jpg', 'h3_context/bb_a_1101-0101_.safetensors', 'ref/YS-YK_前方的路.png',
  ]);
});

test('model names are matched to what the server has', () => {
  const available = { text_encoders: ['qwen3vl_32b_int8.safetensors'], vae: ['video_vae.safetensors'], loras: ['look.safetensors'] };
  const r = remapModels(graph(), available, { 'qwen3vl_32b_nvfp4.safetensors': 'qwen3vl_32b_int8.safetensors' });
  assert.equal(r.graph[4].inputs.clip_name, 'qwen3vl_32b_int8.safetensors', 'the server stand-in');
  assert.equal(r.graph[5].inputs.vae_name, 'video_vae.safetensors', 'same file, other subfolder');
  assert.equal(r.graph[6].inputs.lora_name, 'look.safetensors');
  assert.deepEqual(r.graph[6].inputs.model, ['5', 0], 'links stay as they are');
  assert.deepEqual(r.missing, ['missing.gguf']);
  assert.equal(r.changes.length, 2);
  assert.equal(graph()[4].inputs.clip_name, 'qwen\\qwen3vl_32b_nvfp4.safetensors', 'the original graph is not touched');
});

function fakeFiles(remote = {}) {
  const calls = { uploads: [], downloads: [] };
  const api = {
    async outputSize(rel) { return rel in remote ? remote[rel].length : null; },
    async uploadOutput(rel, abs) { calls.uploads.push(rel); remote[rel] = fs.readFileSync(abs); },
    async downloadOutput(rel, abs) { calls.downloads.push(rel); fs.writeFileSync(abs, remote[rel]); },
  };
  return { api, calls, remote };
}

test('only what the server lacks, or has in another size, is uploaded', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  fs.mkdirSync(path.join(out, 'ref'));
  fs.mkdirSync(path.join(out, 'h3_context'));
  fs.writeFileSync(path.join(out, 'ref', 'YS-YK_前方的路.png'), 'picture');
  fs.writeFileSync(path.join(out, 'h3_context', 'bb_a_1101-0101_.jpg'), 'jpg');
  // the latent is not on this computer: left for ComfyUI to report
  const f = fakeFiles({ 'h3_context/bb_a_1101-0101_.jpg': Buffer.from('jpg'), 'ref/YS-YK_前方的路.png': Buffer.from('old') });
  const uploaded = await pushInputs({ graph: graph(), outputDir: out, api: f.api });
  assert.deepEqual(uploaded, ['ref/YS-YK_前方的路.png']);
  assert.equal(f.remote['ref/YS-YK_前方的路.png'].toString(), 'picture');
});

test('a finished run comes back to the same place, latent included', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  const outputs = {
    364: { gifs: [{ filename: 'bb_a_00001_.mp4', subfolder: 'video', type: 'output' }] },
    507: { images: [{ filename: 'bb_a_1101-0101_.jpg', subfolder: 'h3_context', type: 'output' }] },
    9: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
  };
  assert.deepEqual(historyFiles(outputs).sort(), ['h3_context/bb_a_1101-0101_.jpg', 'h3_context/bb_a_1101-0101_.safetensors', 'video/bb_a_00001_.mp4']);
  const f = fakeFiles({ 'video/bb_a_00001_.mp4': Buffer.from('video'), 'h3_context/bb_a_1101-0101_.jpg': Buffer.from('j'), 'h3_context/bb_a_1101-0101_.safetensors': Buffer.from('latent') });
  assert.equal((await pullOutputs({ outputs, outputDir: out, api: f.api })).length, 3);
  assert.equal(fs.readFileSync(path.join(out, 'video', 'bb_a_00001_.mp4'), 'utf8'), 'video');
  assert.equal(fs.existsSync(path.join(out, 'video', 'bb_a_00001_.mp4.part')), false);
  assert.deepEqual(await pullOutputs({ outputs, outputDir: out, api: f.api }), [], 'files already here are not fetched again');
});

test('a download that comes back short is thrown away', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  const f = fakeFiles({ 'video/v.mp4': Buffer.from('whole video') });
  f.api.downloadOutput = async (rel, abs) => fs.writeFileSync(abs, 'half');
  await assert.rejects(pullOutputs({ outputs: { 1: { gifs: [{ filename: 'v.mp4', subfolder: 'video', type: 'output' }] } }, outputDir: out, api: f.api }), /没下载完整/);
  assert.deepEqual(fs.readdirSync(path.join(out, 'video')), []);
});

// ---------- the tunnel ----------
function fakeSsh() {
  const spawned = [];
  const spawn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit('exit', null); };
    proc.fail = (text) => { proc.stderr.emit('data', Buffer.from(text)); proc.emit('exit', 255); };
    spawned.push({ cmd, args, proc });
    return proc;
  };
  return { spawn, spawned };
}

function tunnelHarness({ probeOk = false } = {}) {
  const ssh = fakeSsh();
  const timers = [];
  const states = [];
  let clock = 0;
  const tunnel = createTunnel({
    spawn: ssh.spawn, pickPort: async () => 50000 + ssh.spawned.length, probe: async () => probeOk,
    now: () => clock, sleep: async () => { clock += 300; await tick(); }, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {}, onChange: (s) => states.push(s), openWaitMs: 1000,
  });
  return { tunnel, ssh, timers, states };
}

test('the tunnel opens once its local end answers', async () => {
  const h = tunnelHarness({ probeOk: true });
  h.tunnel.use(SERVER);
  await tick(); await tick();
  assert.equal(h.ssh.spawned[0].cmd, 'ssh');
  assert.equal(h.tunnel.snapshot().state, 'open');
  assert.equal(h.tunnel.port(), 50000);
  h.tunnel.use(SERVER);
  assert.equal(h.ssh.spawned.length, 1, 'the same server again keeps the tunnel');
  h.tunnel.close();
  assert.equal(h.ssh.spawned[0].proc.killed, true);
  assert.equal(h.tunnel.port(), null);
});

test('an unreachable server is retried, a refused key is not', async () => {
  const h = tunnelHarness();
  h.tunnel.use(SERVER);
  await tick();
  h.ssh.spawned[0].proc.fail('ssh: connect to host 10.0.0.2 port 20598: Connection timed out');
  assert.equal(h.tunnel.snapshot().state, 'down');
  assert.equal(h.tunnel.snapshot().kind, 'unreachable');
  assert.equal(h.tunnel.port(), null);
  assert.equal(h.timers.length, 1);
  h.timers[0].fn();
  await tick(); await tick();
  assert.equal(h.ssh.spawned.length, 2, 'connected again');
  h.ssh.spawned[1].proc.fail('u1@10.0.0.2: Permission denied (publickey,password).');
  assert.equal(h.tunnel.snapshot().kind, 'auth');
  assert.equal(h.timers.length, 1, 'no retry: the same key would be refused again');
});

test('an ssh that never opens the forward is stopped and retried', async () => {
  const h = tunnelHarness({ probeOk: false });
  h.tunnel.use(SERVER);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(h.ssh.spawned[0].proc.killed, true);
  assert.equal(h.tunnel.snapshot().state, 'down');
  assert.equal(h.timers.length, 1);
});

// ---------- the remote target ----------
const fakeLink = (port) => ({ use() {}, retry() {}, close() {}, snapshot: () => ({ state: port ? 'open' : 'down', message: '' }), port: () => port });

test('remote rendering never falls back to the local ComfyUI', () => {
  let config = { port: 8188, target: 'local', servers: [SERVER] };
  const target = createRemoteTarget({ getConfig: () => config, tunnel: fakeLink(null) });
  assert.equal(target.port(), 8188);
  assert.equal(target.transfer(), null);
  config = { ...config, target: 's1' };
  assert.equal(target.port(), 0, 'the tunnel is down: nothing to talk to');
  assert.ok(target.transfer());
});

test('starting ComfyUI that an earlier click already started waits for it instead of failing', async () => {
  const config = { port: 8188, target: 's1', servers: [{ ...SERVER, startCommand: 'tmux new-session -d -s comfy run.sh' }] };
  let t = 0;
  let answers = false;
  const ran = [];
  const target = createRemoteTarget({
    getConfig: () => config, tunnel: fakeLink(50000),
    makeApi: () => ({ async systemStats() { if (!answers) throw new Error('refused'); return {}; } }),
    runRemote: async (s, cmd) => { ran.push(cmd); return { ok: false, code: 1, stdout: '', stderr: 'duplicate session: comfy', message: '服务器上的命令出错（退出码 1）:duplicate session: comfy' }; },
    now: () => t,
    sleep: async (ms) => { t += ms; if (t >= 30000) answers = true; },
  });
  const r = await target.startComfy();
  assert.equal(ran.length, 1);
  assert.equal(r.ok, true);

  // any other failure of the start command is still reported as it is
  const other = createRemoteTarget({
    getConfig: () => config, tunnel: fakeLink(50000),
    makeApi: () => ({ async systemStats() { throw new Error('refused'); } }),
    runRemote: async () => ({ ok: false, code: 127, stdout: '', stderr: 'tmux: command not found', message: '没有 tmux' }),
    now: () => 0, sleep: async () => {},
  });
  assert.deepEqual(await other.startComfy(), { ok: false, message: '没有 tmux' });
});

test('a take whose models the server lacks is refused before it is sent', async () => {
  const config = { port: 8188, target: 's1', servers: [{ ...SERVER, modelSwaps: { 'qwen3vl_32b_nvfp4.safetensors': 'qwen3vl_32b_int8.safetensors' } }] };
  const target = createRemoteTarget({ getConfig: () => config, tunnel: fakeLink(50000) });
  let listed = 0;
  const api = {
    async modelFolders() { listed++; return ['text_encoders', 'vae', 'loras']; },
    async models(folder) { return { text_encoders: ['qwen3vl_32b_int8.safetensors'], vae: ['video_vae.safetensors'], loras: ['look.safetensors'] }[folder]; },
    async outputSize() { return 1; },
  };
  const job = { workflow: graph(), outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-')) };
  await assert.rejects(target.transfer().prepare(job, api), /缺这些模型.*missing\.gguf/);
  assert.equal(listed, 2, 'the list is read again once before giving up');
  delete job.workflow[7];
  const { workflow } = await target.transfer().prepare(job, api);
  assert.equal(workflow[4].inputs.clip_name, 'qwen3vl_32b_int8.safetensors');
});

// ---------- the queue with a remote server ----------
function remoteQueue({ collectFails = 0 } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-'));
  const outputDir = path.join(projectDir, 'output');
  fs.mkdirSync(path.join(outputDir, 'video'), { recursive: true });
  const store = createTakeStore(projectDir);
  const state = { prompts: [], trackers: [], prepared: 0, collected: 0, collectFails };
  const api = {
    async systemStats() { return {}; },
    async prompt(graph) { state.prompts.push(graph); return { prompt_id: `p${state.prompts.length}` }; },
    async history() { return {}; },
    async queuePrompts() { return []; },
  };
  const remote = {
    async prepare(job) { state.prepared++; return { workflow: { ...job.workflow, remapped: true } }; },
    async collect(job) {
      if (state.collectFails > 0) { state.collectFails--; throw new Error('ECONNRESET'); }
      state.collected++;
      fs.writeFileSync(path.join(job.outputDir, 'video', `${job.outputKey}_00001_.mp4`), 'v');
    },
  };
  const queue = createGenerationQueue({
    apiFactory: () => api, trackerFactory: (o) => { state.trackers.push(o); return { close() {} }; }, getPort: () => 50000,
    getRemote: () => remote, readMediaMeta: () => ({ duration: 4.5 }), historyEveryMs: 3600000,
  });
  const take = store.addTake('MOTION-E01-01', { status: 'queued' });
  const job = { kind: 'video', projectDir, outputDir, shotId: 'MOTION-E01-01', takeId: take.id, outputKey: take.outputKey, workflow: { 1: { inputs: {} } } };
  const takeOf = () => store.readShot('MOTION-E01-01').takes[0];
  const succeed = () => state.trackers[state.trackers.length - 1].onEvent({ type: 'execution_success', data: { prompt_id: 'p1' } });
  return { queue, state, job, takeOf, succeed };
}

test('a remote take sends the prepared graph and counts as done only once its files are here', async () => {
  const h = remoteQueue();
  h.queue.enqueue([h.job]);
  await tick(); await tick();
  assert.equal(h.state.prepared, 1);
  assert.equal(h.state.prompts[0].remapped, true);
  h.state.trackers[0].onEvent({ type: 'executed', data: { prompt_id: 'p1', node: '364', output: { gifs: [{ filename: 'x.mp4', subfolder: 'video', type: 'output' }] } } });
  h.succeed();
  await tick(); await tick();
  assert.equal(h.state.collected, 1);
  const take = h.takeOf();
  assert.equal(take.status, 'succeeded');
  assert.equal(take.video, `video/${h.job.outputKey}_00001_.mp4`);
});

test('a fetch that fails holds the queue until 重试 fetches again', async () => {
  const h = remoteQueue({ collectFails: 1 });
  h.queue.enqueue([h.job]);
  await tick(); await tick();
  h.succeed();
  await tick(); await tick();
  const snap = h.queue.snapshot();
  assert.equal(snap.paused, true);
  assert.match(snap.message, /没能取回本机/);
  assert.equal(snap.jobs[0].status, 'fetching');
  assert.equal(h.takeOf().status, 'running', 'not failed: the video is still on the server');
  h.queue.retry();
  await tick(); await tick();
  assert.equal(h.takeOf().status, 'succeeded');
  assert.equal(h.queue.snapshot().jobs.length, 0);
});

test('a take the server cannot run fails and pauses the queue', async () => {
  const h = remoteQueue();
  h.queue = createGenerationQueue({
    apiFactory: () => ({ async systemStats() { return {}; } }), getPort: () => 50000,
    getRemote: () => ({ async prepare() { throw new Error('服务器上缺这些模型，先传上去再抽:x.gguf'); }, async collect() {} }),
  });
  h.queue.enqueue([h.job]);
  await tick(); await tick();
  assert.equal(h.takeOf().status, 'failed');
  assert.match(h.takeOf().error, /x\.gguf/);
  assert.equal(h.queue.snapshot().paused, true);
});

test('a continuation file the history does not list is found by the take name', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  const f = fakeFiles({ 'h3_context/bb_k1_1101-0102_.jpg': Buffer.from('j'), 'h3_context/bb_k1_1101-0102_.safetensors': Buffer.from('latent') });
  f.api.contextClips = async () => ['h3_context/bb_k10_1101-0103_.jpg [output]', 'h3_context/bb_k1_1101-0102_.jpg [output]', 'h3_context/bb_k1_1101-0101_.jpg [output]'];
  const fetched = await pullOutputs({ outputs: {}, outputDir: out, api: f.api, outputKey: 'bb_k1' });
  assert.deepEqual(fetched.sort(), ['h3_context/bb_k1_1101-0102_.jpg', 'h3_context/bb_k1_1101-0102_.safetensors'], 'the newest of its own, never another take whose name starts the same');
  f.api.contextClips = async () => { throw new Error('HTTP 404'); };
  assert.deepEqual(await pullOutputs({ outputs: {}, outputDir: out, api: f.api, outputKey: 'bb_k2' }), [], 'no Motion Context on the server');
});
