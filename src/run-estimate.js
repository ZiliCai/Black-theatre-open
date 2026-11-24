// How long a new take should take, learned from the project's finished takes of the same template.
// Longer and sharper takes take longer, but far from proportionally (loading models and encoding the prompt do
// not grow with them), so only half of a run scales with length and half with size.
const RECENT = 8;
const MAX_RUN_MS = 3 * 60 * 60 * 1000;

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function ratio(now, then) {
  const a = Number(now);
  const b = Number(then);
  return a > 0 && b > 0 ? 0.5 + 0.5 * (a / b) : 1;
}

// takes: records from take-store; returns { totalMs, firstStepMs, tailMs } (the last two may be null) or null.
function estimateRun(takes, { templateId, values = {}, renderedOn = 'local' }) {
  const past = takes
    // a remote GPU and this computer run at very different speeds: only takes made where this one will be
    .filter((t) => t && t.status === 'succeeded' && t.templateId === templateId && (t.renderedOn || 'local') === renderedOn)
    .map((t) => ({ take: t, totalMs: Number(t.completedAt) - Number(t.startedAt) }))
    .filter(({ totalMs }) => totalMs > 0 && totalMs < MAX_RUN_MS)
    .sort((a, b) => b.take.completedAt - a.take.completedAt)
    .slice(0, RECENT);
  if (!past.length) return null;
  const scaled = past.map(({ take, totalMs }) => {
    const v = take.values || {};
    const scale = ratio(values.duration, v.duration) * ratio(values.megapixels, v.megapixels);
    const t = take.timing || {};
    return {
      totalMs: totalMs * scale,
      firstStepMs: t.firstStepMs > 0 ? t.firstStepMs : null, // loading and encoding: does not grow with the take
      tailMs: t.tailMs > 0 ? t.tailMs * scale : null,
    };
  });
  const of = (key) => {
    const known = scaled.map((s) => s[key]).filter((x) => x !== null);
    return known.length ? Math.round(median(known)) : null;
  };
  return { totalMs: of('totalMs'), firstStepMs: of('firstStepMs'), tailMs: of('tailMs') };
}

module.exports = { estimateRun };
