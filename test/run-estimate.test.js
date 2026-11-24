const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateRun } = require('../src/run-estimate');

const take = (templateId, totalMs, values, extra = {}) => ({ status: 'succeeded', templateId, startedAt: 1000, completedAt: 1000 + totalMs, values, ...extra });

test('no finished take of the template: no estimate', () => {
  assert.equal(estimateRun([], { templateId: 'a' }), null);
  assert.equal(estimateRun([take('b', 5000, {}), { ...take('a', 5000, {}), status: 'failed' }], { templateId: 'a' }), null);
});

test('the median of past runs of the same template', () => {
  const takes = [take('a', 100000, {}), take('a', 300000, {}), take('a', 200000, {}), take('b', 1, {})];
  assert.deepEqual(estimateRun(takes, { templateId: 'a', values: {} }), { totalMs: 200000, firstStepMs: null, tailMs: null });
});

test('a longer or sharper take scales half of a past run', () => {
  const takes = [take('a', 100000, { duration: 5, megapixels: 0.6 }, { timing: { firstStepMs: 30000, tailMs: 20000 } })];
  const twiceAsLong = estimateRun(takes, { templateId: 'a', values: { duration: 10, megapixels: 0.6 } });
  assert.deepEqual(twiceAsLong, { totalMs: 150000, firstStepMs: 30000, tailMs: 30000 });
});

test('only the most recent runs count, and nonsense times are left out', () => {
  const old = Array.from({ length: 8 }, (_, i) => ({ ...take('a', 900000, {}), completedAt: 1000 + i }));
  const recent = Array.from({ length: 8 }, (_, i) => ({ ...take('a', 100000, {}), startedAt: 1e9, completedAt: 1e9 + 100000 + i }));
  assert.equal(estimateRun([...old, ...recent], { templateId: 'a' }).totalMs, 100004);
  assert.equal(estimateRun([{ ...take('a', 0, {}), startedAt: undefined }], { templateId: 'a' }), null);
});

test('takes made on a remote GPU are not mixed with this computer\'s', () => {
  const take = (ms, renderedOn) => ({ status: 'succeeded', templateId: 't', startedAt: 0, completedAt: ms, values: { duration: 5, megapixels: 0.75 }, ...(renderedOn ? { renderedOn } : {}) });
  const takes = [take(600000), take(150000, 'srv-1')];
  assert.equal(estimateRun(takes, { templateId: 't', values: { duration: 5, megapixels: 0.75 } }).totalMs, 600000, 'old takes without the field were made here');
  assert.equal(estimateRun(takes, { templateId: 't', values: { duration: 5, megapixels: 0.75 }, renderedOn: 'srv-1' }).totalMs, 150000);
  assert.equal(estimateRun(takes, { templateId: 't', values: {}, renderedOn: 'srv-2' }), null);
});
