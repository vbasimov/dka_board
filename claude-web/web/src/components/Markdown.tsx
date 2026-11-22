import { h, type ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import { parseMarkdown, type BlockNode, type InlineNode } from '../markdown';

/**
 * Safe Markdown renderer: the parser returns a typed AST and every leaf is a
 * Preact text child, so model output can never become markup here.
 */

function renderInline(node: InlineNode, key: string): ComponentChildren {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'code':
      return <code key={key} class="md-inline-code">{node.value}</code>;
    case 'strong':
      return (
        <strong key={key}>
          {node.children.map((child, index) => renderInline(child, `${key}.${index}`))}
        </strong>
      );
    case 'em':
      return <em key={key}>{node.children.map((child, index) => renderInline(child, `${key}.${index}`))}</em>;
    case 'link':
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
          {node.children.map((child, index) => renderInline(child, `${key}.${index}`))}
        </a>
      );
    case 'break':
      return <br key={key} />;
    default:
      return null;
  }
}

function renderInlines(nodes: InlineNode[], keyPrefix: string): ComponentChildren[] {
  return nodes.map((node, index) => renderInline(node, `${keyPrefix}.${index}`));
}

function renderBlock(block: BlockNode, key: string): ComponentChildren {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInlines(block.children, key)}</p>;
    case 'heading': {
      const tag = `h${Math.min(6, Math.max(1, block.level))}`;
      return h(tag, { key, class: 'md-heading' }, renderInlines(block.children, key));
    }
    case 'code':
      return (
        <pre key={key} class="md-code">
          {block.lang ? <span class="md-code-lang">{block.lang}</span> : null}
          <code>{block.value}</code>
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={`${key}.i${index}`}>{renderInlines(item, `${key}.i${index}`)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case 'blockquote':
      return <blockquote key={key}>{block.blocks.map((child, index) => renderBlock(child, `${key}.${index}`))}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    default:
      return null;
  }
}

export function Markdown({ text, class: className }: { text: string; class?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div class={['md', className ?? ''].join(' ').trim()}>{blocks.map((block, index) => renderBlock(block, `b${index}`))}</div>;
}
