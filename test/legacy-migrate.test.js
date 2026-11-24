const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyUserData, MARKER } = require('../src/legacy-migrate');

function dirs({ oldConfig, newConfig, oldSecrets, newSecrets }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  const fromDir = path.join(base, 'comfyui-launcher');
  const toDir = path.join(base, 'blackbox-theater');
  fs.mkdirSync(fromDir);
  fs.mkdirSync(toDir);
  if (oldConfig) fs.writeFileSync(path.join(fromDir, 'config.json'), JSON.stringify(oldConfig));
  if (newConfig) fs.writeFileSync(path.join(toDir, 'config.json'), JSON.stringify(newConfig));
  if (oldSecrets) fs.writeFileSync(path.join(fromDir, 'secrets.json'), oldSecrets);
  if (newSecrets) fs.writeFileSync(path.join(toDir, 'secrets.json'), newSecrets);
  return { fromDir, toDir };
}
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const OLD = {
  llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', optimizer: 'refine' },
  projects: ['C:\\BlackBox\\projects\\穿越时空'],
};
const NEW = {
  port: 8188,
  llm: { baseUrl: '', model: '', optimizer: 'refine' },
  projects: ['C:\\Users\\user\\OneDrive\\2026祥泰\\宣传视频'],
  activeProject: 'C:\\Users\\user\\OneDrive\\2026祥泰\\宣传视频',
};

test('moves llm settings and missing projects, and asks for the key again', () => {
  const d = dirs({ oldConfig: OLD, newConfig: NEW, oldSecrets: '{"k":"enc"}' });
  const first = migrateLegacyUserData(d);
  assert.deepEqual(first.moved.sort(), ['llm', 'projects']);
  assert.equal(first.message, '已从旧版本搬来 DeepSeek 设置和 1 个项目（API 密钥需要在 设置 · 常规 里重新填写一次）');
  const cfg = read(d.toDir, 'config.json');
  assert.equal(cfg.llm.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(cfg.projects, [...NEW.projects, ...OLD.projects]);
  assert.equal(cfg.activeProject, NEW.activeProject);
  assert.equal(cfg.port, 8188);
  // the key was encrypted for the old app folder and cannot be read by the new one: it is not copied
  assert.equal(fs.existsSync(path.join(d.toDir, 'secrets.json')), false);
});

test('runs once: a project removed later, or a cleared address, does not come back', () => {
  const d = dirs({ oldConfig: OLD, newConfig: NEW });
  migrateLegacyUserData(d);
  assert.ok(fs.existsSync(path.join(d.toDir, MARKER)));
  const cfg = read(d.toDir, 'config.json');
  fs.writeFileSync(path.join(d.toDir, 'config.json'), JSON.stringify({ ...cfg, projects: NEW.projects, llm: { ...cfg.llm, baseUrl: '' } }));
  assert.deepEqual(migrateLegacyUserData(d), { moved: [], message: '' });
  assert.deepEqual(read(d.toDir, 'config.json').projects, NEW.projects);
  assert.equal(read(d.toDir, 'config.json').llm.baseUrl, '');
});

test('never overwrites a non-empty llm', () => {
  const mine = { ...NEW, llm: { baseUrl: 'https://mine', model: 'm', optimizer: 'refine' }, projects: OLD.projects };
  const d = dirs({ oldConfig: OLD, newConfig: mine, oldSecrets: '{"k":"old"}', newSecrets: '{"k":"new"}' });
  assert.deepEqual(migrateLegacyUserData(d), { moved: [], message: '' });
  assert.equal(read(d.toDir, 'config.json').llm.baseUrl, 'https://mine');
  assert.equal(fs.readFileSync(path.join(d.toDir, 'secrets.json'), 'utf8'), '{"k":"new"}');
});

test('a fresh install with no new config takes the old settings', () => {
  const d = dirs({ oldConfig: OLD });
  const r = migrateLegacyUserData(d);
  assert.deepEqual(r.moved.sort(), ['llm', 'projects']);
  assert.equal(read(d.toDir, 'config.json').llm.model, 'deepseek-flash');
  assert.equal(r.message, '已从旧版本搬来 DeepSeek 设置和 1 个项目');
});

test('missing old dir is a no-op', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  assert.deepEqual(migrateLegacyUserData({ fromDir: path.join(base, 'nope'), toDir: base }), { moved: [], message: '' });
  assert.equal(fs.existsSync(path.join(base, 'config.json')), false);
});

test('the old folder is left untouched', () => {
  const d = dirs({ oldConfig: OLD, newConfig: NEW, oldSecrets: '{"k":"enc"}' });
  const before = fs.readFileSync(path.join(d.fromDir, 'config.json'), 'utf8');
  migrateLegacyUserData(d);
  assert.equal(fs.readFileSync(path.join(d.fromDir, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(d.fromDir, 'secrets.json')), true);
});
