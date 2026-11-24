const test = require('node:test');
const assert = require('node:assert/strict');
const { resolution, frameCount, tokenCount, estimate, DEFAULTS } = require('../renderer/budget-calc');

test('resolution snaps down to the 32 pixel grid, megapixels counted as 1024 squared', () => {
  assert.deepEqual(resolution(0.8, 16, 9), { width: 1216, height: 672 });
  assert.deepEqual(resolution(0.64, 16, 9), { width: 1088, height: 608 });
  assert.deepEqual(resolution(0.4, 16, 9), { width: 832, height: 480 });
  assert.deepEqual(resolution(0.8, 9, 16), { width: 672, height: 1216 });
});

test('frame count rounds up to 17k+5 and latent steps follow', () => {
  assert.equal(frameCount(5), 124);
  assert.equal(frameCount(8), 192);
  assert.equal(frameCount(10), 243);
  assert.equal(frameCount(0.1), 5);
  assert.equal(tokenCount(1056, 608, 192, 0).latentT, 57); // the clip that ran fine on the 3080
  assert.equal(tokenCount(1216, 672, 124, 300).tokens, 30240);
});

test('the calibration point reproduces itself, and CFG doubles the time', () => {
  const base = { ...DEFAULTS, megapixels: 0.8, seconds: 5, steps: 20, refs: 0, calibTokens: 30240, calibSeconds: 64 };
  const r = estimate(base);
  assert.equal(r.tokens, 30240);
  assert.ok(Math.abs(r.secPerPass - 64) < 1e-9);
  assert.ok(Math.abs(r.totalMin - (20 * 64) / 60) < 1e-9);
  assert.ok(Math.abs(estimate({ ...base, useCfg: true }).totalMin - 2 * r.totalMin) < 1e-9);
});

test('verdict follows how much of the usable VRAM the activations take', () => {
  const at = (seconds) => estimate({ ...DEFAULTS, megapixels: 0.8, seconds, steps: 20, refs: 0 });
  assert.equal(at(5).tone, 'ok');
  assert.equal(at(8).tone, 'warn');
  assert.equal(at(10).tone, 'bad');
  assert.equal(estimate({ ...DEFAULTS, megapixels: 0.8, seconds: 5, vramGB: 24, reserveGB: 2.5, refs: 0 }).tone, 'ok');
});

test('each reference image adds tokens, and the count is bounded to what the node accepts', () => {
  const at = (refs) => estimate({ ...DEFAULTS, megapixels: 0.8, seconds: 5, refs });
  assert.equal(at(0).tokens, 30240);
  assert.equal(at(2).tokens, 30240 + 2 * 2 * 38 * 21); // latent block + vision tokens, 38x21 cells at 1216x672
  assert.ok(at(9).totalMin > at(4).totalMin && at(4).totalMin > at(0).totalMin);
  assert.equal(at(10), null);
  assert.equal(at(-1), null);
  assert.equal(at(1.5), null);
});

test('bad input gives null instead of NaN', () => {
  assert.equal(estimate({ ...DEFAULTS, seconds: 0 }), null);
  assert.equal(estimate({ ...DEFAULTS, megapixels: 'x' }), null);
  assert.equal(estimate({ ...DEFAULTS, steps: 0 }), null);
});

test('a length written as a step rounded to 0.1s renders that step, not the next one up', () => {
  const math = require('../renderer/workflow-math');
  for (const [seconds, frames] of [[4.5, 107], [5.2, 124], [5.9, 141], [6.6, 158], [7.3, 175], [8, 192], [9.5, 226]]) {
    assert.equal(math.frameCount(seconds), frames, `${seconds}s`);
    assert.equal(frameCount(seconds), frames, `${seconds}s budget`);
  }
});
