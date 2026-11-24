const crypto = require('node:crypto');

function normalizeBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
  const url = new URL(baseUrl);
  if (url.username || url.password) throw new Error('请不要把账号或密码写进 API 地址');
  return baseUrl;
}

async function requestJson({ baseUrl, apiKey, path, method = 'GET', body, timeoutMs = 120000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!response.ok) {
      const detail = data && data.error && (data.error.message || data.error) || text.slice(0, 400);
      throw new Error(`LLM API HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('LLM API 请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function validateLlm(config, apiKey) {
  if (!config || !String(config.model || '').trim()) throw new Error('请先填写 LLM 模型名称');
  return { baseUrl: normalizeBaseUrl(config.baseUrl), apiKey: String(apiKey || ''), model: config.model.trim() };
}

async function testLlm(config, apiKey) {
  const checked = validateLlm(config, apiKey);
  await requestJson({ ...checked, path: '/models', timeoutMs: 30000 });
  return { ok: true, message: `连接成功：${checked.model}` };
}

// Told about every reply's token usage ({ model, usage, purpose, prefix }), whether or not the reply turns out usable:
// a cut-off or malformed answer was paid for all the same. prefix: a short fingerprint of the system prompt, so the
// usage log shows which calls opened with exactly the same text (the part the prompt cache can cover).
const prefixOf = (text) => crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 10);
let usageListener = null;
const onUsage = (fn) => { usageListener = typeof fn === 'function' ? fn : null; };

async function optimizeLlm(config, apiKey, messages) {
  return (await completeLlm(config, apiKey, messages)).content;
}

// The messages of a request, fixed part first: the system prompt, then the earlier turns, then the new question.
// DeepSeek and OpenAI cache a repeated beginning by themselves; Claude (through a service that passes Anthropic's
// cache_control along) only caches up to a marked block, so for a Claude model the system prompt and the last
// earlier turn are marked.
function chatMessages(model, { system, history = [], user }) {
  const marked = /claude/i.test(String(model));
  const mark = (text) => [{ type: 'text', text: String(text ?? ''), cache_control: { type: 'ephemeral' } }];
  const turns = history.map((m, i) => (marked && i === history.length - 1 ? { role: m.role, content: mark(m.content) } : m));
  return [
    { role: 'system', content: marked ? mark(system) : system },
    ...turns,
    { role: 'user', content: user },
  ];
}

// The reply with why it ended: finishReason 'length' means it was cut off at the token limit.
async function completeLlm(config, apiKey, messages) {
  const checked = validateLlm(config, apiKey);
  const data = await requestJson({
    ...checked,
    path: '/chat/completions',
    method: 'POST',
    // history: earlier turns of a conversation ({ role, content }), sent between the system prompt and the new question
    body: {
      model: checked.model,
      messages: chatMessages(checked.model, messages),
      temperature: messages.temperature,
      max_tokens: messages.maxTokens,
      ...(messages.thinking ? { thinking: messages.thinking } : {}),
    },
    ...(messages.timeoutMs ? { timeoutMs: messages.timeoutMs } : {}),
  });
  if (usageListener && data && data.usage) {
    try { usageListener({ model: checked.model, usage: data.usage, purpose: messages.purpose || '', prefix: prefixOf(messages.system) }); } catch { /* bookkeeping only */ }
  }
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const finishReason = (choice && choice.finish_reason) || '';
  if (typeof content === 'string') return { content, finishReason, usage: (data && data.usage) || null };
  if (Array.isArray(content)) return { content: content.map((part) => part.text || '').join(''), finishReason, usage: (data && data.usage) || null };
  throw new Error('LLM 返回中没有可用的提示词内容');
}

module.exports = { normalizeBaseUrl, requestJson, testLlm, optimizeLlm, completeLlm, onUsage, chatMessages, prefixOf };
