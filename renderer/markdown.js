// A small, safe Markdown reader for the script documents: headings, paragraphs, lists (nested), tables, code
// blocks, quotes, rules, and bold / italic / code / link text. It only builds data (no HTML); the page turns that
// into elements with textContent, so nothing in a document can run. Loaded as a plain <script> and by node:test.
(function (root) {
  const MAX_DEPTH = 6; // nested quotes / lists deeper than this are shown as plain text
  const MAX_INLINE_DEPTH = 4;
  const SPAN_WINDOW = 600; // an emphasis span never runs longer than this, which also keeps the scan linear

  // ---------- inline ----------
  function pushText(out, s) {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.text += s;
    else out.push({ type: 'text', text: s });
  }

  const PUNCT = /[\\`*_{}[\]()#+\-.!|<>~]/;

  function parseInline(src, depth = 0) {
    const s = String(src || '');
    const out = [];
    let i = 0;
    let noClosingBracket = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
        pushText(out, s[i + 1]);
        i += 2;
        continue;
      }
      if (c === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const fence = '`'.repeat(n);
        let j = s.indexOf(fence, i + n);
        while (j !== -1 && s[j + n] === '`') j = s.indexOf(fence, j + n + 1); // the closing run must be exactly as long
        if (j === -1) {
          pushText(out, fence);
          i += n;
        } else {
          out.push({ type: 'code', text: s.slice(i + n, j).replace(/^ (.*) $/s, '$1') });
          i = j + n;
        }
        continue;
      }
      if (c === '*') {
        let n = 1;
        while (s[i + n] === '*') n++;
        if (n > 3 || depth >= MAX_INLINE_DEPTH || /\s/.test(s[i + n] || ' ')) {
          pushText(out, '*'.repeat(n));
          i += n;
          continue;
        }
        const closer = '*'.repeat(n);
        const limit = Math.min(s.length, i + n + SPAN_WINDOW);
        let j = i + n;
        let found = -1;
        while (j < limit) {
          const k = s.indexOf(closer, j);
          if (k === -1 || k >= limit) break;
          if (s[k + n] !== '*' && !/\s/.test(s[k - 1]) && k > i + n) {
            found = k;
            break;
          }
          j = k + 1;
        }
        if (found === -1) {
          pushText(out, closer);
          i += n;
          continue;
        }
        const inner = parseInline(s.slice(i + n, found), depth + 1);
        if (n === 1) out.push({ type: 'em', children: inner });
        else if (n === 2) out.push({ type: 'strong', children: inner });
        else out.push({ type: 'em', children: [{ type: 'strong', children: inner }] });
        i = found + n;
        continue;
      }
      if (c === '[' && !noClosingBracket) {
        const close = s.indexOf(']', i + 1);
        if (close === -1) {
          noClosingBracket = true;
        } else if (s[close + 1] === '(') {
          let level = 1;
          let k = close + 2;
          while (k < s.length && level > 0) {
            if (s[k] === '(') level++;
            else if (s[k] === ')') level--;
            k++;
          }
          if (level === 0) {
            out.push({ type: 'link', text: s.slice(i + 1, close), href: s.slice(close + 2, k - 1) });
            i = k;
            continue;
          }
        }
      }
      // plain run up to the next character that can start something
      let j = i + 1;
      while (j < s.length && s[j] !== '\\' && s[j] !== '`' && s[j] !== '*' && s[j] !== '[') j++;
      pushText(out, s.slice(i, j));
      i = j;
    }
    return out;
  }

  // ---------- blocks ----------
  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
  const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
  const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE = /^ {0,3}>/;
  const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  const SEP_ROW = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

  const isBlank = (l) => !l.trim();
  const indentOf = (l) => {
    let n = 0;
    for (const ch of l) {
      if (ch === ' ') n++;
      else if (ch === '\t') n += 4;
      else break;
    }
    return n;
  };

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\' && t[i + 1] === '|') {
        cur += '|';
        i++;
      } else if (t[i] === '|') {
        cells.push(cur.trim());
        cur = '';
      } else cur += t[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  const alignOf = (cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  };

  const startsBlock = (lines, i) => {
    const l = lines[i];
    if (FENCE_OPEN.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l)) return true;
    return l.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && SEP_ROW.test(lines[i + 1]);
  };

  function plainParagraph(lines) {
    return [{ type: 'paragraph', inline: [{ type: 'text', text: lines.join('\n') }] }];
  }

  function parseBlocks(lines, depth) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }

      const fence = FENCE_OPEN.exec(line);
      if (fence) {
        const mark = fence[1];
        const body = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (t.length >= mark.length && t === mark[0].repeat(t.length)) break;
          body.push(lines[i]);
          i++;
        }
        i++; // the closing fence, or past the end
        blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2].replace(/[ \t]+#+$/, '')) });
        i++;
        continue;
      }

      if (HR.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
          i++;
        }
        blocks.push({ type: 'quote', blocks: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : plainParagraph(inner) });
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && SEP_ROW.test(lines[i + 1])) {
        const header = splitRow(line);
        const align = splitRow(lines[i + 1]).map(alignOf);
        const rows = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]) && !(FENCE_OPEN.test(lines[i]) || HEADING.test(lines[i]) || QUOTE.test(lines[i]) || HR.test(lines[i]) || LIST.test(lines[i]))) {
          const cells = splitRow(lines[i]);
          rows.push(header.map((_, c) => parseInline(cells[c] || '')));
          i++;
        }
        blocks.push({ type: 'table', header: header.map((h) => parseInline(h)), align: header.map((_, c) => align[c] || ''), rows });
        continue;
      }

      const first = LIST.exec(line);
      if (first) {
        const base = indentOf(first[1]);
        const ordered = /\d/.test(first[2][0]);
        const items = [];
        while (i < lines.length) {
          const m = LIST.exec(lines[i]);
          if (!m || indentOf(m[1]) !== base || /\d/.test(m[2][0]) !== ordered) break;
          // the item's body: following lines that are indented deeper (blank lines only count when more of them follow)
          const body = [];
          i++;
          while (i < lines.length) {
            if (isBlank(lines[i])) {
              let j = i;
              while (j < lines.length && isBlank(lines[j])) j++;
              if (j < lines.length && indentOf(lines[j]) > base) {
                body.push(...lines.slice(i, j));
                i = j;
                continue;
              }
              break;
            }
            if (indentOf(lines[i]) > base) {
              body.push(lines[i]);
              i++;
              continue;
            }
            break;
          }
          const cont = [m[3]];
          let k = 0;
          while (k < body.length && !isBlank(body[k]) && !LIST.test(body[k])) cont.push(body[k++].trim());
          const rest = body.slice(k);
          let children = [];
          if (rest.some((l) => !isBlank(l))) {
            const cut = Math.min(...rest.filter((l) => !isBlank(l)).map(indentOf));
            const dedented = rest.map((l) => (isBlank(l) ? '' : l.slice(Math.min(l.length - l.trimStart().length, cut))));
            children = depth < MAX_DEPTH ? parseBlocks(dedented, depth + 1) : plainParagraph(dedented);
          }
          items.push({ inline: parseInline(cont.join('\n')), children });
        }
        blocks.push({ type: 'list', ordered, items });
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
        para.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', inline: parseInline(para.map((l) => l.trim()).join('\n')) });
    }
    return blocks;
  }

  function parseMarkdown(text) {
    const src = typeof text === 'string' ? text : '';
    return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), 0);
  }

  const api = { parseMarkdown, parseInline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
