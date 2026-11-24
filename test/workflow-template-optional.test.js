const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTemplate, templateForm } = require('../src/workflow-template');
const { compileWorkflow } = require('../src/workflow-compile');

const dir = path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-wenwu');
const template = loadTemplate(dir);
const ref = (name) => `${name} [output]`;

test('the wenwu template declares only the controls it really has', () => {
  const form = templateForm(template);
  assert.equal(form.id, 'minimax-h3-wenwu');
  assert.deepEqual(form.capabilities, { turbo: false, continuation: false, loraChain: true });
  assert.deepEqual(form.defaults.references, [
    'c715baaee3fa989a7a8c94643fb7945e36f943b91a5a28182e44c895c565eec3.jpg [output]',
    '22785d770f0efdcf632f8e8a954a4b05032b63a4ac5a92e74da551fed6020ab2.jpg [output]',
  ]);
  assert.equal(form.defaults.continuationEnabled, false);
  assert.equal(form.defaults.continuationClip, '');
  assert.equal(form.defaults.turboEnabled, false);
  assert.equal(form.defaults.turboModel, '');
  assert.deepEqual(form.turboModels, []);
  assert.equal(form.defaults.steps, 12);
  assert.equal(form.defaults.fullSteps, 12);
  assert.equal(form.defaults.duration, 12);
  assert.equal(form.defaults.megapixels, 1.5);
  assert.equal(form.referenceSlots.length, 6);
  assert.deepEqual(form.defaults.loras, [
    { name: 'minimax_h3_dmad_full_dareties_v4_step600_comfy_fro.safetensors', strength: 0.8 },
  ]);
  assert.deepEqual(form.extensions, []);
});

test('the wenwu template compiles its declared bindings and leaves the rest alone', () => {
  const before = JSON.stringify(template.graph);
  const result = compileWorkflow(template, {
    prompt: 'a brand new wenwu prompt',
    seedMode: 'fixed',
    seed: 42,
    duration: 8,
    aspect: '9:16',
    megapixels: 0.6,
    steps: 20,
    turboEnabled: true,
    turboModel: 'not-a-real-turbo.safetensors',
    continuationEnabled: true,
    continuationClip: 'h3_context/clip_1-1.jpg [output]',
    references: [ref('a.png'), ref('b.png')],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const g = result.workflow;
  assert.equal(g['263'].inputs.value, 'a brand new wenwu prompt');
  assert.equal(g['397'].inputs.seed, 42);
  assert.equal(g['259'].inputs.value, 8);
  assert.equal(g['252'].inputs.aspect_ratio, '9:16 (Portrait Widescreen)');
  assert.equal(g['252'].inputs.megapixels, 0.6);
  assert.equal(g['261'].inputs.steps, 20);
  assert.equal(result.summary.turboEnabled, false);
  assert.equal(result.summary.turboModel, '不启用 Turbo');
  assert.equal(result.summary.continuation, '');
  assert.equal(result.summary.steps, 20);
  assert.equal(result.summary.duration, 8);
  assert.equal(result.summary.frames, 192);
  assert.deepEqual([result.summary.width, result.summary.height], [608, 1056]);
  assert.equal(JSON.stringify(template.graph), before, 'compiling must not mutate the template graph');
});

test('fewer references than slots delete the unused loaders and their graph inputs', () => {
  const one = compileWorkflow(template, { references: [ref('only.png')] });
  assert.equal(one.ok, true, JSON.stringify(one.errors));
  for (const id of ['50', '43', '19', '23']) assert.equal(one.workflow[id], undefined);
  assert.equal(one.workflow['51'].inputs.image, 'only.png [output]');
  assert.equal(one.workflow['265'].inputs['ref_images.ref_image_1'], undefined);
  assert.equal(one.workflow['265'].inputs['ref_images.ref_image_5'], undefined);
  assert.deepEqual(Object.keys(one.workflow['265'].inputs).filter((key) => key.startsWith('ref_images.')), ['ref_images.ref_image_0']);

  const all = compileWorkflow(template, { references: Array.from({ length: 6 }, (_, i) => ref(`r${i + 1}.png`)) });
  assert.equal(all.ok, true, JSON.stringify(all.errors));
  assert.equal(all.workflow['23'].inputs.image, 'r6.png [output]');
  assert.deepEqual(all.workflow['265'].inputs['ref_images.ref_image_5'], ['23', 0]);

  const tooMany = compileWorkflow(template, { references: Array.from({ length: 7 }, (_, i) => ref(`r${i + 1}.png`)) });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.some((message) => message.includes('参考图数量')));
});

test('a shot with no reference images compiles with every loader removed', () => {
  const none = compileWorkflow(template, { references: [] });
  assert.equal(none.ok, true, JSON.stringify(none.errors));
  for (const id of ['51', '49', '50', '43', '19', '23']) assert.equal(none.workflow[id], undefined);
  assert.deepEqual(Object.keys(none.workflow['265'].inputs).filter((key) => key.startsWith('ref_images.')), []);
  assert.deepEqual(none.summary.references, []);
});

test('the continuation template also runs from the previous clip alone', () => {
  const cont = loadTemplate(path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-wenwu-cont'));
  const none = compileWorkflow(cont, { references: [], continuationEnabled: true, continuationClip: 'h3_context/bb_e00-007-t001.jpg [output]' });
  assert.equal(none.ok, true, JSON.stringify(none.errors));
  assert.equal(none.summary.continuationEnabled, true);
  assert.deepEqual(Object.keys(none.workflow['265'].inputs).filter((key) => key.startsWith('ref_images.')), []);
});

test('the LoRA chain ends at attention instead of a turbo switch', () => {
  const form = templateForm(template);
  const grown = compileWorkflow(template, {
    loras: [...form.defaults.loras, { name: 'pack/extra.safetensors', strength: 0.5 }],
  });
  assert.equal(grown.ok, true, JSON.stringify(grown.errors));
  assert.deepEqual(grown.workflow['53'].inputs.model, ['192', 0]);
  assert.equal(grown.workflow['400'], undefined);
  assert.deepEqual(grown.workflow['405'].inputs.model, ['53', 0]);
  assert.deepEqual(grown.workflow['331'].inputs.model, ['405', 0]);

  const stripped = compileWorkflow(template, { loras: [] });
  assert.equal(stripped.ok, true, JSON.stringify(stripped.errors));
  assert.equal(stripped.workflow['53'], undefined);
  assert.equal(stripped.workflow['400'], undefined);
  assert.deepEqual(stripped.workflow['331'].inputs.model, ['192', 0]);
  assert.deepEqual(stripped.summary.loras, []);
});

test('the hybrid template keeps its turbo and continuation capabilities', () => {
  const hybrid = loadTemplate(path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-hybrid'));
  assert.deepEqual(templateForm(hybrid).capabilities, { turbo: true, continuation: true, loraChain: true });
});
