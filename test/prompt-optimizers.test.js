const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOptimizerMessages, buildRevisionMessages, buildPictureRevisionMessages,
  parseOptimizedText, parseRevision, parsePictureRevision, checkRevision, contextText, OPTIMIZERS, FOCUS_RULES,
} = require('../src/prompt-optimizers');

// a continued, reference-free shot in the shape the script writes them
const SHOT = [
  'subject_definitions:',
  '<Subject 1> is the loaded touring bicycle from the previous moment, seen from the rider\'s chest.',
  '<Subject 2> is the dark road over the mountain pass at night, in thin mist.',
  '',
  'summary:',
  '[reference generation] Continuing the chest-mounted night footage: he rides around the cairn.',
  '',
  'retention_analysis:',
  '<Subject 1> (appears in [Shot 1]): partially_preserved - handlebar and gloves.',
  '',
  'detailed_description:',
  '[Shot 1] He pushes off from the middle of <Subject 2>. The rider (S1) calls out, <d>[Chinese] 师傅？车坏了吗？</d> He whispers, <d>[Chinese] ……血？</d>',
  '',
  'overall_soundscape:',
  'Tires on wet asphalt, wind.',
  '',
  'non_diegetic_music:',
  'N/A',
].join('\n');

test('optimizer messages include H3 constraints and reference ordering', () => {
  const messages = buildOptimizerMessages({
    optimizer: 'refine',
    text: 'original prompt',
    context: { references: ['hero.png [output]', 'tunnel.png [output]'], duration: 5.5, width: 1056, height: 608 },
  });
  assert.match(messages.system, /六段顺序/);
  assert.match(messages.system, /起点 → 唯一动作 → 终点/);
  assert.match(messages.user, /<Picture 1> = hero\.png \[output\]/);
  assert.match(messages.user, /<Picture 2> = tunnel\.png \[output\]/);
  assert.match(messages.user, /5\.5 秒/);
  assert.match(messages.user, /1056 × 608/);
  assert.equal(messages.temperature, 0.2);
  assert.match(contextText({ references: [] }), /参考图数量：0/);
});

test('main operations compose all or selected focus rules', () => {
  assert.equal(Object.keys(OPTIMIZERS).length, 2);
  assert.equal(Object.keys(FOCUS_RULES).length, 6);
  const full = buildOptimizerMessages({ optimizer: 'refine', text: 'test', context: { references: [] } });
  const label = (rule) => rule.split('：')[0];
  for (const rule of Object.values(FOCUS_RULES)) assert.equal(full.user.includes(label(rule)), true);

  const selected = buildOptimizerMessages({ optimizer: 'refine', text: 'test', context: { references: [] }, focus: ['camera', 'continuity'] });
  assert.match(selected.user, /本次优化重点：运镜与光线、参考图与连续性\n/);
  assert.equal(selected.user.includes(label(FOCUS_RULES.performance)), false);
  assert.equal(selected.user.includes(label(FOCUS_RULES.audio)), false);

  const none = buildOptimizerMessages({ optimizer: 'refine', text: 'test', context: { references: [] }, focus: [] });
  assert.equal(none.user.includes('本次优化重点'), false);

  // every task and focus rule is spelled out in the one fixed system prompt (cached); the user message only names them
  const expand = buildOptimizerMessages({ optimizer: 'expand', text: 'other', context: { references: ['a.png'] }, focus: ['audio'] });
  assert.ok(expand.user.startsWith('任务：扩写\n'));
  for (const m of [selected, none, expand]) assert.equal(m.system, full.system);
  for (const rule of Object.values(FOCUS_RULES)) assert.equal(full.system.includes(rule), true);
  for (const o of Object.values(OPTIMIZERS)) assert.equal(full.system.includes(o.task), true);
  for (const rule of Object.values(FOCUS_RULES)) assert.equal(full.user.includes(rule), false);
});

