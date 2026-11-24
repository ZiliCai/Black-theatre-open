// A new shot written from the user's few words. The model writes the prompt and fills in a small block of settings
// (title, length, which cards to hang, whether it continues the shot before); the code checks both and sends back
// what is wrong, keeping the best try. Plain Node, no Electron: the LLM is passed in as llm(messages) -> reply.
const { buildComposeMessages, parseCompose, SECTIONS } = require('./prompt-optimizers');
const { paceOf, ensureNoSubtitles } = require('./prompt-hygiene');

const RETRIES = 2;
const DURATION = { min: 2, max: 15 };

const sectionsOf = (text) => [...String(text).matchAll(new RegExp(`^\\s*(${SECTIONS.join('|')})\\s*[:：]`, 'gm'))].map((m) => m[1]);
const numbersOf = (text, tag) => [...String(text).matchAll(new RegExp(`<${tag} (\\d+)>`, 'g'))].map((m) => Number(m[1]));
const contentOf = (out) => (typeof out === 'string' ? out : String((out && out.content) || ''));

// What the reply settles, made safe ({ title, duration, codes, continue }), and what is wrong with it ([text]).
// broken: the six sections are not there, so the prompt cannot be used at all.
function review({ meta, prompt }, { cards, maxReferences, hasPrevious }) {
  const problems = [];
  const byCode = new Map(cards.filter((c) => c.main).map((c) => [String(c.code).toUpperCase(), c]));
  const asked = Array.isArray(meta.references) ? meta.references.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean) : [];
  const codes = [...new Set(asked)].filter((c) => byCode.has(c));
  for (const c of asked.filter((x) => !byCode.has(x))) {
    problems.push(cards.some((k) => String(k.code).toUpperCase() === c) ? `素材卡「${c}」还没有图，不能挂，从 references 里去掉，用文字描写` : `「${c}」不是素材卡代号，references 只能写列表里的代号`);
  }
  if (codes.length > maxReferences) problems.push(`挂了 ${codes.length} 张参考图，最多 ${maxReferences} 张：只留画面里最要紧的人和地点`);
  const broken = sectionsOf(prompt).join() !== SECTIONS.join();
  if (broken) problems.push(`提示词要有六段，按这个顺序：${SECTIONS.join('、')}`);
  const used = new Set(numbersOf(prompt, 'Picture'));
  const extra = [...used].filter((n) => n > codes.length);
  if (extra.length) problems.push(`提示词里有 ${extra.map((n) => `<Picture ${n}>`).join('、')}，可 references 只有 ${codes.length} 个代号`);
  codes.forEach((c, i) => {
    if (!used.has(i + 1)) problems.push(`references 第 ${i + 1} 个是「${byCode.get(c).name}」，提示词里没有用到 <Picture ${i + 1}>：subject_definitions 里给它一条 <Subject k>，或者从 references 里去掉`);
  });
  const defined = new Set([...String(prompt).matchAll(/^\s*<Subject (\d+)>\s+is\b/gm)].map((m) => Number(m[1])));
  const undefinedSubjects = [...new Set(numbersOf(prompt, 'Subject'))].filter((n) => !defined.has(n));
  if (undefinedSubjects.length) problems.push(`${undefinedSubjects.map((n) => `<Subject ${n}>`).join('、')} 在 subject_definitions 里没有定义`);
  let duration = Number(meta.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    problems.push('duration 要写成秒数，比如 6');
    duration = 6;
  }
  duration = Math.round(Math.min(DURATION.max, Math.max(DURATION.min, duration)) * 2) / 2;
  const pace = paceOf(prompt, duration);
  if (pace.dense) problems.push(`这一镜 ${duration} 秒写了大约 ${pace.beats} 个动作，模型会一个赶一个：只留最要紧的 ${pace.allowed} 个，或把 duration 加长`);
  const title = String(meta.title || '').trim().slice(0, 30);
  return { settled: { title, duration, codes, continue: meta.continue === true && hasPrevious }, problems, broken };
}

// → { ok, title, duration, codes, continue, prompt, note, warnings } or { ok: false, message }
async function composeShot({ description, title = '', cards = [], previous = null, next = null, maxReferences = 6, llm }) {
  if (!String(description || '').trim()) return { ok: false, message: '先写一句这一镜想拍什么' };
  const messages = buildComposeMessages({ cards, previous, next, maxReferences, title, description: String(description).trim() });
  const history = [];
  let user = messages.user;
  let best = null;
  for (let tries = 1; tries <= RETRIES + 1; tries++) {
    const raw = contentOf(await llm({ ...messages, user, history: [...history] }));
    let problems;
    try {
      const reply = parseCompose(raw);
      const r = review(reply, { cards, maxReferences, hasPrevious: !!previous });
      problems = r.problems;
      if (!r.broken && (!best || problems.length < best.problems.length)) best = { ...r, prompt: reply.prompt, note: reply.note };
    } catch (e) {
      problems = [`格式不对：${e.message}。按 <note>、<meta>、<prompt> 的格式重新输出`];
    }
    if (best && !best.problems.length) break;
    // the first request and each answer stay as they were, so a retry reads all of them from the cache
    history.push({ role: 'user', content: user }, { role: 'assistant', content: raw });
    user = `上面的结果有这些问题：\n${problems.map((p) => `- ${p}`).join('\n')}\n请改正，重新完整输出 <note>、<meta> 和 <prompt>。`;
  }
  if (!best) return { ok: false, message: 'AI 没写出能用的提示词（六段结构不完整），换个说法再试一次' };
  const { settled } = best;
  return {
    ok: true, title: settled.title || String(title || '').trim(), duration: settled.duration, codes: settled.codes, continue: settled.continue,
    prompt: ensureNoSubtitles(best.prompt), note: best.note, warnings: best.problems,
  };
}

module.exports = { composeShot, review };
