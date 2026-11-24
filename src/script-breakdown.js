// A whole script turned into shots. Three steps:
//  1. plan: the AI reads the script and lists the people and places to make pictures of (cards), then, episode by
//     episode and a few thousand characters at a time, the shots (title, length, what happens, who is in it);
//  2. the user goes over that list and changes what they want;
//  3. write: each shot gets its H3 prompt from the same writer as 「新建镜头」, and the shots go into one MOTION
//     document per episode, the cards into a people-and-places list. The shot page and the asset page read those.
// The plan is kept in .blackbox/breakdown.json, so a long run can be stopped, survive a restart and go on.
// Plain Node, no Electron: the LLM is passed in as llm(messages) -> { content } | string.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./docs');
const { CODE } = require('./asset-cards');
const { listScriptShots } = require('./script-shots');
const { composeShot } = require('./shot-compose');

const MAX_SCRIPT = 400000; // characters of script read at most
const CAST_CHUNK = 60000; // characters the cast step reads per call
const LIST_CHUNK = 6000; // characters the shot list step reads per call
const MAX_REFERENCES = 6;
const DURATION = { min: 2, max: 15, fallback: 6 };
const PLAN_TIMEOUT = 600000;
const MOTION_DIR = '分镜';
const CARDS_DOC = '人物与场景（AI 拆分）.md';

const contentOf = (out) => (typeof out === 'string' ? out : String((out && out.content) || ''));
const sha1 = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');
const clip = (text, max) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// ---------------------------------------------------------------- splitting

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// 十二 → 12, 二十 → 20, 一百零五 → 105; plain digits too
function cnNumber(text) {
  const s = String(text || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) current = CN_DIGITS[ch];
    else if (ch === '十') { total += (current || 1) * 10; current = 0; } else if (ch === '百') { total += (current || 1) * 100; current = 0; } else return NaN;
  }
  return total + current;
}

const EPISODE_HEAD = /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[（(]?\s*)?(?:第[ \t]*([0-9零〇一二三四五六七八九十百两]+)[ \t]*集|EP[ \t]*0*(\d+)|Episode[ \t]*(\d+))[^\n]*$/gim;

// The script in episodes: [{ number, title, text }]. Headings like 「第三集」「EP03」「# 第3集 重逢」 start one; text
// before the first heading (a cast list, a synopsis) goes with the first episode. No headings: one episode.
function splitEpisodes(text) {
  const content = String(text || '').replace(/\r\n?/g, '\n');
  const heads = [...content.matchAll(EPISODE_HEAD)];
  if (!heads.length) return content.trim() ? [{ number: 1, title: '', text: content.trim() }] : [];
  const episodes = [];
  heads.forEach((m, i) => {
    const start = i === 0 ? 0 : m.index;
    const end = i + 1 < heads.length ? heads[i + 1].index : content.length;
    const number = cnNumber(m[1] || m[2] || m[3]);
    const line = m[0].replace(/^[\s#【\[（(]+/, '').trim();
    const title = line.replace(/^(?:第\s*[0-9零〇一二三四五六七八九十百两]+\s*集|EP\s*\d+|Episode\s*\d+)[\s：:·.、\-—】\]）)]*/i, '').trim();
    const body = content.slice(start, end).trim();
    if (body) episodes.push({ number: Number.isFinite(number) && number > 0 ? number : episodes.length + 1, title: clip(title, 30), text: body });
  });
  return episodes;
}

// A long text in pieces of about max characters, cut between paragraphs (or lines, for one giant paragraph).
function chunkText(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t ? [t] : [];
  const pieces = t.split(/\n\s*\n/).flatMap((p) => (p.length > max ? p.split('\n') : [p]));
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > max) {
      chunks.push(cur.trim());
      cur = '';
    }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max));
      continue;
    }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON');
  return JSON.parse(t.slice(start, end + 1)) || {};
}

// ---------------------------------------------------------------- step 1: cards