test('every shot rewrite and every card rewrite opens with one fixed system prompt', () => {
  const variants = [
    buildRevisionMessages({ text: SHOT, feedback: 'a', context: { references: [] } }),
    buildRevisionMessages({ text: 'other', feedback: 'b', context: { references: ['x.png'], duration: 6, continuation: true, blocking: '站位' } }),
    buildRevisionMessages({ text: SHOT, feedback: 'c', context: { continuation: false }, neighbours: '上一镜：…' }),
  ];
  for (const m of variants) assert.equal(m.system, variants[0].system);
  assert.doesNotMatch(variants[0].system, /\$\{|undefined/);
  const card = { name: '何遇', kind: 'char', style: 's', description: 'd' };
  const pictures = [
    buildPictureRevisionMessages({ card, mode: 't2i', ask: 'a', feedback: 'f' }),
    buildPictureRevisionMessages({ card: { ...card, kind: 'scene' }, mode: 'i2i', ask: '', feedback: 'g', usage: '用到这张卡的镜头：…' }),
  ];
  assert.equal(pictures[1].system, pictures[0].system);
  assert.doesNotMatch(pictures[0].system, /\$\{|undefined/);
});

test('revision messages prioritize feedback without losing H3 constraints', () => {
  const messages = buildRevisionMessages({
    text: 'current prompt',
    feedback: '她转身太早，动作再慢一点',
    context: { references: ['hero.png [output]'], duration: 4.5, width: 1376, height: 768 },
  });
  assert.match(messages.system, /反馈是本次修改的首要依据/);
  assert.match(messages.system, /六段顺序/);
  assert.match(messages.user, /她转身太早，动作再慢一点/);
  assert.match(messages.user, /current prompt/);
  assert.match(messages.user, /<Picture 1> = hero\.png \[output\]/);
  assert.equal(messages.temperature, 0.3);
});

test('revision messages teach how to read a plain remark and ask what changed', () => {
  const messages = buildRevisionMessages({ text: 'p', feedback: '让男主稍微帅一点', context: { references: ['ref/HY27_何遇_全身.png [output]'] } });
  assert.match(messages.system, /大白话/);
  assert.match(messages.system, /「稍微」「一点」「有点」只做轻微调整/);
  assert.match(messages.system, /不改掉人物身份/);
  assert.match(messages.system, /让男主稍微帅一点/);
  assert.match(messages.system, /<note>一句中文/);
  assert.match(messages.system, /<prompt>\n修订后的完整提示词\n<\/prompt>/);
  assert.doesNotMatch(messages.system, /只输出 JSON/);
  assert.match(messages.system, /照用户的意思只改那一句/);
  assert.match(messages.user, /HY27_何遇_全身/);
});

test('revision edits in place: positive wording, beats kept, no single-action rule', () => {
  const { system } = buildRevisionMessages({ text: SHOT, feedback: '车灯晃到镜头了', context: { references: [] } });
  assert.match(system, /编辑指令/);
  assert.match(system, /其余句子逐字保留/);
  assert.match(system, /新写的句子不用 no、not、never、without、avoid 这类否定写法/);
  assert.match(system, /和这次反馈说的是同一件事的，一并换成正面说法或删掉/);
  assert.match(system, /和这次反馈无关的原样保留/);
  assert.match(system, /用户反复说同一件事/);
  assert.match(system, /不叠加更重的否定/);
  assert.match(system, /保持原有的动作节拍和顺序/);
  assert.doesNotMatch(system, /唯一动作/);
  assert.match(system, /参考图数量为 0 时不新增任何 <Picture N>/);
  assert.match(system, /不写 no glare、no lens flare/);
});

test('a continued shot keeps its opening; the context says so only when known', () => {
  const continued = buildRevisionMessages({ text: SHOT, feedback: '动作再慢一点', context: { references: [], duration: 8, width: 1056, height: 608, continuation: true } });
  // the rule is in the fixed system prompt, saying it applies when the request says 接续上一镜：是
  assert.match(continued.system, /请求里写着「接续上一镜：是」时才适用/);
  assert.match(continued.system, /\[Shot 1\] 开头交代的起始状态.*原样保留/);
  assert.doesNotMatch(continued.user, /开头交代的起始状态/);
  assert.match(continued.user, /接续上一镜：是/);
  assert.match(continued.user, /实际分辨率：1056 × 608/);
  assert.match(continued.user, /这一镜不挂参考图/);
  const single = buildRevisionMessages({ text: SHOT, feedback: '动作再慢一点', context: { references: ['qx.png [output]'], continuation: false } });
  assert.equal(single.system, continued.system);
  assert.match(single.user, /接续上一镜：否/);
  const unknown = buildRevisionMessages({ text: SHOT, feedback: 'x', context: { references: [] } });
  assert.doesNotMatch(unknown.user, /实际分辨率|\?|接续上一镜/);
});

test('revision replies are tagged text; JSON still reads and a cut-off prompt is refused', () => {
  const quoted = 'He says, "go", <d>[Chinese] 冲了！</d>\nnon_diegetic_music:\nN/A';
  assert.deepEqual(parseRevision(`<note>放慢了起步</note>\n<prompt>\n${quoted}\n</prompt>`), { prompt: quoted, note: '放慢了起步' });
  assert.deepEqual(parseRevision('<prompt>p</prompt>'), { prompt: 'p', note: '' });
  assert.throws(() => parseRevision('<note>n</note><prompt>\nsubject_definitions: half'), /不完整/);
  assert.throws(() => parseRevision('<prompt>  </prompt>'), /空的/);
});

test('a rewrite that breaks the sections is refused; changed dialogue and stray tags are flagged', () => {
  assert.deepEqual(checkRevision({ before: SHOT, after: SHOT.replace('He pushes off', 'He slowly pushes off'), references: [] }), { refuse: '', warnings: [] });
  assert.match(checkRevision({ before: SHOT, after: SHOT.replace('overall_soundscape:\n', ''), references: [] }).refuse, /六段结构/);
  const dialogue = checkRevision({ before: SHOT, after: SHOT.replace('……血？', '血……'), references: [] });
  assert.equal(dialogue.refuse, '');
  assert.match(dialogue.warnings[0], /台词有改动（原来 2 句，现在 2 句），比如「血……」/);
  const picture = checkRevision({ before: SHOT, after: SHOT.replace('from the previous moment', 'from <Picture 1>'), references: [] });
  assert.match(picture.warnings[0], /<Picture 1>，但这一镜只挂了 0 张参考图/);
  assert.equal(checkRevision({ before: SHOT, after: SHOT.replace('from the previous moment', 'from <Picture 1>'), references: ['a.png'] }).warnings.length, 0);
  const subject = checkRevision({ before: SHOT, after: SHOT.replace('middle of <Subject 2>', 'middle of <Subject 3>'), references: [] });
  assert.match(subject.warnings[0], /<Subject 3> 在 subject_definitions 里没有定义/);
});

test('picture revision edits the wish and the look in place', () => {
  const card = { name: '何遇', kind: 'char', style: '写实电影质感', description: '偏瘦，脸颊被高原的风吹得发红' };
  const t2i = buildPictureRevisionMessages({ card, mode: 't2i', ask: '正面定妆，全身', feedback: '让他稍微帅一点' });
  assert.match(t2i.system, /画风（固定，你不能改）/);
  assert.doesNotMatch(t2i.system, /外形描述（固定/);
  assert.match(t2i.system, /"look"/);
  assert.match(t2i.system, /"ask"/);
  assert.match(t2i.system, /请求里写着「出图方式：图生图」时才适用）：基于卡里已有的一张图改/);
  assert.doesNotMatch(t2i.user, /图生图/);
  assert.match(t2i.user, /何遇（人物）/);
  assert.match(t2i.user, /现在的外形描述：偏瘦，脸颊被高原的风吹得发红/);
  assert.match(t2i.user, /正面定妆，全身/);
  assert.match(t2i.user, /让他稍微帅一点/);
  const i2i = buildPictureRevisionMessages({ card: { ...card, kind: 'scene' }, mode: 'i2i', ask: '', feedback: '太亮了' });
  assert.match(i2i.user, /出图方式：图生图/);
  assert.equal(i2i.system, t2i.system);
  assert.match(i2i.user, /（场景）/);
  assert.match(i2i.user, /现在的「想要什么样的图」：（空）/);
  // the card's own edit of the look is what gets edited next
  const edited = buildPictureRevisionMessages({ card, mode: 't2i', ask: '', look: '偏瘦，眉眼有神', feedback: '再瘦一点' });
  assert.match(edited.user, /现在的外形描述：偏瘦，眉眼有神/);
  assert.doesNotMatch(edited.user, /高原的风/);
});

test('picture revision deletes or replaces words instead of adding negations', () => {
  const card = { name: '何遇', kind: 'char', description: '标志：腰间挂一串酒店的车钥匙和一把多功能工具钳' };
  const { system } = buildPictureRevisionMessages({ card, mode: 't2i', ask: '', feedback: '腰间不要挂钥匙' });
  assert.match(system, /编辑指令/);
  assert.match(system, /删掉写它的那几个字/);
  assert.match(system, /不写「不要」「没有」「别」「避免」「不再」「去掉」这类否定句/);
  assert.match(system, /也不点名要去掉的东西/);
  assert.match(system, /其余句子逐字保留/);
  assert.match(system, /不添加和用户的话无关的新要求或限制/);
  assert.match(system, /改成「标志：腰间挂一把多功能工具钳」/);
  // what piled up before is cleaned up too, and a remark made again goes after where the thing is still written
  assert.match(system, /顺手收拾原文里已有的否定写法/);
  assert.match(system, /用户又说了一遍以前说过的事/);
  assert.match(system, /不出现修改口吻/);
  assert.match(system, /只在外形描述里写一次/);
  // the old rules that made the model paper over the look with "不要……" are gone
  assert.doesNotMatch(system, /盖过去/);
  assert.doesNotMatch(system, /在原有要求后面补上/);
  // what the examples tell the model to write carries no negation (quoting what not to write is fine)
  for (const [, example] of system.matchAll(/→ ([^\n]*)/g)) {
    assert.doesNotMatch(example.replace(/不写「[^」]*」/g, ''), /不要|避免|不再/, `example adds a negation: ${example}`);
  }
});

test('the picture rewrite is told which negations are already there', () => {
  const card = { name: '老周', kind: 'char', description: '身材结实，不胖也不矮。标志：一根没点的烟横着夹在耳后' };
  const { user } = buildPictureRevisionMessages({ card, mode: 't2i', ask: '半身。耳后不夹香烟，没有烟。', feedback: '还是有烟' });
  assert.match(user, /两段里现有的否定写法：.*不胖也不矮.*耳后不夹香烟.*没有烟/);
  const clean = buildPictureRevisionMessages({ card: { name: 'x', description: '红色外套' }, mode: 't2i', ask: '全身', feedback: '亮一点' });
  assert.match(clean.user, /两段里现有的否定写法：（没有）/);
});

test('revision replies carry an optional note', () => {
  assert.deepEqual(parseRevision('{"prompt":" new ","note":" 补了五官 "}'), { prompt: 'new', note: '补了五官' });
  assert.deepEqual(parseRevision('{"prompt":"new"}'), { prompt: 'new', note: '' });
  assert.deepEqual(parsePictureRevision('```json\n{"ask":"正面，眉眼有神","note":"加了眼神"}\n```'), { ask: '正面，眉眼有神', note: '加了眼神' });
  assert.throws(() => parsePictureRevision('{"prompt":"wrong field"}'), /缺少 ask/);
  assert.deepEqual(parsePictureRevision('{"look":" 腰间挂一把工具钳 ","ask":"","note":"删了钥匙"}'), { ask: '', look: '腰间挂一把工具钳', note: '删了钥匙' });
  assert.throws(() => parsePictureRevision('{"look":"","ask":""}'), /缺少 ask/);
});

test('optimized JSON is parsed while markdown fences and surrounding text are handled', () => {
  assert.equal(parseOptimizedText('```json\n{"prompt":"better prompt"}\n```'), 'better prompt');
  assert.equal(parseOptimizedText('{"prompt":"  spaced prompt  "}'), 'spaced prompt');
  assert.throws(() => parseOptimizedText('not json'), /不是 JSON/);
  assert.throws(() => parseOptimizedText('{"other":"missing"}'), /缺少 prompt/);
});
