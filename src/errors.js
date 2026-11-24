// Finds real errors in the ComfyUI log (skipping known harmless noise) and builds the report that
// the "复制报错" button puts on the clipboard. Pure functions, tested with real log excerpts.

// A block containing any of these is a known-harmless message, not an error. Extend as needed.
const NOISE_PATTERNS = [
  /_ProactorBasePipeTransport\._call_connection_lost/, // browser closed a connection
  /ConnectionResetError: \[WinError 10054\]/, // same thing, the traceback half
  /Can't find mmproj file/, // H3 text encoder, printed on every load, no effect on H3
  /is part of \w+ImageProcessorKwargs, but not documented/, // transformers startup chatter logged as ERROR
];

const START_MARKER = /^===== \[启动器\]|Starting server/;
const IMPORT_FAILED = /Cannot import (.+?) module for custom nodes/;

const isStarter = (line) =>
  line.startsWith('[ERROR]') ||
  /Windows fatal exception/.test(line) ||
  /^Fatal Python error/.test(line) ||
  /^Traceback \(most recent call last\)/.test(line); // "[WARNING] Traceback…" does not match: that is a warning

const CONTINUATION_HEAD =
  /^(Stack \(most recent call first\)|Traceback \(most recent call last\)|handle:|During handling of the above exception|The above exception was the direct cause|Python runtime state:)/;
const EXCEPTION_SUMMARY = /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/;

function continues(line, prev, next) {
  if (line === '') return typeof next === 'string' && /^Stack \(most recent call first\)/.test(next);
  if (line.startsWith('[ERROR]')) return true;
  if (/^\s/.test(line)) return true;
  if (CONTINUATION_HEAD.test(line)) return true;
  if (EXCEPTION_SUMMARY.test(line) && (/^\s/.test(prev) || /^Traceback/.test(prev))) return true;
  return false;
}

function kindOf(text) {
  if (/Windows fatal exception/.test(text)) return 'crash';
  if (/^Fatal Python error/m.test(text)) return 'fatal';
  if (/Failed to validate prompt/.test(text)) return 'validation';
  return 'error';
}

function extractErrors(lines) {
  const blocks = [];
  let lastStart = -1;
  const importFailures = [];

  for (let i = 0; i < lines.length; i++) {
    if (START_MARKER.test(lines[i])) lastStart = i;
    const m = lines[i].match(IMPORT_FAILED);
    if (m) {
      const name = m[1].split(/[\\/]/).filter(Boolean).pop();
      if (name && !importFailures.includes(name)) importFailures.push(name);
    }
  }

  let i = 0;
  while (i < lines.length) {
    if (!isStarter(lines[i])) { i++; continue; }
    const start = i;
    i++;
    while (i < lines.length && continues(lines[i], lines[i - 1], lines[i + 1])) i++;
    const blockLines = lines.slice(start, i);
    const text = blockLines.join('\n');
    blocks.push({
      kind: kindOf(text),
      start,
      end: i - 1,
      lines: blockLines,
      noise: NOISE_PATTERNS.some((re) => re.test(text)),
      run: lastStart === -1 ? 'unknown' : start > lastStart ? 'current' : 'previous',
    });
  }

  const noiseBlocks = blocks.filter((b) => b.noise);
  const noiseLines = new Set();
  for (const b of noiseBlocks) for (let k = b.start; k <= b.end; k++) noiseLines.add(k);

  return {
    blocks,
    real: blocks.filter((b) => !b.noise),
    noiseCount: noiseBlocks.length,
    noiseLines,
    importFailures,
    lastStart,
  };
}

function countNewErrors(text) {
  if (!text) return 0;
  return extractErrors(text.split(/\r?\n/)).real.length;
}

const KIND_LABEL = {
  crash: '崩溃',
  fatal: '启动失败(Python 致命错误)',
  validation: '工作流校验失败',
  error: '报错',
};
const RUN_LABEL = { current: '本次运行期间', previous: '上次运行期间', unknown: '' };

function capLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines;
  const head = Math.ceil(maxLines * 0.6);
  const tail = maxLines - head - 1;
  const cut = lines.length - head - tail;
  return [...lines.slice(0, head), `…(中间省略 ${cut} 行)…`, ...lines.slice(lines.length - tail)];
}

function buildReport({ lines, meta = {}, maxLines = 200, maxChars = 20000, tailLines = 40, noErrorTailLines = 60 }) {
  const r = extractErrors(lines);
  const clean = lines.filter((_, idx) => !r.noiseLines.has(idx));
  const found = r.real.length > 0;

  const out = ['ComfyUI 报错报告'];
  if (meta.time) out.push(`生成时间:${meta.time}`);
  if (meta.version) out.push(`启动器版本:${meta.version}`);
  if (meta.stateText) out.push(`当前状态:${meta.stateText}`);
  if (meta.args) out.push(`启动参数:${meta.args}`);
  if (meta.vramText) out.push(`显卡显存:${meta.vramText}`);
  if (meta.ramText) out.push(`电脑内存:${meta.ramText}`);
  if (r.importFailures.length) out.push(`自定义节点导入失败:${r.importFailures.join('、')}`);
  out.push('');

  if (found) {
    const last = r.real[r.real.length - 1];
    const run = RUN_LABEL[last.run];
    out.push(`===== 最近一次报错:${KIND_LABEL[last.kind]}${run ? `(${run})` : ''} =====`);
    for (let k = Math.max(0, last.start - 3); k < last.start; k++) {
      if (!r.noiseLines.has(k)) out.push(lines[k]);
    }
    out.push(...last.lines);
    if (r.real.length > 1) out.push('', `(此前还有 ${r.real.length - 1} 处报错)`);
    out.push('', `===== 日志末尾 ${tailLines} 行(已剔除已知无害提示) =====`, ...clean.slice(-tailLines));
  } else {
    out.push('没发现明确报错。', '', `===== 最近 ${noErrorTailLines} 行日志(已剔除已知无害提示) =====`, ...clean.slice(-noErrorTailLines));
  }
  if (r.noiseCount) out.push('', `(已过滤 ${r.noiseCount} 处已知无害提示)`);

  let text = capLines(out, maxLines).join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.floor(maxChars * 0.6))}\n…(中间省略)…\n${text.slice(-Math.floor(maxChars * 0.4))}`;
  }
  return { text, found, realCount: r.real.length, noiseCount: r.noiseCount };
}

module.exports = { extractErrors, buildReport, countNewErrors, NOISE_PATTERNS };
