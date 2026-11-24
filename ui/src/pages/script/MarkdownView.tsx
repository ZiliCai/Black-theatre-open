/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from 'react';
import { Markdown } from '../../legacy';

// Turns the structure from renderer/markdown.js into React elements: text only, links shown but not clickable.
function inline(nodes: any[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return String(n.text).split('\n').flatMap((part: string, j: number) => (j ? [<br key={`${i}-${j}`} />, part] : [part]));
    if (n.type === 'strong') return <strong key={i}>{inline(n.children)}</strong>;
    if (n.type === 'em') return <em key={i}>{inline(n.children)}</em>;
    if (n.type === 'code') return <code key={i}>{n.text}</code>;
    if (n.type === 'link') return <span key={i} className="md-link" title={n.href}>{n.text}</span>;
    return null;
  });
}

function blocks(list: any[]): ReactNode[] {
  return list.map((b, i) => {
    if (b.type === 'heading') {
      const level = Math.min(6, b.level + 1);
      const Tag = `h${level}` as 'h2';
      return <Tag key={i}>{inline(b.inline)}</Tag>;
    }
    if (b.type === 'paragraph') return <p key={i}>{inline(b.inline)}</p>;
    if (b.type === 'list') {
      const Tag = b.ordered ? 'ol' : 'ul';
      return <Tag key={i}>{b.items.map((item: any, j: number) => <li key={j}>{inline(item.inline)}{blocks(item.children || [])}</li>)}</Tag>;
    }
    if (b.type === 'table') {
      const cls = (k: number) => (b.align[k] ? `al-${b.align[k]}` : undefined);
      return (
        <div className="md-table-wrap" key={i}>
          <table>
            <thead><tr>{b.header.map((cell: any, k: number) => <th key={k} className={cls(k)}>{inline(cell)}</th>)}</tr></thead>
            <tbody>{b.rows.map((row: any[], r: number) => <tr key={r}>{row.map((cell, k) => <td key={k} className={cls(k)}>{inline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    if (b.type === 'code') return <pre className="md-code" key={i}><code>{b.text}</code></pre>;
    if (b.type === 'quote') return <blockquote key={i}>{blocks(b.blocks)}</blockquote>;
    if (b.type === 'hr') return <hr key={i} />;
    return null;
  });
}

export function MarkdownView({ text }: { text: string }) {
  return <div className="md" id="doc-preview">{blocks(Markdown.parseMarkdown(text))}</div>;
}
