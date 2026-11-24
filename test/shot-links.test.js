const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../src/shot-links');
const { rewriteShotPrompt, rewritePicture } = require('../src/prompt-rewrite');
const { buildRevisionMessages, buildPictureRevisionMessages } = require('../src/prompt-optimizers');

const six = (beats) => ['subject_definitions: <Subject 1> is a rider.', 'summary: s', 'retention_analysis: r', `detailed_description: ${beats}`, 'overall_soundscape: wind', 'non_diegetic_music: N/A'].join('\n');
const ORDER = [
  { id: 'MOTION-E00-006', prompt: six('He rides past the cairn.') },
  { id: 'MOTION-E00-007', prompt: six('He stops and mounts.'), continuePrevious: true },
  { id: 'MOTION-E00-008', prompt: six('He freezes, then backs away.'), continuePrevious: true },
  { id: 'MOTION-E00-009', prompt: six('He turns and runs.') },
];

test('the shots around one: the one before, the next one, and which are made from the other\'s end', () => {
  const near = L.neighboursOf({ order: ORDER, shotId: 'MOTION-E00-007' });
  assert.deepEqual({ id: near.previous.id, joined: near.previous.joined }, { id: 'MOTION-E00-006', joined: true });
  assert.deepEqual(near.next.map((n) => [n.id, n.joined]), [['MOTION-E00-008', true]]);
  // a draft that chose otherwise wins over the script's flag; a later shot made from this one counts too
  const drafts = new Map([['MOTION-E00-008', { continuation: { mode: 'none' } }], ['MOTION-E00-009', { continuation: { mode: 'shot', shotId: 'MOTION-E00-007' } }]]);
  const other = L.neighboursOf({ order: ORDER, drafts, shotId: 'MOTION-E00-007' });
  assert.deepEqual(other.next.map((n) => [n.id, n.joined]), [['MOTION-E00-008', false], ['MOTION-E00-009', true]]);
  const text = L.neighbourText(near);
  assert.match(text, /上一镜 MOTION-E00-006（这一镜接着它生成/);
  assert.match(text, /He rides past the cairn\./);
  assert.doesNotMatch(text, /subject_definitions/, 'only the beats of a neighbour');
  assert.equal(L.sectionOf(ORDER[0].prompt, 'summary'), 's');
});

test('affected shots are read from the reply, only those the request showed', () => {
  const raw = '<note>n</note>\n<prompt>\nx\n</prompt>\n<affects>\nMOTION-E00-008 | 开头接的是停住的车 | 开头他已经停稳，从停住的状态开始\nMOTION-E01-001 | 不相干 | 改\nMOTION-E00-008 | 重复 | 再改\n</affects>';
  assert.deepEqual(L.parseAffects(raw, ['MOTION-E00-006', 'MOTION-E00-008']), [
    { shotId: 'MOTION-E00-008', n: '008', reason: '开头接的是停住的车', remark: '开头他已经停稳，从停住的状态开始' },
  ]);
  assert.deepEqual(L.parseAffects('<affects></affects>', ['MOTION-E00-008']), []);
  assert.deepEqual(L.fromList([{ shot: 'motion-e00-010', reason: '还写着烟', remark: '老周耳朵干净' }, { shot: 'MOTION-E00-011', reason: 'x', remark: '' }], ['MOTION-E00-010', 'MOTION-E00-011']),
    [{ shotId: 'MOTION-E00-010', n: '010', reason: '还写着烟', remark: '老周耳朵干净' }]);
});

test('notes on shots left behind are kept per project until cleared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  assert.deepEqual(L.readNotes(dir), {});
  L.setNote(dir, 'MOTION-E00-008', { from: '镜头 007 ', reason: '开头对不上', remark: '从停住开始' }, 5);
  assert.deepEqual(L.readNotes(dir)['MOTION-E00-008'], { from: '镜头 007 ', reason: '开头对不上', remark: '从停住开始', at: 5 });
  L.clearNote(dir, 'MOTION-E00-008');
  assert.deepEqual(L.readNotes(dir), {});
});

