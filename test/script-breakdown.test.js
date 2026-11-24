const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../src/script-breakdown');
const { parseShots, listScriptShots } = require('../src/script-shots');
const { parseCards } = require('../src/asset-cards');

const PROMPT = [
  'subject_definitions:', '<Subject 1> is the man in <Picture 1>.', '', 'summary:', '[reference generation] He waits.', '',
  'retention_analysis:', 'fully_preserved', '', 'detailed_description:', 'He looks up.', '', 'overall_soundscape:', 'Rain.', '',
  'non_diegetic_music:', 'N/A',
].join('\n');

// ---------- splitting ----------
test('episode headings split the script; the text before the first one goes with it', () => {
  const eps = B.splitEpisodes('人物：张三\n\n# 第一集 重逢\n张三进门。\n\n第2集：分开\n李四走了。\nEP03\n雨夜。');
  assert.deepEqual(eps.map((e) => e.number), [1, 2, 3]);
  assert.equal(eps[0].title, '重逢');
  assert.equal(eps[1].title, '分开');
  assert.match(eps[0].text, /人物：张三/);
  assert.match(eps[0].text, /张三进门/);
  assert.match(eps[2].text, /雨夜/);
});

test('a script without episode headings is one episode', () => {
  const eps = B.splitEpisodes('张三进门。\n\n李四走了。');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].number, 1);
});

test('Chinese numbers', () => {
  assert.equal(B.cnNumber('十二'), 12);
  assert.equal(B.cnNumber('二十'), 20);
  assert.equal(B.cnNumber('一百零五'), 105);
  assert.equal(B.cnNumber('7'), 7);
});

test('long text is cut between paragraphs into pieces no longer than the limit', () => {
  const text = Array.from({ length: 30 }, (_, i) => `第${i}段。`.repeat(10)).join('\n\n');
  const chunks = B.chunkText(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, c.length);
  assert.equal(chunks.join('\n\n').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

// ---------- parsing the AI ----------
test('cards: new ones only, codes unique and legal, kinds understood', () => {
  const known = [{ code: 'ZS', kind: 'char', name: '张三' }];
  const raw = '```json\n' + JSON.stringify({
    style: '写实电影质感',
    cards: [
      { code: 'ZS', kind: '人物', name: '张三', look: '已有' },
      { code: 'ZS', kind: '人物', name: '赵四', look: '四十岁' },
      { code: '老街', kind: '场景', name: '老街', look: '石板路' },
      { code: 'li si', kind: '人物', name: '李四', look: '二十岁' },
    ],
  }) + '\n```';
  const r = B.parseCast(raw, known);
  assert.equal(r.style, '写实电影质感');
  assert.deepEqual(r.cards.map((c) => [c.code, c.kind, c.name]), [['ZS-2', 'char', '赵四'], ['S', 'scene', '老街'], ['LI-SI', 'char', '李四']]);
});

test('shot list: unknown codes dropped, lengths kept in range, empty shots skipped', () => {
  const codes = new Set(['ZS', 'S-LJ']);
  const shots = B.parseList(JSON.stringify({ shots: [
    { title: '进门', duration: 40, description: '中景，张三推门进来。', cast: ['zs', 'NOBODY', 'S-LJ'], continue: true },
    { title: '空', description: '' },
    { description: '特写，张三说「回来了」。', duration: 'x', cast: [] },
  ] }), codes);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0].cast, ['ZS', 'S-LJ']);
  assert.equal(shots[0].duration, 15);
  assert.equal(shots[0].continue, false, 'nothing before the first shot to continue');
  assert.equal(shots[1].duration, 6);
  assert.ok(shots[1].title);
});

test('a shot whose framing changes cannot continue the one before', () => {
  const shots = B.fixContinuity([
    { description: '中景固定，头灯亮起。', continue: true },
    { description: '近景，她看表。', continue: true },
    { description: '近景，她抬头。', continue: true },
    { description: '她往前走了一步。', continue: true },
    { description: '特写，表盘。', continue: false },
  ]);
  assert.deepEqual(shots.map((s) => s.continue), [false, false, true, true, false]);
  // across two pieces of the same episode: the last shot of the piece before counts
  assert.equal(B.fixContinuity([{ description: '远景，洞口。', continue: true }], { description: '近景，她。' })[0].continue, false);
});

test('a reply without the list is an error', () => {
  assert.throws(() => B.parseList('好的，我来拆', new Set()), /JSON/);
  assert.throws(() => B.parseList('{"shots":[]}', new Set()), /空/);
});

// ---------- documents the rest of the app reads ----------
test('the cards document reads back as the asset page reads it', () => {
  const text = B.cardsDoc({ style: '写实电影质感', cards: [
    { code: 'ZS', kind: 'char', name: '张三', look: '三十岁 | 寸头' },
    { code: 'S-LJ', kind: 'scene', name: '老街', look: '石板路，雨后' },
  ] });
  const parsed = parseCards(text, 'x.md');
  assert.equal(parsed.style, '写实电影质感');
  assert.deepEqual(parsed.cards.map((c) => [c.code, c.kind, c.name, c.description]), [['ZS', 'char', '张三', '三十岁 | 寸头'], ['S-LJ', 'scene', '老街', '石板路，雨后']]);
});

test('the MOTION document reads back as the shot page reads it', () => {
  const cards = new Map([['ZS', { code: 'ZS', kind: 'char', name: '张三' }], ['S-LJ', { code: 'S-LJ', kind: 'scene', name: '老街' }]]);
  const text = B.motionDoc({ id: 'E02', title: '重逢', shots: [
    { title: '进门', duration: 6, description: '张三推门。', cast: ['ZS', 'S-LJ'], codes: ['ZS', 'S-LJ'], continue: false, prompt: PROMPT },
    { title: '回头', duration: 4.5, description: '张三回头。', cast: ['ZS'], continue: true, prompt: '' },
  ] }, cards);
  const shots = parseShots(text, '分镜/MOTION-E02.md');
  assert.deepEqual(shots.map((s) => s.id), ['MOTION-E02-001', 'MOTION-E02-002']);
  assert.equal(shots[0].title, '进门');
  assert.equal(shots[0].duration, 6);
  assert.equal(shots[0].prompt, PROMPT);
  assert.deepEqual(shots[0].references.map((r) => [r.id, r.order, r.title]), [['IMG-ZS', 1, '张三'], ['IMG-S-LJ', 2, '老街']]);
  assert.equal(shots[1].continuePrevious, true);
  assert.equal(shots[1].prompt, '');
});

// ---------- the whole run ----------
async function settle(svc) {
  for (let i = 0; i < 200; i++) {
    const v = svc.load();
    if (!v.running) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('still running');
}

function project(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-breakdown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, '剧本.md'), script);
  return { projectDir: root, docsDir };
}

