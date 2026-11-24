// Pure helpers behind the model page's search box, tag chips and category groups.
// Loaded as a plain <script> in the page and required by node:test.
(function (root) {
  const haystack = (m) =>
    [m.name, m.title, m.desc, m.family, m.category, ...(m.tags || [])].join(' ').toLowerCase();

  function filterModels(models, { query = '', tag = '', category = '' } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((m) => {
      if (category && m.category !== category) return false;
      if (tag && !(m.tags || []).includes(tag)) return false;
      if (!words.length) return true;
      const text = haystack(m);
      return words.every((w) => text.includes(w));
    });
  }

  function collectTags(models) {
    const counts = new Map();
    for (const m of models) for (const t of m.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
  }

  function groupByCategory(models) {
    const groups = new Map();
    for (const m of models) {
      if (!groups.has(m.category)) groups.set(m.category, { category: m.category, models: [], sizeBytes: 0 });
      const g = groups.get(m.category);
      g.models.push(m);
      g.sizeBytes += m.sizeBytes || 0;
    }
    return [...groups.values()];
  }

  const api = { filterModels, collectTags, groupByCategory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ModelFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
