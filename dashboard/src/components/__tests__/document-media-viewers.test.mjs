/**
 * The reviewer on non-Markdown media: an image with region comments, a
 * design package with directions and screen comments plus direction
 * selection on approval, and direct editing of a text document. Everything
 * runs against an in-memory stand-in for the documents API; nothing reaches
 * a real registry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';

const HASH = c => c.repeat(64);
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
const button = (c, label) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === label);
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
async function type(field, value) {
  await act(async () => {
    const proto = Object.getPrototypeOf(field);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = function () {};
if (!window.HTMLElement.prototype.setPointerCapture) window.HTMLElement.prototype.setPointerCapture = function () {};
if (!window.PointerEvent) window.PointerEvent = window.MouseEvent;

const SOURCE = { task: { id: 'task-1', title: 'Succession redesign', status: 'in_progress', status_message: null, project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Joey', path: '/Volumes/Projects/Joey' } };
const LINKS = { review_url: 'https://nexus.example.test/documents/doc-1', raw_url: '/api/documents/doc-1/raw' };

function imageDoc() {
  const revision = { id: 'rev-1', document_id: 'doc-1', content_hash: HASH('a'), byte_length: 1200, line_count: 0, captured_at: '2026-10-16T10:00:00Z', media_type: 'image', mime_type: 'image/png', asset_count: 1, width: 390, height: 844 };
  return {
    document: { id: 'doc-1', title: 'Statement screen', path: '/Volumes/Projects/Joey/docs/qa/s1.png', kind: 'image', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: 'rev-1', created_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z', requires_review: true, intended_action: 'none', media_type: 'image', mime_type: 'image/png' },
    revision, content: '', media_type: 'image', mime_type: 'image/png', asset_count: 1, editable: false, preview_asset_key: 'primary',
    assets: [{ asset_key: 'primary', role: 'primary', path: '/Volumes/Projects/Joey/docs/qa/s1.png', media_type: 'image', mime_type: 'image/png', byte_length: 1200, content_hash: HASH('a'), label: 's1.png', direction: null, appearance: null, viewport: null, state: null, before_asset_key: null, order: -1, width: 390, height: 844 }],
    manifest: null, readiness: { document_id: 'doc-1', revision_id: 'rev-1', content_hash: HASH('a'), media_type: 'image', ready: true, checked_at: '2026-10-16T10:00:00Z', checks: [{ asset_key: 'primary', role: 'primary', required: true, ok: true, status: 'servable' }], required_total: 1, required_ok: 1 },
    file_state: 'ok', file_error: null, source: SOURCE, review: null, review_status: 'needs_review', current_decision: null, links: LINKS,
  };
}

function designDoc() {
  const screen = (id, title, direction, appearance, extra = {}) => ({ asset_key: `screen:${id}`, role: 'screen', path: `/Volumes/Projects/Joey/docs/design/export/${id}.png`, media_type: 'image', mime_type: 'image/png', byte_length: 900, content_hash: HASH(id.slice(-1)), label: title, direction, appearance, viewport: 'iphone-15-pro', state: null, before_asset_key: null, order: 0, width: 390, height: 844, ...extra });
  const revision = { id: 'rev-1', document_id: 'doc-1', content_hash: HASH('d'), byte_length: 2000, line_count: 40, captured_at: '2026-10-16T10:00:00Z', media_type: 'design', mime_type: 'application/json', asset_count: 5 };
  const manifest = {
    format: 'nexus-design-package/1', title: 'Succession redesign (HWC09)', summary: 'Two directions.',
    directions: [{ id: '1a', title: 'Editorial hairline', recommended: true }, { id: '1b', title: 'Ink masthead' }],
    screens: [
      { id: 'S1-1a', title: 'Statement', direction: '1a', appearance: 'light', viewport: 'iphone-15-pro', file: 'export/S1-1a.png', before: 'before/s1.png', state: null, notes: 'Hairline rules.' },
      { id: 'S1-1b', title: 'Statement', direction: '1b', appearance: 'light', viewport: 'iphone-15-pro', file: 'export/S1-1b.png', before: null, state: null, notes: null },
      { id: 'S2-1a', title: 'Rates', direction: '1a', appearance: 'light', viewport: 'iphone-15-pro', file: 'export/S2-1a.png', before: null, state: null, notes: null },
    ],
    tokens: null, previews: [], evidence: [], source: { provider: 'claude-design', stage: 'review_direction' },
  };
  return {
    document: { id: 'doc-1', title: 'Succession redesign (HWC09)', path: '/Volumes/Projects/Joey/docs/design/hwc09.design.json', kind: 'design', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: 'rev-1', created_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z', requires_review: true, intended_action: 'implement', media_type: 'design', mime_type: 'application/json' },
    revision, content: '{"format":"nexus-design-package/1"}', media_type: 'design', mime_type: 'application/json', asset_count: 5, editable: true, preview_asset_key: 'screen:S1-1a',
    assets: [
      { asset_key: 'primary', role: 'primary', path: '/Volumes/Projects/Joey/docs/design/hwc09.design.json', media_type: 'design', mime_type: 'application/json', byte_length: 2000, content_hash: HASH('m'), label: 'hwc09.design.json', direction: null, appearance: null, viewport: null, state: null, before_asset_key: null, order: -1, width: null, height: null },
      screen('S1-1a', 'Statement', '1a', 'light', { before_asset_key: 'before:S1-1a' }),
      { ...screen('S1-1a', 'Statement (before)', '1a', 'light'), asset_key: 'before:S1-1a', role: 'before', content_hash: HASH('9') },
      screen('S1-1b', 'Statement', '1b', 'light'),
      screen('S2-1a', 'Rates', '1a', 'light'),
    ],
    manifest, readiness: { document_id: 'doc-1', revision_id: 'rev-1', content_hash: HASH('d'), media_type: 'design', ready: true, checked_at: '2026-10-16T10:00:00Z', checks: [], required_total: 4, required_ok: 4 },
    file_state: 'ok', file_error: null, source: SOURCE, review: null, review_status: 'needs_review', current_decision: null, links: LINKS,
  };
}

function markdownDoc() {
  const content = '# Plan\n\nFirst draft.\n';
  const revision = { id: 'rev-1', document_id: 'doc-1', content_hash: HASH('a'), byte_length: content.length, line_count: 3, captured_at: '2026-10-16T10:00:00Z', media_type: 'markdown', mime_type: 'text/markdown', asset_count: 1, source: 'capture' };
  return {
    document: { id: 'doc-1', title: 'Plan', path: '/Volumes/Projects/Joey/docs/plan.md', kind: 'plan', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: 'rev-1', created_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z', requires_review: true, intended_action: 'none', media_type: 'markdown' },
    revision, content, media_type: 'markdown', editable: true, preview_asset_key: null, assets: [], manifest: null, readiness: null,
    file_state: 'ok', file_error: null, source: SOURCE, review: null, review_status: 'needs_review', current_decision: null, links: LINKS,
  };
}

/** In-memory documents API for one document. */
function server(doc) {
  const state = { doc, review: null, comments: [], decisions: [], edits: [] };
  const calls = [];
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/documents/doc-1') {
      return response({ ...state.doc, review: state.review ? { ...state.review, comments: state.comments } : null });
    }
    if (method === 'GET' && p === '/api/documents/doc-1/history') return response({ document_id: 'doc-1', current_revision_id: state.doc.revision.id, review_status: state.doc.review_status, revisions: [state.doc.revision], decisions: state.decisions, registrations: [], edits: state.edits, reviews: [] });
    if (method === 'POST' && p === '/api/documents/doc-1/reviews') {
      state.review ??= { id: 'rv-1', document_id: 'doc-1', revision_id: state.doc.revision.id, reviewer_id: 'local_user', status: 'draft', summary: '', pinned_revision: state.doc.revision, document_changed: false, submission: null, created_at: '2026-10-16T10:05:00Z', updated_at: '2026-10-16T10:05:00Z', submitted_at: null };
      return response({ review: { ...state.review, comments: state.comments } }, 201);
    }
    if (method === 'POST' && p === '/api/documents/doc-1/decisions') {
      if (state.doc.manifest && state.doc.manifest.directions.length >= 2 && body.decision === 'approve' && !body.selection?.direction) {
        return response({ error: 'Approving this design package means selecting a direction', code: 'selection_required', directions: ['1a', '1b'] }, 400);
      }
      const decision = { id: `d${state.decisions.length + 1}`, document_id: 'doc-1', revision_id: body.revision_id, content_hash: state.doc.revision.content_hash, decision: body.decision, actor_id: 'local_user', authority: 'access_user', note: body.note ?? '', client_decision_id: body.client_decision_id, intended_action: 'implement', selection: body.selection ?? null, created_at: '2026-10-16T10:07:00Z' };
      state.decisions.push(decision);
      state.doc = { ...state.doc, review_status: body.decision === 'approve' ? 'approved' : 'changes_requested', current_decision: { ...decision, applies_to_current_revision: true } };
      return response({ decision, review_status: state.doc.review_status }, 201);
    }
    if (method === 'PUT' && p === '/api/documents/doc-1/content') {
      if (body.base_revision_id !== state.doc.revision.id) return response({ error: 'stale', code: 'stale_revision', current_revision: state.doc.revision }, 409);
      const revision = { ...state.doc.revision, id: 'rev-2', content_hash: HASH('b'), source: 'nexus_edit', edited_by: 'local_user', captured_at: '2026-10-16T10:09:00Z' };
      const edit = { id: 'e1', base_revision_id: state.doc.revision.id, result_revision_id: 'rev-2', actor_id: 'local_user', authority: 'access_user', summary: body.summary ?? '', created_at: '2026-10-16T10:09:00Z' };
      state.edits.push(edit);
      state.doc = { ...state.doc, revision, content: body.content, document: { ...state.doc.document, current_revision_id: 'rev-2' } };
      if (state.review) state.review = { ...state.review, document_changed: true, pinned_content: 'old' };
      return response({ edit, revision, content: body.content }, 201);
    }
    const m = p.match(/^\/api\/documents\/reviews\/([^/]+)(.*)$/);
    if (!m) return response({ error: `unexpected ${method} ${p}` }, 404);
    const rest = m[2];
    if (method === 'POST' && rest === '/comments') {
      const existing = state.comments.find(c => c.client_id === body.client_id);
      if (existing) return response({ comment: existing, duplicate: true });
      const comment = { id: `c${state.comments.length + 1}`, client_id: body.client_id, kind: body.kind, start_line: body.start_line ?? null, end_line: body.end_line ?? null, quote: body.quote ?? null, selection: body.selection ?? null, body: body.body, parent_id: body.parent_id ?? null, resolved: false, anchor_target: body.anchor ? { ...body.anchor, asset_hash: HASH('a') } : null, target_label: body.anchor ? `${body.anchor.asset_key} target` : null, created_at: '2026-10-16T10:06:00Z', updated_at: '2026-10-16T10:06:00Z', anchor: body.anchor ? { state: 'intact', current_asset_key: body.anchor.asset_key } : { state: body.kind === 'passage' ? 'intact' : 'document' } };
      state.comments.push(comment);
      return response({ comment }, 201);
    }
    const cm = rest.match(/^\/comments\/([^/]+)$/);
    if (method === 'PATCH' && cm) {
      const comment = state.comments.find(c => c.id === cm[1]);
      if (body.resolved !== undefined) comment.resolved = body.resolved;
      if (body.body !== undefined) comment.body = body.body;
      return response({ comment });
    }
    if (method === 'PATCH' && rest === '') { state.review = { ...state.review, summary: body.summary }; return response({ review: { ...state.review, comments: state.comments } }); }
    if (method === 'GET' && rest === '') return response({ review: { ...state.review, comments: state.comments } });
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

