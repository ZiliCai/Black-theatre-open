// The SSH tunnel to a remote server's ComfyUI: one ssh process forwarding a free local port, watched and
// reconnected after it drops. Everything that touches the system is injected (see test/remote-tunnel.test.js).
const net = require('node:net');
const { spawn: realSpawn } = require('node:child_process');
const { sshExecutable, tunnelArgs, commandArgs, explainSsh } = require('./remote-servers');

const RETRY_MS = [2000, 5000, 10000, 30000];
const OPEN_WAIT_MS = 20000;
// these do not fix themselves: retrying would only fail the same way again
const GIVE_UP = new Set(['auth', 'hostkey', 'nossh']);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// true once something accepts connections on the local end
function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const serverKey = (s) => (s ? [s.id, s.host, s.port, s.user, s.keyFile, s.comfyPort].join('|') : '');

function createTunnel({
  spawn = realSpawn, pickPort = freePort, probe = canConnect, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onChange = () => {}, retryMs = RETRY_MS, openWaitMs = OPEN_WAIT_MS,
} = {}) {
  let server = null;
  let child = null;
  let port = null;
  let retryTimer = null;
  let attempts = 0;
  let generation = 0; // bumps on every open/close, so a late exit of an old ssh is ignored
  let state = { state: 'off', kind: '', message: '', port: null, serverId: '', since: now() };

  const set = (patch) => {
    state = { ...state, ...patch, port, serverId: server ? server.id : '', since: now() };
    onChange(state);
  };

  function scheduleRetry(gen) {
    const wait = retryMs[Math.min(attempts, retryMs.length - 1)];
    attempts += 1;
    retryTimer = setTimer(() => { if (gen === generation) connect(gen); }, wait);
    if (retryTimer && retryTimer.unref) retryTimer.unref();
  }

  async function connect(gen) {
    retryTimer = null;
    try {
      port = await pickPort();
    } catch (e) {
      set({ state: 'down', kind: 'error', message: `找不到可用的本机端口:${e.message}` });
      return scheduleRetry(gen);
    }
    if (gen !== generation) return;
    set({ state: 'connecting', kind: '', message: '正在连接服务器…' });
    let stderr = '';
    let exited = false;
    let proc;
    try {
      proc = spawn(sshExecutable, tunnelArgs(server, port), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      stderr = e.message;
      exited = true;
    }
    if (proc) {
      child = proc;
      if (proc.stderr) proc.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-4000); });
      proc.on('error', (e) => { stderr += `\n${e.code || ''} ${e.message}`; });
      proc.on('exit', () => {
        exited = true;
        if (gen !== generation || child !== proc) return;
        child = null;
        const why = explainSsh(stderr);
        set({ state: 'down', ...why });
        if (!GIVE_UP.has(why.kind)) scheduleRetry(gen);
      });
    }
    if (exited) {
      const why = explainSsh(stderr);
      set({ state: 'down', ...why });
      if (!GIVE_UP.has(why.kind)) scheduleRetry(gen);
      return;
    }
    // the forward is set up once its local end accepts connections
    const until = now() + openWaitMs;
    while (!exited && gen === generation && now() < until) {
      if (await probe(port)) {
        if (exited || gen !== generation) return;
        attempts = 0;
        set({ state: 'open', kind: '', message: '' });
        return;
      }
      await sleep(300);
    }
    if (!exited && gen === generation) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  function stop() {
    generation += 1;
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
    }
    child = null;
    port = null;
  }

  return {
    // Use this server (null: none). The same server again keeps a working tunnel as it is.
    use(next) {
      if (serverKey(next) === serverKey(server) && state.state !== 'off') return;
      stop();
      server = next;
      attempts = 0;
      if (!server) {
        set({ state: 'off', kind: '', message: '' });
        return;
      }
      connect(generation);
    },
    // reconnect at once instead of waiting for the next retry
    retry() {
      if (!server) return;
      const s = server;
      stop();
      server = s;
      attempts = 0;
      connect(generation);
    },
    close() {
      stop();
      server = null;
      set({ state: 'off', kind: '', message: '' });
    },
    snapshot: () => state,
    port: () => (state.state === 'open' ? port : null),
  };
}

// Runs one command on the server. Never rejects: { ok, code, stdout, stderr, kind, message }.
function runRemote(server, command, { spawn = realSpawn, timeoutMs = 30000, input = null } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(sshExecutable, commandArgs(server, command), { windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: null, stdout, stderr: e.message, ...explainSsh(e.message) });
      return;
    }
    if (input !== null) {
      proc.stdin.on('error', () => {}); // SSH reports an early remote exit on stderr.
      proc.stdin.end(input);
    }
    const timer = setTimeout(() => { stderr += '\nConnection timed out'; try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (e) => { stderr += `\n${e.code || ''} ${e.message}`; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, code, stdout, stderr, kind: '', message: '' });
      // 255 is ssh itself failing; any other code is the command's own
      else if (code === 255 || code === null) resolve({ ok: false, code, stdout, stderr, ...explainSsh(stderr) });
      else resolve({ ok: false, code, stdout, stderr, kind: 'command', message: `服务器上的命令出错（退出码 ${code}）:${stderr.trim().split(/\r?\n/).pop() || ''}` });
    });
  });
}

module.exports = { createTunnel, runRemote, freePort, canConnect, RETRY_MS };
