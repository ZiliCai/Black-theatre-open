// Talking the whole script over with the LLM. The documents the user picks go in front (the current saved
// versions), the conversation after. A reply is talk, plus edits to the documents (a passage copied from the
// document and what it becomes, applied one by one by the user, each one undoable) and shots whose prompts should
// change (rewritten the way a linked edit is, tidied like any rewrite). The conversation is kept per project in
// .blackbox/script-chat.json. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');
const D = require('./docs');
const links = require('./shot-links');

const MAX_CONTEXT = 240000; // characters of documents sent along
const KEEP_MESSAGES = 24; // earlier messages sent back with each question, at least
// The oldest messages are let go this many at a time, so the conversation sent along starts the same way for several
// questions in a row and the service's prompt cache keeps matching it (24–31 messages).
const DROP_STEP = 8;
const MAX_QUESTION = 8000;
const SKIP_BY_DEFAULT = /旧稿|废稿|备份/; // left out until picked: old drafts the script itself no longer uses

const SYSTEM = [
  '你是这部短剧的编剧搭档。用户会和你从整体上讨论剧本：人物、情节、节奏、前后对不对得上、分镜怎么拆、哪一镜要改。',
  '下面附上用户选给你看的项目文档，都是现在保存着的版本；用户应用了你的修改以后，你下一次看到的就是改过的版本。',
  '',
  '怎么回答：',
  '- 用中文，像跟合作的编剧说话：直接、具体，说清楚是哪一集哪一场哪一镜、为什么。没把握的地方先问，或者给两三个方案让用户挑。',
  '- 只在用户要你改、或者你们已经说定怎么改的时候才给出修改；还在讨论时只讨论。',
  '- 剧本里已经定下的写法和规矩（文档开头的说明、画风、人物外形、格式）照着来，不要自己另起一套。',
  '',
  '改文档，一处改动写一个 edit，多处就写多个：',
  '<edit doc="文档路径">',
  '<find>',
  '要改的那一段原文，一字不差地照抄（标点、空格、换行都照抄），长到在这篇文档里只出现一次',
  '</find>',
  '<replace>',
  '改成的样子',
  '</replace>',
  '<why>一句话：为什么这样改</why>',
  '</edit>',
  '- 文档路径用下面 <doc path="…"> 里的路径。插入新内容：find 写插入点前面那一小段原文，replace 写这段原文再接上新内容。删除：replace 留空。',
  '- find 只抄要改的那几行，不要整段整篇地抄，更不要把整篇文档重写一遍。',
  '- 要去掉的东西直接删掉或换成别的写法，不要补「不要……」「没有……」这类防御性的句子。',
  '',
  '镜头的提示词（MOTION 文档里每一镜那段英文六段式提示词）不要用 edit 改，写进 shots：',
  '<shots>',
  '镜头编号 | 为什么要改 | 修改说明',
  '</shots>',
  '- 一行一镜，镜头编号写完整，比如 MOTION-E01-010。修改说明用中文写清楚这一镜要改成什么样，像在跟改提示词的人交代；软件会按它逐镜改写，改完再整理一遍。',
  '- 镜头的标题、时长、接续上一镜、参考图这些中文字段，以及分镜总表、大纲这些文档，用 edit 改。',
  '- 写新镜头、或者给镜头加动作时按时长算：视频模型会把写下的每个人物动作都做完，动作多了就一个赶一个、显得急。大约每 2.5–3 秒一个动作，一镜最多三个；装不下就删掉次要的、加长时长，或拆成两镜，不要压缩着写。',
  '- 一个改动牵连到前后镜头的（动作、位置、道具、时间接不上），把要跟着改的镜头也写进 shots。',
].join('\n');

const chatFile = (projectDir) => path.join(projectDir, '.blackbox', 'script-chat.json');

function readChat(projectDir) {
  try {
    const data = JSON.parse(fs.readFileSync(chatFile(projectDir), 'utf8'));
    return { docs: Array.isArray(data.docs) ? data.docs : null, messages: Array.isArray(data.messages) ? data.messages : [] };
  } catch {
    return { docs: null, messages: [] };
  }
}

function writeChat(projectDir, chat) {
  const file = chatFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, ...chat }, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

// The documents the AI sees: the user's choice when there is one, else all but old drafts.
function chosenDocs(chat, all) {
  const known = new Set(all.map((d) => d.relPath));
  if (chat.docs) return chat.docs.filter((p) => known.has(p));
  return all.filter((d) => !SKIP_BY_DEFAULT.test(d.relPath)).map((d) => d.relPath);
}

const docBlock = (docs) => docs.map((d) => `<doc path="${d.relPath}">\n${d.content}\n</doc>`).join('\n\n');

