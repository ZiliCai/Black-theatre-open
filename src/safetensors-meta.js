// Reads the optional title / description a .safetensors file carries in its JSON header.
// Only the header is read (never the weights), and absurd header sizes are refused.
const fs = require('node:fs');

const MAX_HEADER_BYTES = 8 * 1024 * 1024;

function readSafetensorsMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 8) return null;

    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE());
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || headerLen > MAX_HEADER_BYTES || 8 + headerLen > size) {
      return null;
    }

    const buf = Buffer.alloc(headerLen);
    fs.readSync(fd, buf, 0, headerLen, 8);
    const meta = JSON.parse(buf.toString('utf8')).__metadata__;
    if (!meta || typeof meta !== 'object') return null;

    const title = typeof meta['modelspec.title'] === 'string' ? meta['modelspec.title'].trim() : '';
    const description = typeof meta['modelspec.description'] === 'string' ? meta['modelspec.description'].trim() : '';
    return title || description ? { title, description } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readSafetensorsMeta, MAX_HEADER_BYTES };
