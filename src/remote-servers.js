// Remote GPU servers: the saved profiles, which one is in use, and the ssh command lines that reach them.
// Plain Node, no Electron. Passwords are never stored or typed: ssh runs with BatchMode and the user's own keys.
const path = require('node:path');

const NAME_PART = /^[A-Za-z0-9._-]+$/;
// a host name or address that ssh cannot mistake for an option
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;

const portOf = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
};

// One profile, from whatever was saved or typed: unknown fields dropped, wrong types replaced.
function normalizeServer(raw = {}) {
  const swaps = {};
  if (raw.modelSwaps && typeof raw.modelSwaps === 'object') {
    for (const [from, to] of Object.entries(raw.modelSwaps)) {
      if (typeof to === 'string' && from.trim() && to.trim()) swaps[from.trim()] = to.trim();
    }
  }
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    id: text(raw.id),
    name: text(raw.name),
    host: text(raw.host),
    port: portOf(raw.port, 22),
    user: text(raw.user),
    keyFile: text(raw.keyFile),
    comfyPort: portOf(raw.comfyPort, 8188),
    startCommand: typeof raw.startCommand === 'string' ? raw.startCommand.trim() : '',
    modelSwaps: swaps,
  };
}

function validateServer(server) {
  const errors = [];
  if (!server.name) errors.push('请给服务器起个名字');
  if (!server.host) errors.push('请填服务器地址');
  else if (!HOST.test(server.host)) errors.push(`服务器地址不对:${server.host}`);
  if (!server.user) errors.push('请填登录用户名');
  else if (!NAME_PART.test(server.user)) errors.push(`用户名只能有字母、数字和 . _ -:${server.user}`);
  if (server.keyFile && !path.win32.isAbsolute(server.keyFile)) errors.push(`钥匙文件要写完整路径:${server.keyFile}`);
  return { ok: errors.length === 0, errors };
}

// The server the config says to render on, or null when rendering stays on this computer.
function activeServer(config) {
  if (!config || !config.target || config.target === 'local') return null;
  const found = (config.servers || []).find((s) => s.id === config.target);
  return found ? normalizeServer(found) : null;
}

// Options shared by every ssh call: never ask for a password, give up on a dead link instead of hanging.
function sshBase(server) {
  return [
    '-p', String(server.port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...(server.keyFile ? ['-i', server.keyFile, '-o', 'IdentitiesOnly=yes'] : []),
  ];
}

const destination = (server) => `${server.user}@${server.host}`;

// ssh that only forwards localPort on this computer to ComfyUI's port on the server
function tunnelArgs(server, localPort) {
  return ['-N', '-o', 'ExitOnForwardFailure=yes', ...sshBase(server), '-L', `127.0.0.1:${localPort}:127.0.0.1:${server.comfyPort}`, destination(server)];
}

// ssh that runs one command on the server
function commandArgs(server, command) {
  return [...sshBase(server), destination(server), command];
}

// What went wrong, from ssh's error output, in words the user can act on.
function explainSsh(stderr) {
  const text = String(stderr || '');
  if (/Permission denied/i.test(text)) return { kind: 'auth', message: '服务器不认这把钥匙：先把钥匙登记到服务器（~/.ssh/authorized_keys），或者在设置里换一把钥匙' };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return { kind: 'hostkey', message: '服务器的身份和上次不一样（可能是实例重装过）：确认无误后，从 ~/.ssh/known_hosts 删掉这台服务器的旧记录' };
  }
  if (/timed out|No route to host|Network is unreachable|Connection refused|Connection reset|Could not resolve|Connection closed/i.test(text)) {
    return { kind: 'unreachable', message: '连不上服务器：实例可能没开机（到期会自动关机），或者地址、端口不对' };
  }
  if (/Address already in use|cannot listen|Could not request local forwarding/i.test(text)) return { kind: 'port', message: '本机端口被占用，正在换一个端口重试' };
  if (/not recognized|ENOENT|not found/i.test(text)) return { kind: 'nossh', message: '这台电脑上找不到 ssh：请在 Windows 设置 → 可选功能里装上“OpenSSH 客户端”' };
  const last = text.trim().split(/\r?\n/).filter(Boolean).pop();
  return { kind: 'error', message: last ? `SSH 出错:${last}` : 'SSH 连接断开了' };
}

module.exports = { normalizeServer, validateServer, activeServer, sshBase, tunnelArgs, commandArgs, explainSsh };
