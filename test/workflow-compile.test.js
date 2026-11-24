const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTemplate, templateForm } = require('../src/workflow-template');
const { compileWorkflow, dimensions, resolutionTier, validModelName, validReference, validContinuation } = require('../src/workflow-compile');

const template = loadTemplate(path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-hybrid'));
const ref = (name) => `${name} [output]`;

test('the hybrid template defaults to random seed, two references and two existing LoRAs', () => {
  const form = templateForm(template);
  assert.equal(form.id, 'minimax-h3-hybrid');
  assert.equal(form.referenceSlots.length, 9);
  assert.equal(form.defaults.references.length, 2);
  assert.equal(form.defaults.loras.length, 2);
  assert.equal(form.defaults.seedMode, 'random');
  const before = JSON.stringify(template.graph);
  const result = compileWorkflow(template, form.defaults);
  assert.equal(result.ok, true);
  assert.notEqual(result.workflow['129'].inputs.noise_seed, template.graph['129'].inputs.noise_seed);
  assert.equal(result.workflow['242'].inputs.switch, true);
  assert.equal(result.workflow['243'].inputs.switch, false);
  assert.equal(result.workflow['233'], undefined);
  assert.equal(result.workflow['243'].inputs.on_true, undefined);
  assert.equal(result.workflow['146'].inputs.value, true);
  assert.equal(result.workflow['144'].inputs.value, 4);
  assert.equal(result.workflow['362'].inputs.value, false);
  assert.equal(result.workflow['336'].inputs.value, true);
  assert.equal(result.workflow['337'].inputs.clip, 'h3_context/clip_1-1.jpg [output]');
  assert.equal(result.summary.continuation, 'h3_context/clip_1-1.jpg [output]');
  assert.equal(result.summary.seedMode, 'random');
  assert.equal(JSON.stringify(template.graph), before, 'compiling must not mutate the template graph');
});

const wenwuCont = loadTemplate(path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-wenwu-cont'));
const wenwu = loadTemplate(path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-wenwu'));

test('compile sets unique output prefixes when outputKey is given', () => {
  const form = templateForm(wenwuCont);
  const result = compileWorkflow(wenwuCont, form.defaults, { outputKey: 'bb_x1' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow['507'].inputs.filename_prefix, 'h3_context/bb_x1');
  assert.equal(result.workflow['364'].inputs.filename_prefix, 'video/bb_x1');
  assert.equal(result.summary.outputKey, 'bb_x1');
  assert.equal(wenwuCont.graph['507'].inputs.filename_prefix, 'h3_context/clip', 'the template graph is not touched');
});

test('hybrid only sets the context prefix', () => {
  const form = templateForm(template);
  const result = compileWorkflow(template, form.defaults, { outputKey: 'bb_x1' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow['338'].inputs.filename_prefix, 'h3_context/bb_x1');
  assert.deepEqual(result.workflow['92'].inputs.filename_prefix, ['338', 1]);
});

test('without outputKey the prefixes stay as the template has them', () => {
  const result = compileWorkflow(wenwuCont, templateForm(wenwuCont).defaults);
  assert.equal(result.workflow['507'].inputs.filename_prefix, 'h3_context/clip');
  assert.equal(result.summary.outputKey, null);
});

test('continuation accepts any h3_context jpg', () => {
  const form = templateForm(wenwuCont);
  const clip = 'h3_context/bb_e01-04-t002-a1b2_1026-142233_.jpg [output]';
  const result = compileWorkflow(wenwuCont, { ...form.defaults, continuationEnabled: true, continuationClip: clip });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow['501'].inputs.clip, clip);
});

test('continuation still rejects paths outside h3_context', () => {
  assert.equal(validContinuation('video/x.jpg [output]'), false);
  assert.equal(validContinuation('h3_context/../x.jpg [output]'), false);
  assert.equal(validContinuation('h3_context/sub/x.jpg [output]'), false);
});

test('continuation capability reflects bindings', () => {
  assert.equal(templateForm(wenwuCont).capabilities.continuation, true);
  assert.equal(templateForm(template).capabilities.continuation, true);
  assert.equal(templateForm(wenwu).capabilities.continuation, false);
});

test('continuation selection writes the real H3 nodes and validates kept-shot clips', () => {
  const form = templateForm(template);
  const result = compileWorkflow(template, { ...form.defaults, continuationEnabled: true, continuationClip: 'h3_context/clip_1-4.jpg [output]' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.workflow['336'].inputs.value, true);
  assert.equal(result.workflow['337'].inputs.clip, 'h3_context/clip_1-4.jpg [output]');
  assert.equal(result.summary.continuation, 'h3_context/clip_1-4.jpg [output]');

  const independent = compileWorkflow(template, { ...form.defaults, continuationEnabled: false, continuationClip: '' });
  assert.equal(independent.ok, true);
  assert.equal(independent.workflow['336'].inputs.value, false);
  assert.equal(independent.summary.continuation, '');
  assert.equal(compileWorkflow(template, { ...form.defaults, continuationEnabled: true, continuationClip: '../secret.jpg [output]' }).ok, false);
  assert.equal(validContinuation('h3_context/clip_2-15b.jpg [output]'), true);
  assert.equal(validContinuation('h3_context/other.jpg [output]'), true); // per-take names, not only kept shots
  assert.equal(validContinuation('h3_context/other.png [output]'), false);
});

test('all common controls compile into the cloned hybrid graph', () => {
  const result = compileWorkflow(template, {
    prompt: 'a new hybrid prompt',
    seedMode: 'fixed',
    seed: 42,
    turboEnabled: false,
    turboModel: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    steps: 25,
    duration: 5.5,
    aspect: '9:16',
    megapixels: 1.2,
    references: [ref('a.png'), ref('b.png'), ref('c.png')],
    loras: [{ name: 'h3-realism-people-t2v-i2v-r2v.safetensors', strength: 0.7 }],
    extensions: { motionDeghost: true },
  });
  assert.equal(result.ok, true);
  const g = result.workflow;
  assert.equal(g['138'].inputs.value, 'a new hybrid prompt');
  assert.equal(g['129'].inputs.noise_seed, 42);
  assert.equal(g['146'].inputs.value, false);
  assert.equal(g['143'].inputs.value, 25);
  assert.equal(g['144'].inputs.value, 4);
  assert.equal(g['132'].inputs.value, 141 / 24, '5.5s goes in as the exact length of its 141-frame step');
  assert.equal(g['115'].inputs.aspect_ratio, '9:16 (Portrait Widescreen)');
  assert.equal(g['115'].inputs.megapixels, 1.2);
  assert.equal(g['243'].inputs.switch, true);
  assert.equal(g['244'].inputs.switch, false);
  assert.equal(g['362'].inputs.value, true);
  assert.equal(g['150'], undefined);
  assert.deepEqual(g['361'].inputs.model, ['385', 0]);
  assert.deepEqual(g['145'].inputs.model, ['361', 0]);
  assert.deepEqual(g['141'].inputs.on_false, ['361', 0]);
  assert.equal(result.summary.turboModel, '不启用 Turbo');
  assert.deepEqual(JSON.parse(result.apiJson), g);
});

test('reference slots and additional LoRAs grow and shrink with their model links intact', () => {
  const references = Array.from({ length: 9 }, (_, i) => ref(`ref-${i + 1}.png`));
  const loras = Array.from({ length: 4 }, (_, i) => ({ name: `pack/lora-${i + 1}.safetensors`, strength: 0.5 + i * 0.1 }));
  const grown = compileWorkflow(template, { references, loras });
  assert.equal(grown.ok, true);
  for (const id of ['242', '243', '244', '352', '354', '356', '358', '360']) assert.equal(grown.workflow[id].inputs.switch, true);
  for (const id of ['361', '150', '388', '389']) assert.equal(grown.workflow[id].class_type, 'LoraLoaderModelOnly');
  assert.deepEqual(grown.workflow['361'].inputs.model, ['385', 0]);
  assert.deepEqual(grown.workflow['150'].inputs.model, ['361', 0]);
  assert.deepEqual(grown.workflow['388'].inputs.model, ['150', 0]);
  assert.deepEqual(grown.workflow['389'].inputs.model, ['388', 0]);
  assert.deepEqual(grown.workflow['145'].inputs.model, ['389', 0]);
  assert.ok(grown.changes.some((c) => c.kind === 'node-added' && c.nodeId === '388'));

  const removed = compileWorkflow(template, { loras: [] });
  assert.equal(removed.ok, true);
  assert.equal(removed.workflow['361'], undefined);
  assert.equal(removed.workflow['150'], undefined);
  assert.deepEqual(removed.workflow['145'].inputs.model, ['385', 0]);
  assert.deepEqual(removed.workflow['141'].inputs.on_false, ['385', 0]);
  assert.ok(removed.changes.some((c) => c.kind === 'node-removed' && c.nodeId === '361'));
});

test('invalid dynamic values are rejected before any graph is returned', () => {
  const result = compileWorkflow(template, {
    prompt: '',
    seedMode: 'fixed',
    seed: -1,
    turboEnabled: true,
    turboModel: 'not-in-list.safetensors',
    steps: 0,
    duration: 0,
    aspect: 'bad',
    megapixels: 0,
    references: [],
    loras: [{ name: '../bad.safetensors', strength: 3 }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 9);
  assert.equal(result.workflow, undefined);
});

test('megapixel resolution and tier labels follow ResolutionSelector', () => {
  assert.deepEqual(dimensions({ w: 16, h: 9 }, 0.6), { width: 1056, height: 608 });
  assert.deepEqual(dimensions({ w: 16, h: 9 }, 1), { width: 1376, height: 768 });
  assert.equal(resolutionTier(864, 480), '约 480p');
  assert.equal(resolutionTier(1056, 608), '约 1K');
  assert.equal(resolutionTier(2048, 1152), '约 2K');
});

test('output references and LoRA names reject traversal and invalid values', () => {
  assert.equal(validReference('folder/人物 1.png [output]'), true);
  assert.equal(validReference('folder/person.png'), false);
  assert.equal(validReference('../secret.png [output]'), false);
  assert.equal(validModelName('pack/custom.safetensors'), true);
  assert.equal(validModelName('../custom.safetensors'), false);
  assert.equal(validModelName('custom.gguf'), false);
});
