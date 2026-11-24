const fs = require('node:fs');
const path = require('node:path');
const D = require('./docs');
const { createScanner } = require('./gallery');
const { resolveInside } = require('./safe-path');

const scanner = createScanner({ readMeta: () => null });
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
const posix = (value) => value.split(path.sep).join('/');

function quotedPrompt(block) {
  const marker = /^###\s+可复制提示词\s*$/m.exec(block);
  if (!marker) return '';
  const lines = block.slice(marker.index + marker[0].length).split('\n');
  const prompt = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) break;
    const match = /^>\s?(.*)$/.exec(line);
    if (match) prompt.push(match[1]);
  }
  return prompt.join('\n').trim();
}

function parseShots(text, source) {
  const content = String(text || '').replace(/\r\n?/g, '\n');
  const heading = /^##\s+(MOTION-([A-Z0-9]+)-(\d+))(?:\s*·\s*([^\n]+))?\s*$/gim;
  const matches = [...content.matchAll(heading)];
  const shots = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const block = content.slice(match.index + match[0].length, i + 1 < matches.length ? matches[i + 1].index : content.length);
    const duration = /^-\s*时长：\s*([\d.]+)\s*s/imu.exec(block);
    const shot = /^-\s*分镜：\s*([^\s]+)/imu.exec(block);
    const continuation = /^-\s*接续上一镜：\s*([^\n]+)/imu.exec(block);
    const references = [];
    const refPattern = /PLAN-([A-Z0-9-]+)（顺序：(\d+)）·\s*IMG-([A-Z0-9-]+)(?:《([^》]+)》)?(?:（用途：([^）]+)）)?/gi;
    for (const ref of block.matchAll(refPattern)) {
      references.push({
        id: `IMG-${ref[3].toUpperCase()}`,
        planId: `PLAN-${ref[1].toUpperCase()}`,
        order: Number(ref[2]),
        title: (ref[4] || '').trim(),
        use: (ref[5] || '').trim(),
      });
    }
    references.sort((a, b) => a.order - b.order);
    // 「接续上一镜：是（接 003 …）」 continues from that shot of the same episode instead of the one just before
    const fromNo = continuation && /^是/.test(continuation[1].trim()) ? /接\s*第?\s*(\d+)\s*镜?/.exec(continuation[1]) : null;
    const continueFrom = fromNo ? `MOTION-${match[2].toUpperCase()}-${fromNo[1].padStart(match[3].length, '0')}` : '';
    shots.push({
      id: match[1].toUpperCase(),
      episode: match[2].toUpperCase(),
      sequence: match[3],
      title: (match[4] || '').trim(),
      shotId: shot ? shot[1].trim() : '',
      source,
      prompt: quotedPrompt(block),
      duration: duration ? Number(duration[1]) : null,
      continuePrevious: continuation ? /^是/.test(continuation[1].trim()) : false,
      continuation: continuation ? continuation[1].trim() : '',
      continueFrom,
      references,
    });
  }
  return shots;
}

function aspectRatio(docsDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(docsDir, 'short-drama.json'), 'utf8'));
    return data.format && typeof data.format.aspect_ratio === 'string' ? data.format.aspect_ratio : '';
  } catch {
    return '';
  }
}

function listScriptShots({ docsDir }) {
  if (!docsDir || !fs.existsSync(docsDir)) return { ok: false, noProject: true, shots: [], aspectRatio: '', message: '还没有选择剧本项目' };
  const byId = new Map();
  const docs = D.listDocs(docsDir, null).docs.filter((doc) => /motion[-_]|视频提示词/i.test(doc.name));
  for (const doc of docs) {
    const read = D.readDoc(docsDir, doc.relPath);
    if (!read.ok || read.readOnly) continue;
    const preferred = /^MOTION[-_]/i.test(doc.name);
    for (const shot of parseShots(read.content, doc.relPath)) {
      const old = byId.get(shot.id);
      if (!old || (preferred && !/^MOTION[-_]/i.test(path.basename(old.source)))) byId.set(shot.id, shot);
    }
  }
  const shots = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, 'zh', { numeric: true }));
  return { ok: true, shots, aspectRatio: aspectRatio(docsDir), message: shots.length ? '' : '项目中没有找到 MOTION 单镜提示词' };
}

