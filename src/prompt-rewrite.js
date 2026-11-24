// An AI rewrite as the pages use it: the user's remark is carried out, then the result is tidied (negations turned
// into what is there, repeats and edit-talk dropped) so remarks never pile up as "don't …". 整理 alone is the second
// step by itself. The LLM is passed in as llm(messages) -> reply text. Plain Node, no Electron.
const {
  buildRevisionMessages, buildPictureRevisionMessages, parseRevision, parsePictureRevision, checkRevision,
} = require('./prompt-optimizers');
const { addedNegations, paceOf, ensureNoSubtitles, SECONDS_PER_ACTION, NO_SUBTITLES } = require('./prompt-hygiene');
const { parseAffects, fromList } = require('./shot-links');

// the remarks the tidy step sends: same picture, same shot; only the way it is said changes
const TIDY_PICTURE = '整理一下：画面不变，把「不要」「没有」「不再」这类否定写法换成正面的样子，删掉两段里重复的话和修改口吻的话';
const TIDY_VIDEO = `整理一下：画面、动作节拍和台词都不变，把 no、not、never、does not 这类否定写法换成正面的样子，删掉反复强调同一件事的话。只有一句例外：画面上没有字幕这件事固定写成「${NO_SUBTITLES}」，原文里绕着说的（字幕在画面外、画面只有场景本身、画面铺满画框）都换回这一句`;
// the remark a shot gets when it holds more actions than its length can show at a calm pace
const PACE = (pace, duration) => `节奏太急：这一镜 ${duration} 秒，现在写了大约 ${pace.beats} 个动作（${(pace.actions || []).map((a, i) => `${i + 1}. ${a.length > 90 ? `${a.slice(0, 90)}…` : a}`).join(' ')}），模型会把每个都做完，就一个赶一个。按每 ${SECONDS_PER_ACTION} 秒左右一个动作，只留最要紧的 ${pace.allowed} 个，其余删掉，不要压缩着写；开头的状态和结尾停住的样子保持不变（前后镜头要接）。留下的动作写慢一点，中间留停顿、反应和呼吸。开头画面里已经在的东西写成已经在那儿，不写成现铺、现拿。台词一句不删。`;
const TIDY_FAILED = '整理这一步没成功，先用的是只按你的话改过的版本，可以再点一次「整理」';

// What the user is told when the text ended up with more "don't …" than it started with.
function negationWarning(before, after) {
  const added = addedNegations(before, after);
  return added.length ? [`改完多了 ${added.length} 处否定写法（${added.slice(0, 3).map((c) => `「${c}」`).join('')}），模型读到反而容易画出来，可以再点一次「整理」或手动换成正面说法`] : [];
}

// A shot prompt: { text, note, warnings, affects } or { refuse }. References are checked against the final text.
// around: { text, ids } — the shots around it as the request shows them, and the ids it may name as affected.
async function rewriteShotPrompt({ text, feedback = '', context = {}, tidyOnly = false, around = { text: '', ids: [] }, llm }) {
  const references = (context && context.references) || [];
  const pass = async (from, remark, neighbours = '') => {
    const raw = await llm(buildRevisionMessages({ text: from, feedback: remark, context, neighbours }));
    const { prompt, note } = parseRevision(raw);
    return { prompt, note, raw, refuse: checkRevision({ before: from, after: prompt, references }).refuse };
  };
  const notes = [];
  const warnings = [];
  let affects = [];
  let current = text;
  if (!tidyOnly) {
    const first = await pass(text, feedback, around.text);
    if (first.refuse) return { refuse: first.refuse };
    current = first.prompt;
    if (first.note) notes.push(first.note);
    affects = parseAffects(first.raw, around.ids);
  }
  try {
    const tidy = await pass(current, TIDY_VIDEO);
    if (tidy.refuse) {
      if (tidyOnly) return { refuse: tidy.refuse };
      warnings.push(TIDY_FAILED);
    } else {
      if (tidyOnly && tidy.note) notes.push(tidy.note);
      else if (tidy.prompt !== current) notes.push('顺带整理了否定写法和重复的话');
      current = tidy.prompt;
    }
  } catch (e) {
    if (tidyOnly) throw e;
    warnings.push(TIDY_FAILED);
  }
  // a shot holding more actions than its length: one more pass that keeps the important ones and slows them down
  const duration = Number(context && context.duration);
  let pace = paceOf(current, duration);
  if (pace.dense) {
    try {
      const slower = await pass(current, PACE(pace, duration));
      const after = paceOf(slower.prompt, duration);
      if (!slower.refuse && after.beats < pace.beats) {
        notes.push(`放慢了节奏：动作从大约 ${pace.beats} 个减到 ${after.beats} 个`);
        current = slower.prompt;
        pace = after;
      }
    } catch {
      // the rewrite stands as it is; the warning below says what is left to do
    }
    if (pace.dense) warnings.push(`这一镜 ${duration} 秒写了大约 ${pace.beats} 个动作，出片会显得急：删掉次要的动作、加长时长，或拆成两镜`);
  }
  current = ensureNoSubtitles(current);
  const { refuse, warnings: checked } = checkRevision({ before: text, after: current, references });
  if (refuse) return { refuse };
  return { text: current, note: notes.join('；'), warnings: [...checked, ...warnings, ...negationWarning(text, current)], affects };
}

// A card's look and wish: { look, ask, note, warnings, affects }. A reply that is not the JSON asked for gets one
// more try. users: { text, ids } — the shots that show the card, and the ids it may name as affected.
async function rewritePicture({ card, mode, ask: wish = '', look, feedback = '', tidyOnly = false, users = { text: '', ids: [] }, llm }) {
  const pass = async (from, remark, usage = '') => {
    const messages = buildPictureRevisionMessages({ card, mode, ask: from.ask, look: from.look, feedback: remark, usage });
    let r;
    try {
      r = parsePictureRevision(await llm(messages));
    } catch {
      r = parsePictureRevision(await llm(messages));
    }
    return { ask: r.ask, look: r.look ?? from.look, note: r.note, affects: r.affects };
  };
  const start = { ask: wish, look };
  const notes = [];
  const warnings = [];
  let affects = [];
  let current = start;
  if (!tidyOnly) {
    const first = await pass(start, feedback, users.text);
    current = { ask: first.ask, look: first.look };
    if (first.note) notes.push(first.note);
    // only a changed look can leave a shot behind
    if (first.look !== start.look) affects = fromList(first.affects, users.ids);
  }
  try {
    const tidy = await pass(current, TIDY_PICTURE);
    if (tidyOnly && tidy.note) notes.push(tidy.note);
    else if (tidy.ask !== current.ask || tidy.look !== current.look) notes.push('顺带整理了否定写法和重复的话');
    current = { ask: tidy.ask, look: tidy.look };
  } catch (e) {
    if (tidyOnly) throw e;
    warnings.push(TIDY_FAILED);
  }
  const text = (p) => `${p.look}\n${p.ask}`;
  return { ...current, note: notes.join('；'), warnings: [...warnings, ...negationWarning(text(start), text(current))], affects };
}

module.exports = { rewriteShotPrompt, rewritePicture, negationWarning, TIDY_PICTURE, TIDY_VIDEO };
