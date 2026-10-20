import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { PresentationView } from '../presentation/presentation-view.tsx';
import { PresentationScreen } from '../presentation/presentation-screen.tsx';

const session = { id: 's1', sourceDeviceId: 'windows:one', targetId: 'monitor:a', method: 'windows-monitor', state: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), reason: null };
const snapshot = content => ({ version: 1, session: { ...session, view: { kind: content.kind } }, sampledAt: new Date().toISOString(), content });
const doc = { kind: 'document', documentId: 'doc-one', revisionId: 'rev-one', contentHash: 'a'.repeat(64), title: 'Exact report', mediaType: 'markdown', mimeType: 'text/markdown', content: '# Pinned\n\n[Inbox](/inbox) ![secret](/api/private)\n\n| A | B |\n|---|---|\n| 1 | 2 |', assetUrl: null, newerRevisionAvailable: true };

test('all four families render selected data without approval, chat, or navigation controls', () => {
  for (const content of [
    { kind: 'ambient', label: 'Board activity', counts: { active: 2, queued: 3, completed: 5 } },
    { kind: 'focus', mode: 'active', tasks: [{ id: 't', title: 'Ship review', project: 'Nexus', status: 'in_progress', updatedAt: null }], truncated: false },
    { kind: 'day-plan', date: '2026-10-20', events: [{ id: 'e', title: 'Review', startsAt: '2026-10-20T10:00:00Z', endsAt: null, status: 'scheduled' }], truncated: false },
    doc,
  ]) {
    const html = renderToStaticMarkup(createElement(PresentationView, { snapshot: snapshot(content), assetSrc: null }));
    assert.match(html, /Read-only presentation/);
    assert.doesNotMatch(html, /data-block-comment-button|Approve|Finish review|textarea|href="\/inbox"|src="\/api\/private"/);
  }
});

test('document output visibly binds exact identity and keeps update notification read-only', () => {
  const html = renderToStaticMarkup(createElement(PresentationView, { snapshot: snapshot(doc), assetSrc: null }));
  for (const marker of ['doc-one', 'rev-one', 'a'.repeat(64), 'newer revision', '<table']) assert.ok(html.includes(marker), marker);
  assert.doesNotMatch(html, /<a\b|<img\b/);
});

test('PDF, image and video use existing read-only media stages', () => {
  for (const [mediaType, tag] of [['pdf', 'iframe'], ['image', 'img'], ['video', 'video']]) {
    const html = renderToStaticMarkup(createElement(PresentationView, { snapshot: snapshot({ ...doc, mediaType, content: null }), assetSrc: 'blob:asset' }));
    assert.ok(html.includes(`<${tag}`));
    assert.doesNotMatch(html, /Comment on|Comment at|data-image-draft|Open full|target="_blank"/);
    if (mediaType === 'pdf') { assert.match(html, /inert=""/); assert.match(html, /pointer-events:none/); }
  }
});

test('a receiver blanks previously displayed data on failed refresh', async () => {
  let fail = false;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const load = async () => { if (fail) throw new Error('Session expired or revoked'); return snapshot(doc); };
  try {
    await act(async () => { root.render(createElement(PresentationScreen, { load, loadAsset: async () => '', pollMs: 15 })); });
    assert.match(container.textContent, /Exact report/);
    fail = true;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    assert.doesNotMatch(container.textContent, /Exact report|Pinned/);
    assert.match(container.textContent, /Session expired or revoked/);
  } finally { act(() => root.unmount()); container.remove(); }
});

test('presentation Mermaid stays literal and cannot issue requests or navigation', () => {
  const content = '```mermaid\nflowchart TD\nA@{ img: "/api/documents/unselected/raw", label: "unselected" }\nclick A href "https://example.test/inbox" "Go" _top\n```';
  const html = renderToStaticMarkup(createElement(PresentationView, { snapshot: snapshot({ ...doc, content }), assetSrc: null }));
  assert.match(html, /<pre/);
  assert.match(html, /language-mermaid/);
  assert.doesNotMatch(html, /data-mermaid|<a\b|<img\b|<svg\b/);
});
