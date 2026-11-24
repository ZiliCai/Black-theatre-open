// The rules of the shot page, as plain functions over plain data: the three tiers, shot order, where a shot
// continues from, which takes no longer join up, and the episode timeline. Nothing here touches files.
const DEFAULT_DURATION = 5;

const ms = (seconds) => Math.round(seconds * 1000) / 1000;
const succeeded = (t) => t && t.status === 'succeeded';
const takesOf = (states, shotId) => ((states.get(shotId) || {}).takes || []);

// MOTION-E01-05 -> "05", HAND-E01-1 -> "手动1": how a shot is named in messages.
function shotNo(shotId) {
  const id = String(shotId);
  const last = id.split('-').pop();
  return /^HAND-/i.test(id) ? `手动${last}` : last;
}

// Setting a take's tier: the same tier again clears it, and a shot has at most one pick (the old one becomes cand).
function applyTier(takes, takeId, tier) {
  const target = takes.find((t) => t.id === takeId);
  const next = target && target.tier === tier ? '' : tier;
  return takes.map((t) => {
    if (t.id === takeId) return { ...t, tier: next };
    if (next === 'pick' && t.tier === 'pick') return { ...t, tier: 'cand' };
    return t;
  });
}

function pickOf(takes) {
  return (takes || []).find((t) => t.tier === 'pick' && succeeded(t)) || null;
}

function latestCand(takes) {
  return (takes || []).filter((t) => t.tier === 'cand' && succeeded(t)).sort((a, b) => b.n - a.n)[0] || null;
}

// Script shots in the order of their numbers; hand-made shots go in one by one, oldest first, each where it was
// put. One made "before" or "after" a shot goes right next to it: replayed in the order they were made, that gives
// the list the user saw each time. One with only `after` (made before that choice existed) keeps its old rule:
// after that shot and the hand-made shots already put after it. One whose shot is gone goes to the end.
function orderEpisode(scriptShots, manualShots) {
  const out = [...scriptShots].sort((a, b) => a.id.localeCompare(b.id, 'zh', { numeric: true }));
  const tail = [];
  for (const m of [...manualShots].sort((a, b) => a.createdAt - b.createdAt)) {
    if (m.anchor && (m.place === 'before' || m.place === 'after')) {
      const list = out.some((s) => s.id === m.anchor) ? out : tail;
      const i = list.findIndex((s) => s.id === m.anchor);
      if (i < 0) tail.push(m);
      else list.splice(m.place === 'before' ? i : i + 1, 0, m);
      continue;
    }
    let at = m.after ? out.findIndex((s) => s.id === m.after) : -1;
    if (at < 0) {
      tail.push(m);
      continue;
    }
    while (at + 1 < out.length && out[at + 1].after === m.after && /^HAND-/i.test(out[at + 1].id)) at++;
    out.splice(at + 1, 0, m);
  }
  return [...out, ...tail];
}

function resolveContinuation({ order, states, shotId, choice, templateId, templateNames = {} }) {
  const mode = choice && choice.mode;
  if (!mode || mode === 'none') return { ok: true, enabled: false };
  if (mode === 'legacy') {
    return { ok: true, enabled: true, clip: `h3_context/clip_${choice.legacyShot}.jpg [output]`, from: { legacy: choice.legacyShot } };
  }
  let sourceId = choice.shotId;
  if (mode === 'previous') {
    const at = order.findIndex((s) => s.id === shotId);
    if (at <= 0) return { ok: false, message: '这是本集第一镜，没有上一镜可接' };
    sourceId = order[at - 1].id;
  }
  const no = shotNo(sourceId);
  const pick = pickOf(takesOf(states, sourceId));
  if (!pick) return { ok: false, message: `镜头 ${no} 还没有选中，先去选一条` };
  if (pick.templateId !== templateId) {
    return { ok: false, message: `镜头 ${no} 是用 ${templateNames[pick.templateId] || pick.templateId} 生成的，当前模板接不了` };
  }
  if (!pick.context) return { ok: false, message: `镜头 ${no} 的选中没有接续文件，换一条带接续的模板重新生成` };
  return { ok: true, enabled: true, clip: `h3_context/${pick.context}.jpg [output]`, from: { shotId: sourceId, takeId: pick.id } };
}

