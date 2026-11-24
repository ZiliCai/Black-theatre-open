const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/prompt-hygiene');
const { rewriteShotPrompt } = require('../src/prompt-rewrite');

const shot = (beats) => ['subject_definitions:', '<Subject 1> is a man.', 'summary:', 's', 'retention_analysis:', 'r', 'detailed_description:',
  `Cinematic look, slight film grain. [Shot 1] ${beats} The camera holds at chest height.`, 'overall_soundscape:', 'wind', 'non_diegetic_music:', 'N/A'].join('\n');
const RUSHED = shot('The door is pushed open. <Subject 1> steps out and pulls the door shut, then walks to the truck. He crouches and glances under it, then lays out a cardboard sheet and slides underneath. He mutters and wipes his cheek.');
const CALM = shot('<Subject 1> steps out of the door and stops in the cold air. He looks across at the truck for a moment.');

test('a shot with more actions than its seconds is counted as hurried; a calm one is not', () => {
  const rushed = H.paceOf(RUSHED, 7.3);
  assert.equal(rushed.allowed, 3);
  assert.ok(rushed.beats >= 8, `counted ${rushed.beats}`);
  assert.equal(rushed.dense, true);
  const { beats, allowed, dense } = H.paceOf(CALM, 7.3);
  assert.deepEqual({ beats, allowed, dense }, { beats: 3, allowed: 3, dense: false });
  assert.equal(H.paceOf(RUSHED, 0).dense, false, 'no length, no judgement');
});

test('the no-subtitles sentence goes back after the look line when a prompt lost it', () => {
  const fixed = H.ensureNoSubtitles(CALM);
  assert.match(fixed, /detailed_description:\nCinematic look, slight film grain\. No subtitles or on-screen text of any kind\. \[Shot 1\]/);
  assert.equal(H.ensureNoSubtitles(fixed), fixed);
});

test('a rewrite that leaves the shot hurried gets one more pass that slows it down', async () => {
  const asked = [];
  const replies = [RUSHED, RUSHED, CALM].map((p) => JSON.stringify({ prompt: p, note: 'n' }));
  const r = await rewriteShotPrompt({ text: RUSHED, feedback: '门要先开', context: { duration: 7.3 }, llm: async (m) => { asked.push(m); return replies.shift(); } });
  assert.equal(asked.length, 3);
  assert.match(asked[2].user, /节奏太急：这一镜 7.3 秒，现在写了大约 \d+ 个动作/);
  assert.match(r.note, /放慢了节奏：动作从大约 \d+ 个减到 3 个/);
  assert.match(r.text, /No subtitles or on-screen text of any kind\./);
  assert.deepEqual(r.warnings.filter((w) => /显得急/.test(w)), []);
});
