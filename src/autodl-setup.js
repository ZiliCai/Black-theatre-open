const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { runRemote } = require('./remote-tunnel');
const { validateServer } = require('./remote-servers');
const { loadTemplate } = require('./workflow-template');
const { compileWorkflow } = require('./workflow-compile');
const { compileImage } = require('./image-compile');
const { createApi } = require('./comfy-api');

const PROFILES = {
  wenwu: ['minimax-h3-wenwu-cont', 'minimax-h3-wenwu'],
  hybrid: ['minimax-h3-hybrid'],
  image: [],
};
const STARTER = 'bbt_acceptance';
const PYTHON = 'if [ -x /root/miniconda3/bin/python ]; then py=/root/miniconda3/bin/python; else py=$(command -v python3); fi';
const remoteDir = (port) => `/root/autodl-tmp/blackbox/${port}`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function recipe(root, profile, upscale = false) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error('未知的 AutoDL 工作流');
  const videos = PROFILES[profile];
  const workflows = ['qwen-image-t2i', 'qwen-image-i2i', ...videos];
  if (upscale) workflows.push('seedvr2-upscale');
  const templates = workflows.map((id) => loadTemplate(path.join(root, 'workflow-templates', id)));
  const nodes = [...new Set(templates.flatMap((t) => Object.values(t.graph).map((n) => n.class_type)))].sort();
  const plugins = new Set();
  if (videos.length) {
    for (const name of ['comfyui-kjnodes', 'ComfyUI-H3-Motion-Context']) plugins.add(name);
    if (profile === 'wenwu') {
      plugins.add('SelfLiftH3Sampler');
      plugins.add('comfyui-videohelpersuite');
    } else {
      plugins.add('ComfyUI-GGUF');
      plugins.add('ComfyUI-MAINodes');
    }
  }
  if (upscale) {
    plugins.add('comfyui-videohelpersuite');
    plugins.add('ComfyUI-SeedVR2_VideoUpscaler');
  }
  const image = compileImage(templates[0], { prompt: '写实电影画面，明亮木桌上的蓝色陶杯，柔和窗光。', seed: 731, aspect: '16:9' }, { outputKey: STARTER });
  if (!image.ok) throw new Error(image.errors.join('，'));
  let video = null;
  if (videos.length) {
    const result = compileWorkflow(templates[2], {
      prompt: 'Picture 1 是参考图。桌上的蓝色陶杯保持静止，镜头缓慢推进，自然光线，无对白。',
      references: ['ref/bbt_acceptance.png [output]'], seedMode: 'fixed', seed: 732,
      duration: 4, megapixels: 0.6, aspect: '16:9', continuationEnabled: false,
    }, { outputKey: STARTER });
    if (!result.ok) throw new Error(result.errors.join('，'));
    video = result.workflow;
    // Hybrid normally takes its file name from the context branch.
    for (const node of Object.values(video)) {
      if (node.class_type === 'SaveVideo') node.inputs.filename_prefix = 'video/' + STARTER;
    }
  }
  return { workflows, nodes, plugins: [...plugins].sort(), image: image.workflow, video };
}

async function makeBundle(root, options) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bbt-autodl-'));
  try {
    const plan = recipe(root, options.profile, options.upscale);
    const json = path.join(tmp, 'recipe.json');
    await fs.writeFile(json, JSON.stringify(plan));
    await fs.utimes(json, 0, 0);
    const archive = path.join(tmp, 'setup.tgz');
    await execFile('tar', ['-czf', archive, '--exclude=__pycache__', '--exclude=*.pyc', '-C', root,
      'autodl', ...plan.plugins.map((name) => 'comfyui-plugins/' + name), '-C', tmp, 'recipe.json'],
    { windowsHide: true, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return await fs.readFile(archive);
  } finally {
    await fs.rm(tmp, { force: true, recursive: true });
  }
}

function checkServer(server) {
  const check = validateServer(server);
  if (!check.ok || server.user.startsWith('-') || !Number.isInteger(server.comfyPort) || server.comfyPort < 1 || server.comfyPort > 65535) {
    throw new Error(check.errors.join('，') || '服务器登录信息或端口无效');
  }
}

async function launch(server, root, options) {
  checkServer(server);
  const bundle = await makeBundle(root, options);
  const hash = sha256(bundle);
  const base = remoteDir(server.comfyPort);
  // Unpack privately, then publish an immutable complete directory. Concurrent uploads may share it.
  const command = `set -eu; umask 077; test -d /root/autodl-tmp || { echo '未找到 AutoDL 数据盘 /root/autodl-tmp' >&2; exit 1; }; ` +
    `mkdir -p ${base}/bundles; cd ${base}/bundles; t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; ` +
    `cat > "$t/bundle.tgz"; echo "${hash}  $t/bundle.tgz" | sha256sum -c - >/dev/null; ` +
    `( flock -x 9; if [ ! -d ${hash} ]; then u=$(mktemp -d .upload.XXXXXXXX); ` +
    `tar -xzf "$t/bundle.tgz" -C "$u" && mv "$u" ${hash}; fi ) 9>.upload.lock; ` +
    `${PYTHON}; "$py" ${hash}/autodl/setup.py launch ${server.comfyPort}`;
  const reply = await runRemote(server, command, { input: bundle, timeoutMs: 300000 });
  if (!reply.ok) throw new Error(reply.message);
}

async function status(server) {
  checkServer(server);
  const base = remoteDir(server.comfyPort);
  const reply = await runRemote(server, `if [ -f ${base}/state.json ]; then cd ${base}; ` +
    `if flock -n setup.lock true; then echo released; else echo locked; fi; cat state.json; else echo idle; fi`);
  if (!reply.ok) throw new Error(reply.message);
  const [lock, ...json] = reply.stdout.trim().split(/\r?\n/);
  if (lock === 'idle') return { status: 'idle', message: '' };
  const s = JSON.parse(json.join('\n'));
  if (lock === 'released' && s.status === 'running') {
    return { ...s, status: 'failed', message: '上次配置被中断，可继续配置并复用已下载文件。' };
  }
  return s;
}

async function collect(state, localPort, directory) {
  if (!/^[0-9a-f]{32}$/.test(state.run) || !/^[a-f0-9]{64}$/.test(state.sha256) ||
      !Number.isSafeInteger(state.bytes) || state.bytes <= 0 ||
      !new RegExp('^(video|ref)/bbt_acceptance_' + state.run + '_[a-zA-Z0-9_.-]+\\.(png|mp4)$').test(state.file)) {
    throw new Error('服务器返回的验收文件信息无效');
  }
  const name = state.run + path.extname(state.file);
  const dest = path.join(directory, name);
  const matches = async (file) => (await fs.stat(file)).size === state.bytes && sha256(await fs.readFile(file)) === state.sha256;
  if (await matches(dest).catch(() => false)) return name;
  if (!localPort) throw new Error('等待 SSH 隧道恢复后取回验收文件');
  await fs.mkdir(directory, { recursive: true });
  const temp = dest + '.' + crypto.randomUUID() + '.part';
  try {
    await createApi({ port: localPort }).downloadOutput(state.file, temp);
    if (!await matches(temp)) throw new Error('验收文件下载不完整，稍后会重新取回');
    await fs.rename(temp, dest);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return name;
}

module.exports = { recipe, launch, status, collect, remoteDir };