function mount(srv) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings: { pollMs: 20, summaryDebounceMs: 20 } })));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

/** Drag on the image stage from one normalized point to another (jsdom has no layout, so the image rect is faked). */
async function drag(container, from, to) {
  const img = container.querySelector('img[data-image-role="after"]');
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 });
  const frame = img.closest('[data-image-viewer] > div');
  const fire = (name, x, y) => act(async () => { frame.dispatchEvent(new window.MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0 })); });
  // React listens to pointer events; jsdom dispatches them as MouseEvents when PointerEvent is aliased.
  await fire('pointerdown', from.x * 390, from.y * 844);
  await fire('pointermove', (from.x + 0.1) * 390, (from.y + 0.1) * 844);
  await fire('pointermove', to.x * 390, to.y * 844);
  await fire('pointerup', to.x * 390, to.y * 844);
  await settle();
}

test('an image opens in the zoomable viewer; dragging a region opens the composer and saves a region comment the rail lists with its pin', async () => {
  const srv = server(imageDoc());
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.equal(c.querySelector('[data-document-review-page]').dataset.mediaType, 'image');
    assert.match(c.querySelector('[data-media-chip]').textContent, /Image/);
    assert.ok(c.querySelector('[data-image-viewer="primary"] img[src^="/api/documents/doc-1/assets/primary?revision=rev-1"]'), 'the image comes from the same-origin asset route');
    assert.equal(c.querySelector('[data-readiness-chip]').dataset.readinessChip, 'ready');
    assert.ok(!c.querySelector('[data-edit-button]'), 'images are not editable');
    assert.ok(!c.querySelector('[data-block-comment-button]'), 'no Markdown block controls on an image');

    await drag(c, { x: 0.1, y: 0.2 }, { x: 0.5, y: 0.4 });
    const composer = c.querySelector('[data-composer]');
    assert.ok(composer, 'a region drag opens the composer');
    assert.equal(composer.dataset.composerKind, 'region');
    assert.match(composer.textContent, /s1\.png at \(10%, 20%\) 40×20%/);
    await type(composer.querySelector('textarea[aria-label="Comment text"]'), 'Hairline is too heavy here.');
    await click(button(composer, 'Save comment'));
    const post = srv.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(post.body.kind, 'region');
    assert.deepEqual(post.body.anchor, { asset_key: 'primary', x: 0.1, y: 0.2, w: 0.4, h: 0.2 });
    assert.ok(!c.querySelector('[data-composer]'));
    assert.match(c.querySelector('[data-comment-list]').textContent, /primary target[\s\S]*Hairline is too heavy here\./);
    const pin = c.querySelector('[data-image-pin="c1"]');
    assert.ok(pin, 'the saved comment is drawn as a pin on the image');
    assert.equal(pin.style.left, '10%');
    assert.equal(pin.style.width, '40%');
    await click(pin);
    assert.ok(c.querySelector('[data-comment-id="c1"]').className.includes('border-cyan-500/60'), 'selecting the pin highlights the comment');

    // Reply and resolve are the reviewer's own thread bookkeeping.
    await click(c.querySelector('[data-comment-id="c1"] [data-comment-reply]'));
    await type(c.querySelector('[data-composer] textarea'), 'Actually it reads fine at 1x.');
    await click(button(c.querySelector('[data-composer]'), 'Save comment'));
    const reply = srv.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments')).at(-1);
    assert.equal(reply.body.parent_id, 'c1');
    assert.match(c.querySelector('[data-comment-replies]').textContent, /Actually it reads fine/);
    await click(c.querySelector('[data-comment-id="c1"] [data-comment-resolve]'));
    assert.match(c.querySelector('[data-comment-id="c1"]').textContent, /resolved/);
    assert.match(c.querySelector('[data-review-panel]').textContent, /Comments \(2\)/);
  } finally { t.cleanup(); }
});

