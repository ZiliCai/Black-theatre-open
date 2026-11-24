// Incremental reader for the ComfyUI log file.
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { stripAnsi } = require('./ansi');

const INCOMPLETE_ESCAPE_AT_END = /\u001b(?:\[[0-9;?]*[ -/]*)?$/;
const LAST_LINES_WINDOW = 512 * 1024;

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function createTail(file, { fromEnd = true } = {}) {
  let pos = fromEnd ? fileSize(file) : 0;
  let decoder = new StringDecoder('utf8'); // keeps half a multi-byte character for the next read
  let held = ''; // an ANSI sequence cut off at the end of the previous read

  return {
    readNew() {
      const size = fileSize(file);
      if (size < pos) { // truncated or replaced: start over
        pos = 0;
        decoder = new StringDecoder('utf8');
        held = '';
      }
      if (size === pos) return '';

      const fd = fs.openSync(file, 'r');
      let buf;
      try {
        buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
      } finally {
        fs.closeSync(fd);
      }
      pos = size;

      let text = held + decoder.write(buf);
      held = '';
      const cut = text.match(INCOMPLETE_ESCAPE_AT_END);
      if (cut) {
        held = cut[0];
        text = text.slice(0, -held.length);
      }
      return stripAnsi(text);
    },
  };
}

function lastLines(file, n) {
  const size = fileSize(file);
  if (size === 0) return [];
  const start = Math.max(0, size - LAST_LINES_WINDOW);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let lines = stripAnsi(buf.toString('utf8')).split(/\r?\n/);
  if (start > 0) lines = lines.slice(1); // first line may be cut in half
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

module.exports = { createTail, lastLines };
