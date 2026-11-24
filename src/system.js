// Thin glue over Windows: netstat / tasklist / taskkill / spawn. Verified by test/integration.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseNetstatListener, parseTasklistMemMB } = require('./comfy-process');
const { buildArgs } = require('./args');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`${cmd} 退出码 ${err.code}`), { stdout, stderr }));
      resolve(stdout);
    });
  });
}

async function listenerPid(port) {
  return parseNetstatListener(await run('netstat', ['-ano', '-p', 'TCP']), port);
}

// Command line plus absolute executable path (the latter identifies relative-path launches).
async function processInfoOf(pid) {
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}';` +
    'if($p){@{commandLine=[string]$p.CommandLine;executablePath=[string]$p.ExecutablePath}|ConvertTo-Json -Compress}';
  try {
    const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
    const d = JSON.parse(out);
    return { commandLine: d.commandLine || '', executablePath: d.executablePath || '' };
  } catch {
    return { commandLine: '', executablePath: '' };
  }
}

// Always asks Windows. Used for anything destructive (stop).
async function probePort(port) {
  const pid = await listenerPid(port);
  if (pid === null) return null;
  return { pid, ...(await processInfoOf(pid)) };
}

// For the 3-second status poll: remembers the command line of the last listener pid only.
function createCachedProbe() {
  let last = null;
  return async (port) => {
    const pid = await listenerPid(port);
    if (pid === null) { last = null; return null; }
    if (!last || last.pid !== pid) last = { pid, ...(await processInfoOf(pid)) };
    return { ...last };
  };
}

// ComfyUI has to outlive us, so it cannot be a plain child. But a `detached` child gets no console at all,
// and then every console program ComfyUI runs gets a console window of its own: VideoHelperSuite runs
// ffmpeg twice per video (encode, then mux the audio), which flashed two black windows per take.
// Node cannot ask for a hidden console, so a one-line Python step starts ComfyUI with CREATE_NO_WINDOW
// (a console without a window, which ffmpeg inherits) plus CREATE_NEW_PROCESS_GROUP, prints its pid, exits.
const BOOTSTRAP =
  'import subprocess,sys\n' +
  "log=open(sys.argv[1],'ab'); log.seek(0,2)\n" +
  'p=subprocess.Popen(sys.argv[2:],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,creationflags=0x08000000|0x00000200)\n' +
  'print(p.pid)';

async function startComfy(config) {
  const python = path.join(config.workdir, 'python_embeded', 'python.exe');
  fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
  fs.appendFileSync(config.logPath, `\n===== [启动器] ${new Date().toLocaleString()} 启动 ComfyUI,端口 ${config.port} =====\n`);
  const child = spawn(python, ['-s', '-c', BOOTSTRAP, config.logPath, python, ...buildArgs(config)], {
    cwd: config.workdir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const pid = Number(out.trim());
  if (code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`python 退出码 ${code}:${err.trim() || out.trim() || '没有输出'}`);
  }
  return { pid };
}

async function killProcess(pid) {
  await run('taskkill', ['/PID', String(Number(pid)), '/T', '/F']);
}

async function waitPortFree(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if ((await listenerPid(port)) === null) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function memoryOfPid(pid) {
  return parseTasklistMemMB(await run('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH']));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = { probePort, createCachedProbe, startComfy, killProcess, waitPortFree, memoryOfPid, isAlive };