/** A tap: pointer down and up at one spot on the image itself, the way a finger lands on a phone. */
async function tap(container, x, y) {
  const img = container.querySelector('img[data-image-role="after"]');
  for (const name of ['pointerdown', 'pointerup']) {
    await act(async () => { img.dispatchEvent(new window.MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0 })); });
  }
  await settle();
}

test('on a touch screen the image starts out of pin mode: a tap opens it full screen, and pinning is a switch', async () => {
  const srv = server(imageDoc());
  const hadMatchMedia = Object.prototype.hasOwnProperty.call(window, 'matchMedia');
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query.includes('coarse'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    const toggle = c.querySelector('[data-pin-mode]');
    assert.ok(toggle, 'the toolbar offers Pin a note');
    assert.equal(toggle.dataset.pinMode, 'off', 'a touch screen starts with pinning off');
    // jsdom's style engine drops touch-action, so the finger-scrolls-the-page half is checked in the browser, not here.
    assert.ok(!c.querySelector('[data-image-toolbar]').className.includes('absolute'), 'the toolbar sits above the image, not over it');

    await tap(c, 100, 200);
    assert.ok(!c.querySelector('[data-composer]'), 'a tap pins nothing');
    const lightbox = document.querySelector('[data-lightbox]');
    assert.ok(lightbox, 'a tap opens the image full screen');
    assert.ok(lightbox.querySelector('img[data-lightbox-image][src^="/api/documents/doc-1/assets/primary"]'));
    await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
    await settle();
    assert.ok(!document.querySelector('[data-lightbox]'), 'Escape closes it');

    await click(toggle);
    assert.equal(c.querySelector('[data-pin-mode]').dataset.pinMode, 'on');
    await drag(c, { x: 0.1, y: 0.2 }, { x: 0.5, y: 0.4 });
    const composer = c.querySelector('[data-composer]');
    assert.ok(composer, 'in pin mode a drag opens the composer');
    assert.equal(composer.dataset.composerKind, 'region');
    assert.ok(!document.querySelector('[data-lightbox]'), 'a drag never opens full screen');
  } finally {
    t.cleanup();
    if (hadMatchMedia) window.matchMedia = previousMatchMedia; else delete window.matchMedia;
  }
});

