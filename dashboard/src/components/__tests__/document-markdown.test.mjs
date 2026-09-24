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

// ---------------------------------------------------------------------------
// Mermaid fences: drawn as diagrams (stubbed renderer, see test/stubs/mermaid.mjs)
// ---------------------------------------------------------------------------
import mermaidStub, { calls as mermaidCalls } from '../../../test/stubs/mermaid.mjs';

const DIAGRAM_DOC = [
  '# Praxis',                                  // 1
  '',
  '```mermaid',                                // 3
  'flowchart LR',
  '  V[Voice] --> P((Praxis))',
  '```',                                       // 6
  '',
  '*Figure 1. The familiar ways in.*',         // 8
  '',
  '```mermaid',                                // 10
  'stateDiagram-v2',
  '  [*] --> Proposed',
  '```',                                       // 13
  '',
  '```js',                                     // 15
  'const kept = true;',
  '```',                                       // 17
  '',
  'Closing prose.',                            // 19
].join('\n');

const BROKEN_DOC = [
  'Before the break.',                         // 1
  '',
  '```mermaid',                                // 3
  'flowchart LR',
  '  INVALID -->',
  '```',                                       // 6
  '',
  '```mermaid',                                // 8
  'flowchart TB',
  '  A --> B',
  '```',                                       // 11
  '',
  'After the break.',                          // 13
].join('\n');

async function until(check, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    await settle();
    if (check()) return true;
  }
  return check();
}

test('mermaid fences render as diagrams; captions, prose and other fences are untouched', async () => {
  const before = mermaidCalls.length;
  const t = mount({ content: DIAGRAM_DOC });
  try {
    const c = t.container;
    assert.ok(await until(() => c.querySelectorAll('[data-mermaid-diagram="ok"]').length === 2), 'both diagrams drawn');
    const figures = [...c.querySelectorAll('[data-mermaid-diagram]')];
    assert.equal(figures.length, 2);
    const svgs = figures.map(f => f.querySelector('svg[data-stub-mermaid]'));
    assert.ok(svgs.every(Boolean), 'each figure holds the generated SVG');
    assert.notEqual(svgs[0].id, svgs[1].id, 'each diagram has its own SVG id');
    assert.equal(mermaidCalls.length - before, 2, 'one render per fence');
    assert.equal(mermaidCalls.at(-2).source, 'flowchart LR\n  V[Voice] --> P((Praxis))', 'fence source passed verbatim without the trailing newline');
    assert.equal(mermaidStub.config?.securityLevel, 'strict', 'renderer initialised with the strict security level');
    assert.ok(mermaidStub.config?.dompurifyConfig?.FORBID_TAGS?.includes('img'), 'label sanitiser also refuses resource-loading tags');
    // The figure records the natural width so the stylesheet can floor how far a wide diagram shrinks on desktop.
    assert.equal(figures[0].dataset.mermaidWidth, '200');
    assert.equal(figures[0].style.getPropertyValue('--nexus-mermaid-min'), '140px');
    // Diagrams stay inside their review block with the source line anchor and comment control.
    assert.ok(c.querySelector('#L3 [data-mermaid-diagram]'), 'first diagram anchored at its fence line');
    assert.equal(c.querySelector('#L3').dataset.blockEnd, '6');
    assert.ok(c.querySelector('#L3 [data-block-comment-button]'), 'diagram block keeps its comment control');
    assert.ok(c.querySelector('#L10 [data-mermaid-diagram]'), 'second diagram anchored at its fence line');
    // Caption and surrounding prose survive; the ordinary fence is still a code block.
    assert.match(c.querySelector('#L8').textContent, /Figure 1\. The familiar ways in\./);
    assert.ok(c.querySelector('#L8 em'), 'caption keeps its emphasis');
    const js = c.querySelector('#L15 pre code');
    assert.ok(js, 'non-mermaid fence remains a pre/code block');
    assert.match(js.className, /language-js/);
    assert.equal(js.textContent.trim(), 'const kept = true;');
    assert.ok(!c.querySelector('#L15 [data-mermaid-diagram]'), 'js fence is not treated as a diagram');
    assert.match(c.querySelector('#L19').textContent, /Closing prose\./);
    assert.ok(!c.querySelector('script'), 'no script element anywhere in the rendered document');
  } finally { t.cleanup(); }
});

test('a broken mermaid fence shows a fallback with its source while the rest of the document renders', async () => {
  const t = mount({ content: BROKEN_DOC });
  try {
    const c = t.container;
    assert.ok(await until(() => c.querySelector('[data-mermaid-diagram="error"]') && c.querySelector('[data-mermaid-diagram="ok"]')), 'both fences settled');
    const broken = c.querySelector('#L3 [data-mermaid-diagram="error"]');
    assert.ok(broken, 'broken diagram flagged at its fence line');
    assert.match(broken.querySelector('[data-mermaid-notice]').textContent, /did not render \(Parse error on line 2\)/);
    assert.match(broken.querySelector('pre code').textContent, /INVALID -->/, 'source stays visible for the broken fence');
    assert.ok(!broken.querySelector('svg'), 'no partial SVG for the broken fence');
    assert.ok(c.querySelector('#L8 [data-mermaid-diagram="ok"] svg'), 'the valid diagram after it still draws');
    assert.match(c.querySelector('#L1').textContent, /Before the break\./);
    assert.match(c.querySelector('#L13').textContent, /After the break\./);
  } finally { t.cleanup(); }
});

test('changing the document replaces its diagrams; unrelated re-renders do not redraw', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (props) => act(() => root.render(createElement(DocumentMarkdown, props)));
  try {
    render({ content: DIAGRAM_DOC, selected: null });
    assert.ok(await until(() => container.querySelectorAll('[data-mermaid-diagram="ok"]').length === 2));
    const firstIds = [...container.querySelectorAll('svg[data-stub-mermaid]')].map(s => s.id);
    const after = mermaidCalls.length;
    // Selection change (comment workflow) re-renders the tree without touching the diagrams.
    render({ content: DIAGRAM_DOC, selected: { start: 8, end: 8 } });
    await settle();
    assert.equal(mermaidCalls.length, after, 'no re-render of unchanged diagrams');
    assert.deepEqual([...container.querySelectorAll('svg[data-stub-mermaid]')].map(s => s.id), firstIds);
    // Navigating to another document swaps every diagram for the new one; nothing stale remains.
    render({ content: BROKEN_DOC, selected: null });
    assert.ok(await until(() => container.querySelector('[data-mermaid-diagram="error"]') && container.querySelector('#L8 [data-mermaid-diagram="ok"]')));
    const svgs = [...container.querySelectorAll('svg[data-stub-mermaid]')];
    assert.equal(svgs.length, 1, 'only the new document\'s valid diagram is on screen');
    assert.ok(!firstIds.includes(svgs[0].id), 'the new diagram did not reuse an old SVG id');
    assert.match(svgs[0].textContent, /flowchart TB/);
    assert.ok(!container.textContent.includes('V[Voice]'), 'no stale source or diagram from the previous document');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