test('the rewrite request shows the neighbours and asks for <affects>; without them it does not', () => {
  const around = L.neighbourText(L.neighboursOf({ order: ORDER, shotId: 'MOTION-E00-007' }));
  const m = buildRevisionMessages({ text: ORDER[1].prompt, feedback: '车别往前', neighbours: around });
  assert.match(m.user, /He freezes, then backs away\./);
  // the rules and the format for the shots around it are in the fixed system prompt, saying when they apply; the
  // user message only asks for them, so the cache covers the rules either way
  assert.match(m.system, /<affects>\n镜头编号 \| 原因 \| 给那一镜的修改说明\n<\/affects>/);
  assert.match(m.system, /尽量不动后面镜头要接的东西/);
  assert.match(m.user, /再输出 <affects>。$/);
  assert.doesNotMatch(m.user, /尽量不动后面镜头/);
  // the shots around it come before the prompt: the same on every pass, so the passes after the first read them cached
  assert.ok(m.user.indexOf('He freezes') < m.user.indexOf('当前完整提示词'));
  const plain = buildRevisionMessages({ text: ORDER[1].prompt, feedback: '车别往前' });
  assert.match(plain.user, /这次不输出 <affects>/);
  assert.equal(m.system, plain.system);
  const usage = L.usageText([{ id: 'MOTION-E01-010', prompt: six('x') }]);
  const card = buildPictureRevisionMessages({ card: { name: '老周' }, mode: 't2i', ask: '', look: '烟夹在耳后', feedback: '去掉烟', usage });
  assert.match(card.user, /用到这张卡的镜头[\s\S]*MOTION-E01-010[\s\S]*<Subject 1> is a rider/);
  assert.match(card.user, /带上 affects/);
  assert.match(card.system, /"affects"/);
  const alone = buildPictureRevisionMessages({ card: { name: '老周' }, mode: 't2i', ask: '', look: '烟夹在耳后', feedback: '去掉烟' });
  assert.doesNotMatch(alone.user, /affects/);
  assert.equal(card.system, alone.system);
});

test('a shot rewrite returns the shots that must follow it; the tidy step does not add any', async () => {
  const asked = [];
  const replies = [
    `<note>停住了</note>\n<prompt>\n${six('He stops dead.')}\n</prompt>\n<affects>\nMOTION-E00-008 | 开头要接停住 | 开头他已经停稳\n</affects>`,
    `<note>整理</note>\n<prompt>\n${six('He stops dead.')}\n</prompt>\n<affects>\nMOTION-E00-006 | x | y\n</affects>`,
  ];
  const r = await rewriteShotPrompt({
    text: ORDER[1].prompt, feedback: '车别往前', context: {}, around: { text: 'around', ids: ['MOTION-E00-006', 'MOTION-E00-008'] },
    llm: async (m) => { asked.push(m); return replies.shift(); },
  });
  assert.deepEqual(r.affects.map((a) => a.shotId), ['MOTION-E00-008']);
  assert.match(asked[0].user, /around/);
  assert.doesNotMatch(asked[1].user, /around/, 'the tidy step works on the shot alone');
});

test('a card rewrite names shots only when the look changed', async () => {
  const reply = (look) => JSON.stringify({ look, ask: '半身', note: 'n', affects: [{ shot: 'MOTION-E01-010', reason: '还写着烟', remark: '老周耳朵干净' }] });
  const users = { text: 'users', ids: ['MOTION-E01-010'] };
  const changed = [reply('肩上搭毛巾'), reply('肩上搭毛巾')];
  const r = await rewritePicture({ card: { name: '老周' }, mode: 't2i', ask: '半身', look: '肩上搭毛巾，烟夹在耳后', feedback: '去掉烟', users, llm: async () => changed.shift() });
  assert.deepEqual(r.affects.map((a) => a.shotId), ['MOTION-E01-010']);
  const same = [reply('肩上搭毛巾'), reply('肩上搭毛巾')];
  const s = await rewritePicture({ card: { name: '老周' }, mode: 't2i', ask: '全身', look: '肩上搭毛巾', feedback: '换成半身', users, llm: async () => same.shift() });
  assert.deepEqual(s.affects, []);
});