const CAST_SYSTEM = `你是短剧的美术统筹。读用户给的剧本，列出需要做定妆图的人物和需要做场景图的地点。以后每个镜头都拿这些图当参考图，保证人物和场景前后一致。

只输出 JSON，不要 Markdown、代码块或解释：
{"style":"画风","cards":[{"code":"代号","kind":"人物","name":"名字","look":"外形"}]}

规则：
- 人物：有台词或在画面里反复出现的角色才列；路人、一句话带过的群众不列。同一个人年龄或造型差别很大（比如少年和成年）时各列一张。
- 场景：故事真正发生的地点。同一个地点的白天和夜晚不用分开列。
- kind 只写「人物」或「场景」。
- code：大写英文字母、数字和短横线。人物用名字的拼音首字母（张小明 → ZXM），场景用 S- 加拼音首字母（老街 → S-LJ）。不能和「已有的卡」里的代号重复。
- look：只写看得见的样子，60–150 字。人物写年龄、性别、身材、脸、发型、衣着和标志性特征；场景写地点、年代、陈设、关键道具和光线。剧本没写的按剧情合理补全，不写性格和剧情。
- 「已有的卡」里已经有的人和地点不要再列。
- style：一句话的画风，比如「写实电影质感，自然光，色彩克制」。剧本里写了画风就照它写；用户已经定了画风就原样照抄。`;

function cardLine(c) {
  return `- ${c.code} | ${c.kind === 'scene' ? '场景' : '人物'} | ${c.name} | ${clip(c.look || c.description, 120) || '（没写）'}`;
}

function buildCastMessages({ text, known = [], style = '', part = 1, parts = 1 }) {
  const user = [
    known.length ? `已有的卡（代号 | 类型 | 名字 | 外形）：\n${known.map(cardLine).join('\n')}` : '已有的卡：没有。',
    style ? `用户已经定的画风：${style}` : '',
    `剧本${parts > 1 ? `（第 ${part}/${parts} 部分）` : ''}：\n${text}`,
  ].filter(Boolean).join('\n\n');
  return { system: CAST_SYSTEM, user, temperature: 0.3, maxTokens: 16384, timeoutMs: PLAN_TIMEOUT };
}

// → { style, cards: [{ code, kind, name, look }] }, only the cards that are new; codes made unique against known
function parseCast(raw, known = []) {
  const data = parseJson(raw);
  if (!Array.isArray(data.cards)) throw new Error('JSON 里没有 cards 列表');
  const codes = new Set(known.map((c) => c.code));
  const names = new Set(known.map((c) => `${c.kind}|${c.name}`));
  const cards = [];
  for (const item of data.cards) {
    if (!item || typeof item !== 'object') continue;
    const name = clip(item.name, 30);
    if (!name) continue;
    const kind = /场景|地点|scene|place/i.test(String(item.kind || '')) ? 'scene' : 'char';
    if (names.has(`${kind}|${name}`)) continue;
    let code = String(item.code || '').trim().toUpperCase().replace(/\s+/g, '-');
    if (!CODE.test(code)) code = kind === 'scene' ? 'S' : 'C';
    const base = code;
    for (let n = 2; codes.has(code); n++) code = `${base}-${n}`;
    codes.add(code);
    names.add(`${kind}|${name}`);
    cards.push({ code, kind, name, look: clip(item.look || item.description, 400) });
  }
  return { style: clip(data.style, 200), cards };
}

// ---------------------------------------------------------------- step 2: shot list

const LIST_SYSTEM = `你是短剧的分镜师。把用户给的这一段剧本拆成视频镜头清单。每个镜头之后会单独交给 MiniMax H3 视频模型生成，一镜 2–15 秒。

只输出 JSON，不要 Markdown、代码块或解释：
{"shots":[{"title":"标题","duration":6,"description":"这一镜拍什么","cast":["代号"],"continue":false}]}

规则：
- 按剧本顺序，从这一段的开头拆到结尾，不跳过，也不加剧本里没有的情节。剧本里的每句台词都要落在某一镜里：逐字照抄，用「」括起来，写明是谁说的。
- 一镜只拍一小段连贯的画面：同一个地点、同一段时间。大约每 2.5–3 秒一个动作，一镜最多三个动作；台词按每秒 4 个字左右算时长。装不下就拆成两镜。
- title：十个字以内的中文标题。
- duration：秒数，2–15，一般 4–10。
- description：一到三句中文。写清景别和机位（远景、中景、近景、特写；固定、跟拍、推近），谁在画面里，做什么，说什么。只写画面里看得见、听得见的东西。
- cast：这一镜画面里出现的人物卡代号，主要的在前，最后加这一镜地点的场景卡代号。只能用「素材卡」里的代号，最多 6 个；素材卡里没有的人或地方不写进 cast，在 description 里用文字描写。
- continue：「接上一镜」会从上一镜最后几帧接着生成画面，只适合同一个机位、同一个景别、画面没有切的连续动作，这时写 true。只要换了景别（比如中景换近景）、换了机位、换了地点或跳了时间，一律写 false。正常剪辑里大多数镜头都是 false。`;

