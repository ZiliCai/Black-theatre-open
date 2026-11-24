// Whitebox scenes of a project: 白模/<名字>.scene.json, with the versions they replaced in 白模/.history, and the
// pictures taken from their cameras in ref/ (named by the scene's code, so a card can pick them up). Plain Node.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { removeFile } = require('./fs-safe');
const { emptyScene, buildScene, checkScene } = require('./scene-model');
const { shotFacts, setupForShot, resolveSetup, cameraFacts, factsText } = require('./scene-blocking');

const DIR = '白模';
const EXT = '.scene.json';
const HISTORY_KEEP = 30;
const BAD = /[<>:"/\\|?*\u0000-\u001f]/;
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const two = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
const okId = (id) => typeof id === 'string' && id.trim() && id.length <= 80 && !BAD.test(id) && !id.startsWith('.');

function createSceneService({ getProjectDir, now = () => new Date() }) {
  const dirOf = () => {
    const p = getProjectDir();
    return p ? path.join(p, DIR) : null;
  };
  const fileOf = (id) => path.join(dirOf(), `${id}${EXT}`);
  const need = (fn) => (...args) => (dirOf() ? fn(...args) : { ok: false, noProject: true, message: '还没有打开剧本项目' });

  function read(id) {
    if (!okId(id)) return { ok: false, message: '场景名字不对' };
    let raw;
    try {
      raw = fs.readFileSync(fileOf(id));
    } catch {
      return { ok: false, message: `找不到场景「${id}」` };
    }
    let scene;
    try {
      scene = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return { ok: false, message: `「${id}」不是有效的 JSON：${e.message}`, broken: true, text: raw.toString('utf8'), version: sha1(raw) };
    }
    return { ok: true, id, scene, version: sha1(raw) };
  }

  function write(id, scene) {
    const file = fileOf(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.from(`${JSON.stringify(scene, null, 1)}\n`, 'utf8');
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
    return sha1(buf);
  }

  function keepHistory(id) {
    const file = fileOf(id);
    if (!fs.existsSync(file)) return;
    const dir = path.join(dirOf(), '.history', id);
    fs.mkdirSync(dir, { recursive: true });
    let name = `${stamp(now())}.json`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stamp(now())}-${n}.json`;
    fs.copyFileSync(file, path.join(dir, name));
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) removeFile(path.join(dir, old));
  }

  // the scenes with blocking, read again only when a file changed; and what was worked out per shot
  let cache = { key: '', scenes: [], facts: new Map() };
  function blockedScenes() {
    const dir = dirOf();
    if (!dir) return [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(EXT)); } catch { return []; }
    const key = `${dir}|${files.map((f) => { try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`; } catch { return f; } }).join('|')}`;
    if (key !== cache.key) {
      const scenes = files.map((f) => read(f.slice(0, -EXT.length))).filter((r) => r.ok && Array.isArray(r.scene.setups) && r.scene.setups.length);
      cache = { key, scenes, facts: new Map() };
    }
    return cache.scenes;
  }

  return {
    // What the camera of a shot sees, from the first scene whose blocking covers the shot: { id, facts } or null.
    factsFor(shotId) {
      const scenes = blockedScenes();
      if (cache.facts.has(shotId)) return cache.facts.get(shotId);
      let found = null;
      for (const r of scenes) {
        if (!setupForShot(r.scene, shotId)) continue;
        try { found = { id: r.id, facts: shotFacts(r.scene, shotId) }; } catch { found = null; }
        break;
      }
      cache.facts.set(shotId, found);
      return found;
    },

    list: need(() => {
      let names = [];
      try {
        names = fs.readdirSync(dirOf()).filter((f) => f.endsWith(EXT));
      } catch {
        names = [];
      }
      const scenes = names.map((f) => {
        const id = f.slice(0, -EXT.length);
        const st = fs.statSync(path.join(dirOf(), f));
        const r = read(id);
        return { id, name: r.ok ? r.scene.name || id : id, rooms: r.ok && Array.isArray(r.scene.rooms) ? r.scene.rooms.length : 0, broken: !r.ok, mtimeMs: st.mtimeMs };
      }).sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { ok: true, scenes, folder: dirOf() };
    }),

    // the scene with what it draws and what is wrong with it
    open: need((id) => {
      const r = read(id);
      if (!r.ok) return r;
      return { ...r, built: buildScene(r.scene), problems: checkScene(r.scene) };
    }),

    // with a setup: its people and cameras drawn in, and what each of its cameras sees in words
    build: (scene, setup) => {
      const out = { ok: true, built: buildScene(scene, { setup }), problems: checkScene(scene) };
      const chosen = setup && (scene.setups || []).find((s) => s && s.name === setup);
      if (chosen) {
        const plain = buildScene(scene);
        const r = resolveSetup(scene, chosen, plain);
        out.facts = Object.fromEntries(r.cameras.map((c) => [c.name, factsText(cameraFacts(scene, r, c, plain))]));
      }
      return out;
    },

    create: need((name, scene) => {
      const id = String(name || '').trim();
      if (!okId(id)) return { ok: false, message: '名字不能空着，也不能有 \\ / : * ? " < > | 这些字符' };
      if (fs.existsSync(fileOf(id))) return { ok: false, message: `已经有一个叫「${id}」的场景了` };
      const version = write(id, scene || emptyScene(id));
      return { ok: true, id, version };
    }),

    // version: what the page opened; a file changed since then (another editor, Claude) is not overwritten
    save: need((id, scene, version, { overwrite = false } = {}) => {
      if (!okId(id)) return { ok: false, message: '场景名字不对' };
      if (!scene || typeof scene !== 'object' || !Array.isArray(scene.rooms)) return { ok: false, message: '不是一个场景（要有 rooms 数组）' };
      const cur = read(id);
      if (cur.ok && !overwrite && cur.version !== version) return { ok: false, conflict: true, message: '这个场景在你打开之后被改过了（可能是别的程序或 Claude），请重新打开' };
      keepHistory(id);
      return { ok: true, version: write(id, scene) };
    }),

    // a picture taken from one of the scene's cameras, as a reference image: ref/<代号><n>_<机位>.png, or, for a
    // camera that says which asset card it shoots for (card: "YS-DT"), ref/YS-DT_白模_<机位>.png, which that card
    // then finds among its pictures and can use as the base of an image-to-image picture
    // shotCard(shotIds): the location card the shots use, for a blocking camera that does not name its own
    saveShot: need(({ id, index, camera, dataUrl }, shotCard = () => '') => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, message: '截图不是 PNG' };
      const r = read(id);
      const code = r.ok && r.scene.code ? String(r.scene.code).replace(BAD, '') : id.replace(BAD, '');
      const label = String(camera || '').replace(/[（(].*$/, '').replace(BAD, '').replace(/\s+/g, '').slice(0, 30) || '机位';
      const all = r.ok ? [...(r.scene.cameras || []), ...(r.scene.setups || []).flatMap((s) => (s && Array.isArray(s.cameras) ? s.cameras : []))] : [];
      const cam = all.find((c) => c && c.name === camera);
      const own = cam && typeof cam.card === 'string' ? cam.card : cam && Array.isArray(cam.shots) && cam.shots.length ? shotCard(cam.shots) : '';
      const card = String(own || '').replace(BAD, '').trim();
      const file = card ? `${card}_白模_${label}.png` : `${code}${Number(index) + 1}_${label}.png`;
      const dir = path.join(getProjectDir(), 'ref');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), Buffer.from(m[1], 'base64'));
      return { ok: true, relPath: `ref/${file}` };
    }),
  };
}

module.exports = { createSceneService, DIR, EXT };
