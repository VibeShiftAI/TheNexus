import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownMessage } from '../chat/markdown-message.tsx';

// The chat transcript is where Praxis hands Robert a document to review. The
// link it posts is the absolute tunnel URL the Nexus API mints; rendered as a
// new-window anchor it left the Mac bridge app (localhost:3000) for the
// Cloudflare-protected host and asked him to sign in again. It must render as
// an in-app link on the current origin instead, while external links keep
// opening in a new tab.

const DOC = 'bb977fdf-5496-48bb-98bb-031421cc9c1a';
const TASK = 'fd648080-df4b-4bfb-8596-9eecc8b96cb6';

function render(content) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(MarkdownMessage, { content })));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); } };
}

test('a Praxis document-review link opens in-app on the current origin, not in a new window', () => {
  const t = render(`[Report review URL](https://nexus.vibeshiftai.com/documents/${DOC}). **Bounded repair verified.**\n\nSee [the task](/task/${TASK}) and [GitHub](https://github.com/x/y).`);
  try {
    const anchors = [...t.container.querySelectorAll('a')];
    const review = anchors.find(a => a.textContent === 'Report review URL');
    assert.ok(review, 'review link rendered');
    assert.equal(review.getAttribute('href'), `/documents/${DOC}`);
    assert.equal(review.getAttribute('target'), null);
    assert.equal(review.getAttribute('rel'), null);

    const task = anchors.find(a => a.textContent === 'the task');
    assert.equal(task.getAttribute('href'), `/task/${TASK}`);
    assert.equal(task.getAttribute('target'), null);

    const external = anchors.find(a => a.textContent === 'GitHub');
    assert.equal(external.getAttribute('href'), 'https://github.com/x/y');
    assert.equal(external.getAttribute('target'), '_blank');
    assert.equal(external.getAttribute('rel'), 'noopener noreferrer');
  } finally { t.cleanup(); }
});

test('the bare review URL and a localhost:3000 link both stay in-app; the Access login host does not', () => {
  const t = render(`Review link: https://nexus.vibeshiftai.com/documents/${DOC}\n\n<http://localhost:3000/documents/${DOC}>\n\n[login](https://vibeshiftai.cloudflareaccess.com/cdn-cgi/access/login/nexus.vibeshiftai.com)`);
  try {
    const anchors = [...t.container.querySelectorAll('a')];
    const inApp = anchors.filter(a => a.getAttribute('href') === `/documents/${DOC}`);
    assert.equal(inApp.length, 2, 'autolinked tunnel URL and localhost URL both route in-app');
    assert.ok(inApp.every(a => a.getAttribute('target') === null));
    const login = anchors.find(a => a.textContent === 'login');
    assert.equal(login.getAttribute('target'), '_blank');
  } finally { t.cleanup(); }
});
