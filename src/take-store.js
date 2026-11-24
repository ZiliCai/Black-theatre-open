// Takes (one generation run each), drafts and hand-made shots of a script project, kept inside the project in
// .blackbox/ so they travel with it. One file per shot: a damaged file costs that shot only, and it is moved
// aside (never overwritten) before anything new is written there. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');
const { removeFile } = require('./fs-safe');

const VERSION = 1;
const SHOT_ID = /^(MOTION|HAND)-[A-Z0-9]+-\d+$/i;

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// undefined = no file, null = a file that is not JSON
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// MOTION-E01-05 -> e01-05, HAND-E01-1 -> h-e01-1: short, ASCII, safe in a ComfyUI file name.
function shortName(shotId) {
  const s = String(shotId).toLowerCase();
  if (s.startsWith('motion-')) return s.slice('motion-'.length);
  if (s.startsWith('hand-')) return `h-${s.slice('hand-'.length)}`;
  return s.replace(/[^a-z0-9-]+/g, '-');
}

function check(shotId) {
  if (!SHOT_ID.test(String(shotId))) throw new Error(`镜头编号不对:${shotId}`);
}

function createTakeStore(projectDir, { now = Date.now, rand = Math.random } = {}) {
  const root = path.join(projectDir, '.blackbox');
  const shotFile = (shotId) => path.join(root, 'shots', `${shotId}.json`);
  const manualFile = path.join(root, 'manual-shots.json');

  // a damaged file goes aside as <name>.corrupt-<time>.json so a hand edit is never lost
  function keepAside(file) {
    if (readJson(file) !== null) return;
    const ext = path.extname(file);
    fs.renameSync(file, `${file.slice(0, -ext.length)}.corrupt-${now()}${ext}`);
  }

  function load(shotId) {
    if (!SHOT_ID.test(String(shotId))) return { draft: null, takes: [], warning: `镜头编号不对:${shotId}` };
    const data = readJson(shotFile(shotId));
    if (data === undefined) return { draft: null, takes: [], warning: '' };
    if (data === null || typeof data !== 'object') {
      return { draft: null, takes: [], warning: `镜头 ${shotId} 的记录文件损坏，已按空白处理（原文件会另存为 .corrupt 备份，不会被覆盖）` };
    }
    return {
      draft: data.draft && typeof data.draft === 'object' ? data.draft : null,
      takes: Array.isArray(data.takes) ? data.takes.filter((t) => t && typeof t.id === 'string') : [],
      warning: '',
    };
  }

  function save(shotId, { draft, takes }) {
    check(shotId);
    keepAside(shotFile(shotId));
    writeJson(shotFile(shotId), { version: VERSION, shotId, draft, takes });
  }

  function listShotIds() {
    try {
      return fs.readdirSync(path.join(root, 'shots'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((id) => SHOT_ID.test(id))
        .sort();
    } catch {
      return [];
    }
  }

  // shots taken off the list ("HAND-E01-3.1793….json"): their numbers stay used
  function deletedIds() {
    try {
      return fs.readdirSync(path.join(root, 'deleted')).map((name) => name.split('.')[0]).filter((id) => SHOT_ID.test(id));
    } catch {
      return [];
    }
  }

  function readManualData() {
    const data = readJson(manualFile);
    if (data === undefined) return { shots: [], damaged: false };
    if (!data || !Array.isArray(data.shots)) return { shots: [], damaged: true };
    return { shots: data.shots.filter((s) => s && typeof s.id === 'string'), damaged: false };
  }

  return {
    readShot: load,

    writeDraft(shotId, draft) {
      check(shotId);
      save(shotId, { ...load(shotId), draft });
    },

    addTake(shotId, partial) {
      check(shotId);
      const shot = load(shotId);
      const n = shot.takes.reduce((max, t) => Math.max(max, Number(t.n) || 0), 0) + 1;
      const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
      const id = `${shortName(shotId)}-t${String(n).padStart(3, '0')}-${suffix}`;
      const take = { tier: '', status: 'queued', error: null, ...partial, id, n, createdAt: now(), outputKey: `bb_${id}` };
      save(shotId, { draft: shot.draft, takes: [...shot.takes, take] });
      return take;
    },

    updateTake(shotId, takeId, patch) {
      const shot = load(shotId);
      const i = shot.takes.findIndex((t) => t.id === takeId);
      if (i < 0) return null;
      const take = { ...shot.takes[i], ...patch };
      shot.takes[i] = take;
      save(shotId, shot);
      return take;
    },

    replaceTakes(shotId, takes) {
      save(shotId, { draft: load(shotId).draft, takes });
    },

    listShotIds,

    // true when some shot's record could not be read: its takes (and their files) are unknown
    isDamaged() {
      return listShotIds().some((id) => readJson(shotFile(id)) === null);
    },

    readManual: () => readManualData().shots,

    manualWarning() {
      return readManualData().damaged ? '手动镜头的记录文件损坏，已按空白处理（新建手动镜头时原文件会另存为 .corrupt 备份）' : '';
    },

    // after: the older placement (after that shot and the hand-made shots already put after it).
    // anchor + place ('before' | 'after'): right next to that shot, as the list stood when this one was made.
    addManual({ episode, title, after, anchor, place }) {
      const { shots } = readManualData();
      // numbers already used by a record file count too, so a new shot never takes over an old one's takes
      const used = [...shots.map((s) => s.id), ...listShotIds(), ...deletedIds()]
        .map((id) => new RegExp(`^HAND-${episode}-(\\d+)$`, 'i').exec(id))
        .filter(Boolean)
        .map((m) => Number(m[1]));
      const n = (used.length ? Math.max(...used) : 0) + 1;
      const next = anchor && (place === 'before' || place === 'after') ? { after: null, anchor: String(anchor), place } : { after: after || null };
      const shot = { id: `HAND-${episode}-${n}`, episode, title: String(title || ''), ...next, createdAt: now() };
      if (fs.existsSync(manualFile)) keepAside(manualFile);
      writeJson(manualFile, { version: VERSION, shots: [...shots, shot] });
      return shot;
    },

    // A shot taken off the list: a hand-made one leaves the manual list, the ones placed next to it move to
    // `moved` ({ anchor, place } or { anchor: null } for the end), and its record goes aside into
    // .blackbox/deleted/ with whatever else is worth keeping (`extra`), so the number is never reused for it.
    removeShot(shotId, { moved = { anchor: null }, extra = {} } = {}) {
      check(shotId);
      const { shots } = readManualData();
      const gone = shots.find((s) => s.id === shotId) || null;
      const placed = (s) => s.anchor === shotId || s.after === shotId;
      const next = shots.filter((s) => s.id !== shotId).map((s) => (!placed(s) ? s
        : moved.anchor ? { ...s, after: null, anchor: moved.anchor, place: moved.place } : { ...s, after: null, anchor: null, place: null }));
      if (gone || shots.some(placed)) {
        if (fs.existsSync(manualFile)) keepAside(manualFile);
        writeJson(manualFile, { version: VERSION, shots: next });
      }
      const record = readJson(shotFile(shotId));
      writeJson(path.join(root, 'deleted', `${shotId}.${now()}.json`), { version: VERSION, shotId, deletedAt: now(), manual: gone, record: record === undefined ? null : record, ...extra });
      if (record !== undefined) removeFile(shotFile(shotId));
      return { manual: gone };
    },
  };
}

module.exports = { createTakeStore, shortName, SHOT_ID };
