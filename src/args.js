// Turns the launcher config into the argument list for python_embeded\python.exe.
function buildArgs(config) {
  const args = ['-s', 'ComfyUI\\main.py', '--windows-standalone-build', '--disable-auto-launch', '--port', String(config.port)];
  const f = config.flags;
  if (f.lowvram) args.push('--lowvram');
  if (f.reserveVram !== null && f.reserveVram !== undefined && f.reserveVram !== '') {
    args.push('--reserve-vram', String(f.reserveVram));
  }
  if (f.disablePinnedMemory) args.push('--disable-pinned-memory');
  if (config.outputDir) args.push('--output-directory', config.outputDir);
  if (config.inputDir) args.push('--input-directory', config.inputDir);
  const extra = String(f.extraArgs || '').split(/\s+/).filter(Boolean);
  if (!extra.includes('--preview-method')) args.push('--preview-method', 'auto');
  return args.concat(extra);
}

module.exports = { buildArgs };
