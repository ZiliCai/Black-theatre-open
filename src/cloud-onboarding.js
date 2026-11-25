const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client, utils } = require('ssh2');
const { sshExecutable, commandArgs, explainSsh } = require('./remote-servers');

const exec = promisify(execFile);
// The only pages the renderer may open; the in-app guide links to these.
const LINKS = Object.freeze({
  instance: 'https://www.autodl.com/console/instance/list',
  deepseek: 'https://platform.deepseek.com/api_keys',
  autodl: 'https://www.autodl.com/',
  recharge: 'https://www.autodl.com/recharge',
  comfyui: 'https://github.com/comfyanonymous/ComfyUI/releases/tag/v0.37.0',
  pluginsDoc: 'https://github.com/ZiliCai/Black-theatre-open/tree/main/comfyui-plugins',
  modelsDoc: 'https://github.com/ZiliCai/Black-theatre-open/blob/main/docs/%E6%A8%A1%E5%9E%8B%E4%B8%8B%E8%BD%BD.md',
});
const DEEPSEEK = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

async function verifyDeepSeek(key, request = fetch) {
  if (typeof key !== 'string' || !/^sk-[A-Za-z0-9_-]+$/.test(key)) throw new Error('请从 DeepSeek 开放平台复制完整的 API Key。');
  let response;
  try {
    response = await request(DEEPSEEK.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000), redirect: 'error',
    });
  } catch { throw new Error('无法连接 DeepSeek 开放平台，请检查网络后重试。'); }
  if (response.status === 401 || response.status === 403) throw new Error('DeepSeek 拒绝了此 API Key，请检查密钥后重试。');
  if (!response.ok) throw new Error('DeepSeek 暂时无法验证密钥（HTTP ' + response.status + '）。');
  const catalog = await response.json().catch(() => null);
  const model = [DEEPSEEK.model, 'deepseek-v4-flash', 'deepseek-v4-pro'].find((name) =>
    Array.isArray(catalog?.data) && catalog.data.some((item) => item?.id === name));
  if (!model) throw new Error('此 API Key 的模型列表中没有受支持的 DeepSeek 模型。');
  return { ...DEEPSEEK, model };
}

function parseLogin(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts[0] !== 'ssh' || parts.length !== 4) throw new Error('请复制 AutoDL 实例的完整 SSH 登录指令，例如 ssh -p 12345 root@主机。');
  const portFirst = parts[1] === '-p';
  const address = portFirst ? parts[3] : parts[1];
  const portText = portFirst ? parts[2] : parts[3];
  const match = /^root@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:seetacloud\.com|autodl\.com))$/i.exec(address);
  if ((!portFirst && parts[2] !== '-p') || !match || !/^\d{1,5}$/.test(portText) || +portText < 1 || +portText > 65535) {
    throw new Error('请使用控制台提供的 root 登录指令，检查 AutoDL 主机名和端口。');
  }
  return { host: match[1].toLowerCase(), port: +portText, user: 'root' };
}

