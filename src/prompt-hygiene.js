// Keeping prompts free of the "don't …" pile that grows when every remark is answered with one more negation.
// Image and video models attend to the things they read, so "耳后不夹烟" or "the bicycle does not move" puts the
// cigarette and the motion in front of them. Plain text checks, no LLM: used to clean what the code assembles and
// to tell the user when a rewrite added negations. Plain Node, no Electron.

// Chinese words that start with 不 but are not saying "not this" (不远处, 不停地, 不同 …).
const NOT_NEGATION = /^不(远|停|断|同|少|久|过|管|仅|住|禁|起|了|由|时|妨|免|然|料|知不觉)/;
const ZH_WORDS = /(不要|不再|不能|不会|不是|不准|不许|不必|不用|别|没有|没|避免|去掉|免得|勿|无须)/;
const ZH_BARE = /不[一-龥]/g;
const EN = /\b(no|not|never|without|avoid|avoids|avoiding|none|nor|don't|doesn't|isn't|aren't|won't|can't|cannot)\b|n't\b/i;

// The clauses of a text (split at Chinese and English punctuation), trimmed and non-empty.
const clauses = (text) => String(text || '').split(/[。；;！!？?\n]|\.(?=\s|$)|[，,、](?![^（(]*[）)])/).map((s) => s.trim()).filter(Boolean);

function isNegation(clause) {
  if (EN.test(clause) || ZH_WORDS.test(clause)) return true;
  // a bare 不 only counts when what follows is not one of the everyday words above
  return [...clause.matchAll(ZH_BARE)].some((m) => !NOT_NEGATION.test(clause.slice(m.index)));
}

// The clauses that say what is not there. Spoken lines (<d>…</d>) are what someone says, not what is shown, and
// the one fixed no-subtitles sentence of a video prompt is meant to be there.
const negations = (text) => clauses(String(text || '').replace(/<d>[\s\S]*?<\/d>/g, ' ').split('No subtitles or on-screen text of any kind.').join(' '))
  .filter(isNegation);

// Negations a rewrite brought in that were not there before (the same clause anywhere before counts as there).
function addedNegations(before, after) {
  const had = new Set(negations(before));
  return [...new Set(negations(after))].filter((c) => !had.has(c));
}

// "画面上没有字幕和文字" and its variants: the picture prompt adds this once by itself, so copies in the parts the
// user or the model wrote are dropped instead of stacking up.
// Only that clause goes: "红色防风衣，画面里不要出现文字。" keeps "红色防风衣".
const NO_TEXT_CLAUSE = /[^。！？\n，,；;]*(?:没有|不要|无|不出现|不带)[^。！？\n，,；;]*(?:字幕|文字|水印)[^。！？\n，,；;]*[。！？，,；;]?/g;
const dropNoText = (text) => String(text || '').replace(NO_TEXT_CLAUSE, '')
  .replace(/[，,；;]+(?=[。！？]|$)/g, '').replace(/\s{2,}/g, ' ').trim();

// The project's style paragraph is written for whoever writes the prompts: it holds instructions to the writer
// ("提示词里统一写明……") and rules for other kinds of pictures ("丧尸和恐怖的画面……", "夜戏……"). A picture gets only
// the sentences about how it looks, and the conditional ones only when the card is that kind of picture.
const WRITER_NOTE = /提示词|统一写明|写明|按[^。；]*来写|都按/;
const CONDITIONS = [
  { when: /丧尸|恐怖|尸变/, card: /丧尸|尸变|恐怖|尸体|咬痕|血/ },
  { when: /夜戏|夜里|夜景/, card: /夜|晚上|黑夜|深夜|凌晨/ },
];

function pictureStyle(style, cardText = '') {
  const parts = String(style || '').split(/(?<=[。；])/).map((s) => s.trim()).filter(Boolean);
  const kept = [];
  for (const part of parts) {
    const rule = CONDITIONS.find((c) => c.when.test(part));
    if (rule && !rule.card.test(cardText)) continue;
    if (!WRITER_NOTE.test(part)) {
      kept.push(part);
      continue;
    }
    // "丧尸按……来写，吓人但不恶心：灰白发青的皮肤……" — what follows the colon is how it looks
    const at = part.lastIndexOf('：');
    const look = at >= 0 ? dropNoText(part.slice(at + 1)) : '';
    if (look && !WRITER_NOTE.test(look)) kept.push(/[。；]$/.test(look) ? look : `${look}。`);
  }
  // a sentence cut at "；" keeps reading as one: end it with "。"
  return kept.join('').replace(/；$/, '。').trim();
}

module.exports = { negations, addedNegations, isNegation, dropNoText, pictureStyle };

