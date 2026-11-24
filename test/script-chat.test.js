const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/script-chat');

function project() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
  const docsDir = path.join(projectDir, '剧本');
  fs.mkdirSync(path.join(docsDir, '第一集'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, '大纲.md'), '# 大纲\n\n第一场：何遇早上醒来。\n第二场：老周在厨房抽烟。\n');
  fs.writeFileSync(path.join(docsDir, '第一集', '旧稿.md'), '# 旧稿\n');
  return { projectDir, docsDir };
}

test('a reply is split into talk, edits to documents it was shown, and shots that exist', () => {
  const raw = [
    '老周抽烟和后面厨房戏冲突，建议换掉。',
    '<edit doc="大纲.md">\n<find>\n第二场：老周在厨房抽烟。\n</find>\n<replace>\n第二场：老周在厨房擦锅。\n</replace>\n<why>和后面对上</why>\n</edit>',
    '<edit doc="别的.md">\n<find>x</find>\n<replace>y</replace>\n</edit>',
    '<shots>\nMOTION-E01-010 | 还在抽烟 | 老周改成擦锅\nMOTION-E09-001 | 不存在 | 改\n</shots>',
    '你看行不行？',
  ].join('\n\n');
  const r = C.parseReply(raw, { docs: ['大纲.md'], shotIds: ['MOTION-E01-010'] });
  assert.equal(r.text, '老周抽烟和后面厨房戏冲突，建议换掉。\n\n你看行不行？');
  assert.deepEqual(r.edits, [{ id: 'e1', doc: '大纲.md', find: '第二场：老周在厨房抽烟。', replace: '第二场：老周在厨房擦锅。', why: '和后面对上' }]);
  assert.deepEqual(r.shots.map((s) => [s.shotId, s.remark]), [['MOTION-E01-010', '老周改成擦锅']]);
});

test('a copied passage is found exactly, or with the spacing changed; never when it is there twice', () => {
  assert.deepEqual(C.locate('甲乙丙', '乙'), { start: 1, end: 2 });
  const loose = C.locate('He rides  past\nthe cairn.', 'He rides past the cairn.');
  assert.equal(loose.start, 0);
  assert.match(C.locate('乙乙', '乙').error, /不止一次/);
  assert.match(C.locate('甲', '丁').error, /找不到/);
});

test('the documents go in the system prompt; earlier replies carry what became of their edits', () => {
  const m = C.buildChatMessages({
    docs: [{ relPath: '大纲.md', content: '正文' }],
    messages: [{ role: 'user', text: '问' }, { role: 'assistant', text: '答', raw: '答<edit>…</edit>', edits: [{ doc: '大纲.md', state: 'applied' }, { doc: '大纲.md', state: 'todo' }] }],
    question: '再问',
  });
  assert.match(m.system, /<doc path="大纲.md">\n正文\n<\/doc>/);
  assert.match(m.system, /不要用 edit 改，写进 shots/);
  assert.deepEqual(m.history.map((h) => h.role), ['user', 'assistant']);
  assert.equal(m.history[1].content, '答<edit>…</edit>', 'the reply as it was');
  assert.equal(m.user, '（你上一条回复里的修改，用户的处理：第 1 处（大纲.md）已应用；第 2 处（大纲.md）没应用。）\n\n再问');
  assert.equal(C.parseReply('好的。\n（用户对这些修改的处理：第 1 处已应用。）').text, '好的。', 'an echoed note is dropped');
});

