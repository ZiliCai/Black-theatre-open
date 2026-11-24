// Character and scene cards of a script project, read from its people-and-places list: a Markdown table whose
// first column is 代号, under a "## 人物 / 角色" or "## 场景" heading. The first paragraph under "## 画风" in the
// same file is its style line. The list is written outside the app; here it is only read. Plain Node, no Electron.
const fs = require('node:fs');
const D = require('./docs');

const CODE = /^[A-Za-z0-9-]+$/;

const cellsOf = (line) => {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};
const isTableLine = (line) => /^\s*\|/.test(line);
const isSeparator = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
const plain = (text) => String(text || '').replace(/\*\*|__|`/g, '').trim();

function kindOf(heading, nameHeader) {
  const people = /人物|角色/.test(heading);
  const places = /场景/.test(heading);
  if (people && !places) return 'char';
  if (places && !people) return 'scene';
  if (/人物|角色|名字/.test(nameHeader)) return 'char';
  if (/场景/.test(nameHeader)) return 'scene';
  return null;
}

// One document: its cards in table order, its style line and what was wrong with it.
function parseCards(text, source) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const cards = [];
  const warnings = [];
  let heading = '';
  let style = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      heading = h2[1];
      if (/画风/.test(heading) && !style) {
        const para = [];
        for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) {
          const t = lines[j].replace(/^>\s?/, '').trim();
          if (!t) {
            if (para.length) break;
            continue;
          }
          para.push(t);
        }
        style = para.join('');
      }
      continue;
    }
    if (!isTableLine(line) || !isSeparator(lines[i + 1] || '')) continue;
    const header = cellsOf(line).map(plain);
    let j = i + 2;
    const rows = [];
    for (; j < lines.length && isTableLine(lines[j]); j++) rows.push(cellsOf(lines[j]));
    i = j - 1;
    if (header[0] !== '代号') continue;
    const kind = kindOf(heading, header[1] || '');
    if (!kind) continue;
    for (const row of rows) {
      const code = plain(row[0]);
      if (!code) continue;
      if (!CODE.test(code)) {
        warnings.push(`「${code}」不是合法代号，只能用字母、数字和短横线（${source}）`);
        continue;
      }
      cards.push({ code: code.toUpperCase(), kind, name: plain(row[1]), description: plain(row[2]), source });
    }
  }
  for (const card of cards) card.style = style;
  return { cards, style, warnings };
}

// Every card of the project. A code listed twice keeps its first place (documents in name order).
function listCards({ docsDir }) {
  if (!docsDir || !fs.existsSync(docsDir)) return { ok: false, noProject: true, cards: [], warnings: [], sources: [], message: '还没有选择剧本项目' };
  const byCode = new Map();
  const warnings = [];
  const sources = [];
  for (const doc of D.listDocs(docsDir, null).docs.filter((d) => /\.md$/i.test(d.name))) {
    const read = D.readDoc(docsDir, doc.relPath);
    if (!read.ok) continue;
    const parsed = parseCards(read.content, doc.relPath);
    warnings.push(...parsed.warnings);
    if (parsed.cards.length) sources.push(doc.relPath);
    for (const card of parsed.cards) {
      const old = byCode.get(card.code);
      if (old) warnings.push(`代号 ${card.code} 出现了两次，用的是「${old.source}」里的那一行`);
      else byCode.set(card.code, card);
    }
  }
  const cards = [...byCode.values()];
  return { ok: true, cards, warnings, sources, message: cards.length ? '' : '项目里没有找到人物与场景清单' };
}

module.exports = { listCards, parseCards, CODE };
