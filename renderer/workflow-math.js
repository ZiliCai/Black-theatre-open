(function (root) {
  function dimensions(aspect, megapixels, multiple = 32) {
    const totalPixels = megapixels * 1024 * 1024;
    const scale = Math.sqrt(totalPixels / (aspect.w * aspect.h));
    return {
      width: Math.max(multiple, Math.round((aspect.w * scale) / multiple) * multiple),
      height: Math.max(multiple, Math.round((aspect.h * scale) / multiple) * multiple),
    };
  }

  function resolutionTier(width, height) {
    const longEdge = Math.max(width, height);
    if (longEdge >= 1800) return '约 2K';
    if (longEdge <= 900) return '约 480p';
    return '约 1K';
  }

  // The model takes 17k+5 frames. A length a hair over a step (5.2s = 124.8 frames, the 124-frame step shown
  // rounded) stays on that step instead of jumping 0.7s to the next one.
  function frameCount(seconds) {
    let n = Math.max(5, Math.round(seconds * 24) - 2);
    while (n % 17 !== 5) n += 1;
    return n;
  }

  const api = { dimensions, resolutionTier, frameCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkflowMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