// For every take: '' when it still joins up, 'prev-changed' when the shot it continued from now has another pick,
// 'upstream-changed' when the take it continued from is itself out of date.
function staleness({ states }) {
  const byId = new Map();
  for (const [shotId, state] of states) for (const t of state.takes || []) byId.set(t.id, { shotId, take: t });
  const memo = new Map();
  const visiting = new Set();
  function of(take) {
    if (memo.has(take.id)) return memo.get(take.id);
    const from = take.continuedFrom;
    let result = '';
    if (from && from.shotId && !visiting.has(take.id)) {
      visiting.add(take.id);
      const pick = pickOf(takesOf(states, from.shotId));
      if (!pick || pick.id !== from.takeId) result = 'prev-changed';
      else if (of(pick)) result = 'upstream-changed';
      visiting.delete(take.id);
    }
    memo.set(take.id, result);
    return result;
  }
  const out = new Map();
  for (const { take } of byId.values()) out.set(take.id, of(take));
  return out;
}

function dependents(states, takeId) {
  const out = [];
  for (const [shotId, state] of states) {
    for (const t of state.takes || []) {
      if (t.tier !== 'trash' && t.continuedFrom && t.continuedFrom.takeId === takeId) out.push({ shotId, takeId: t.id });
    }
  }
  return out;
}

function timeline({ order, states, gapMode = 'black' }) {
  const stale = staleness({ order, states });
  const segments = [];
  let start = 0;
  let previousPick = null;
  let previousShot = null;
  for (const shot of order) {
    const state = states.get(shot.id) || {};
    const takes = state.takes || [];
    const pick = pickOf(takes);
    const cand = latestCand(takes);
    const planned = (state.draft && state.draft.values && Number(state.draft.values.duration)) || shot.duration || DEFAULT_DURATION;
    let used = null;
    let kind = 'gap';
    if (pick) [used, kind] = [pick, 'pick'];
    else if (gapMode === 'cand' && cand) [used, kind] = [cand, 'cand'];
    const linked = !!(pick && previousPick && pick.continuedFrom && pick.continuedFrom.shotId === previousShot && pick.continuedFrom.takeId === previousPick.id);
    previousPick = pick;
    previousShot = shot.id;
    if (kind === 'gap' && gapMode === 'skip') continue;
    const duration = ms((used && used.durationSec) || planned);
    segments.push({
      shotId: shot.id, start: ms(start), duration, kind, linked,
      takeId: used ? used.id : null, video: used ? used.video : null, hasCand: !!cand,
      // the upscaled version, once there is one
      upscaled: used && used.upscale && used.upscale.status === 'succeeded' && used.upscale.video ? used.upscale.video : null,
      stale: used ? stale.get(used.id) || '' : '',
    });
    start += duration;
  }
  return { total: ms(start), segments };
}

// Where time t of the episode falls: which segment, and how far into it. Clamped to the ends.
function locate(segments, t) {
  if (!segments.length) return null;
  const last = segments.length - 1;
  if (t <= 0) return { index: 0, offset: 0 };
  for (let i = 0; i <= last; i++) {
    const s = segments[i];
    if (t < s.start + s.duration || i === last) return { index: i, offset: ms(Math.min(Math.max(t - s.start, 0), s.duration)) };
  }
  return null;
}

function shotStatus(takes) {
  if ((takes || []).some((t) => t.status === 'queued' || t.status === 'running')) return 'running';
  if (pickOf(takes)) return 'pick';
  if ((takes || []).some((t) => t.tier === 'cand' && succeeded(t))) return 'cand';
  return 'none';
}

module.exports = { shotNo, applyTier, pickOf, latestCand, orderEpisode, resolveContinuation, staleness, dependents, timeline, locate, shotStatus, DEFAULT_DURATION };
