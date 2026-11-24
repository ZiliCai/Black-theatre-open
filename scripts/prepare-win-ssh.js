// Stage only the client and its support files in the installer. No system OpenSSH service is installed.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const release = '10.4.0.0p1-Preview';
const digest = 'b67ff8becd203502190ec42ac7787c24c2cd3325ed7700485fe7a1c83d2a7957';
const url = 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/' + release + '/OpenSSH-Win64.zip';
const files = ['ssh.exe', 'libcrypto.dll', 'ssh-sk-helper.exe', 'ssh-pkcs11-helper.exe', 'LICENSE.txt', 'NOTICE.txt'];
const cache = path.join(__dirname, '..', '.pack-cache');
const archive = path.join(cache, 'OpenSSH-Win64-' + release + '.zip');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function prepare() {
  await fs.mkdir(cache, { recursive: true });
  const saved = await fs.readFile(archive).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  if (!saved || hash(saved) !== digest) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('OpenSSH 下载失败，HTTP ' + response.status);
    const data = Buffer.from(await response.arrayBuffer());
    if (hash(data) !== digest) throw new Error('OpenSSH 压缩包 SHA-256 校验失败');
    await fs.writeFile(archive, data);
  }
  const entries = files.map((name) => 'OpenSSH-Win64/' + name);
  if (process.platform === 'linux') {
    execFileSync('unzip', ['-o', archive, ...entries, '-d', cache], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', archive, '-C', cache, ...entries], { stdio: 'inherit' });
  }
}

prepare().catch((error) => { console.error(error.message); process.exitCode = 1; });