test('a conversation: old drafts left out by default, an edit applied and undone, kept per project', async () => {
  const p = project();
  const asked = [];
  const chat = C.createScriptChat({
    getPaths: () => p,
    listShotIds: () => [],
    llm: async (m) => {
      asked.push(m);
      return '换成擦锅。\n<edit doc="大纲.md">\n<find>\n老周在厨房抽烟。\n</find>\n<replace>\n老周在厨房擦锅。\n</replace>\n</edit>';
    },
  });
  const start = chat.load();
  assert.deepEqual(start.docs.map((d) => [d.relPath, d.chosen]), [['大纲.md', true], ['第一集/旧稿.md', false]]);
  const r = await chat.send('老周别抽烟了');
  assert.equal(r.ok, true);
  assert.doesNotMatch(asked[0].system, /# 旧稿/);
  const reply = r.messages[1];
  assert.equal(reply.text, '换成擦锅。');
  assert.equal(reply.raw, undefined, 'the raw reply stays in the file');

  const file = path.join(p.docsDir, '大纲.md');
  const applied = chat.apply(reply.id, 'e1');
  assert.equal(applied.ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /老周在厨房擦锅。/);
  assert.equal(fs.readdirSync(path.join(p.docsDir, '.history', '大纲')).length, 1, 'the old version is in the history');
  assert.match(chat.apply(reply.id, 'e1').message, /已经改过/);

  assert.equal(chat.undo(reply.id, 'e1').ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /老周在厨房抽烟。/);

  // what the next question says about the edit, and the choice of documents, survive a restart
  chat.setDocs(['大纲.md', '第一集/旧稿.md']);
  const again = C.createScriptChat({ getPaths: () => p, listShotIds: () => [], llm: async (m) => { asked.push(m); return '好'; } });
  await again.send('再看看');
  assert.match(asked[1].system, /# 旧稿/);
  assert.match(asked[1].user, /第 1 处（大纲.md）没应用/);
  assert.equal(again.clear().messages.length, 0);
});

test('an undo after the document changed elsewhere finds the edit by its text', async () => {
  const p = project();
  const chat = C.createScriptChat({
    getPaths: () => p, listShotIds: () => [],
    llm: async () => '<edit doc="大纲.md">\n<find>何遇早上醒来。</find>\n<replace>何遇被闹钟震醒。</replace>\n</edit>',
  });
  const reply = (await chat.send('开头')).messages[1];
  chat.apply(reply.id, 'e1');
  const file = path.join(p.docsDir, '大纲.md');
  fs.writeFileSync(file, `前言\n${fs.readFileSync(file, 'utf8')}`);
  assert.equal(chat.undo(reply.id, 'e1').ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '前言\n# 大纲\n\n第一场：何遇早上醒来。\n第二场：老周在厨房抽烟。\n');
});

test('a reply cut off at the token limit keeps its finished edits and says it stopped', async () => {
  const p = project();
  const cut = [
    '先改大纲。',
    '<edit doc="大纲.md">', '<find>', '何遇早上醒来。', '</find>', '<replace>', '何遇被闹钟震醒。', '</replace>',
    '<edit doc="大纲.md">', '<find>', '老周在',
  ].join('\n');
  const answers = [{ content: cut, finishReason: 'length' }, { content: '', finishReason: 'length' }];
  const chat = C.createScriptChat({ getPaths: () => p, listShotIds: () => [], llm: async () => answers.shift() });
  const r = await chat.send('改开头');
  const reply = r.messages[1];
  assert.deepEqual(reply.edits.map((e) => e.replace), ['何遇被闹钟震醒。'], 'the unclosed edit counts, the unfinished one does not');
  assert.match(reply.text, /^先改大纲。\n\n（回复到了长度上限/);
  const empty = await chat.send('再来');
  assert.equal(empty.ok, false);
  assert.match(empty.message, /长度上限/);
});

test('an edit with malformed tags is not dropped in silence: the reply and the next turn both say so', () => {
  const raw = '先改时长。\n<edit doc="第一集/A.md\n- 时长：6.6s\n</find>\n<replace>\n- 时长：7.3s\n</replace>\n<why>加长</why>\n</edit>\n好了。';
  const { parseReply, buildChatMessages } = C;
  const r = parseReply(raw, { docs: ['第一集/A.md'] });
  assert.equal(r.edits.length, 0);
  assert.equal(r.broken, 1);
  assert.match(r.text, /1 处修改的格式不对/);
  const { user } = buildChatMessages({ docs: [], messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: r.text, edits: [], broken: 1 }], question: '接着' });
  assert.match(user, /另有 1 处 <edit> 格式不对/);
});

