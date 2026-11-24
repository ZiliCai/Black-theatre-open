// "Is this path really inside that folder?" Shared by the finished-work page, projects and script documents.
const path = require('node:path');

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// relPath -> absolute path, only when it stays strictly inside root. Everything else gives null.
function resolveInside(root, relPath) {
  if (typeof root !== 'string' || !root || typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return null;
  if (path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, relPath);
  return fold(abs).startsWith(fold(base) + path.sep) ? abs : null;
}

// Same folder, ignoring case on Windows and a trailing slash.
const sameDir = (a, b) => !!a && !!b && fold(path.resolve(a)) === fold(path.resolve(b));

module.exports = { resolveInside, sameDir, fold };
