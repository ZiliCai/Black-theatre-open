const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs } = require('../src/args');
const { defaultConfig } = require('../src/config');

test('default config starts silently and enables latent previews', () => {
  assert.deepEqual(buildArgs(defaultConfig()), [
    '-s', 'ComfyUI\\main.py', '--windows-standalone-build', '--disable-auto-launch', '--port', '8188',
    '--lowvram', '--reserve-vram', '2.5', '--disable-pinned-memory', '--preview-method', 'auto',
  ]);
});

test('unchecked flags are left out', () => {
  const cfg = defaultConfig();
  cfg.flags.lowvram = false;
  cfg.flags.disablePinnedMemory = false;
  assert.deepEqual(buildArgs(cfg), [
    '-s', 'ComfyUI\\main.py', '--windows-standalone-build', '--disable-auto-launch', '--port', '8188',
    '--reserve-vram', '2.5', '--preview-method', 'auto',
  ]);
});

test('custom port and reserve-vram are used', () => {
  const cfg = defaultConfig();
  cfg.port = 8199;
  cfg.flags.reserveVram = 4;
  const args = buildArgs(cfg);
  assert.equal(args[args.indexOf('--port') + 1], '8199');
  assert.equal(args[args.indexOf('--reserve-vram') + 1], '4');
});

test('reserve-vram of 0 is still passed (zero is a real value)', () => {
  const cfg = defaultConfig();
  cfg.flags.reserveVram = 0;
  const args = buildArgs(cfg);
  assert.equal(args[args.indexOf('--reserve-vram') + 1], '0');
});

test('extra args are split on whitespace and appended last', () => {
  const cfg = defaultConfig();
  cfg.flags.extraArgs = '  --preview-method auto   --fast ';
  const args = buildArgs(cfg);
  assert.deepEqual(args.slice(-3), ['--preview-method', 'auto', '--fast']);
  assert.equal(args.filter((arg) => arg === '--preview-method').length, 1);
  assert.equal(args.includes(''), false);
});
