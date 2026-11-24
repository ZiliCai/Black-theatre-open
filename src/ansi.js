// Strips ANSI escape sequences (colors etc.) from ComfyUI console output.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

module.exports = { stripAnsi };
