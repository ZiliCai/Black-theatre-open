// Pure maths behind the budget page: MiniMax H3 resolution, frames, tokens, VRAM and time.
// Resolution, frame and token formulas mirror ComfyUI_MiniMax_H3_Extender/extender.py (exact).
// VRAM and time are estimates: time is scaled from one measured run, VRAM from the model's width.
// Loaded as a plain <script> in the page and required by node:test.
(function (root) {
  const FPS = 24;
  const AUDIO_LATENT_FPS = 40;
  const GRID = 32;
  const HIDDEN = 5376;
  const FFN = 14336;
  const ATTN_DIM = 56 * 128;
  const LAYERS = 50;
  const PARAMS_PER_LAYER = 347e6;
  const ACT_BYTES_PER_TOKEN = (HIDDEN * 6 + FFN * 2) * 2; // bf16 activations alive in one layer, an estimate
  const FIXED_VRAM_GB = 1.8; // layer-weight working set plus desktop/CUDA context, an estimate

  // The 3080 run in the log: 1056x608, 8 s, 87 s per forward pass.
  const DEFAULTS = {
    megapixels: 0.8, aspectW: 16, aspectH: 9, seconds: 5, steps: 20, useCfg: false, refs: 2,
    vramGB: 10, reserveGB: 2.5, calibTokens: 36679, calibSeconds: 87, textTokens: 300,
  };

  function resolution(megapixels, aspectW, aspectH) {
    const scale = Math.sqrt((megapixels * 1024 * 1024) / (aspectW * aspectH));
    const snap = (v) => Math.max(GRID, Math.floor((v * scale) / GRID) * GRID);
    return { width: snap(aspectW), height: snap(aspectH) };
  }

  // same steps as workflow-math: a length a hair over a step stays on it
  function frameCount(seconds) {
    let n = Math.max(5, Math.round(seconds * FPS) - 2);
    while (n % 17 !== 5) n += 1;
    return n;
  }

  // Each reference image costs tokens twice, as a latent block in the video model and as vision tokens in the
  // text encoder. At the default "match" sizing both are about one grid cell per 32x32 pixels of the video. An estimate.
  const refTokens = (width, height) => 2 * (width / GRID) * (height / GRID);

  function tokenCount(width, height, frames, textTokens, refs = 0) {
    const latentT = Math.floor((frames - 5) / 17) * 5 + 2;
    const audioT = Math.round((frames / FPS) * AUDIO_LATENT_FPS);
    const video = latentT * (width / GRID) * (height / GRID);
    return { latentT, tokens: video + 2 * audioT + textTokens + refs * refTokens(width, height) };
  }

  // linear layers plus attention, which grows with the square of the token count
  const cost = (n) => 2 * PARAMS_PER_LAYER * LAYERS * n + 4 * n * n * ATTN_DIM * LAYERS;

  const positive = (v) => Number.isFinite(v) && v > 0;

  function estimate(input) {
    const p = { ...DEFAULTS, ...input };
    const needPositive = [p.megapixels, p.aspectW, p.aspectH, p.seconds, p.steps, p.vramGB, p.calibTokens, p.calibSeconds];
    if (!needPositive.every(positive) || !Number.isFinite(p.reserveGB) || p.reserveGB < 0
      || !Number.isInteger(p.refs) || p.refs < 0 || p.refs > 9) return null;

    const { width, height } = resolution(p.megapixels, p.aspectW, p.aspectH);
    const frames = frameCount(p.seconds);
    const { latentT, tokens } = tokenCount(width, height, frames, p.textTokens, p.refs);
    const secPerPass = (p.calibSeconds * cost(tokens)) / cost(p.calibTokens);
    const passes = p.steps * (p.useCfg ? 2 : 1);
    const actGB = (tokens * ACT_BYTES_PER_TOKEN) / 1e9;
    const usableGB = p.vramGB - p.reserveGB - FIXED_VRAM_GB;
    const ratio = usableGB > 0 ? actGB / usableGB : Infinity;
    let tone = 'ok';
    let verdict = '显存充足';
    if (ratio > 1) { tone = 'bad'; verdict = '很可能爆显存,请降低分辨率或时长'; }
    else if (ratio >= 0.7) { tone = 'warn'; verdict = '显存紧张,可能能跑,建议先试短片段'; }
    return {
      width, height, frames, latentT, tokens, actGB, usableGB, ratio, tone, verdict,
      secPerPass, passes, totalMin: (passes * secPerPass) / 60,
    };
  }

  const api = { DEFAULTS, resolution, frameCount, tokenCount, estimate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
