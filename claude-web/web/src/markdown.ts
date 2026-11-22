/**
 * Minimal Markdown parser for assistant output.
 *
 * Safety rule (CONTRACT.md §7, plan §7.1): model output is never interpreted as
 * HTML. This module produces a small typed AST from plain text; the Preact
 * renderer turns every text node into an escaped text child, so `<img onerror=…>`
 * inside an answer stays literal text. No `dangerouslySetInnerHTML` anywhere.
 *
 * Supported subset: paragraphs, ATX headings, fenced code, unordered/ordered
 * lists, blockquotes, horizontal rules, inline code, bold, italic, and links
 * (only `http(s)`, `mailto`, root-relative and fragment targets).
 *
 * The module is intentionally dependency-free so node:test can import the .ts
 * file directly (Node 24 type stripping) and assert the XSS-relevant behaviour.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'break' };

export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'code'; lang: string; value: string }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
  | { type: 'blockquote'; blocks: BlockNode[] }
  | { type: 'hr' };

/**
 * Accept only URLs that cannot execute script: http(s), mailto, same-origin
 * absolute paths and fragments. `javascript:`, `data:`, `vbscript:`,
 * protocol-relative `//host` and control-character smuggling are rejected.
 */
export function sanitizeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(href)) return null; // no whitespace/control chars in a URL
  if (href.startsWith('//')) return null; // protocol-relative target
  if (href.startsWith('/') || href.startsWith('#')) return href;
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  return null;
}

function pushText(nodes: InlineNode[], value: string): void {
  if (!value) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'text') last.value += value;
  else nodes.push({ type: 'text', value });
}

/** One alternation per supported inline construct; first match wins left to right. */
const INLINE =
  /(`+)([\s\S]*?)\1|\[([^\]]*)\]\(([^)\s]*)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/;

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let rest = source;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      pushText(nodes, rest);
      break;
    }
    if (match.index > 0) pushText(nodes, rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);

    if (match[1] !== undefined) {
      nodes.push({ type: 'code', value: match[2] ?? '' });
    } else if (match[3] !== undefined) {
      const href = sanitizeHref(match[4] ?? '');
      if (href !== null) nodes.push({ type: 'link', href, children: parseInline(match[3]) });
      else pushText(nodes, match[0]); // unsafe scheme: keep the literal text
    } else if (match[5] !== undefined) {
      nodes.push({ type: 'strong', children: parseInline(match[5]) });
    } else if (match[6] !== undefined) {
      nodes.push({ type: 'strong', children: parseInline(match[6]) });
    } else if (match[7] !== undefined) {
      nodes.push({ type: 'em', children: parseInline(match[7]) });
    } else if (match[8] !== undefined) {
      nodes.push({ type: 'em', children: parseInline(match[8]) });
    }
  }
  return nodes;
}

const FENCE = /^\s{0,3}(```|~~~)\s*([\w#+.@/-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const BLOCKQUOTE = /^\s{0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;

export function parseMarkdown(source: string): BlockNode[] {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1; // closing fence
      blocks.push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && BLOCKQUOTE.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }

    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      const ordered = listItem[3] !== undefined;
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]);
        if (!item || (item[3] !== undefined) !== ordered) break;
        let text = item[4];
        index += 1;
        // Indented continuation lines belong to the same item.
        while (
          index < lines.length
          && /^\s{2,}\S/.test(lines[index])
          && !LIST_ITEM.test(lines[index])
          && !FENCE.test(lines[index])
        ) {
          text += ` ${lines[index].trim()}`;
          index += 1;
        }
        items.push(parseInline(text));
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === '') break;
      if (FENCE.test(next) || HEADING.test(next) || HR.test(next) || BLOCKQUOTE.test(next)) break;
      if (LIST_ITEM.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ').trim()) });
  }

  return blocks;
}
