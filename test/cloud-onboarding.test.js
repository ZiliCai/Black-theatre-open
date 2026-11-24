const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { Server, utils } = require('ssh2');
const { parseLogin, connectInstance, probe, registerKey, verifyDeepSeek } = require('../src/cloud-onboarding');

test('parse a copied AutoDL command as data', () => {
  const host = 'connect.example.seetacloud.com';
  for (const cmd of ['ssh -p 12345 root@' + host, 'ssh root@' + host + ' -p 12345']) {
    assert.deepEqual(parseLogin(cmd), { host, port: 12345, user: 'root' });
  }
  for (const cmd of ['ssh -p 0 root@' + host, 'ssh -p 65536 root@' + host,
    'ssh -p 22 root@' + host + '.other.test', 'ssh -p 22 root@' + host + ';id', 'ssh -oProxyCommand=x root@' + host]) {
    assert.throws(() => parseLogin(cmd));
  }
});

test('only send a DeepSeek key to the official model catalog and mask API errors', async () => {
  const key = 'sk-fixture';
  const config = await verifyDeepSeek(key, async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, 'Bearer ' + key);
    return Response.json({ data: [{ id: 'deepseek-flash' }] });
  });
  assert.equal(config.model, 'deepseek-flash');
  await assert.rejects(verifyDeepSeek('wrong field', () => assert.fail()), /请从 DeepSeek/);
  await assert.rejects(verifyDeepSeek(key, () => new Response(key, { status: 401 })), (e) => !e.message.includes(key) && /拒绝/.test(e.message));
  await assert.rejects(verifyDeepSeek(key, () => Response.json({ data: [] })), /模型列表/);
});

test('first password login enrolls a per-instance key and the next native SSH login needs no password', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbt-enroll-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const password = 'fixture-pass!$()';
  const hostKey = utils.generateKeyPairSync('ed25519');
  let registered = '';
  let passwordAttempts = 0;
  const fixture = new Server({ hostKeys: [hostKey.private] }, (conn) => {
    conn.on('error', () => {});
    conn.on('authentication', (auth) => {
      if (auth.method === 'password') {
        passwordAttempts++;
        if (auth.password === password) return auth.accept();
      } else if (auth.method === 'publickey' && registered) {
        const pub = utils.parseKey(registered);
        if (auth.key.data.equals(pub.getPublicSSH()) && (!auth.signature || pub.verify(auth.blob, auth.signature))) return auth.accept();
      }
      auth.reject(['publickey', 'password']);
    }).on('ready', () => conn.on('session', (accept) => accept().on('exec', (ok, _no, info) => {
      const stream = ok();
      if (info.command === 'true') { stream.exit(0); stream.end(); return; }
      assert.match(info.command, /authorized_keys/);
      assert.ok(!info.command.includes(password));
      let input = '';
      stream.on('data', (chunk) => { input += chunk; });
      stream.on('end', () => { registered = input.trim(); stream.exit(0); stream.end(); });
    })));
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.close(resolve)));
  const login = { host: '127.0.0.1', port: fixture.address().port, user: 'root' };
  const pins = path.join(directory, 'known_hosts').replace(/\\/g, '/');
  const check = (s) => probe(s, (exe, args, opts) => exec(exe, ['-F', 'none', '-o', 'UserKnownHostsFile="' + pins + '"', ...args], opts));
  await assert.rejects(connectInstance(login, '', directory, check), /需要 SSH 密码/);
  await assert.rejects(connectInstance(login, 'invalid', directory, check), /密码验证失败/);
  const server = await connectInstance(login, password, directory, check);
  assert.match(registered, /^ssh-ed25519 /);
  assert.equal((await connectInstance(login, '', directory, check)).keyFile, server.keyFile);
  assert.equal(await check(server), null);
  const attemptsBefore = passwordAttempts;
  await assert.rejects(registerKey(login, { algorithm: 'ssh-ed25519', fingerprint: 'different' }, password, registered), /指纹/);
  assert.equal(passwordAttempts, attemptsBefore);
  assert.ok(!(await fs.readFile(server.keyFile, 'utf8')).includes(password));
});