function buildListMessages({ chunk, cards = [], style = '', episode = '', part = 1, parts = 1, before = [] }) {
  const user = [
    cards.length ? `素材卡（代号 | 类型 | 名字 | 外形）：\n${cards.map(cardLine).join('\n')}` : '素材卡：没有。',
    style ? `画风：${style}` : '',
    before.length ? `这一段前面的最后几镜（接着它们往下拆，不要重复）：\n${before.map((s) => `- ${s.title}：${clip(s.description, 120)}`).join('\n')}` : '',
    `${episode ? `第 ${episode} 集` : '剧本'}${parts > 1 ? `（第 ${part}/${parts} 段）` : ''}：\n${chunk}`,
  ].filter(Boolean).join('\n\n');
  return { system: LIST_SYSTEM, user, temperature: 0.3, maxTokens: 32768, timeoutMs: PLAN_TIMEOUT };
}

function normalizeShot(item, codes) {
  if (!item || typeof item !== 'object') return null;
  const description = String(item.description || '').trim();
  if (!description) return null;
  let duration = Number(item.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = DURATION.fallback;
  duration = Math.round(Math.min(DURATION.max, Math.max(DURATION.min, duration)) * 2) / 2;
  const cast = [...new Set((Array.isArray(item.cast) ? item.cast : []).map((c) => String(c || '').trim().toUpperCase()))]
    .filter((c) => codes.has(c)).slice(0, MAX_REFERENCES);
  return { title: clip(item.title, 20) || clip(description, 10), duration, description: description.slice(0, 1000), cast, continue: item.continue === true };
}

const FRAMING = /大特写|特写|中近景|近景|中景|全景|远景|大远景|过肩/;
const framingOf = (text) => { const m = FRAMING.exec(String(text || '')); return m ? m[0] : ''; };

// 「接上一镜」 starts from the last frames of the shot before, so it only works when the camera does not cut. The AI
// marks it too often (in a real 112-shot run: 73 times, 52 of them across a change of framing); a shot whose framing
// differs from the one before cannot continue it.
function fixContinuity(shots, before = null) {
  shots.forEach((shot, i) => {
    const prev = i > 0 ? shots[i - 1] : before;
    if (!shot.continue) return;
    const a = framingOf(prev && prev.description);
    const b = framingOf(shot.description);
    if (!prev || (a && b && a !== b)) shot.continue = false;
  });
  return shots;
}

// → [{ title, duration, description, cast, continue }]; codes nobody knows are dropped from cast
function parseList(raw, codes, before = null) {
  const data = parseJson(raw);
  if (!Array.isArray(data.shots)) throw new Error('JSON 里没有 shots 列表');
  const shots = data.shots.map((s) => normalizeShot(s, codes)).filter(Boolean);
  if (!shots.length) throw new Error('镜头清单是空的');
  return fixContinuity(shots, before);
}

// ---------------------------------------------------------------- documents

const mdCell = (text) => String(text || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function cardsDoc({ style, cards }) {
  const table = (kind) => {
    const rows = cards.filter((c) => c.kind === kind);
    if (!rows.length) return '';
    return [`## ${kind === 'char' ? '人物' : '场景'}`, '', '| 代号 | 名字 | 外形 |', '|---|---|---|', ...rows.map((c) => `| ${c.code} | ${mdCell(c.name)} | ${mdCell(c.look)} |`), ''].join('\n');
  };
  return [
    '# 人物与场景（AI 拆分）', '',
    '> 由「剧本拆分镜」生成。可以直接改这张表：代号是镜头挂参考图用的，改代号要连分镜文档里的一起改。', '',
    ...(style ? ['## 画风', '', style, ''] : []),
    table('char'), table('scene'),
  ].filter((part, i, all) => part !== '' || all[i - 1] !== '').join('\n');
}

const shotId = (episode, n) => `MOTION-${episode}-${String(n).padStart(3, '0')}`;

function motionBlock(episode, n, shot, cardsByCode) {
  const lines = [`## ${shotId(episode, n)} · ${shot.title}`, `- 时长：${shot.duration}s`, `- 接续上一镜：${shot.continue ? '是' : '否'}`, `- 剧情：${String(shot.description).replace(/\s*\n\s*/g, ' ')}`];
  const refs = shot.codes || shot.cast || [];
  if (refs.length) {
    lines.push('- 输入参考图：');
    refs.forEach((code, i) => {
      const card = cardsByCode.get(code);
      lines.push(`  - PLAN-${episode}-${String(n).padStart(3, '0')}-${i + 1}（顺序：${i + 1}）· IMG-${code}《${card ? card.name : code}》（用途：${card && card.kind === 'scene' ? '地理' : '身份'}）`);
    });
  }
  lines.push('', '### 可复制提示词');
  if (shot.prompt) lines.push(...String(shot.prompt).split('\n').map((l) => (l.trim() ? `> ${l}` : '>')));
  return lines.join('\n');
}

function motionDoc(episode, cardsByCode) {
  const head = [`# 第 ${episode.id.replace(/^E0*/, '')} 集${episode.title ? ` · ${episode.title}` : ''}（AI 拆分）`, '', '> 由「剧本拆分镜」生成。每个「##」是一个镜头，镜头页会读到它们。', ''];
  return `${head.join('\n')}\n${episode.shots.map((s, i) => motionBlock(episode.id, i + 1, s, cardsByCode)).join('\n\n')}\n`;
}

function writeFileAtomic(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, abs);
}

// A file name in docsDir nobody uses yet: name, else 「name (2)」…
function freeName(docsDir, rel) {
  const ext = path.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? rel : `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(docsDir, candidate))) return candidate;
  }
}

// ---------------------------------------------------------------- the service

const stateFile = (projectDir) => path.join(projectDir, '.blackbox', 'breakdown.json');

function readState(projectDir) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(projectDir), 'utf8'));
    return s && typeof s === 'object' && s.phase ? s : null;
  } catch {
    return null;
  }
}
function writeState(projectDir, state) {
  writeFileAtomic(stateFile(projectDir), JSON.stringify(state, null, 2));
}

const totalShots = (plan) => plan.episodes.reduce((n, e) => n + e.shots.length, 0);

// getCards: the project's cards now ([{ code, kind, name, description, main }]); getStyle: its 画风 line
function createScriptBreakdown({ getPaths, getCards = () => [], getStyle = () => '', llm, compose = composeShot, now = () => Date.now() }) {
  let running = null; // { kind: 'plan' | 'write', stop: boolean }

  function withPaths(fn) {
    const paths = getPaths();
    if (!paths) return { ok: false, message: '还没有打开剧本项目' };
    return fn(paths);
  }

  function docsInfo(paths) {
    return D.listDocs(paths.docsDir, null).docs.map((d) => {
      const r = d.size <= D.MAX_BYTES ? D.readDoc(paths.docsDir, d.relPath) : null;
      return { relPath: d.relPath, name: d.name, category: d.category, chars: r && r.ok ? r.content.length : 0 };
    });
  }

  const view = (paths, state = readState(paths.projectDir)) => ({
    ok: true,
    running: running ? running.kind : '',
    stopping: !!(running && running.stop),
    // the script itself stays here: the page asks for this every second or two
    state: state ? { ...state, sources: (state.sources || []).map((s) => ({ relPath: s.relPath, chars: String(s.text || '').length })) } : null,
    docs: state ? [] : docsInfo(paths),
    limit: MAX_SCRIPT,
  });

  function save(paths, state) {
    state.updatedAt = now();
    writeState(paths.projectDir, state);
  }

  // ---- step 1 + 2, in the background ----
  async function runPlan(paths, state) {
    const known = (getCards() || []).filter((c) => c && c.code).map((c) => ({ code: String(c.code).toUpperCase(), kind: c.kind === 'scene' ? 'scene' : 'char', name: c.name || '', look: c.description || '', existing: true }));
    const script = state.sources.map((s) => s.text).join('\n\n');
    const castChunks = chunkText(script, CAST_CHUNK);
    const episodes = splitEpisodes(script);
    const listJobs = episodes.map((e) => chunkText(e.text, LIST_CHUNK));
    const steps = castChunks.length + listJobs.reduce((n, c) => n + c.length, 0);
    let step = 0;
    const progress = (label) => {
      state.progress = { done: step, total: steps, label };
      save(paths, state);
    };

    let style = String(getStyle() || '').trim();
    const cards = [...known];
    for (let i = 0; i < castChunks.length; i++) {
      if (running.stop) throw new Error('已停止');
      progress(`读剧本，列人物和场景（${i + 1}/${castChunks.length}）`);
      const found = await ask(buildCastMessages({ text: castChunks[i], known: cards, style, part: i + 1, parts: castChunks.length }), (raw) => parseCast(raw, cards), '剧本拆分镜·人物场景');
      if (!style && found.style) style = found.style;
      cards.push(...found.cards);
      step++;
    }
    const codes = new Set(cards.map((c) => c.code));

    const used = new Set((listScriptShots({ docsDir: paths.docsDir }).shots || []).map((s) => s.episode));
    let next = 1;
    const takeId = (wanted) => {
      const id = (n) => `E${String(n).padStart(2, '0')}`;
      if (wanted && !used.has(id(wanted))) { used.add(id(wanted)); return id(wanted); }
      while (used.has(id(next))) next++;
      used.add(id(next));
      return id(next);
    };

    const planned = [];
    for (let e = 0; e < episodes.length; e++) {
      const episode = { id: takeId(episodes[e].number), title: episodes[e].title, shots: [] };
      const chunks = listJobs[e];
      for (let i = 0; i < chunks.length; i++) {
        if (running.stop) throw new Error('已停止');
        progress(`拆第 ${episode.id.replace(/^E0*/, '')} 集的镜头${chunks.length > 1 ? `（${i + 1}/${chunks.length} 段）` : ''}`);
        const shots = await ask(
          buildListMessages({ chunk: chunks[i], cards, style, episode: episode.id.replace(/^E0*/, ''), part: i + 1, parts: chunks.length, before: episode.shots.slice(-2) }),
          (raw) => parseList(raw, codes, episode.shots[episode.shots.length - 1] || null), '剧本拆分镜·镜头清单',
        );
        if (!episode.shots.length && shots[0]) shots[0].continue = false;
        episode.shots.push(...shots);
        step++;
      }
      planned.push(episode);
    }
    Object.assign(state, {
      phase: 'review', style, cards: cards.filter((c) => !c.existing), existing: cards.filter((c) => c.existing).map(({ existing, ...c }) => c),
      episodes: planned.map((ep) => ({ ...ep, shots: ep.shots.map((s) => ({ ...s, status: 'todo' })) })), progress: null, error: '',
    });
    save(paths, state);
  }

  // one LLM call, parsed; a reply that does not parse is sent back once with what was wrong
  async function ask(messages, parse, purpose) {
    const history = [];
    let user = messages.user;
    let lastError = null;
    for (let tries = 0; tries < 2; tries++) {
      const out = await llm({ ...messages, user, history: [...history], purpose });
      const raw = contentOf(out);
      try {
        return parse(raw);
      } catch (e) {
        lastError = e;
        const cut = out && out.finishReason === 'length';
        history.push({ role: 'user', content: user }, { role: 'assistant', content: raw });
        user = cut ? '回复太长被截断了。把同样的内容写得更简短一些（description 每镜一两句），重新完整输出 JSON。' : `格式不对：${e.message}。请按要求重新完整输出 JSON。`;
      }
    }
    throw new Error(`AI 的回复没法用：${lastError ? lastError.message : '格式不对'}`);
  }

  // ---- step 3, in the background ----
  async function runWrite(paths, state) {
    const cardsByCode = new Map([...(state.existing || []), ...state.cards].map((c) => [c.code, c]));
    if (state.cards.length && !state.cardsDoc) {
      state.cardsDoc = freeName(paths.docsDir, CARDS_DOC);
      writeFileAtomic(path.join(paths.docsDir, state.cardsDoc), cardsDoc({ style: state.style, cards: state.cards }));
      save(paths, state);
    }
    const total = totalShots(state);
    const doneCount = () => state.episodes.reduce((n, e) => n + e.shots.filter((s) => s.status === 'done').length, 0);
    const writeEpisode = (episode) => {
      const abs = path.join(paths.docsDir, episode.doc);
      if (fs.existsSync(abs) && episode.written && sha1(fs.readFileSync(abs, 'utf8')) !== episode.written) {
        throw new Error(`「${episode.doc}」在拆分之后被改过了。为了不覆盖你的修改，没有接着写；可以先把改动挪走，或者在镜头页逐镜补写`);
      }
      const text = motionDoc(episode, cardsByCode);
      writeFileAtomic(abs, text);
      episode.written = sha1(text);
    };

    for (const episode of state.episodes) {
      if (!episode.doc) {
        episode.doc = freeName(paths.docsDir, `${MOTION_DIR}/MOTION-${episode.id}.md`);
        writeEpisode(episode);
        save(paths, state);
      }
      for (let i = 0; i < episode.shots.length; i++) {
        const shot = episode.shots[i];
        if (shot.status === 'done') continue;
        if (running.stop) return;
        state.progress = { done: doneCount(), total, label: `写第 ${episode.id.replace(/^E0*/, '')} 集第 ${i + 1} 镜：${shot.title}` };
        save(paths, state);
        const prev = i > 0 ? episode.shots[i - 1] : null;
        const after = episode.shots[i + 1];
        const castCards = shot.cast.map((c) => cardsByCode.get(c)).filter(Boolean)
          .map((c) => ({ code: c.code, kind: c.kind, name: c.name, description: c.look || c.description || '', main: 'planned' }));
        const people = castCards.filter((c) => c.kind !== 'scene').map((c) => `${c.name}（${c.code}）`);
        const places = castCards.filter((c) => c.kind === 'scene').map((c) => `${c.name}（${c.code}）`);
        const continues = !!(shot.continue && prev && prev.prompt);
        const description = [
          shot.description,
          people.length ? `出场人物：${people.join('、')}。` : '',
          places.length ? `地点：${places.join('、')}。` : '',
          `计划时长约 ${shot.duration} 秒。`,
          continues ? '这一镜紧接着上一镜，同一机位、同一时刻接着拍（continue 写 true）。' : prev ? '这一镜换了机位或时间，不接着上一镜（continue 写 false）。' : '',
          !prev && state.style ? `画风：${state.style}` : '',
        ].filter(Boolean).join('\n');
        try {
          const r = await compose({
            description, title: shot.title, cards: castCards, maxReferences: MAX_REFERENCES,
            previous: prev && prev.prompt ? { id: shotId(episode.id, i), prompt: prev.prompt } : null,
            next: after ? { id: shotId(episode.id, i + 2), prompt: after.prompt || `（这一镜还没写提示词，计划拍的是：${after.description}）` } : null,
            llm: (messages) => llm({ ...messages, purpose: '剧本拆分镜·写提示词' }),
          });
          if (!r.ok) throw new Error(r.message || '没写出来');
          Object.assign(shot, { status: 'done', prompt: r.prompt, codes: r.codes, duration: r.duration || shot.duration, continue: continues, error: '' });
        } catch (e) {
          Object.assign(shot, { status: 'failed', error: e.message });
        }
        writeEpisode(episode);
        save(paths, state);
      }
    }
  }

  function launch(paths, state, kind, job) {
    running = { kind, stop: false };
    job(paths, state)
      .then(() => {
        const s = readState(paths.projectDir) || state;
        if (kind === 'write') {
          const left = s.episodes.reduce((n, e) => n + e.shots.filter((x) => x.status !== 'done').length, 0);
          Object.assign(s, { phase: running.stop && left ? 'stopped' : 'done', progress: null });
          save(paths, s);
        }
      })
      .catch((e) => {
        const s = readState(paths.projectDir) || state;
        Object.assign(s, { phase: kind === 'plan' ? 'failed' : 'stopped', error: e.message, progress: null });
        save(paths, s);
      })
      .finally(() => { running = null; });
  }

  return {
    load: () => withPaths((paths) => view(paths)),

    // relPaths: the script documents, in reading order
    start: (relPaths) => withPaths((paths) => {
      if (running) return { ok: false, message: '正在进行中，请等它做完或先停下' };
      const old = readState(paths.projectDir);
      if (old && ['review', 'writing', 'stopped'].includes(old.phase)) return { ok: false, message: '上一次的拆分还没处理完：先写完或放弃它' };
      const sources = [];
      for (const rel of (Array.isArray(relPaths) ? relPaths : []).map(String)) {
        const r = D.readDoc(paths.docsDir, rel);
        if (!r.ok) return { ok: false, message: `读不了「${rel}」：${r.message || ''}` };
        if (r.content.trim()) sources.push({ relPath: rel, text: r.content });
      }
      if (!sources.length) return { ok: false, message: '先选要拆的剧本文档' };
      const chars = sources.reduce((n, s) => n + s.text.length, 0);
      if (chars > MAX_SCRIPT) return { ok: false, message: `剧本太长了（约 ${Math.round(chars / 10000)} 万字），一次最多 ${MAX_SCRIPT / 10000} 万字，请分几次拆` };
      const state = { phase: 'planning', startedAt: now(), sources, style: '', cards: [], existing: [], episodes: [], progress: { done: 0, total: 0, label: '准备中' }, error: '' };
      save(paths, state);
      launch(paths, state, 'plan', runPlan);
      return view(paths, state);
    }),

    // The user's changes to the list (review only): cards' names and looks, shots' fields, removed and added shots.
    update: (plan) => withPaths((paths) => {
      const state = readState(paths.projectDir);
      if (!state || state.phase !== 'review') return { ok: false, message: '现在不能改清单' };
      if (running) return { ok: false, message: '正在进行中' };
      const input = plan && typeof plan === 'object' ? plan : {};
      if (typeof input.style === 'string') state.style = clip(input.style, 200);
      if (Array.isArray(input.cards)) {
        const byCode = new Map(state.cards.map((c) => [c.code, c]));
        state.cards = input.cards.map((c) => {
          const old = byCode.get(String((c && c.code) || '').toUpperCase());
          return old ? { ...old, name: clip(c.name, 30) || old.name, look: clip(c.look, 400) } : null;
        }).filter(Boolean);
      }
      const codes = new Set([...(state.existing || []), ...state.cards].map((c) => c.code));
      if (Array.isArray(input.episodes)) {
        const byId = new Map(state.episodes.map((e) => [e.id, e]));
        state.episodes = input.episodes.map((e) => {
          const old = byId.get(String((e && e.id) || ''));
          if (!old) return null;
          const shots = (Array.isArray(e.shots) ? e.shots : []).map((s) => normalizeShot(s, codes)).filter(Boolean).map((s) => ({ ...s, status: 'todo' }));
          if (shots[0]) shots[0].continue = false;
          return { ...old, title: clip(e.title, 30), shots };
        }).filter((e) => e && e.shots.length);
      }
      save(paths, state);
      return view(paths, state);
    }),

    // Step 3: writes the documents and the prompts. Also goes on after a stop, and retries the shots that failed.
    write: () => withPaths((paths) => {
      if (running) return { ok: false, message: '正在进行中' };
      const state = readState(paths.projectDir);
      if (!state || !['review', 'writing', 'stopped', 'done'].includes(state.phase)) return { ok: false, message: '还没有镜头清单' };
      if (!totalShots(state)) return { ok: false, message: '镜头清单是空的' };
      for (const e of state.episodes) for (const s of e.shots) if (s.status === 'failed') s.status = 'todo';
      Object.assign(state, { phase: 'writing', error: '' });
      save(paths, state);
      launch(paths, state, 'write', runWrite);
      return view(paths, state);
    }),

    stop: () => withPaths((paths) => {
      if (!running) return view(paths);
      running.stop = true;
      return view(paths);
    }),

    // Forgets the plan. Documents already written stay where they are.
    discard: () => withPaths((paths) => {
      if (running) return { ok: false, message: '正在进行中，请先停下' };
      try { fs.rmSync(stateFile(paths.projectDir), { force: true }); } catch { /* nothing to forget */ }
      return view(paths, null);
    }),
  };
}

module.exports = {
  createScriptBreakdown, splitEpisodes, chunkText, cnNumber, buildCastMessages, parseCast, buildListMessages, parseList, fixContinuity,
  cardsDoc, motionDoc, motionBlock, CARDS_DOC,
};
