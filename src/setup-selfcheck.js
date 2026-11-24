const { createApi } = require('./comfy-api');
const { completeLlm } = require('./llm-api');

const endpoint = (s) => JSON.stringify([s.id, s.host, s.port, s.user, s.comfyPort]);
const official = (url) => /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/i.test(url || '');

async function checkGpu(port) {
  if (!port) throw new Error('请在「远程 GPU」重新连接该实例，再运行自检。');
  const api = createApi({ port, timeoutMs: 8000 });
  let stats;
  try { [stats] = await Promise.all([api.systemStats(), api.queue()]); }
  catch { throw new Error('桌面端无法读取 ComfyUI 或任务队列，请检查 SSH 隧道并启动云端 ComfyUI。'); }
  if (!stats.deviceName || !stats.vramTotal || /\bcpu\b/i.test(stats.deviceName)) {
    throw new Error('ComfyUI 没有报告可用显卡，请确认实例已用 GPU 模式开机。');
  }
  return stats.deviceName + ' · ' + (stats.vramTotal / 2 ** 30).toFixed(1) + ' GiB，任务队列可访问';
}

async function checkChat(llm, key, complete = completeLlm) {
  if (!official(llm.baseUrl) || !llm.model || !key) throw new Error('请在「设置 → 常规」检查 DeepSeek 官方地址、模型和 API Key。');
  let reply;
  try {
    reply = await complete(llm, key, { system: '这是连通性测试。', user: '请仅回复 OK。',
      maxTokens: 32, thinking: { type: 'disabled' }, timeoutMs: 25000, purpose: '配置自检' });
  } catch (e) {
    const code = /^LLM API HTTP (\d+)\b/.exec(e.message)?.[1];
    if (code === '402') throw new Error('DeepSeek 账户余额不足。充值后可重新自检。');
    if (code === '401' || code === '403') throw new Error('DeepSeek 拒绝了此密钥，请在「设置 → 常规」更新 API Key。');
    throw new Error('DeepSeek 调用失败' + (code ? '（HTTP ' + code + '）' : '') + '，请检查网络、模型和账户后重试。');
  }
  if (!reply.content.trim()) throw new Error('DeepSeek 未返回可用文本，请检查模型设置后重试。');
  return llm.model + ' 已返回测试文本';
}

async function run({ state, preview, port, llm, getKey, requiresChat, probeGpu = checkGpu, probeChat = checkChat }) {
  const check = (id, label, status, detail) => ({ id, label, status, detail });
  async function probe(id, label, action) {
    try { return check(id, label, 'pass', await action()); }
    catch (e) { return check(id, label, 'fail', e.message); }
  }
  const renderedVideo = preview.endsWith('.mp4');
  const video = state.video ?? renderedVideo;
  const [gpu, chat] = await Promise.all([
    probe('gpu', '桌面端连接 GPU 与任务队列', () => probeGpu(port)),
    requiresChat || official(llm.baseUrl)
      ? probe('chat', 'DeepSeek 文本生成', async () => probeChat(llm, await getKey()))
      : check('chat', 'DeepSeek 文本生成', 'skip', '本次仅配置云端 GPU，可在常规设置中连接 DeepSeek。'),
  ]);
  // The worker reaches ready only after inspecting this recipe and rendering its samples;
  // the caller supplies preview only after the byte count and SHA-256 match locally.
  const checks = [gpu, check('models', '工作流节点与模型', 'pass', '云端 ComfyUI 已识别这套工作流所需的节点和模型。'),
    check('image', '素材出图', 'pass', '已实际生成验收图。'),
    check('video', '镜头出片', !video ? 'skip' : renderedVideo ? 'pass' : 'fail',
      !video ? '本次选择了仅素材出图。' : renderedVideo ? '已用验收图生成约 4 秒的短片。' : '这套工作流需要视频，但验收文件中缺少短片。'),
    check('file', '验收文件取回', 'pass', '本机文件大小与 SHA-256 校验通过。'), chat];
  return { run: state.run, at: Date.now(), checks, ok: checks.every((c) => c.status !== 'fail') };
}

module.exports = { endpoint, checkGpu, checkChat, run };
