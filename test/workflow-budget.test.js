const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTemplate, templateForm } = require('../src/workflow-template');
const { compileWorkflow } = require('../src/workflow-compile');
const { buildBudget } = require('../src/workflow-budget');

const template = loadTemplate(path.join(__dirname, '..', 'workflow-templates', 'minimax-h3-hybrid'));

test('budget includes activation VRAM, model weights and estimated RAM', () => {
  const compiled = compileWorkflow(template, templateForm(template).defaults);
  const relPaths = [
    ...template.manifest.resources,
    ...templateForm(template).defaults.loras.map((lora) => `loras/${lora.name}`),
    `loras/${templateForm(template).defaults.turboModel}`,
  ];
  const models = relPaths.map((relPath) => ({ relPath, sizeBytes: 1000 }));
  const budget = buildBudget({
    template,
    summary: compiled.summary,
    context: { vramTotal: 10e9, reserveVram: 2.5, ramTotal: 64e9, ramFree: 60e9, models },
  });
  assert.equal(budget.ok, true);
  assert.equal(budget.weightsGB, (relPaths.length * 1000) / 1e9);
  assert.ok(budget.actGB > 0);
  assert.equal(budget.estimatedRamGB, budget.weightsGB + budget.actGB);
  assert.equal(budget.ramFreeGB, 60);
  assert.deepEqual(budget.missingResources, []);
  assert.equal(budget.deghost, false);
});