function imageCandidates(root, source) {
  if (!root || !fs.existsSync(root)) return [];
  return scanner.scan(root, { maxFiles: 3000 }).entries
    .filter((entry) => entry.kind === 'image')
    .map((entry) => ({ ...entry, source, root, abs: path.join(root, entry.relPath) }));
}

function titleKey(title) {
  return normalize(String(title || '')
    .replace(/\d{4}\s*年|\d+\s*岁|角色板|场景板|夜景板|特写|母版/g, ''));
}

function rankedCandidates(reference, candidates) {
  const id = normalize(reference.id.replace(/^IMG-/i, ''));
  const title = titleKey(reference.title);
  return candidates.filter((candidate) => {
    const name = normalize(path.basename(candidate.relPath, path.extname(candidate.relPath)));
    return id && name.includes(id);
  }).map((candidate) => {
    const base = path.basename(candidate.relPath, path.extname(candidate.relPath));
    const name = normalize(base);
    let score = candidate.source === 'output' ? 40 : candidate.source === 'ref' ? 20 : 10;
    score += name.startsWith(id) ? 12 : 5;
    if (title && name.includes(title)) score += 80;
    if (/角色板/.test(reference.title) && name.includes('全身')) score += 18;
    if (/角色板/.test(reference.title) && name.includes('脸母版')) score -= 4;
    if (/_\d{5}_/.test(base)) score -= 3;
    score -= candidate.relPath.split('/').length * 2;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score || a.candidate.relPath.localeCompare(b.candidate.relPath, 'zh', { numeric: true }));
}

function materialize(candidate, outputDir) {
  if (candidate.source === 'output') return { value: `${posix(candidate.relPath)} [output]`, copied: '' };
  const relPath = `ref/${candidate.name}`;
  const target = resolveInside(outputDir, relPath);
  if (!target) throw new Error('参考图目标路径无效');
  let copied = '';
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(candidate.abs, target, fs.constants.COPYFILE_EXCL);
    copied = relPath;
  }
  return { value: `${relPath} [output]`, copied };
}

// cards: { CODE: main picture path in the output folder, or '' when the card has none yet }. A card's main
// picture is used as it is; without one the best-named file is looked for, as before there were cards.
function importScriptShot({ docsDir, projectDir, outputDir, shotId, maxReferences = 9, cards = {} }) {
  const listed = listScriptShots({ docsDir });
  if (!listed.ok) return listed;
  const shot = listed.shots.find((item) => item.id === String(shotId || '').toUpperCase());
  if (!shot) return { ok: false, message: '找不到这个镜头，可能文档已经更改，请刷新后重试' };
  if (!shot.prompt) return { ok: false, message: `${shot.id} 没有可复制的提示词` };
  if (!Number.isFinite(shot.duration)) return { ok: false, message: `${shot.id} 没有有效时长` };
  if (shot.references.length > maxReferences) return { ok: false, message: `${shot.id} 的参考图超过模板上限 ${maxReferences} 张` };
  const candidates = [
    ...imageCandidates(outputDir, 'output'),
    ...imageCandidates(path.join(projectDir, 'ref'), 'ref'),
    ...imageCandidates(path.join(projectDir, 'input'), 'input'),
  ];
  const references = [];
  const copied = [];
  const warnings = [];
  for (const reference of shot.references) {
    const code = reference.id.replace(/^IMG-/i, '').toUpperCase();
    if (cards[code]) {
      references.push(`${cards[code]} [output]`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(cards, code)) warnings.push(`${code} 还没有主图，按文件名找的`);
    const best = rankedCandidates(reference, candidates)[0];
    if (!best) {
      references.push('');
      warnings.push(`${reference.id}《${reference.title || '未命名素材'}》没有找到对应图片`);
      continue;
    }
    const made = materialize(best.candidate, outputDir);
    references.push(made.value);
    if (made.copied) copied.push(made.copied);
  }
  return {
    ok: true,
    shot,
    values: { prompt: shot.prompt, duration: shot.duration, aspect: listed.aspectRatio, references },
    copied,
    warnings,
  };
}

function replaceShotPrompt(content, shotId, prompt) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const heading = /^##\s+(MOTION-([A-Z0-9]+)-(\d+))(?:\s*·\s*([^\n]+))?\s*$/gim;
  const matches = [...text.matchAll(heading)];
  const index = matches.findIndex((match) => match[1].toUpperCase() === shotId);
  if (index < 0) return null;
  const match = matches[index];
  const blockStart = match.index + match[0].length;
  const blockEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
  const block = text.slice(blockStart, blockEnd);
  const marker = /^###\s+可复制提示词\s*$/m.exec(block);
  if (!marker) return null;
  const promptStart = blockStart + marker.index + marker[0].length;
  const afterMarker = block.slice(marker.index + marker[0].length);
  const nextHeading = /^#{2,3}\s+/m.exec(afterMarker);
  const promptEnd = nextHeading ? promptStart + nextHeading.index : blockEnd;
  const quoted = prompt.trim().split('\n').map((line) => line ? `> ${line}` : '>').join('\n');
  return `${text.slice(0, promptStart)}\n${quoted}\n\n${text.slice(promptEnd)}`;
}