// What an earlier reply's edits came to, so the next answer knows what is in the documents now. It opens the
// user's next message: put after the reply itself, the model took it for part of its own way of answering and
// started writing it at the end of its replies.
function outcomeNote(message) {
  const edits = message.edits || [];
  const said = edits.map((e, i) => `第 ${i + 1} 处（${e.doc}）${e.state === 'applied' ? '已应用' : '没应用'}`);
  if (message.broken) said.push(`另有 ${message.broken} 处 <edit> 格式不对没被识别，没有改，需要的话按格式重发`);
  if (!said.length) return '';
  return `（你上一条回复里的修改，用户的处理：${said.join('；')}。）\n\n`;
}

// Where the conversation sent along starts: it moves on DROP_STEP messages at a time (an even number: on a question).
const historyStart = (count) => (count <= KEEP_MESSAGES ? 0 : Math.floor((count - KEEP_MESSAGES) / DROP_STEP) * DROP_STEP);

// The documents in the order they last changed, oldest first: an edit moves its document to the end, so the
// documents in front of it are sent exactly as before and the prompt cache still covers them.
function cacheOrder(docs, changedAt = {}) {
  const at = (d) => (Number.isFinite(changedAt[d.relPath]) ? changedAt[d.relPath] : 0);
  return [...docs].sort((a, b) => at(a) - at(b) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

function buildChatMessages({ docs, messages, question }) {
  let note = '';
  const history = messages.slice(historyStart(messages.length)).map((m) => {
    if (m.role === 'assistant') {
      note = outcomeNote(m);
      return { role: 'assistant', content: m.raw || m.text };
    }
    const content = `${note}${m.text}`;
    note = '';
    return { role: 'user', content };
  });
  return {
    system: `${SYSTEM}\n\n项目文档：\n\n${docBlock(docs)}`,
    history,
    user: `${note}${question}`,
    temperature: 0.5,
    maxTokens: 32768, // a thinking model spends most of it thinking over a long script before it writes
    timeoutMs: 300000,
  };
}

const trimBlock = (s) => String(s || '').replace(/^\r?\n/, '').replace(/\r?\n$/, '');

// A reply: { text (the talk), edits: [{ id, doc, find, replace, why }], shots: [{ shotId, n, reason, remark }] }.
// contents: { relPath: text } of those documents, to place an edit whose tags came out malformed (optional).
function parseReply(raw, { docs = [], shotIds = [], contents = {} } = {}) {
  const body = String(raw || '');
  const allowed = new Set(docs);
  const edits = [];
  // an edit the reply never closed (it was cut off) still counts when its find and replace are complete
  const editRe = /<edit\s+doc\s*=\s*["“]([^"”]+)["”]\s*>([\s\S]*?)(?:<\/edit>|(?=<edit\s|<shots>)|$)/g;
  for (let m; (m = editRe.exec(body));) {
    const part = (tag) => {
      const t = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[2]);
      return t ? trimBlock(t[1]) : null;
    };
    const find = part('find');
    const doc = m[1].trim();
    if (find === null || !find.trim() || !allowed.has(doc)) continue;
    edits.push({ id: `e${edits.length + 1}`, doc, find, replace: part('replace') || '', why: (part('why') || '').trim() });
  }
  const s = /<shots>([\s\S]*?)<\/shots>/.exec(body);
  const shots = s ? links.fromList(s[1].split('\n').map((line) => line.split(/\s*[|｜]\s*/)).map(([shot, reason, remark]) => ({ shot, reason, remark })), shotIds) : [];
  let text = body.replace(editRe, '').replace(/<shots>[\s\S]*?<\/shots>/g, '')
    .replace(/^（(?:用户对这些修改的处理|你上一条回复里的修改)[^\n]*$/gm, '') // an echo of the outcome note
    .replace(/\n{3,}/g, '\n\n').trim();
  // A slip the model makes again and again: the passage it copies starts with a heading, and it runs the heading into
  // the doc attribute, dropping the rest of the tag ('<edit doc="第一集/MOTION-E01-015 · 一杯水\n- 时长：6.6s\n</find>').
  // The heading is still there to read: put the "## " back, and when that passage is in exactly one of the documents
  // it was shown, that is the edit.
  const slipRe = /<edit\s+doc\s*=\s*["“]([^"”\n>]*)\n([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>(?:\s*<why>([\s\S]*?)<\/why>)?\s*(?:<\/edit>)?/g;
  text = text.replace(slipRe, (all, head, rest, replace, why) => {
    const title = head.slice(head.lastIndexOf('/') + 1).trim();
    for (const find of [`## ${title}\n${trimBlock(rest)}`, `${title}\n${trimBlock(rest)}`]) {
      const hits = docs.filter((doc) => contents[doc] !== undefined && !locate(contents[doc], find).error);
      if (hits.length !== 1) continue;
      edits.push({ id: `e${edits.length + 1}`, doc: hits[0], find, replace: trimBlock(replace), why: (why || '').trim() });
      return '';
    }
    return all;
  }).replace(/\n{3,}/g, '\n\n').trim();
  // an edit whose tags came out malformed in any other way is left in the text: say so, instead of the change
  // silently not happening
  const broken = Math.max((text.match(/<edit\b/g) || []).length, (text.match(/<\/replace>/g) || []).length);
  if (broken) text += `\n\n（这条回复里有 ${broken} 处修改的格式不对，软件没能识别，这几处没有改；可以让它按格式重发。）`;
  return { text, edits, shots, broken };
}

// Where a copied passage sits in a document: exactly, or with the spacing the model got wrong. Must be once.
function locate(content, find) {
  const exact = [];
  for (let i = content.indexOf(find); i !== -1 && exact.length < 2; i = content.indexOf(find, i + 1)) exact.push(i);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + find.length };
  if (exact.length > 1) return { error: '这段原文在文档里出现了不止一次，不知道改哪一处' };
  const words = find.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return { error: '没有要改的原文' };
  const loose = new RegExp(words.join('\\s*'), 'g');
  const found = [...content.matchAll(loose)].slice(0, 2);
  if (found.length === 1) return { start: found[0].index, end: found[0].index + found[0][0].length };
  return { error: found.length ? '这段原文在文档里出现了不止一次，不知道改哪一处' : '文档里找不到这段原文（可能已经改过了）' };
}

function createScriptChat({ getPaths, listShotIds, llm, now = () => Date.now() }) {
  let busy = false;
  const ids = { n: 0 };
  const newId = () => `m${now().toString(36)}${(ids.n++).toString(36)}`;

  function withPaths(fn) {
    const paths = getPaths();
    if (!paths) return { ok: false, message: '还没有打开剧本项目' };
    return fn(paths);
  }

  function docsInfo(paths, chat) {
    const all = D.listDocs(paths.docsDir, null).docs;
    const chosen = new Set(chosenDocs(chat, all));
    const docs = all.map((d) => {
      const r = d.size <= D.MAX_BYTES ? D.readDoc(paths.docsDir, d.relPath) : null;
      return { relPath: d.relPath, name: d.name, chars: r && r.ok ? r.content.length : 0, chosen: chosen.has(d.relPath) };
    });
    return { docs, chosenChars: docs.filter((d) => d.chosen).reduce((n, d) => n + d.chars, 0) };
  }

  const view = (paths, chat) => ({ ok: true, ...docsInfo(paths, chat), limit: MAX_CONTEXT, messages: chat.messages.map(({ raw, ...m }) => m), busy });

  function findEdit(chat, messageId, editId) {
    const message = chat.messages.find((m) => m.id === messageId);
    const edit = message && (message.edits || []).find((e) => e.id === editId);
    return edit ? { message, edit } : null;
  }

  return {
    load: () => withPaths((paths) => view(paths, readChat(paths.projectDir))),

    setDocs: (relPaths) => withPaths((paths) => {
      const chat = readChat(paths.projectDir);
      const known = new Set(D.listDocs(paths.docsDir, null).docs.map((d) => d.relPath));
      chat.docs = (Array.isArray(relPaths) ? relPaths : []).map(String).filter((p) => known.has(p));
      writeChat(paths.projectDir, chat);
      return view(paths, chat);
    }),

    clear: () => withPaths((paths) => {
      const chat = readChat(paths.projectDir);
      writeChat(paths.projectDir, { docs: chat.docs, messages: [] });
      return view(paths, { docs: chat.docs, messages: [] });
    }),

    async send(question) {
      const q = String(question || '').trim();
      if (!q) return { ok: false, message: '先写点什么' };
      if (q.length > MAX_QUESTION) return { ok: false, message: `一次最多 ${MAX_QUESTION} 个字` };
      const paths = getPaths();
      if (!paths) return { ok: false, message: '还没有打开剧本项目' };
      if (busy) return { ok: false, message: 'AI 还在回答上一个问题' };
      const chat = readChat(paths.projectDir);
      const listed = D.listDocs(paths.docsDir, null).docs;
      const relPaths = chosenDocs(chat, listed);
      const read = [];
      for (const relPath of relPaths) {
        const r = D.readDoc(paths.docsDir, relPath);
        if (r.ok && !r.readOnly) read.push({ relPath, content: r.content });
      }
      const docs = cacheOrder(read, Object.fromEntries(listed.map((d) => [d.relPath, d.mtimeMs])));
      const chars = docs.reduce((n, d) => n + d.content.length, 0);
      if (chars > MAX_CONTEXT) return { ok: false, message: `选给 AI 的文档太长了（约 ${Math.round(chars / 1000)} 千字），请少选几篇` };
      busy = true;
      try {
        const out = await llm(buildChatMessages({ docs, messages: chat.messages, question: q }));
        const raw = typeof out === 'string' ? out : String((out && out.content) || '');
        const cut = !!(out && out.finishReason === 'length');
        if (cut && !raw.trim()) return { ok: false, message: 'AI 想得太久，还没写出回答就到了长度上限。换个问法，或者把问题问得具体一点' };
        const reply = parseReply(raw, {
          docs: docs.map((d) => d.relPath), shotIds: listShotIds(), contents: Object.fromEntries(docs.map((d) => [d.relPath, d.content])),
        });
        if (cut) reply.text += `${reply.text ? '\n\n' : ''}（回复到了长度上限，后面没写完。可以说「接着写」让它补完。）`;
        // read again: the user may have applied or undone an edit while waiting
        const fresh = readChat(paths.projectDir);
        fresh.messages.push({ id: newId(), role: 'user', text: q, at: now() });
        fresh.messages.push({
          id: newId(), role: 'assistant', text: reply.text, raw: String(raw || ''), at: now(),
          edits: reply.edits.map((e) => ({ ...e, state: 'todo' })), shots: reply.shots, shotsDone: false, broken: reply.broken,
        });
        writeChat(paths.projectDir, fresh);
        return view(paths, fresh);
      } catch (e) {
        return { ok: false, message: e.message };
      } finally {
        busy = false;
      }
    },

    // Puts one edit into its document (the old version goes to the document's history, like any save).
    apply: (messageId, editId) => withPaths((paths) => {
      const chat = readChat(paths.projectDir);
      const hit = findEdit(chat, messageId, editId);
      if (!hit) return { ok: false, message: '找不到这处修改，请刷新' };
      const { edit } = hit;
      if (edit.state === 'applied') return { ok: false, message: '这处已经改过了' };
      const doc = D.readDoc(paths.docsDir, edit.doc);
      if (!doc.ok) return doc;
      if (doc.readOnly) return { ok: false, message: doc.readOnlyReason };
      const at = locate(doc.content, edit.find);
      if (at.error) return { ok: false, message: at.error };
      const content = doc.content.slice(0, at.start) + edit.replace + doc.content.slice(at.end);
      const saved = D.saveDoc({ docsDir: paths.docsDir, relPath: edit.doc, content, expectVersion: doc.version });
      if (!saved.ok) return saved;
      Object.assign(edit, { state: 'applied', was: doc.content.slice(at.start, at.end), at: at.start, version: saved.version });
      writeChat(paths.projectDir, chat);
      return { ...view(paths, chat), doc: edit.doc };
    }),

    // Takes an applied edit back out: where it went in, when the document has not changed since; else where its text is.
    undo: (messageId, editId) => withPaths((paths) => {
      const chat = readChat(paths.projectDir);
      const hit = findEdit(chat, messageId, editId);
      if (!hit || hit.edit.state !== 'applied') return { ok: false, message: '这处还没改，不用撤销' };
      const { edit } = hit;
      const doc = D.readDoc(paths.docsDir, edit.doc);
      if (!doc.ok) return doc;
      let at = null;
      if (doc.version === edit.version) at = { start: edit.at, end: edit.at + edit.replace.length };
      else if (edit.replace.trim()) at = locate(doc.content, edit.replace);
      if (!at || at.error) return { ok: false, message: '文档后来又改过，找不到改动的位置了。可以在「历史版本」里恢复' };
      const content = doc.content.slice(0, at.start) + edit.was + doc.content.slice(at.end);
      const saved = D.saveDoc({ docsDir: paths.docsDir, relPath: edit.doc, content, expectVersion: doc.version });
      if (!saved.ok) return saved;
      edit.state = 'todo';
      delete edit.was;
      delete edit.at;
      delete edit.version;
      writeChat(paths.projectDir, chat);
      return { ...view(paths, chat), doc: edit.doc };
    }),

    // The reply's shots were sent through the linked-edit dialog (rewritten or left with a note).
    shotsDone: (messageId) => withPaths((paths) => {
      const chat = readChat(paths.projectDir);
      const message = chat.messages.find((m) => m.id === messageId);
      if (!message) return { ok: false, message: '找不到这条回复，请刷新' };
      message.shotsDone = true;
      writeChat(paths.projectDir, chat);
      return view(paths, chat);
    }),
  };
}

module.exports = { MAX_CONTEXT, SYSTEM, readChat, chosenDocs, cacheOrder, historyStart, buildChatMessages, parseReply, locate, createScriptChat };