function fakeLlm(calls) {
  return async (m) => {
    calls.push(m.purpose);
    if (/人物场景/.test(m.purpose)) {
      return { content: JSON.stringify({ style: '写实', cards: [{ code: 'ZS', kind: '人物', name: '张三', look: '三十岁' }, { code: 'S-LJ', kind: '场景', name: '老街', look: '石板路' }] }) };
    }
    const ep = /第 (\d+) 集/.exec(m.user)[1];
    return { content: JSON.stringify({ shots: [
      { title: `第${ep}集开场`, duration: 5, description: '远景，老街。', cast: ['S-LJ'], continue: true },
      { title: '进门', duration: 6, description: '张三推门说「我回来了」。', cast: ['ZS', 'S-LJ'], continue: true },
    ] }) };
  };
}

const fakeCompose = (seen) => async (o) => {
  seen.push(o);
  return { ok: true, prompt: PROMPT, codes: o.cards.map((c) => c.code), duration: 5.5, continue: false, title: o.title };
};

test('plan, review and write: the shot page and the asset page find what was written', async (t) => {
  const paths = project(t, '# 第一集\n张三回到老街。\n\n# 第二集\n张三又走了。');
  // an episode the project already has keeps its id
  fs.mkdirSync(path.join(paths.docsDir, '分镜'), { recursive: true });
  fs.writeFileSync(path.join(paths.docsDir, '分镜', 'MOTION-E01.md'), `## MOTION-E01-001 · 旧的\n- 时长：4s\n\n### 可复制提示词\n> ${PROMPT.split('\n').join('\n> ')}\n`);
  const calls = [];
  const seen = [];
  const svc = B.createScriptBreakdown({ getPaths: () => paths, llm: fakeLlm(calls), compose: fakeCompose(seen) });

  assert.ok(svc.load().docs.some((d) => d.relPath === '剧本.md'));
  const started = svc.start(['剧本.md']);
  assert.equal(started.ok, true, started.message);
  let v = await settle(svc);
  assert.equal(v.state.phase, 'review', v.state.error);
  assert.deepEqual(v.state.episodes.map((e) => e.id), ['E02', 'E03']);
  assert.equal(v.state.episodes[0].shots[0].continue, false, 'the first shot of an episode never continues');
  assert.deepEqual(v.state.cards.map((c) => c.code), ['ZS', 'S-LJ']);
  assert.deepEqual(calls, ['剧本拆分镜·人物场景', '剧本拆分镜·镜头清单', '剧本拆分镜·镜头清单']);

  // the user drops a shot and renames a card
  const plan = JSON.parse(JSON.stringify(v.state));
  plan.episodes[1].shots.pop();
  plan.cards[0].name = '张小三';
  v = svc.update(plan);
  assert.equal(v.ok, true, v.message);
  assert.equal(v.state.episodes[1].shots.length, 1);

  assert.equal(svc.write().ok, true);
  v = await settle(svc);
  assert.equal(v.state.phase, 'done', v.state.error);
  assert.equal(seen.length, 3);
  assert.equal(seen[1].previous.id, 'MOTION-E02-001');
  assert.equal(seen[0].next.id, 'MOTION-E02-002');
  assert.match(seen[0].description, /画风：写实/);

  const listed = listScriptShots({ docsDir: paths.docsDir });
  assert.deepEqual(listed.shots.map((s) => s.id), ['MOTION-E01-001', 'MOTION-E02-001', 'MOTION-E02-002', 'MOTION-E03-001']);
  const second = listed.shots.find((s) => s.id === 'MOTION-E02-002');
  assert.equal(second.prompt, PROMPT);
  assert.equal(second.duration, 5.5);
  assert.equal(second.continuePrevious, true);
  assert.deepEqual(second.references.map((r) => r.id), ['IMG-ZS', 'IMG-S-LJ']);
  const cards = parseCards(fs.readFileSync(path.join(paths.docsDir, B.CARDS_DOC), 'utf8'), B.CARDS_DOC);
  assert.deepEqual(cards.cards.map((c) => c.name), ['张小三', '老街']);

  // a new run is refused until this one is put away; then it starts fresh
  assert.equal(svc.start(['剧本.md']).ok, true, 'done plans can be replaced');
  await settle(svc);
});