function reviseScriptShotPrompt({ docsDir, shotId, expectedPrompt, prompt }) {
  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, message: '修订后的提示词不能为空' };
  if (prompt.length > 200000) return { ok: false, message: '修订后的提示词超过长度上限' };
  const id = String(shotId || '').toUpperCase();
  const listed = listScriptShots({ docsDir });
  if (!listed.ok) return listed;
  const shot = listed.shots.find((item) => item.id === id);
  if (!shot) return { ok: false, message: '找不到要修订的镜头，请刷新后重试' };
  if (!/^MOTION[-_]/i.test(path.basename(shot.source))) {
    return { ok: false, message: '只找到拼合版视频提示词；它是生成产物，请先在项目中添加单镜 MOTION 文件' };
  }
  const read = D.readDoc(docsDir, shot.source);
  if (!read.ok) return read;
  if (read.readOnly) return { ok: false, message: `源文件只能读取，不能修改：${read.readOnlyReason}` };
  const current = parseShots(read.content, shot.source).find((item) => item.id === id);
  const before = String(expectedPrompt || '').trim();
  if (!current || current.prompt !== before) {
    return { ok: false, conflict: true, message: '源文件中的提示词已在其他地方改变；请重新导入镜头后再修订，未覆盖任何内容' };
  }
  const content = replaceShotPrompt(read.content, id, prompt);
  if (!content) return { ok: false, message: '无法定位这个镜头的提示词块，未修改文件' };
  const saved = D.saveDoc({ docsDir, relPath: shot.source, content, expectVersion: read.version, overwrite: false });
  if (!saved.ok) return { ...saved, message: saved.conflict ? '源文件刚刚被其他程序修改，未覆盖任何内容' : saved.message };
  return { ok: true, source: shot.source, version: saved.version };
}

// The document without one shot: its "## MOTION-…" heading and everything up to the next "## " heading (a section
// between shots, like a 站位 note, stays). → { content, removed } or null when the shot is not in it.
function removeShotBlock(content, shotId) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const heading = /^##\s+(MOTION-[A-Z0-9]+-\d+)(?:\s*·\s*[^\n]+)?\s*$/gim;
  const match = [...text.matchAll(heading)].find((m) => m[1].toUpperCase() === shotId);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##\s/m.exec(rest);
  const end = next ? match.index + match[0].length + next.index : text.length;
  const before = text.slice(0, match.index).replace(/\n*$/, '');
  const after = text.slice(end);
  return { content: before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after, removed: text.slice(match.index, end).trim() };
}