test('the heading run into the doc attribute is put back, when the passage is in exactly one document', () => {
  const { parseReply } = C;
  const raw = '先重发。\n<edit doc="第一集/MOTION-E01-015 · 一杯水\n- 分镜：SHOT-E01-015\n- 时长：6.6s\n</find>\n<replace>\n## MOTION-E01-015 · 一杯水\n- 分镜：SHOT-E01-015\n- 时长：7.3s\n</replace>\n<why>加长</why>\n</edit>\n\n三点。';
  const contents = {
    '第一集/MOTION.md': '# 上半集\n\n## MOTION-E01-015 · 一杯水\n- 分镜：SHOT-E01-015\n- 时长：6.6s\n- 其他',
    '第一集/总表.md': '| 015 | 一杯水 | 6.6s |',
  };
  const r = parseReply(raw, { docs: Object.keys(contents), contents });
  assert.equal(r.broken, 0);
  assert.equal(r.text, '先重发。\n\n三点。');
  assert.deepEqual(r.edits.map(({ doc, find, why }) => ({ doc, find, why })),
    [{ doc: '第一集/MOTION.md', find: '## MOTION-E01-015 · 一杯水\n- 分镜：SHOT-E01-015\n- 时长：6.6s', why: '加长' }]);
  assert.match(r.edits[0].replace, /时长：7\.3s$/);
});

test('the documents go in the order they last changed, so an edit leaves the ones before it as they were sent', async () => {
  assert.deepEqual(C.cacheOrder([{ relPath: 'b.md' }, { relPath: 'a.md' }, { relPath: 'c.md' }], { 'a.md': 30, 'b.md': 10, 'c.md': 10 }).map((d) => d.relPath),
    ['b.md', 'c.md', 'a.md']);
  const p = project();
  fs.writeFileSync(path.join(p.docsDir, '人物.md'), '# 人物\n');
  const at = (rel, s) => fs.utimesSync(path.join(p.docsDir, rel), s, s);
  at('大纲.md', 1000);
  at('人物.md', 2000);
  const asked = [];
  const edit = (from, to) => `换。\n<edit doc="大纲.md">\n<find>\n${from}\n</find>\n<replace>\n${to}\n</replace>\n</edit>`;
  const replies = [edit('老周在厨房抽烟。', '老周在厨房擦锅。'), edit('老周在厨房擦锅。', '老周在厨房切菜。'), '好'];
  const chat = C.createScriptChat({ getPaths: () => p, listShotIds: () => [], llm: async (m) => { asked.push(m); return replies.shift(); } });
  const first = await chat.send('看看');
  assert.ok(asked[0].system.indexOf('<doc path="大纲.md">') < asked[0].system.indexOf('<doc path="人物.md">'));
  assert.equal(chat.apply(first.messages[1].id, 'e1').ok, true);
  const second = await chat.send('再看看');
  const cut = asked[1].system.indexOf('<doc path="大纲.md">');
  assert.ok(asked[1].system.indexOf('<doc path="人物.md">') < cut, 'the edited document moved to the end');
  // edited again: only the document itself changes; everything in front of it goes out exactly as before
  assert.equal(chat.apply(second.messages[3].id, 'e1').ok, true);
  await chat.send('还有吗');
  assert.match(asked[2].system, /老周在厨房切菜。/);
  assert.equal(asked[2].system.slice(0, cut), asked[1].system.slice(0, cut));
});

test('the conversation sent along lets old messages go a few at a time, starting on a question', () => {
  assert.equal(C.historyStart(10), 0);
  assert.equal(C.historyStart(24), 0);
  for (const n of [26, 28, 30]) assert.equal(C.historyStart(n), 0);
  assert.equal(C.historyStart(32), 8);
  assert.equal(C.historyStart(38), 8);
  assert.equal(C.historyStart(40), 16);
  const messages = Array.from({ length: 26 }, (_, i) => (i % 2 ? { role: 'assistant', text: `a${i}` } : { role: 'user', text: `q${i}` }));
  const one = C.buildChatMessages({ docs: [], messages, question: 'x' });
  const two = C.buildChatMessages({ docs: [], messages: [...messages, { role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }], question: 'z' });
  assert.equal(one.history[0].content, 'q0');
  assert.deepEqual(two.history.slice(0, one.history.length), one.history, 'the next question repeats the conversation as it was sent');
  const pairs = (n) => Array.from({ length: n }, (_, i) => [{ role: 'user', text: `x${i}` }, { role: 'assistant', text: `y${i}` }]).flat();
  const later = C.buildChatMessages({ docs: [], messages: [...messages, ...pairs(3)], question: 'z' });
  assert.equal(later.history.length, 24, 'at 32 messages the first 8 go');
  assert.equal(later.history[0].content, 'q8');
});
