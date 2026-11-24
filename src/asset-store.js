// Pictures made for the cards of a script project, kept inside the project in .blackbox/assets/ so they travel
// with it. One file per card: its draft, every take, the pictures kept in it and which one is the main picture.
// A damaged file costs that card only and is moved aside before anything new is written. Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const CARD_CODE = /^[A-Z0-9-]+$/;

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

function check(code) {
  if (!CARD_CODE.test(String(code))) throw new Error(`代号不对:${code}`);
}

const EMPTY = { kind: '', draft: null, takes: [], set: [], main: '' };

function createAssetStore(projectDir, { now = Date.now, rand = Math.random } = {}) {
  const dir = path.join(projectDir, '.blackbox', 'assets');
  const cardFile = (code) => path.join(dir, `${code}.json`);

  function keepAside(file) {
    if (readJson(file) !== null) return;
    const ext = path.extname(file);
    fs.renameSync(file, `${file.slice(0, -ext.length)}.corrupt-${now()}${ext}`);
  }

  function load(code) {
    if (!CARD_CODE.test(String(code))) return { ...EMPTY, warning: `代号不对:${code}` };
    const data = readJson(cardFile(code));
    if (data === undefined) return { ...EMPTY, warning: '' };
    if (data === null || typeof data !== 'object') {
      return { ...EMPTY, warning: `${code} 的记录文件损坏，已按空白处理（原文件会另存为 .corrupt 备份，不会被覆盖）` };
    }
    return {
      kind: typeof data.kind === 'string' ? data.kind : '',
      draft: data.draft && typeof data.draft === 'object' ? data.draft : null,
      takes: Array.isArray(data.takes) ? data.takes.filter((t) => t && typeof t.id === 'string') : [],
      set: Array.isArray(data.set) ? data.set.filter((s) => s && typeof s.image === 'string') : [],
      main: typeof data.main === 'string' ? data.main : '',
      warning: '',
    };
  }

  function save(code, card) {
    check(code);
    keepAside(cardFile(code));
    const { kind, draft, takes, set, main } = card;
    writeJson(cardFile(code), { version: VERSION, code, kind, draft, set, main, takes });
  }

  // Read, change, write back: fn gets a copy of the card and returns the parts to replace.
  function change(code, fn) {
    check(code);
    const card = load(code);
    const next = { ...card, ...fn(card) };
    save(code, next);
    return next;
  }

  function listCodes() {
    try {
      return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((code) => CARD_CODE.test(code))
        .sort();
    } catch {
      return [];
    }
  }

  return {
    readCard: load,
    change,
    listCodes,

    writeDraft(code, draft, kind) {
      change(code, (card) => ({ draft, kind: kind || card.kind }));
    },

    addTake(code, partial) {
      let take;
      change(code, (card) => {
        const n = card.takes.reduce((max, t) => Math.max(max, Number(t.n) || 0), 0) + 1;
        const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
        const id = `${code.toLowerCase()}-t${String(n).padStart(3, '0')}-${suffix}`;
        take = { tier: '', status: 'queued', error: null, ...partial, id, n, createdAt: now(), outputKey: `bb_${id}` };
        return { takes: [...card.takes, take] };
      });
      return take;
    },

    updateTake(code, takeId, patch) {
      let updated = null;
      if (!load(code).takes.some((t) => t.id === takeId)) return null;
      change(code, (card) => ({
        takes: card.takes.map((t) => (t.id === takeId ? (updated = { ...t, ...patch }) : t)),
      }));
      return updated;
    },

    // true when some card's record could not be read: its takes (and their files) are unknown
    isDamaged() {
      return listCodes().some((code) => readJson(cardFile(code)) === null);
    },

    // The record-store interface the generation queue uses after a restart (the same as the shot store's).
    listShotIds: listCodes,
    readShot: load,
  };
}

module.exports = { createAssetStore, CARD_CODE };
