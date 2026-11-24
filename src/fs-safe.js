// Deleting without fs.rmSync. On Windows, Node 24's rmSync kills the whole process (no exception to catch)
// when a path contains non-ASCII characters, such as the Chinese file and folder names used here. unlink and
// rmdir are not affected, so everything that deletes goes through these two helpers.
const fs = require('node:fs');
const path = require('node:path');

const gone = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

function removeFile(p) {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (!gone(e)) throw e;
  }
}

// A file, or a folder with everything inside it. Links (symlinks, junctions) are removed themselves and never
// followed, so nothing outside the folder can be deleted through one.
function removeTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (gone(e)) return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(p);
    } catch {
      fs.rmdirSync(p); // a directory junction is removed like an empty folder
    }
    return;
  }
  if (!st.isDirectory()) {
    removeFile(p);
    return;
  }
  for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
  try {
    fs.rmdirSync(p);
  } catch (e) {
    if (!gone(e)) throw e;
  }
}

module.exports = { removeFile, removeTree };
