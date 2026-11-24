const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteShotPrompt, rewritePicture, TIDY_PICTURE, TIDY_VIDEO } = require('../src/prompt-rewrite');

// A fake LLM: answers each call with the next reply and remembers what it was asked.
function llm(replies) {
  const asked = [];
  return { asked, ask: async (messages) => { asked.push(messages); const r = replies.shift(); if (r instanceof Error) throw r; return r; } };
}
const reply = (look, ask, note) => JSON.stringify({ look, ask, note });

test('a picture rewrite carries out the remark, then tidies the result', async () => {
  const f = llm([
    reply('标志：肩上搭一条旧毛巾', '半身。耳朵干净，没有烟。', '删了烟'),
    reply('标志：肩上搭一条旧毛巾', '半身，耳朵干净利落。', '换成正面写法'),
  ]);
  const r = await rewritePicture({ card: { name: '老周', kind: 'char' }, mode: 't2i', ask: '半身。耳后不夹烟。', look: '标志：肩上搭一条旧毛巾，烟夹在耳后', feedback: '还是有烟', llm: f.ask });
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[0].user, /还是有烟/);
  assert.match(f.asked[1].user, new RegExp(TIDY_PICTURE.slice(0, 10)));
  assert.match(f.asked[0].user, /现在的「想要什么样的图」：半身。耳后不夹烟。/, 'the wish goes to the model, never mixed up with the LLM call');
  assert.match(f.asked[1].user, /半身。耳朵干净，没有烟。/, 'the tidy step works on what the first step wrote');
  assert.deepEqual([r.look, r.ask], ['标志：肩上搭一条旧毛巾', '半身，耳朵干净利落。']);
  assert.equal(r.note, '删了烟；顺带整理了否定写法和重复的话');
  assert.deepEqual(r.warnings, []);
});

test('整理 alone is one tidy step; a failed tidy after a rewrite keeps the rewrite and says so', async () => {
  const only = llm([reply('身材匀称', '全身', '不胖也不矮 → 身材匀称')]);
  const r = await rewritePicture({ card: { name: 'x' }, mode: 't2i', ask: '全身', look: '不胖也不矮', tidyOnly: true, llm: only.ask });
  assert.equal(only.asked.length, 1);
  assert.equal(r.look, '身材匀称');
  assert.equal(r.note, '不胖也不矮 → 身材匀称');

  const broken = llm([reply('红外套', '全身，夜里', '改成夜里'), 'not json', 'still not json']);
  const kept = await rewritePicture({ card: { name: 'x' }, mode: 't2i', ask: '全身', look: '红外套', feedback: '改成夜里', llm: broken.ask });
  assert.equal(kept.ask, '全身，夜里');
  assert.match(kept.warnings[0], /整理这一步没成功/);
});

const SHOT = ['subject_definitions: <Subject 1> is a rider.', 'summary: He rides.', 'retention_analysis: x', 'detailed_description: He rides on.', 'overall_soundscape: wind', 'non_diegetic_music: N/A'].join('\n');
const tagged = (prompt, note) => `<note>${note}</note>\n<prompt>\n${prompt}\n</prompt>`;

test('a shot rewrite is tidied too, and a tidy that breaks the six sections is not used', async () => {
  const stopped = SHOT.replace('He rides on.', 'He brakes hard, both feet down.');
  const f = llm([tagged(stopped.replace('both feet down.', 'both feet down, the bike does not move.'), '改成停住'), tagged(stopped, '换成正面写法')]);
  const r = await rewriteShotPrompt({ text: SHOT, feedback: '车别往前', context: { references: [] }, llm: f.ask });
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[1].user, new RegExp(TIDY_VIDEO.slice(0, 10)));
  // every video prompt carries the one fixed no-subtitles sentence
  assert.equal(r.text, stopped.replace('both feet down.', 'both feet down. No subtitles or on-screen text of any kind.'));
  assert.deepEqual(r.warnings, []);

  const broke = llm([tagged(stopped, '改成停住'), tagged('summary: only one section', '整理')]);
  const kept = await rewriteShotPrompt({ text: SHOT, feedback: '车别往前', context: { references: [] }, llm: broke.ask });
  assert.equal(kept.text, stopped.replace('both feet down.', 'both feet down. No subtitles or on-screen text of any kind.'));
  assert.match(kept.warnings.join(), /整理这一步没成功/);

  const refused = llm([tagged('summary: only one section', '整理')]);
  assert.ok((await rewriteShotPrompt({ text: SHOT, tidyOnly: true, context: {}, llm: refused.ask })).refuse);
});
