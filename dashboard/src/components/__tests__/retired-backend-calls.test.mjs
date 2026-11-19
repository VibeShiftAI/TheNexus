/**
 * The dashboard no longer offers controls, or makes requests, for backends
 * that were retired (task 62b7c967, 2026-11-19):
 *   - the plan approve / reject flow of the old LangGraph terminal
 *     (/api/terminal/interact, /api/terminal/state/<thread id>);
 *   - artifact comments (/api/artifacts/<id>/comments, /api/comments/<id>/...).
 * Plan cards in old transcripts still display, read-only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageRow } from '../chat/message-row.tsx';
import { PlanReviewModal } from '../chat/plan-review-modal.tsx';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function host(markup) {
  const el = document.createElement('div');
  el.innerHTML = markup;
  return el;
}

function buttonLabels(el) {
  return [...el.querySelectorAll('button')].map((b) => b.textContent.trim());
}

const finalPlan = {
  type: 'PLAN_DRAFT',
  data: {
    title: 'Synthetic legacy plan',
    version: 2,
    markdown: '# Steps\n\n1. First step',
    rationale: 'Synthetic rationale',
    is_final: true,
    thread_id: 'legacy-thread-1',
  },
};

function renderRow(artifact) {
  return host(renderToStaticMarkup(createElement(MessageRow, {
    msg: { role: 'assistant', content: 'Plan', timestamp: new Date('2026-07-01T12:00:00Z'), artifact },
    rowKey: 'row', i: 0, isLast: false, loading: false,
    expandedArtifact: null, setExpandedArtifact: () => {}, setReviewModalData: () => {},
    dismissedVoice: new Set(), listenedVoice: new Set(),
  })));
}

test('a final markdown plan card still displays, without approve or critique controls', () => {
  const el = renderRow(finalPlan);
  assert.match(el.textContent, /Synthetic legacy plan/);
  assert.match(el.textContent, /Synthetic rationale/);
  assert.deepEqual(buttonLabels(el), ['Open Full View'], 'the only control is the read-only full view');
  assert.doesNotMatch(el.textContent, /Approve|Critique|Revision Feedback/);
});

test('a revised plan with legacy nodes still displays, without approve or critique controls', () => {
  const el = renderRow({
    type: 'PLAN_REVISED',
    data: { title: 'Synthetic node plan', version: 3, is_final: true, thread_id: 'legacy-thread-2', nodes: [{ type: 'task', description: 'Do the thing' }] },
  });
  assert.match(el.textContent, /Final for Review/);
  assert.match(el.textContent, /Synthetic node plan/);
  assert.match(el.textContent, /\[task\] Do the thing/);
  assert.equal(el.querySelectorAll('button').length, 0);
  assert.doesNotMatch(el.textContent, /Approve|Critique/);
});

test('the full plan view shows the plan and rationale with only a close control', () => {
  const el = host(renderToStaticMarkup(createElement(PlanReviewModal, {
    data: { artifact: finalPlan, messageKey: 'row' },
    onClose: () => {},
  })));
  assert.match(el.textContent, /Synthetic legacy plan/);
  assert.match(el.textContent, /First step/);
  assert.match(el.textContent, /Synthetic rationale/);
  assert.equal(el.querySelectorAll('button').length, 1, 'the close button is the only control');
  assert.doesNotMatch(el.textContent, /Approve|Request Revisions|Revision Feedback/);
});

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx?|mjs|js)$/.test(name) && path !== THIS_FILE) out.push(path);
  }
  return out;
}

// A route literal: a string or template that starts with the path, or
// continues a `${base}` prefix. Comments that name a retired route for the
// reader ("posted to /api/terminal/interact") are not calls.
const RETIRED_ROUTE_LITERAL = /[`'"}]\/api\/(?:terminal\b|artifacts\/|comments\/)/;

test('no dashboard source calls the retired terminal or artifact comment routes', () => {
  assert.ok(RETIRED_ROUTE_LITERAL.test('fetch(`${base}/api/terminal/state/${id}`)'), 'pattern catches a prefixed template');
  assert.ok(RETIRED_ROUTE_LITERAL.test("fetch('/api/comments/' + id + '/resolve')"), 'pattern catches a quoted literal');
  const hits = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
      if (RETIRED_ROUTE_LITERAL.test(line)) hits.push(`${relative(SRC, file)}:${n + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the provider drops a stale terminal thread id instead of looking it up', () => {
  const provider = readFileSync(join(SRC, 'components/cortex-provider.tsx'), 'utf8');
  assert.match(provider, /LEGACY_TERMINAL_THREAD_KEY = 'cortex_thread_id'/);
  assert.match(provider, /localStorage\.removeItem\(LEGACY_TERMINAL_THREAD_KEY\)/);
  assert.doesNotMatch(provider, /localStorage\.getItem\((?:'cortex_thread_id'|LEGACY_TERMINAL_THREAD_KEY)\)/);
});