async function identity(directory, login) {
  const id = crypto.createHash('sha256').update(JSON.stringify([login.host, login.port, login.user])).digest('hex');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, id);
  let key;
  try { key = await fs.readFile(keyFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pair = utils.generateKeyPairSync('ed25519');
    // Publish the finished private key atomically. A retry can derive the public half from it.
    const tmp = keyFile + '.' + crypto.randomUUID();
    await fs.writeFile(tmp, '', { mode: 0o600, flag: 'wx' });
    try {
      // Windows ignores POSIX mode bits. Set an owner-only ACL before writing private bytes.
      if (process.platform === 'win32') {
        const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
        const sid = stdout.match(/S-1-(?:\d+-)+\d+/i)?.[0];
        if (!sid) throw new Error('无法确认当前 Windows 用户，未能创建 SSH 密钥。');
        await exec('icacls.exe', [tmp, '/inheritance:r', '/grant:r', '*' + sid + ':F'], { windowsHide: true });
      }
      await fs.writeFile(tmp, pair.private);
      try { await fs.link(tmp, keyFile); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    finally { await fs.unlink(tmp); }
    key = await fs.readFile(keyFile);
  }
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw new Error('本机的 AutoDL 专用密钥无法读取');
  return { keyFile, publicKey: parsed.type + ' ' + parsed.getPublicSSH().toString('base64') };
}

// The same OpenSSH known_hosts policy as the generation tunnel verifies the endpoint first.
// Bind the password exchange to the precise host key accepted by that probe.
async function probe(server, execute = exec) {
  // Win32 OpenSSH verbose logging can block on a Node pipe. Give it a short-lived native log file.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbt-hostkey-'));
  const log = path.join(directory, 'probe.log');
  try {
    await fs.writeFile(log, '', { mode: 0o600, flag: 'wx' });
    await execute(sshExecutable, ['-n', '-E', log, '-v', '-o', 'FingerprintHash=sha256', ...commandArgs(server, 'true')], { windowsHide: true, timeout: 25000 });
    return null;
  } catch (e) {
    const output = (await fs.readFile(log, 'utf8').catch(() => '')) + (e.stderr || '');
    const why = explainSsh(output || e.code);
    const key = /Server host key: ([\w@.-]+) SHA256:([\w+/]+)/.exec(output);
    if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Failed to add the host/i.test(output)) {
      throw new Error('SSH 主机身份校验失败，请在 Windows OpenSSH 中核对该实例的指纹。');
    }
    if (why.kind !== 'auth' || !key) throw new Error(why.kind === 'error' ? 'SSH 连接失败，请核对实例状态及登录指令。' : why.message);
    return { algorithm: key[1], fingerprint: key[2] };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function registerKey(server, pin, password, publicKey) {
  const command = 'set -eu; umask 077; mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; cd "$HOME/.ssh"; ' +
    'touch authorized_keys; chmod 600 authorized_keys; IFS= read -r key; ' +
    '(flock -x 9; grep -qxF -- "$key" authorized_keys || printf "\\n%s\\n" "$key" >> authorized_keys) 9>.blackbox-register.lock';
  return new Promise((resolve, reject) => {
    const client = new Client();
    let changed = false;
    const fail = (message) => { reject(new Error(message)); client.destroy(); };
    const timer = setTimeout(() => fail('SSH 登记超时，请检查实例后重试。'), 35000);
    client.once('close', () => { clearTimeout(timer); reject(new Error('SSH 连接在登记完成前断开，请重试。')); });
    client.on('error', (e) => fail(changed ? 'SSH 主机指纹已改变，请核对实例。' :
      e.level === 'client-authentication' ? 'SSH 密码验证失败，请重新复制实例密码。' : '无法连接实例并登记公钥，请检查 SSH 登录信息。'));
    client.once('ready', () => client.exec(command, (err, stream) => {
      if (err) return fail('实例未能启动公钥登记命令。');
      stream.resume();
      stream.stderr.resume();
      stream.on('error', () => fail('登记公钥时连接中断。'));
      stream.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return fail('写入实例的 SSH 公钥失败，请检查登录权限。');
        resolve();
        client.end();
      });
      stream.end(publicKey + '\n');
    }));
    const algorithms = pin.algorithm === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [pin.algorithm];
    client.connect({ host: server.host, port: server.port, username: server.user, password,
      algorithms: { serverHostKey: algorithms }, readyTimeout: 15000,
      hostVerifier(key) {
        changed = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '') !== pin.fingerprint;
        return !changed;
      } });
  });
}

async function connectInstance(login, password, directory, check = probe) {
  const { keyFile, publicKey } = await identity(directory, login);
  const server = { ...login, keyFile };
  const pin = await check(server);
  if (pin) {
    if (typeof password !== 'string' || !password) throw new Error('首次连接这台实例需要 SSH 密码，请从 AutoDL 控制台复制。');
    await registerKey(server, pin, password, publicKey);
    if (await check(server)) throw new Error('公钥已登记，但免密连接失败，请检查实例的 SSH 设置。');
  }
  return server;
}

module.exports = { LINKS, DEEPSEEK, verifyDeepSeek, parseLogin, connectInstance, identity, probe, registerKey };