test('a design package shows its directions and screens, comments anchor to a screen, and approving records the selected direction', async () => {
  const srv = server(designDoc());
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.equal(c.querySelector('[data-document-review-page]').dataset.mediaType, 'design');
    const directions = c.querySelector('[data-design-directions]');
    assert.match(directions.textContent, /Editorial hairline[\s\S]*rec\.[\s\S]*Ink masthead/);
    assert.equal(c.querySelector('[data-design-direction="1a"]').getAttribute('aria-pressed'), 'true', 'the recommended direction opens first');
    assert.equal(c.querySelectorAll('[data-design-filmstrip] [data-design-screen]').length, 2, 'only the 1a light screens are listed');
    assert.match(c.querySelector('[data-design-active-title]').textContent, /Statement/);
    assert.match(c.querySelector('[data-design-notes]').textContent, /Hairline rules/);
    assert.ok(button(c, 'Before/after'), 'the screen with a before image offers the comparison');
    assert.ok(c.querySelector('[data-edit-button]'), 'the manifest is editable');

    await click(c.querySelector('[data-design-screen="screen:S2-1a"]'));
    assert.match(c.querySelector('[data-design-active-title]').textContent, /Rates/);
    await drag(c, { x: 0.2, y: 0.3 }, { x: 0.6, y: 0.5 });
    const composer = c.querySelector('[data-composer]');
    assert.equal(composer.dataset.composerKind, 'screen');
    assert.match(composer.textContent, /Rates · 1a · light at \(20%, 30%\)/);
    await type(composer.querySelector('textarea'), 'Oxblood debits please.');
    await click(button(composer, 'Save comment'));
    const post = srv.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(post.body.kind, 'screen');
    assert.deepEqual(post.body.anchor, { asset_key: 'screen:S2-1a', region: { x: 0.2, y: 0.3, w: 0.4, h: 0.2 } });
    assert.ok(c.querySelector('[data-image-pin="c1"]'));
    assert.match(c.querySelector('[data-design-filmstrip] [data-design-screen="screen:S2-1a"]').textContent, /1/, 'the filmstrip counts the comment');

    await click(c.querySelector('[data-design-direction="1b"]'));
    assert.equal(c.querySelectorAll('[data-design-filmstrip] [data-design-screen]').length, 1);
    await click(c.querySelector('[data-design-compare]'));
    assert.ok(c.querySelector('[data-design-compare-grid]'));
    assert.match(c.querySelector('[data-design-compare-grid]').textContent, /Statement[\s\S]*Editorial hairline[\s\S]*Ink masthead/);

    // Approval: the direction is required and recorded with the decision.
    const card = c.querySelector('[data-decision-card]');
    await click(card.querySelector('[data-decision-button="approve"]'));
    const fieldset = card.querySelector('[data-decision-directions]');
    assert.ok(fieldset, 'approving asks which direction');
    assert.equal(fieldset.querySelector('input[value="1a"]').checked, true, 'the recommended direction is preselected');
    await act(async () => { fieldset.querySelector('input[value="1b"]').click(); });
    await click(card.querySelector('[data-decision-submit]'));
    const decision = srv.calls.find(x => x.method === 'POST' && x.path.endsWith('/decisions'));
    assert.deepEqual(decision.body.selection, { direction: '1b' });
    assert.match(c.querySelector('[data-decision-card] [data-decision-notice="ok"]').textContent, /Approved rev dddddddd, direction 1b/);
    assert.ok(c.querySelector('[data-design-selected]'), 'the selected direction is marked');
    assert.match(c.querySelector('[data-design-direction="1b"]').textContent, /selected/);
  } finally { t.cleanup(); }
});

