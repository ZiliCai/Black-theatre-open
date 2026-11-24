const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLoose, summarizePrompt } = require('../src/prompt-summary');

// A real ComfyUI prompt (only the story text and picture names were replaced). It contains a bare NaN.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'media', 'prompt-h3.json'), 'utf8');
const load = () => parseLoose(FIXTURE);
const withEdit = (edit) => {
  const p = load();
  edit(p);
  return JSON.stringify(p);
};

test('parseLoose reads the bare NaN / Infinity Python writes, and leaves those words in text alone', () => {
  assert.deepEqual(parseLoose('{"a":[NaN],"b":Infinity,"c":-Infinity,"d":"NaN and Infinity"}'), { a: [null], b: null, c: null, d: 'NaN and Infinity' });
  assert.deepEqual(parseLoose('{"s":"quote \\" NaN \\\\"}'), { s: 'quote " NaN \\' });
  assert.equal(parseLoose('not json'), null);
  assert.equal(parseLoose(''), null);
  assert.equal(parseLoose('[1,2]'), null); // a prompt is an object of nodes
});

test('H3 workflow: the basics come out of the nodes the sampler actually uses', () => {
  const s = summarizePrompt(FIXTURE);
  assert.equal(s.seed, 728888521730947);
  assert.equal(s.steps, 16);
  assert.equal(s.sampler, 'euler');
  assert.equal(s.scheduler, 'beta');
  assert.equal(s.unet, 'MiniMax-H3-Ref2VA-Q3_K_M.gguf');
  assert.deepEqual(s.loras, ['h3-realism-people-t2v-i2v-r2v.safetensors']);
  assert.equal(s.turbo, false);
});

test('H3 workflow: turning Turbo on changes the steps and adds the speed-up LoRA', () => {
  const s = summarizePrompt(withEdit((p) => { p['146'].inputs.value = true; }));
  assert.equal(s.turbo, true);
  assert.equal(s.steps, 4);
  assert.deepEqual(s.loras, [
    'h3-realism-people-t2v-i2v-r2v.safetensors',
    'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  ]);
});

test('H3 workflow: the story text, with the summary line picked out', () => {
  const s = summarizePrompt(FIXTURE);
  assert.ok(s.promptText.startsWith('subject_definitions:'));
  assert.equal(s.summary, 'A short test clip of a person greeting a friend in a living room.');
});

test('H3 workflow: only the reference pictures that are switched on are listed', () => {
  assert.deepEqual(summarizePrompt(FIXTURE).refs, ['角色甲_00001_.png', '角色乙_00001_.png']);
  const s = summarizePrompt(withEdit((p) => { p['242'].inputs.switch = false; }));
  assert.deepEqual(s.refs, ['角色甲_00001_.png']);
});

test('H3 workflow: a stand-alone clip vs a clip that continues an earlier one', () => {
  const alone = summarizePrompt(FIXTURE);
  assert.equal(alone.continued, false);
  assert.equal(alone.continueFrom, null);
  assert.equal(alone.clipIndex, 1); // it still saved itself as clip 1

  const next = summarizePrompt(withEdit((p) => {
    p['336'].inputs.value = true;
    p['337'].inputs.clip_index = 2;
    p['338'].inputs.clip_index = 3;
  }));
  assert.equal(next.continued, true);
  assert.equal(next.continueFrom, 2);
  assert.equal(next.clipIndex, 3);
});

test('H3 workflow: clip_index 0 means "numbered by run", so there is no clip number', () => {
  const s = summarizePrompt(withEdit((p) => { p['338'].inputs.clip_index = 0; }));
  assert.equal(s.clipIndex, null);
});

test('a seed or step count that comes from another node is followed', () => {
  const s = summarizePrompt(JSON.stringify({
    1: { class_type: 'RandomNoise', inputs: { noise_seed: ['2', 0] } },
    2: { class_type: 'PrimitiveInt', inputs: { value: 4242 } },
    3: { class_type: 'BasicScheduler', inputs: { steps: ['2', 0], scheduler: 'simple', model: ['4', 0] } },
    4: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'x.gguf' } },
  }));
  assert.equal(s.seed, 4242);
  assert.equal(s.steps, 4242);
  assert.equal(s.unet, 'x.gguf');
});

test('a plain image workflow: KSampler seed / steps and the positive text', () => {
  const s = summarizePrompt(JSON.stringify({
    3: { class_type: 'KSampler', inputs: { seed: 5, steps: 20, sampler_name: 'euler', scheduler: 'normal', positive: ['6', 0], model: ['4', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat on a sofa', clip: ['4', 1] } },
  }));
  assert.equal(s.seed, 5);
  assert.equal(s.steps, 20);
  assert.equal(s.promptText, 'a cat on a sofa');
  assert.equal(s.summary, 'a cat on a sofa');
  assert.equal(s.unet, 'model.safetensors');
});

test('text without a summary line is shortened', () => {
  const long = 'x'.repeat(500);
  const s = summarizePrompt(JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: long } }, 3: { class_type: 'KSampler', inputs: { positive: ['6', 0] } } }));
  assert.equal(s.promptText, long);
  assert.ok(s.summary.length <= 161 && s.summary.endsWith('…'));
});

test('anything that is not a ComfyUI prompt gives null; an empty one gives no details', () => {
  assert.equal(summarizePrompt(undefined), null);
  assert.equal(summarizePrompt('garbage'), null);
  assert.equal(summarizePrompt('{"a":1}'), null); // values are not nodes
  const empty = summarizePrompt('{"1":{"class_type":"Note","inputs":{}}}');
  assert.equal(empty.seed, null);
  assert.equal(empty.steps, null);
  assert.deepEqual(empty.loras, []);
  assert.deepEqual(empty.refs, []);
});

test('switches that point at themselves or at each other do not hang the reader', () => {
  const s = summarizePrompt(JSON.stringify({
    1: { class_type: 'ComfySwitchNode', inputs: { switch: true, on_true: ['2', 0] } },
    2: { class_type: 'ComfySwitchNode', inputs: { switch: true, on_true: ['1', 0] } },
    3: { class_type: 'BasicScheduler', inputs: { steps: ['1', 0], model: ['1', 0] } },
  }));
  assert.equal(s.steps, null);
});

test('a very long story text is cut so one file cannot flood the page', () => {
  const s = summarizePrompt(JSON.stringify({
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'y'.repeat(50000) } },
    3: { class_type: 'KSampler', inputs: { positive: ['6', 0] } },
  }));
  assert.ok(s.promptText.length <= 4001);
});

test('a story that is only a tag or blanks has no summary', () => {
  const s = summarizePrompt(JSON.stringify({
    6: { class_type: 'CLIPTextEncode', inputs: { text: '[reference generation]  ' } },
    3: { class_type: 'KSampler', inputs: { positive: ['6', 0] } },
  }));
  assert.equal(s.summary, null);
});
