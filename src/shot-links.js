// Keeping shots joined up when one of them is rewritten. A rewrite sees the shots around it (the end the next shot
// opens on, the opening this one continues from) or, for a card, the shots that show it, and names the shots that
// must change with it. Those the user does not change now keep a note ("镜 7 改过：……") until their prompt changes.
// Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');

const SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const MAX_PART = 1800; // characters of a neighbour's text: enough for its beats, short enough to keep the request small

const shotNo = (shotId) => {
  const m = /-(\d+)$/.exec(String(shotId));
  return m ? m[1] : String(shotId);
};

// One section of a six-section H3 prompt ("" when it has no such section).
function sectionOf(prompt, name) {
  const text = String(prompt || '');
  const start = new RegExp(`^\\s*${name}\\s*[:：]`, 'm').exec(text);
  if (!start) return '';
  const rest = text.slice(start.index + start[0].length);
  const next = new RegExp(`^\\s*(${SECTIONS.join('|')})\\s*[:：]`, 'm').exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

const clip = (text, max = MAX_PART) => {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// Where a shot's beats are: its detailed_description, or the whole prompt when it is not in six sections.
const beatsOf = (prompt) => clip(sectionOf(prompt, 'detailed_description') || prompt);

// The shots around shotId in its episode. order: [{ id, prompt, continuePrevious }], drafts: Map id -> draft.
// joined: the later shot opens on the end of the earlier one (it is made from its last frames).
function neighboursOf({ order, drafts = new Map(), shotId }) {
  const at = order.findIndex((s) => s.id === shotId);
  if (at < 0) return { previous: null, next: [] };
  const continues = (later, earlierId, earlierIndex) => {
    const choice = drafts.get(later.id) && drafts.get(later.id).continuation;
    if (choice && choice.mode === 'shot') return choice.shotId === earlierId;
    if (choice && choice.mode === 'previous') return order.indexOf(later) === earlierIndex + 1;
    if (choice && choice.mode === 'none') return false;
    return !!later.continuePrevious && order.indexOf(later) === earlierIndex + 1;
  };
  const me = order[at];
  const prev = at > 0 ? order[at - 1] : null;
  const previous = prev ? { id: prev.id, prompt: prev.prompt || '', joined: continues(me, prev.id, at - 1) } : null;
  // the next shot, and any later one made from this shot's end
  const next = order.filter((s, i) => i > at && (i === at + 1 || continues(s, me.id, at)))
    .map((s) => ({ id: s.id, prompt: s.prompt || '', joined: continues(s, me.id, at) }));
  return { previous, next };
}

// The part of a shot rewrite's request that shows the shots around it.
function neighbourText({ previous, next }) {
  if (!previous && !next.length) return '';
  const lines = ['前后镜头（只给你对照，不要改它们；镜头编号照抄）：'];
  if (previous) {
    lines.push(`上一镜 ${previous.id}${previous.joined ? '（这一镜接着它生成：开头是它结尾的画面）' : ''}：`, beatsOf(previous.prompt), '');
  }
  for (const n of next) {
    lines.push(`后面的 ${n.id}${n.joined ? '（接着这一镜生成：开头是这一镜结尾的画面）' : '（紧接在这一镜后面）'}：`, beatsOf(n.prompt), '');
  }
  return lines.join('\n').trim();
}

// The part of a card rewrite's request that shows the shots using the card: how each one describes its subjects.
function usageText(shots) {
  if (!shots.length) return '';
  const lines = ['用到这张卡的镜头（只给你对照，不要改它们；镜头编号照抄）：'];
  for (const s of shots) lines.push(`${s.id}：`, clip(sectionOf(s.prompt, 'subject_definitions') || s.prompt, 900), '');
  return lines.join('\n').trim();
}

// "<affects>" lines of a reply: "MOTION-E00-009 | 原因 | 给那一镜的修改说明". Only shots in `allowed` count.
function parseAffects(raw, allowed) {
  const m = /<affects>([\s\S]*?)<\/affects>/.exec(String(raw || ''));
  if (!m) return [];
  return fromList(m[1].split('\n').map((line) => line.split(/\s*[|｜]\s*/)).map(([shot, reason, remark]) => ({ shot, reason, remark })), allowed);
}

// The same from a JSON reply's "affects": [{ shot, reason, remark }].
function fromList(list, allowed) {
  const ok = new Set(allowed || []);
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const shotId = String((item && item.shot) || '').trim().replace(/^[-*\s]+/, '').toUpperCase();
    const reason = String((item && item.reason) || '').trim();
    const remark = String((item && item.remark) || '').trim();
    if (!ok.has(shotId) || seen.has(shotId) || !remark) continue;
    seen.add(shotId);
    out.push({ shotId, n: shotNo(shotId), reason, remark });
  }
  return out;
}

// ---- notes on shots that were not changed along with the one they depend on ----
const notesFile = (projectDir) => path.join(projectDir, '.blackbox', 'link-notes.json');

function readNotes(projectDir) {
  try {
    const data = JSON.parse(fs.readFileSync(notesFile(projectDir), 'utf8'));
    return data && typeof data.notes === 'object' && data.notes ? data.notes : {};
  } catch {
    return {};
  }
}

function writeNotes(projectDir, notes) {
  const file = notesFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, notes }, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function setNote(projectDir, shotId, { from, reason, remark }, now = Date.now()) {
  const notes = readNotes(projectDir);
  notes[shotId] = { from: String(from || ''), reason: String(reason || ''), remark: String(remark || ''), at: now };
  writeNotes(projectDir, notes);
}

function clearNote(projectDir, shotId) {
  const notes = readNotes(projectDir);
  if (!notes[shotId]) return;
  delete notes[shotId];
  writeNotes(projectDir, notes);
}

module.exports = {
  sectionOf, neighboursOf, neighbourText, usageText, parseAffects, fromList, readNotes, setNote, clearNote, shotNo,
};
