// Pure helpers behind the finished-work page: search, tab counts, card labels, time and size text.
// Loaded as a plain <script> in the page and required by node:test.
(function (root) {
  const haystack = (e) => {
    const p = e.params || {};
    return [
      e.relPath, e.keptShot ? `分镜 ${e.keptShot} ${e.keptShot}` : '', p.summary, p.promptText, p.seed, p.turbo ? 'turbo' : '',
      ...(p.refs || []), ...(p.loras || []),
    ].filter((x) => x !== null && x !== undefined && x !== '').join(' ').toLowerCase();
  };

  const words = (query) => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (e, ws) => {
    if (!ws.length) return true;
    const text = haystack(e);
    return ws.every((w) => text.includes(w));
  };

  // "1-4", "1－4", " 1 - 4 " -> "1-4"; null = not a shot number. Same rule as src/clip-keep.js.
  function normalizeShot(text) {
    const s = String(text ?? '').replace(/\s/g, '').replace(/[－—–_]/g, '-').toLowerCase();
    return /^\d{1,3}-\d{1,4}[a-z]?$/.test(s) ? s : null;
  }

  // 1-4 before 1-10 before 2-1
  function compareShots(a, b) {
    const pa = String(a).split('-');
    const pb = String(b).split('-');
    return parseInt(pa[0], 10) - parseInt(pb[0], 10) || parseInt(pa[1], 10) - parseInt(pb[1], 10) || String(a).localeCompare(String(b));
  }

  // kind 'kept' = the takes kept for a shot, in shot order
  function filterEntries(entries, { kind = '', query = '' } = {}) {
    const ws = words(query);
    if (kind === 'kept') return entries.filter((e) => e.keptShot && matches(e, ws)).sort((a, b) => compareShots(a.keptShot, b.keptShot));
    return entries.filter((e) => (!kind || e.kind === kind) && matches(e, ws));
  }

  function countByKind(entries, query) {
    const ws = words(query);
    const out = { video: 0, image: 0, kept: 0 };
    for (const e of entries) {
      if (!matches(e, ws)) continue;
      if (out[e.kind] !== undefined) out[e.kind]++;
      if (e.keptShot) out.kept++;
    }
    return out;
  }

  // Small labels on a card: kept for which shot, which clip of a chain it is, what it continues, how it was sampled.
  function chipsOf(e) {
    const p = e.params;
    const chips = e.keptShot ? [{ text: `★ 分镜 ${e.keptShot}`, tone: 'kept' }] : [];
    if (!p) return chips;
    if (p.clipIndex) chips.push({ text: `第 ${p.clipIndex} 段`, tone: 'clip' });
    if (p.continued && p.continueFrom) chips.push({ text: `接第 ${p.continueFrom} 段`, tone: 'link' });
    if (p.steps) chips.push(p.turbo ? { text: `Turbo ${p.steps} 步`, tone: 'fast' } : { text: `${p.steps} 步`, tone: 'plain' });
    return chips;
  }

  const titleOf = (e) => (e.params && e.params.summary) || e.name;

  function formatDuration(sec) {
    if (!sec || sec < 0) return '';
    if (sec < 60) return `${sec.toFixed(1)} 秒`;
    const whole = Math.round(sec);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  const formatResolution = (w, h) => (w && h ? `${w}×${h}` : '');

  const two = (n) => String(n).padStart(2, '0');
  function formatStamp(ms, nowMs) {
    const d = new Date(ms);
    const now = new Date(nowMs);
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return `今天 ${hm}`;
    if (diff === 1) return `昨天 ${hm}`;
    const md = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
    return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
  }

  // After deleting item `removed` out of `total` items, which index should the viewer show? -1 = none left.
  function indexAfterRemoval(total, removed) {
    const left = total - 1;
    if (left <= 0) return -1;
    return Math.min(removed, left - 1);
  }

  const api = { filterEntries, countByKind, chipsOf, titleOf, formatDuration, formatResolution, formatStamp, indexAfterRemoval, normalizeShot, compareShots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GalleryFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
