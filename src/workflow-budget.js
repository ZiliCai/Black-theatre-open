const BudgetCalc = require('../renderer/budget-calc');

const normalize = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();

function buildBudget({ template, summary, context = {} }) {
  const aspect = template.manifest.aspects.find((item) => item.label === summary.aspect);
  const estimate = BudgetCalc.estimate({
    megapixels: summary.megapixels,
    aspectW: aspect.w,
    aspectH: aspect.h,
    seconds: summary.duration,
    steps: summary.steps,
    useCfg: false,
    refs: summary.references.length,
    vramGB: context.vramTotal ? context.vramTotal / 1e9 : 10,
    reserveGB: context.reserveVram ?? 2.5,
  });
  if (!estimate) return { ok: false, errors: ['当前参数无法计算资源预算'] };

  const models = new Map((context.models || []).map((model) => [normalize(model.relPath), model]));
  const missing = [];
  const sizeOf = (relPath) => {
    const model = models.get(normalize(relPath));
    if (!model) {
      missing.push(relPath);
      return 0;
    }
    return model.sizeBytes || 0;
  };
  let bytes = template.manifest.resources.reduce((sum, relPath) => sum + sizeOf(relPath), 0);
  for (const lora of summary.loras) bytes += sizeOf(`loras/${lora.name}`);
  if (summary.turboEnabled) bytes += sizeOf(`loras/${summary.turboModelValue}`);

  const weightsGB = bytes / 1e9;
  const estimatedRamGB = weightsGB + estimate.actGB;
  const ramFreeGB = context.ramFree ? context.ramFree / 1e9 : null;
  let ramTone = 'idle';
  if (ramFreeGB !== null) {
    ramTone = 'ok';
    if (estimatedRamGB > ramFreeGB) ramTone = 'bad';
    else if (estimatedRamGB > ramFreeGB * 0.8) ramTone = 'warn';
  }
  const deghost = !!summary.extensions.find((extension) => extension.label === '运动去残影' && extension.enabled);
  return {
    ok: true,
    ...estimate,
    weightsGB,
    estimatedRamGB,
    ramFreeGB,
    ramTotalGB: context.ramTotal ? context.ramTotal / 1e9 : null,
    ramTone,
    deghost,
    missingResources: [...new Set(missing)],
  };
}

module.exports = { buildBudget };
