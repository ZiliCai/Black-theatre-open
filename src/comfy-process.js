// Finding / identifying the ComfyUI process. (Start / stop are added with their integration test.)

const norm = (s) => String(s).toLowerCase().replace(/\//g, '\\');

// True only for a ComfyUI main.py that belongs to this exact workdir. A launch like the user's
// .bat uses a relative path (".\python_embeded\python.exe"), so the command line alone may not
// contain the workdir; the process's absolute executable path then proves where it came from.
function isOurComfy(commandLine, workdir, executablePath) {
  if (!commandLine) return false;
  const cmd = norm(commandLine);
  if (!cmd.includes('main.py')) return false;
  const dir = norm(workdir).replace(/\\+$/, '') + '\\';
  return cmd.includes(dir) || (!!executablePath && norm(executablePath).startsWith(dir));
}

// Parses the JSON printed by the PowerShell port probe: { pid, commandLine, executablePath }.
function parseProbe(stdout) {
  const text = String(stdout || '').replace(/^﻿/, '').trim();
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || !Number.isInteger(data.pid)) return null;
  return { pid: data.pid, commandLine: data.commandLine || '', executablePath: data.executablePath || '' };
}

// `netstat -ano -p TCP` output -> pid of the process LISTENING on `port` (IPv4 or IPv6), else null.
function parseNetstatListener(stdout, port) {
  const re = /^\s*TCP\s+(?:\[[^\]]*\]|[\d.]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(re);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

// `tasklist /FO CSV /NH` output -> working set in MB, else null.
function parseTasklistMemMB(stdout) {
  const m = String(stdout || '').match(/"([\d,.\s]+)\s*K"\s*$/m);
  if (!m) return null;
  const kb = Number(m[1].replace(/\D/g, ''));
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
}

module.exports = { isOurComfy, parseProbe, parseNetstatListener, parseTasklistMemMB };