// ---- pace: how many things the people of a shot do, against its length ----
// H3 carries out every action it reads, so seven actions in seven seconds come out one on top of the next, hurried.
// Counted in [Shot 1] of detailed_description, in the sentences about a character (<Subject n>, he, she, the dog),
// cut into clauses at "then", ";" and "and <verb>s": each clause is one action, unless it only says how things are
// (stands at the stove, already holding, holds still for a beat, his eyes stay on the pan), which takes no time.
// A rough count, meant to catch the shot that is plainly overfull, not to grade one that is close.
const SECONDS_PER_ACTION = 2.5;
const NO_SUBTITLES = 'No subtitles or on-screen text of any kind.';
const STATE_CLAUSE = new RegExp([
  '\\b(already|still|from the first frame|in frame)\\b',
  // a clause that opens on a verb of being somewhere or keeping still: "<Subject 1> stands at …", "her eyes stay …",
  // or, after "then"/"and", on the bare verb: "breathes", "pauses for a breath", "holds them there a moment"
  '^(?:(?:<Subject \\d+>(?:\'s)?(?: \\w+)?|(?:he|she|they|it)|(?:his|her|its|their|the) \\w+)\\s+)?(?:\\w+ly\\s+)?'
    + '(?:is|are|stands(?! up)|sits(?! (?:up|down))|lies(?! down)|stays?|remains?|keeps?|holds? (?:still|\\w+ there)'
    + '|rests?|waits?|pauses?|lets?|breathes|takes (?:a|one) (?:\\w+ )?breath|settles|comes? to (?:a stop|rest)|fills?|watches|gazes|looks on)\\b',
  // things lying where they are: "a cardboard sheet lies spread out beside the truck", "the kitchen door stands open"
  '\\b(?:lies|lie|hangs?) (?:spread|flat|open|on|in|beside|by|across)\\b|\\bstands? (?:open|ajar)\\b',
].join('|'), 'i');
// Saying the line while doing something ("pushes the phone toward him and says, …") is one beat, not two.
const SPEECH_WITH = /^(?:then\s+)?(?:says|asks|answers|replies|calls(?: out)?|mutters|murmurs|whispers|shouts|barks|snaps|adds)\b/i;
// "by 00:01.5 the camera has tilted down …": the camera moving, not anyone in the shot
const CAMERA_CLAUSE = (c) => { const at = c.search(/\bthe camera\b/i); return at >= 0 && !/<Subject \d+>|\b(he|she|they)\b/i.test(c.slice(0, at)); };
// A sentence that sets up the frame ("Medium shot in <Subject 2>.", "Continuing at the table: she …"): only what
// follows its colon is action.
const FRAMING = /^(?:(?:extreme |very )?(?:wide|medium|close|tight|full|long|over-the-shoulder)\b[^.:]*shot\b|one continuous|continuing|picking up|hard cut)/i;
function paceOf(prompt, duration) {
  const text = String(prompt || '').replace(/\r\n?/g, '\n');
  const m = /detailed_description\s*:\s*([\s\S]*?)(?:\n\s*overall_soundscape\s*:|$)/i.exec(text);
  // a spoken line counts as saying something, and ends the sentence it closes
  const desc = (m ? m[1] : '').replace(/^[\s\S]*?\[Shot 1\]/, '').replace(/<d>[\s\S]*?<\/d>/g, 'something.');
  const sentences = desc.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => (FRAMING.test(s) ? (s.includes(':') ? s.slice(s.indexOf(':') + 1).trim() : '') : s)).filter(Boolean);
  const actions = [];
  for (const s of sentences) {
    if (/^(the )?camera\b/i.test(s)) continue;
    if (!/<Subject \d+>|\b(he|she|they)\b|^(then,? )?(it|his|her|its)\b|\bthe dog\b/i.test(s)) continue;
    const parts = s.split(/\bthen\b|;|,?\s+and\s+(?=(?:then\s+)?[a-z]+(?:s|es)\b(?!\s+of))/i)
      .map((c) => c.replace(/^[\s,]+/, '').trim()).filter(Boolean);
    actions.push(...parts.filter((c, i) => !STATE_CLAUSE.test(c) && !CAMERA_CLAUSE(c) && !(i > 0 && SPEECH_WITH.test(c))));
  }
  const beats = actions.length;
  const seconds = Number(duration) > 0 ? Number(duration) : 0;
  const allowed = Math.max(2, Math.round(seconds / SECONDS_PER_ACTION));
  return { beats, allowed, dense: seconds > 0 && beats > allowed + 1, actions };
}

// The one negation a video prompt keeps, in one fixed wording: a prompt without it (the tidy step once talked it
// into "captions sit outside the frame") gets it after the first sentence of detailed_description, the look line.
function ensureNoSubtitles(prompt) {
  const text = String(prompt || '');
  if (text.includes(NO_SUBTITLES) || /no subtitles/i.test(text)) return text;
  const m = /(detailed_description\s*:\s*)([^\n]*?[.!?])(\s|$)/i.exec(text);
  if (!m) return text;
  const at = m.index + m[1].length + m[2].length;
  return `${text.slice(0, at)} ${NO_SUBTITLES}${text.slice(at)}`;
}

module.exports.paceOf = paceOf;
module.exports.ensureNoSubtitles = ensureNoSubtitles;
module.exports.NO_SUBTITLES = NO_SUBTITLES;
module.exports.SECONDS_PER_ACTION = SECONDS_PER_ACTION;