test('cards the project already has are reused, not listed again', async (t) => {
  const paths = project(t, '张三回到老街。');
  const calls = [];
  const svc = B.createScriptBreakdown({
    getPaths: () => paths, llm: fakeLlm(calls), compose: fakeCompose([]),
    getCards: () => [{ code: 'ZS', kind: 'char', name: '张三', description: '三十岁', main: 'ref/zs.png' }], getStyle: () => '水墨',
  });
  svc.start(['剧本.md']);
  const v = await settle(svc);
  assert.deepEqual(v.state.cards.map((c) => c.code), ['S-LJ']);
  assert.deepEqual(v.state.existing.map((c) => c.code), ['ZS']);
  assert.equal(v.state.style, '水墨');
});

test('a failed shot is retried on the next write; a stop leaves the rest for later', async (t) => {
  const paths = project(t, '张三回到老街。');
  let fail = true;
  const svc = B.createScriptBreakdown({
    getPaths: () => paths, llm: fakeLlm([]),
    compose: async (o) => {
      if (fail && /推门/.test(o.description)) return { ok: false, message: '没写好' };
      return { ok: true, prompt: PROMPT, codes: [], duration: 5 };
    },
  });
  svc.start(['剧本.md']);
  await settle(svc);
  svc.write();
  let v = await settle(svc);
  assert.equal(v.state.phase, 'done');
  const shots = v.state.episodes[0].shots;
  assert.deepEqual(shots.map((s) => s.status), ['done', 'failed']);
  assert.equal(shots[1].error, '没写好');
  fail = false;
  svc.write();
  v = await settle(svc);
  assert.deepEqual(v.state.episodes[0].shots.map((s) => s.status), ['done', 'done']);
});

test('a MOTION document edited after the split is not overwritten', async (t) => {
  const paths = project(t, '张三回到老街。');
  let fail = true;
  const svc = B.createScriptBreakdown({
    getPaths: () => paths, llm: fakeLlm([]),
    compose: async (o) => (fail && /推门/.test(o.description) ? { ok: false, message: 'x' } : { ok: true, prompt: PROMPT, codes: [], duration: 5 }),
  });
  svc.start(['剧本.md']);
  await settle(svc);
  svc.write();
  let v = await settle(svc);
  const doc = path.join(paths.docsDir, v.state.episodes[0].doc);
  fs.appendFileSync(doc, '\n我自己加的一句\n');
  fail = false;
  svc.write();
  v = await settle(svc);
  assert.equal(v.state.phase, 'stopped');
  assert.match(v.state.error, /被改过了/);
  assert.match(fs.readFileSync(doc, 'utf8'), /我自己加的一句/);
});

test('nothing to split, or too much, is refused before any AI call', (t) => {
  const paths = project(t, '');
  const svc = B.createScriptBreakdown({ getPaths: () => paths, llm: async () => { throw new Error('no call'); } });
  assert.equal(svc.start([]).ok, false);
  assert.equal(svc.start(['剧本.md']).ok, false);
  fs.writeFileSync(path.join(paths.docsDir, '剧本.md'), '字'.repeat(400001));
  assert.match(svc.start(['剧本.md']).message, /太长/);
  assert.equal(B.createScriptBreakdown({ getPaths: () => null, llm: async () => '' }).load().ok, false);
});
