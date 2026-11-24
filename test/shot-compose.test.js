const test = require('node:test');
const assert = require('node:assert/strict');
const { composeShot } = require('../src/shot-compose');
const { buildComposeMessages, parseCompose } = require('../src/prompt-optimizers');

const CARDS = [
  { code: 'AC23', kind: 'char', name: '阿措', description: '二十出头，扎马尾', main: 'ref/ac23.png' },
  { code: 'YS-DT', kind: 'scene', name: '大堂', description: '木地板，旗墙', main: 'ref/ys.png' },
  { code: 'DD8', kind: 'char', name: '朵朵', description: '八岁', main: '' },
];
const six = (refs = 2) => [
  'subject_definitions:',
  '<Subject 1> is the young woman from <Picture 1>.',
  ...(refs > 1 ? ['<Subject 2> is the hotel lobby from <Picture 2>.'] : []),
  '', 'summary:', 'She carries a bowl to the window.',
  '', 'retention_analysis:', '<Subject 1>: fully_preserved.',
  '', 'detailed_description:', 'Realistic drama look. [Shot 1] <Subject 1> walks to the window holding the bowl. She pauses, steam rising.',
  '', 'overall_soundscape:', 'Footsteps on wood.',
  '', 'non_diegetic_music:', 'N/A',
].join('\n');
const reply = (meta, prompt = six()) => `<note>她端粥到窗边</note>\n<meta>${JSON.stringify(meta)}</meta>\n<prompt>\n${prompt}\n</prompt>`;

test('the request is one fixed system prompt; cards and neighbours come before the user words', () => {
  const a = buildComposeMessages({ cards: CARDS, previous: { id: 'MOTION-E01-016', prompt: 'PREV' }, next: { id: 'MOTION-E01-017', prompt: 'NEXT' }, description: '端粥' });
  const b = buildComposeMessages({ cards: [], description: '别的' });
  assert.equal(a.system, b.system);
  assert.doesNotMatch(a.system, /\$\{|undefined/);
  assert.match(a.user, /- AC23 \| 人物 \| 阿措/);
  assert.doesNotMatch(a.user, /DD8/); // no picture, nothing to hang
  assert.ok(a.user.indexOf('PREV') < a.user.indexOf('端粥'));
  assert.ok(a.user.indexOf('AC23') < a.user.indexOf('PREV'));
  assert.match(b.user, /本集第一镜/);
  assert.match(b.user, /不挂参考图/);
});

test('the reply is read as note, settings and prompt', () => {
  const r = parseCompose(reply({ title: '端粥', duration: 6, references: ['AC23'], continue: true }));
  assert.equal(r.note, '她端粥到窗边');
  assert.deepEqual(r.meta, { title: '端粥', duration: 6, references: ['AC23'], continue: true });
  assert.throws(() => parseCompose('<meta>{}</meta><prompt>\nhalf'), /没有写完/);
  assert.throws(() => parseCompose('<prompt>p</prompt>'), /没有 <meta>/);
});

test('a good reply is taken as it is', async () => {
  const asked = [];
  const r = await composeShot({
    description: '阿措端着粥走到窗边', cards: CARDS, previous: { id: 'P', prompt: 'x' }, maxReferences: 6,
    llm: async (m) => { asked.push(m); return reply({ title: '端粥', duration: 6, references: ['ac23', 'YS-DT'], continue: true }); },
  });
  assert.equal(asked.length, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.codes, ['AC23', 'YS-DT']);
  assert.equal(r.continue, true);
  assert.equal(r.duration, 6);
  assert.match(r.prompt, /No subtitles/);
  assert.deepEqual(r.warnings, []);
});

test('wrong settings go back to the model with what is wrong, as a follow-up turn', async () => {
  const asked = [];
  const replies = [
    reply({ title: 't', duration: 'six', references: ['DD8', 'XX', 'AC23'], continue: true }, six(1)),
    reply({ title: 't', duration: 5, references: ['AC23'], continue: true }, six(1)),
  ];
  const r = await composeShot({ description: 'x', cards: CARDS, llm: async (m) => { asked.push(m); return replies.shift(); } });
  assert.equal(asked.length, 2);
  const problems = asked[1].user;
  assert.match(problems, /「DD8」还没有图/);
  assert.match(problems, /「XX」不是素材卡代号/);
  assert.match(problems, /duration 要写成秒数/);
  // the first request and answer are kept word for word ahead of the fix, so the retry reads them cached
  assert.equal(asked[1].history[0].content, asked[0].user);
  assert.equal(asked[1].system, asked[0].system);
  assert.equal(r.ok, true);
  assert.deepEqual(r.codes, ['AC23']);
  assert.equal(r.continue, false); // no shot before it to continue
});

test('a picture hung but never used, or one too many, is sent back; the best try is kept', async () => {
  const replies = [
    reply({ title: 't', duration: 6, references: ['AC23', 'YS-DT'] }, six(1)),
    'no format at all',
    'still nothing',
  ];
  const r = await composeShot({ description: 'x', cards: CARDS, llm: async () => replies.shift() });
  assert.equal(r.ok, true);
  assert.match(r.warnings[0], /没有用到 <Picture 2>/);
  const broken = await composeShot({ description: 'x', cards: CARDS, llm: async () => reply({ duration: 6, references: [] }, 'just text') });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /六段/);
  assert.equal((await composeShot({ description: ' ', llm: async () => '' })).ok, false);
});
