import assert from 'node:assert/strict';
import test from 'node:test';
// Node 24 runs TypeScript directly (type stripping), so the parser is tested as shipped.
import { parseInline, parseMarkdown, sanitizeHref } from '../../web/src/markdown.ts';

function collectTypes(nodes, bucket = []) {
  for (const node of nodes) {
    bucket.push(node.type);
    if (node.children) collectTypes(node.children, bucket);
    if (node.items) for (const item of node.items) collectTypes(item, bucket);
    if (node.blocks) collectTypes(node.blocks, bucket);
  }
  return bucket;
}

test('markdown: raw HTML in model output stays literal text', () => {
  const blocks = parseMarkdown('<img src=x onerror="alert(1)">');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[0].children, [{ type: 'text', value: '<img src=x onerror="alert(1)">' }]);
});

test('markdown: <script> is a text node, never a script', () => {
  const blocks = parseMarkdown('<script>alert(1)</script>');
  assert.deepEqual(blocks, [{ type: 'paragraph', children: [{ type: 'text', value: '<script>alert(1)</script>' }] }]);
});

test('markdown: HTML inside emphasis remains text', () => {
  const blocks = parseMarkdown('**<b onclick="x()">bold</b>**');
  assert.equal(blocks[0].type, 'paragraph');
  const strong = blocks[0].children[0];
  assert.equal(strong.type, 'strong');
  assert.deepEqual(strong.children, [{ type: 'text', value: '<b onclick="x()">bold</b>' }]);
});

test('markdown: dangerous link schemes are rejected', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/path',
    'java\nscript:alert(1)',
    'java script:alert(1)',
    '',
  ]) {
    assert.equal(sanitizeHref(href), null, `должен быть отклонён: ${JSON.stringify(href)}`);
  }
});

test('markdown: safe link schemes are allowed', () => {
  assert.equal(sanitizeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(sanitizeHref('http://example.com'), 'http://example.com');
  assert.equal(sanitizeHref('mailto:someone@example.com'), 'mailto:someone@example.com');
  assert.equal(sanitizeHref('/claude/'), '/claude/');
  assert.equal(sanitizeHref('#section'), '#section');
});

test('markdown: markdown link keeps href and recursive children', () => {
  const nodes = parseInline('[ссылка](https://example.com)');
  assert.deepEqual(nodes, [
    { type: 'link', href: 'https://example.com', children: [{ type: 'text', value: 'ссылка' }] },
  ]);
});

test('markdown: unsafe markdown link degrades to literal text', () => {
  const nodes = parseInline('[x](javascript:alert(1))');
  assert.ok(nodes.every((node) => node.type === 'text'), 'не должно быть link-узла');
  assert.equal(nodes.map((node) => node.value).join(''), '[x](javascript:alert(1))');
});

test('markdown: inline code wins over emphasis markers', () => {
  const nodes = parseInline('`**not bold**`');
  assert.deepEqual(nodes, [{ type: 'code', value: '**not bold**' }]);
});

test('markdown: bold, italic and inline code', () => {
  const nodes = parseInline('a **b** _c_ `d`');
  assert.equal(nodes[0].value, 'a ');
  assert.equal(nodes[1].type, 'strong');
  assert.equal(nodes[2].value, ' ');
  assert.equal(nodes[3].type, 'em');
  assert.equal(nodes[4].value, ' ');
  assert.equal(nodes[5].type, 'code');
  assert.equal(nodes[5].value, 'd');
});

test('markdown: fenced code block keeps its body verbatim', () => {
  const blocks = parseMarkdown('```js\nconst a = 1;\nconsole.log(a);\n```');
  assert.deepEqual(blocks, [{ type: 'code', lang: 'js', value: 'const a = 1;\nconsole.log(a);' }]);
});

test('markdown: unclosed fence still becomes a code block', () => {
  const blocks = parseMarkdown('```\nline1\nline2');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].value, 'line1\nline2');
});

test('markdown: headings, lists, blockquote and rule', () => {
  const blocks = parseMarkdown('# H1\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n---');
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].type, 'list');
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].type, 'list');
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[3].type, 'blockquote');
  assert.equal(blocks[3].blocks[0].type, 'paragraph');
  assert.equal(blocks[4].type, 'hr');
});

test('markdown: soft line breaks join into one paragraph', () => {
  const blocks = parseMarkdown('первая\nвторая');
  assert.deepEqual(blocks, [{ type: 'paragraph', children: [{ type: 'text', value: 'первая вторая' }] }]);
});

test('markdown: AST only contains whitelisted node types', () => {
  const source = [
    '# Заголовок',
    '',
    'Текст с **жирным**, *курсивом*, `кодом` и [ссылкой](https://example.com).',
    '',
    '```sh',
    'ls -la',
    '```',
    '',
    '- пункт 1',
    '- пункт 2',
    '',
    '> цитата',
    '',
    '<div>сырой html</div>',
  ].join('\n');
  const allowed = new Set(['paragraph', 'heading', 'code', 'list', 'blockquote', 'hr', 'text', 'strong', 'em', 'link', 'break']);
  for (const type of collectTypes(parseMarkdown(source))) {
    assert.ok(allowed.has(type), `недопустимый тип узла AST: ${type}`);
  }
});
