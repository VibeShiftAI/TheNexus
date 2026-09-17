import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentMarkdown } from '../document-review/document-markdown.tsx';
import { extractOutline, quoteLines } from '../../lib/document-outline.ts';

const DOC = [
  '# Reliability readiness',          // 1
  '',
  'Intro paragraph with **bold** and a [site](https://example.com/x) link.', // 3
  '',
  '## Findings',                       // 5
  '',
  '| Check | Result |',                // 7
  '| --- | --- |',
  '| Restart | pass |',                // 9
  '',
  '- first item',                      // 11
  '- second item',                     // 12
  '',
  '```js',                             // 14
  'const x = 1;',
  '```',                               // 16
  '',
  '<script>alert(1)</script>',         // 18
  '',
  '[bad](javascript:alert(1)) and [rel](/task/abc)', // 20
].join('\n');

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

function mount(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentMarkdown, props)));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); } };
}

test('renders full GFM with per-block source line anchors and no active scripts', async () => {
  const t = mount({ content: DOC, commentCounts: { 3: 2 } });
  try {
    await settle();
    const c = t.container;
    assert.ok(c.querySelector('table'), 'GFM table rendered');
    assert.equal(c.querySelectorAll('tbody tr').length, 1);
    assert.ok(c.querySelector('pre code'), 'fenced code rendered');
    assert.equal(c.querySelectorAll('ul li').length, 2);
    assert.equal(c.querySelector('#L1').dataset.blockStart, '1');
    assert.equal(c.querySelector('#L7').dataset.blockEnd, '9');
    assert.equal(c.querySelector('#L11').dataset.blockEnd, '12');
    assert.equal(c.querySelector('#L14').dataset.blockEnd, '16');
    assert.ok(!c.querySelector('script'), 'raw HTML is never rendered as elements');
    assert.match(c.textContent, /<script>alert\(1\)<\/script>/, 'raw HTML shown as text');
    const links = [...c.querySelectorAll('a')];
    const external = links.find(a => a.textContent === 'site');
    assert.equal(external.getAttribute('target'), '_blank');
    assert.equal(external.getAttribute('rel'), 'noopener noreferrer');
    const bad = links.find(a => a.textContent === 'bad');
    assert.ok(!bad.getAttribute('href') || !/javascript:/i.test(bad.getAttribute('href')), 'javascript: href neutralised');
    const rel = links.find(a => a.textContent === 'rel');
    assert.equal(rel.getAttribute('href'), '/task/abc');
    assert.equal(rel.getAttribute('target'), null);
    // Explicit comment controls on every block, with the count shown on annotated blocks.
    const buttons = [...c.querySelectorAll('[data-block-comment-button]')];
    assert.equal(buttons.length, 7, 'h1, p, h2, table, ul, pre, p are the top-level blocks');
    const intro = c.querySelector('#L3 [data-block-comment-button]');
    assert.equal(intro.getAttribute('aria-label'), 'Comment on line 3');
    assert.equal(intro.textContent.trim(), '2');
    assert.equal(c.querySelector('#L7 [data-block-comment-button]').getAttribute('aria-label'), 'Comment on lines 7 to 9');
  } finally { t.cleanup(); }
});

test('tapping a block control selects that block; non-interactive mode has no controls', async () => {
  const selections = [];
  const t = mount({ content: DOC, onBlockSelect: (block, extra) => selections.push({ block, extra }) });
  try {
    await settle();
    await act(async () => t.container.querySelector('#L11 [data-block-comment-button]').click());
    assert.deepEqual(selections[0].block, { start: 11, end: 12 });
    assert.equal(quoteLines(DOC, 11, 12), '- first item\n- second item');
  } finally { t.cleanup(); }
  const readOnly = mount({ content: DOC, interactive: false });
  try {
    await settle();
    assert.equal(readOnly.container.querySelectorAll('[data-block-comment-button]').length, 0);
    assert.ok(readOnly.container.querySelector('#L5'));
  } finally { readOnly.cleanup(); }
});

test('outline lists headings with their source lines, skipping fenced content', () => {
  const outline = extractOutline(DOC + '\n```\n# not a heading\n```\n### Deep');
  assert.deepEqual(outline.map(h => [h.level, h.text, h.line, h.id]), [
    [1, 'Reliability readiness', 1, 'L1'],
    [2, 'Findings', 5, 'L5'],
    [3, 'Deep', 24, 'L24'],
  ]);
});