test('Edit opens the text editor, Save writes a new revision through the API and the page reloads onto it', async () => {
  const srv = server(markdownDoc());
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.textContent, /rev aaaaaaaa/);
    await click(c.querySelector('[data-edit-button]'));
    const editor = c.querySelector('[data-text-editor="markdown"]');
    assert.ok(editor);
    assert.ok(editor.querySelector('[data-editor-preview]'), 'Markdown edits show a live preview');
    assert.ok(editor.querySelector('[data-editor-save]').disabled, 'nothing to save yet');
    await type(editor.querySelector('[data-editor-textarea]'), '# Plan\n\nEdited by Robert.\n');
    assert.match(editor.querySelector('[data-editor-preview]').textContent, /Edited by Robert/);
    await type(editor.querySelector('[data-editor-summary]'), 'Tightened the intro');
    await click(editor.querySelector('[data-editor-save]'));
    const put = srv.calls.find(x => x.method === 'PUT');
    assert.equal(put.path, '/api/documents/doc-1/content');
    assert.equal(put.body.base_revision_id, 'rev-1');
    assert.equal(put.body.content, '# Plan\n\nEdited by Robert.\n');
    assert.equal(put.body.summary, 'Tightened the intro');
    assert.match(put.body.client_edit_id, /^[A-Za-z0-9_-]{8,}$/);
    assert.ok(!c.querySelector('[data-text-editor]'), 'the editor closes after saving');
    assert.match(c.textContent, /rev bbbbbbbb/);
    assert.match(c.querySelector('[data-revision-chip]').textContent, /edited in Nexus/);
    assert.match(c.querySelector('article').textContent, /Edited by Robert/);

    // A stale edit is refused and the editor offers to reload instead of overwriting.
    srv.state.doc = { ...srv.state.doc, revision: { ...srv.state.doc.revision, id: 'rev-3' } };
    await click(c.querySelector('[data-edit-button]'));
    await type(c.querySelector('[data-editor-textarea]'), '# Plan\n\nConflicting.\n');
    srv.state.doc = { ...srv.state.doc, revision: { ...srv.state.doc.revision, id: 'rev-4' } };
    await click(c.querySelector('[data-editor-save]'));
    assert.equal(c.querySelector('[data-editor-error]').dataset.editorError, 'stale');
    assert.ok(button(c.querySelector('[data-editor-error]'), 'Reload the current revision'));
    assert.equal(c.querySelector('[data-editor-textarea]').value, '# Plan\n\nConflicting.\n', 'the text is kept');
  } finally { t.cleanup(); }
});
