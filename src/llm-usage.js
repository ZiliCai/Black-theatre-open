// What the language model has been used for and what it cost: one line per call in a JSONL file in the app's
// data folder, and a price table (yuan per million tokens, off-peak and peak) to turn tokens into money.
// Plain Node, no Electron.
const fs = require('node:fs');
const path = require('node:path');

// DeepSeek's published prices, yuan per million tokens: [off-peak, peak]. Cache-hit input, cache-miss input, output.
const DEFAULT_PRICES = {
  currency: '元',
  // off-peak hours, Beijing time (UTC+8); the rest of the day is peak
  offPeak: { start: '00:30', end: '08:30' },
  models: [
    { model: 'deepseek-flash', hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
    { model: 'deepseek-v4-pro', hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
  ],
};

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Whether a moment falls in the off-peak hours (Beijing time). A window may run past midnight (22:00–06:00).
function isOffPeak(at, offPeak = DEFAULT_PRICES.offPeak) {
  const start = minutesOf(offPeak && offPeak.start);
  const end = minutesOf(offPeak && offPeak.end);
  if (start === null || end === null || start === end) return false;
  const d = new Date(at + 8 * 3600 * 1000);
  const now = d.getUTCHours() * 60 + d.getUTCMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// The token counts of one reply's usage block. DeepSeek splits the input into cache hits and misses; an
// OpenAI-style service reports cached tokens under prompt_tokens_details. Reasoning is part of the output.
function countsOf(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  const prompt = n(u.prompt_tokens);
  const hit = u.prompt_cache_hit_tokens !== undefined ? n(u.prompt_cache_hit_tokens) : n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
  const miss = u.prompt_cache_miss_tokens !== undefined ? n(u.prompt_cache_miss_tokens) : Math.max(0, prompt - hit);
  return { hit, miss, out: n(u.completion_tokens), reasoning: n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) };
}

// The price row for a model name: exact, then the longest listed name it starts with (deepseek-v4-pro-0813).
function priceFor(prices, model) {
  const name = String(model || '').trim().toLowerCase();
  const rows = (prices && Array.isArray(prices.models) ? prices.models : []).filter((r) => r && r.model);
  return rows.find((r) => r.model.toLowerCase() === name)
    || rows.filter((r) => name.startsWith(r.model.toLowerCase())).sort((a, b) => b.model.length - a.model.length)[0]
    || null;
}

// Yuan for one call, or null when the model has no price row.
function costOf(entry, prices) {
  const row = priceFor(prices, entry.model);
  if (!row) return null;
  const i = isOffPeak(entry.at, prices.offPeak) ? 0 : 1;
  const per = (pair) => (Array.isArray(pair) ? Number(pair[i]) || 0 : 0);
  return (entry.hit * per(row.hit) + entry.miss * per(row.miss) + entry.out * per(row.out)) / 1e6;
}

function validPrices(value) {
  const pair = (p) => Array.isArray(p) && p.length === 2 && p.every((x) => Number.isFinite(Number(x)) && Number(x) >= 0);
  if (!value || typeof value !== 'object' || !Array.isArray(value.models) || !value.models.length) return null;
  const valid = (r) => r && typeof r.model === 'string' && r.model.trim() && pair(r.hit) && pair(r.miss) && pair(r.out);
  if (!value.models.every(valid)) return null;
  const models = value.models
    .map((r) => ({ model: r.model.trim(), hit: r.hit.map(Number), miss: r.miss.map(Number), out: r.out.map(Number) }));
  const offPeak = value.offPeak && minutesOf(value.offPeak.start) !== null && minutesOf(value.offPeak.end) !== null
    ? { start: value.offPeak.start.trim(), end: value.offPeak.end.trim() } : DEFAULT_PRICES.offPeak;
  return { currency: DEFAULT_PRICES.currency, offPeak, models };
}

const dayOf = (at) => new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10);

function createUsageLog({ dir, now = () => Date.now() }) {
  const file = path.join(dir, 'llm-usage.jsonl');
  const priceFile = path.join(dir, 'llm-prices.json');

  function readPrices() {
    try {
      return validPrices(JSON.parse(fs.readFileSync(priceFile, 'utf8'))) || DEFAULT_PRICES;
    } catch {
      return DEFAULT_PRICES;
    }
  }

  function readEntries() {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (Number.isFinite(e.at)) out.push(e);
      } catch { /* a line cut off by a crash: skip it */ }
    }
    return out;
  }

  return {
    // One call's usage. Never throws: losing a line of bookkeeping must not fail the call it describes.
    // prefix: the fingerprint of the call's system prompt (calls with the same one can share the prompt cache).
    record({ model, usage, purpose = '', prefix = '' }) {
      if (!usage) return null;
      const entry = { at: now(), model: String(model || ''), purpose: String(purpose || ''), ...countsOf(usage), ...(prefix ? { prefix: String(prefix) } : {}) };
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      } catch { return null; }
      return entry;
    },

    prices: readPrices,

    setPrices(value) {
      const checked = validPrices(value);
      if (!checked) return { ok: false, message: '价格表格式不对：每行要有模型名，以及空闲/高峰两档的命中输入、未命中输入、输出单价' };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(priceFile, `${JSON.stringify(checked, null, 2)}\n`);
      return { ok: true, prices: checked };
    },

    resetPrices() {
      try { fs.rmSync(priceFile, { force: true }); } catch { /* nothing to remove */ }
      return { ok: true, prices: DEFAULT_PRICES };
    },

    // Totals per day and model, per purpose, and overall, each priced at the time of every call.
    summary() {
      const prices = readPrices();
      const blank = () => ({ calls: 0, hit: 0, miss: 0, out: 0, reasoning: 0, cost: 0, unpriced: 0 });
      const add = (into, e, cost) => {
        into.calls += 1;
        into.hit += e.hit || 0;
        into.miss += e.miss || 0;
        into.out += e.out || 0;
        into.reasoning += e.reasoning || 0;
        if (cost === null) into.unpriced += 1;
        else into.cost += cost;
      };
      const byDay = new Map();
      const byPurpose = new Map();
      const total = blank();
      const today = blank();
      const month = blank();
      const nowDay = dayOf(now());
      for (const e of readEntries()) {
        const cost = costOf(e, prices);
        const day = dayOf(e.at);
        const key = `${day}\u0000${e.model}`;
        if (!byDay.has(key)) byDay.set(key, { day, model: e.model, ...blank() });
        add(byDay.get(key), e, cost);
        const p = e.purpose || '其他';
        if (!byPurpose.has(p)) byPurpose.set(p, { purpose: p, ...blank() });
        add(byPurpose.get(p), e, cost);
        add(total, e, cost);
        if (day === nowDay) add(today, e, cost);
        if (day.slice(0, 7) === nowDay.slice(0, 7)) add(month, e, cost);
      }
      return {
        ok: true,
        prices,
        days: [...byDay.values()].sort((a, b) => (a.day === b.day ? a.model.localeCompare(b.model) : b.day.localeCompare(a.day))),
        purposes: [...byPurpose.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls),
        total,
        today,
        month,
      };
    },
  };
}

module.exports = { DEFAULT_PRICES, isOffPeak, countsOf, priceFor, costOf, validPrices, createUsageLog };