// Takes a shot out of its MOTION document; the old version goes to the document's history, like any save.
function removeScriptShot({ docsDir, shotId }) {
  const id = String(shotId || '').toUpperCase();
  const listed = listScriptShots({ docsDir });
  if (!listed.ok) return listed;
  const shot = listed.shots.find((item) => item.id === id);
  if (!shot) return { ok: false, message: '剧本里找不到这个镜头，请刷新' };
  if (!/^MOTION[-_]/i.test(path.basename(shot.source))) {
    return { ok: false, message: '这个镜头只在拼合版视频提示词里，它是生成产物，请到单镜 MOTION 文件里删' };
  }
  const read = D.readDoc(docsDir, shot.source);
  if (!read.ok) return read;
  if (read.readOnly) return { ok: false, message: `源文件只能读取，不能修改：${read.readOnlyReason}` };
  const cut = removeShotBlock(read.content, id);
  if (!cut) return { ok: false, message: '无法定位这个镜头的段落，未修改文件' };
  const saved = D.saveDoc({ docsDir, relPath: shot.source, content: cut.content, expectVersion: read.version, overwrite: false });
  if (!saved.ok) return { ...saved, message: saved.conflict ? '剧本文件刚刚被其他程序修改，没有删，请刷新后再试' : saved.message };
  return { ok: true, source: shot.source, removed: cut.removed };
}

// People a continuing shot leaves out: someone whose identity picture the shot it continues from had, and this one
// has not. The first frame still shows them, but the model has no picture of them to keep, so they are drawn
// away or turned into someone else (023 picking up 022 at the table without the mother).
// shots: in episode order, as parseShots gives them. → [{ id, from, missing: [title] }]
function castGaps(shots) {
  const people = (shot) => new Map(shot.references.filter((r) => /身份/.test(r.use || '')).map((r) => [r.id, r.title || r.id]));
  const gaps = [];
  shots.forEach((shot, i) => {
    if (!shot.continuePrevious) return;
    const before = shot.continueFrom ? shots.find((s) => s.id === shot.continueFrom) : shots[i - 1];
    if (!before) return;
    const have = people(shot);
    const missing = [...people(before)].filter(([id]) => !have.has(id)).map(([, title]) => title);
    if (missing.length) gaps.push({ id: shot.id, from: before.id, missing });
  });
  return gaps;
}

// <Picture n> in a prompt is the n-th reference picture of the shot. When a picture is added or taken out the
// numbers in the prompt can be left pointing at the wrong one: 023 called the mother's portrait "the lobby" and
// the lobby picture "Wang Li", so the model had no picture of her as a person and drew her out of the shot.
// A subject that reads as a place should point at a location picture, a person at an identity one.
// → [{ subject, picture, says: '地点' | '人物', title }]
const PLACE_WORDS = /\b(room|lobby|hall|area|kitchen|roof|rooftop|corridor|road|parking|lot|yard|gorge|canyon|dormitory|table|stairs|stairway|building|hotel|street|valley|pass|truck|car)\b/i;
const PERSON_WORDS = /\b(woman|man|girl|boy|dog|mastiff|child|person|chef|cook|driver|mother|father|wife|husband|guest|rider|zombie|influencer)\b/i;
function pictureMismatches(shot) {
  const defs = /subject_definitions:\s*([\s\S]*?)\n\s*(?:summary|retention_analysis)\s*:/i.exec(String(shot.prompt || ''));
  if (!defs) return [];
  const out = [];
  for (const line of defs[1].split('\n')) {
    const m = /^<Subject (\d+)> is (.*?)<Picture (\d+)>/.exec(line.trim());
    if (!m) continue;
    const ref = shot.references.find((r) => r.order === Number(m[3]));
    if (!ref) {
      out.push({ subject: Number(m[1]), picture: Number(m[3]), says: '', title: '' });
      continue;
    }
    const place = PLACE_WORDS.test(m[2]) && !PERSON_WORDS.test(m[2]);
    if (!ref.use || place === /地理|场景/.test(ref.use)) continue;
    out.push({ subject: Number(m[1]), picture: Number(m[3]), says: place ? '地点' : '人物', title: ref.title || ref.id });
  }
  return out;
}

module.exports = { pictureMismatches, castGaps, parseShots, listScriptShots, importScriptShot, rankedCandidates, replaceShotPrompt, reviseScriptShotPrompt, removeShotBlock, removeScriptShot, imageCandidates, materialize };
