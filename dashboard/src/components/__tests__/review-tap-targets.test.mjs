// Phone and tablet tap targets on the review surface's viewers (task 3f8d291a, QA round 1): every control in the image
// toolbar, the lightbox, the design package's tabs, directions and appearance switch, and the video player is 44px in
// both dimensions below lg, and pins and markers take taps through a 44px square without moving their visual box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { REVIEW_TAP_TARGETS } from '../../lib/review-tap-targets.ts';
import { ImageViewer } from '../document-review/viewers/image-viewer.tsx';
import { DesignPackageViewer } from '../document-review/viewers/design-package-viewer.tsx';
import { VideoViewer } from '../document-review/viewers/video-viewer.tsx';
import { PdfViewer } from '../document-review/viewers/pdf-viewer.tsx';
import { PrototypeViewer } from '../document-review/viewers/prototype-viewer.tsx';
import { covered, ruleSelector, uncovered } from './tap-target-coverage.mjs';

async function settle(ms = 0) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }

/** Renders inside a stand-in for the review page root, which carries the rule as the real <main> does. */
function mount(element) {
  const host = document.createElement('main');
  host.setAttribute('data-document-review-page', '');
  host.className = `min-h-screen ${REVIEW_TAP_TARGETS}`;
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, cleanup() { act(() => root.unmount()); host.remove(); } };
}

test('the review-surface rule floors both dimensions of every control kind and wins the width over the phone min-width reset', () => {
  const minH = ruleSelector('min-h-11');
  assert.equal(ruleSelector('min-w-11!'), minH, 'one selector for both dimensions');
  assert.match(REVIEW_TAP_TARGETS, /\]:min-w-11!(\s|$)/, 'the width floor is !important: globals.css resets .flex > * min-width below 768px');
  const scratch = document.createElement('div');
  scratch.innerHTML = [
    '<button>b</button>', '<a href="/x">a</a>', '<select><option>1</option></select>', '<details><summary>s</summary></details>',
    '<div role="tab">t</div>', '<input type="text">', '<input type="number">',
    '<input type="hidden">', '<input type="checkbox">', '<input type="radio">', '<input type="range">',
    '<button data-image-pin="p1"></button>', '<button data-point-pin="pp1"></button>', '<button data-time-marker="m1"></button>', '<button data-line-gutter="">12</button>', '<a>no href</a>',
  ].join('');
  const matched = [...scratch.querySelectorAll('*')].filter((el) => el.matches(minH)).map((el) => el.outerHTML.replace(/>.*$/s, '>'));
  assert.deepEqual(matched, ['<button>', '<a href="/x">', '<select>', '<summary>', '<div role="tab">', '<input type="text">', '<input type="number">']);
});

test('image viewer: every toolbar control, the pins and the full-screen lightbox are 44px targets below lg', async () => {
  const pins = [
    { id: 'pin-r', index: 1, region: { x: 0.1, y: 0.1, w: 0.05, h: 0.05 }, label: 'Logo' },
    { id: 'pin-p', index: 2, point: { x: 0.5, y: 0.5 } },
  ];
  const t = mount(createElement(ImageViewer, { src: '/after.png', alt: 'After', assetKey: 'after', width: 800, height: 600, beforeSrc: '/before.png', pins, annotate: true, onRegion: () => {} }));
  try {
    await settle();
    const toolbar = t.host.querySelector('[data-image-toolbar]');
    assert.ok(toolbar, 'the toolbar renders');
    const buttons = [...toolbar.querySelectorAll('button')];
    assert.ok(buttons.length >= 7, `zoom out, fit, zoom in, actual size, before/after, side by side, full screen (got ${buttons.length})`);
    for (const b of buttons) assert.match(b.className, /\bmax-lg:min-h-11\b/, `toolbar control "${b.getAttribute('aria-label') || b.textContent.trim()}" is 44px tall below lg`);
    for (const label of ['Zoom out', 'Fit to view', 'Zoom in', 'Actual size', 'Side by side', 'Full screen']) {
      assert.match(toolbar.querySelector(`button[aria-label="${label}"]`).className, /(^|\s)max-lg:min-w-11!(\s|$)/, `"${label}" is 44px wide below lg`);
    }
    assert.match(toolbar.className, /\bflex-wrap\b/, 'enlarged controls wrap instead of widening the page');
    assert.deepEqual(uncovered(toolbar), []);

    const pinEls = [...t.host.querySelectorAll('[data-image-pin]')];
    assert.equal(pinEls.length, 2);
    for (const pin of pinEls) {
      assert.ok(!pin.matches(ruleSelector('min-h-11')), 'a pin keeps its region box; the rule leaves it alone');
      assert.ok(covered(pin), `pin ${pin.getAttribute('data-image-pin')} has a 44px hit square`);
    }

    await click(toolbar.querySelector('[data-open-fullscreen]'));
    const lightbox = document.querySelector('[data-lightbox]');
    assert.ok(lightbox, 'full screen opens');
    assert.ok(!t.host.contains(lightbox), 'portaled outside the page root');
    for (const c of REVIEW_TAP_TARGETS.split(/\s+/)) assert.ok(lightbox.classList.contains(c), 'so it carries the rule itself');
    assert.deepEqual(uncovered(lightbox), [], 'zoom, fit, close, previous and next are all covered');
    await click(lightbox.querySelector('[data-lightbox-close]'));
  } finally { t.cleanup(); }
});

const screen = (key, direction, appearance, order) => ({ asset_key: key, role: 'screen', path: `screens/${key}.png`, media_type: 'image', mime_type: 'image/png', byte_length: 10, content_hash: 'c'.repeat(64), label: `Home · ${appearance}`, direction, appearance, viewport: '375', state: null, before_asset_key: null, order, width: 375, height: 800 });

test('design package: tabs, direction chips, compare and the appearance switch are 44px targets below lg', async () => {
  const manifest = {
    format: 'nexus-design-package/1', title: 'Status report', summary: null,
    directions: [{ id: 'a', title: 'Classic', summary: null, recommended: true }, { id: 'b', title: 'Editorial', summary: null }],
    screens: [], tokens: null, previews: [], evidence: [{ id: 'e1', label: 'Contrast report', file: 'evidence/contrast.json' }], source: null,
  };
  const assets = [screen('a-light', 'a', 'light', 1), screen('a-dark', 'a', 'dark', 2), screen('b-light', 'b', 'light', 3), screen('b-dark', 'b', 'dark', 4),
    { ...screen('e1', null, null, 5), asset_key: 'e1', role: 'evidence', path: 'evidence/contrast.json', media_type: 'json', mime_type: 'application/json', label: 'Contrast report', appearance: null }];
  const t = mount(createElement(DesignPackageViewer, { documentId: 'doc-1', revisionId: 'rev-1', manifest, assets, pins: { byAsset: {}, selectedId: null, onSelect: () => {} } }));
  try {
    await settle();
    const tabs = [...t.host.querySelectorAll('[data-design-tab]')];
    assert.ok(tabs.length >= 2, 'screens and evidence tabs');
    for (const tab of tabs) assert.match(tab.className, /\bmax-lg:min-h-11\b.*(^|\s)max-lg:min-w-11!(\s|$)/, `tab ${tab.getAttribute('data-design-tab')}`);
    const appearance = [...t.host.querySelectorAll('[data-design-appearance]')];
    assert.equal(appearance.length, 3);
    for (const b of appearance) assert.match(b.className, /\bmax-lg:min-h-11\b.*(^|\s)max-lg:min-w-11!(\s|$)/, `appearance ${b.getAttribute('data-design-appearance')}`);
    for (const chip of t.host.querySelectorAll('[data-design-direction], [data-design-compare]')) assert.match(chip.className, /\bmax-lg:min-h-11\b/);
    assert.match([...t.host.querySelectorAll('[data-design-directions] button')].find((b) => b.textContent.trim() === 'All').className, /\bmax-lg:min-h-11\b.*(^|\s)max-lg:min-w-11!(\s|$)/);
    assert.deepEqual(uncovered(t.host), [], 'screens tab: nothing under 44px');
    await click(t.host.querySelector('[data-design-tab="evidence"]'));
    assert.deepEqual(uncovered(t.host), [], 'evidence tab: nothing under 44px');
  } finally { t.cleanup(); }
});

test('video player: transport controls, the seek bar and comment markers are 44px targets below lg', async () => {
  const markers = [{ id: 'm1', index: 1, t_start: 2 }, { id: 'm2', index: 2, t_start: 5, t_end: 8, label: 'Cut here' }];
  const t = mount(createElement(VideoViewer, { src: '/clip.mp4', assetKey: 'clip', kind: 'video', mimeType: 'video/mp4', markers, annotate: true, onTimestamp: () => {} }));
  try {
    await settle();
    const seek = t.host.querySelector('[data-video-seek]');
    assert.match(seek.className, /\bmax-lg:h-11\b/, 'the seek input is 44px tall below lg');
    assert.match(seek.className, /\bmax-lg:top-0\b/);
    assert.match(seek.parentElement.className, /(^|\s)max-lg:h-\[88px\](\s|$)/, 'the row holds the 44px input and a 44px marker strip under it');
    for (const m of t.host.querySelectorAll('[data-time-marker]')) {
      assert.ok(covered(m), `marker ${m.getAttribute('data-time-marker')} has a 44px hit square`);
      assert.match(m.className, /\bmax-lg:top-11\b/, 'markers hang below the seek input, not over it');
      assert.match(m.querySelector('[data-tap-area]').className, /\btop-0\b/, 'the hit square runs down from the marker (44-88px), clear of the seek input (0-44px)');
    }
    assert.deepEqual(uncovered(t.host).filter((x) => !x.startsWith('input "Seek"')), [], 'play, frame steps, speed, mute, in, out, loop and comment');
  } finally { t.cleanup(); }
});

test('pdf viewer: page controls and page markers are 44px targets below lg, and the marker row wraps', async () => {
  const markers = Array.from({ length: 9 }, (_, i) => ({ id: `pm${i}`, index: i + 1, page: i + 1 }));
  const t = mount(createElement(PdfViewer, { src: '/doc.pdf', assetKey: 'pdf', markers, annotate: true, onPage: () => {} }));
  try {
    await settle();
    const first = t.host.querySelector('[data-page-marker]');
    assert.ok(first.matches(ruleSelector('min-h-11')), 'page markers are toolbar chips the rule floors');
    assert.match(first.parentElement.className, /\bflex-wrap\b/, 'nine markers wrap instead of running off a phone screen');
    assert.deepEqual(uncovered(t.host), [], 'previous, page number, next, markers, open full and comment');
  } finally { t.cleanup(); }
});

test('prototype viewer: viewport switch, reload, open, place and the point pins are 44px targets below lg', async () => {
  const pins = [{ id: 'pp1', index: 1, x: 0.2, y: 0.3, viewport: null }, { id: 'pp2', index: 2, x: 0.8, y: 0.6, viewport: null }];
  const t = mount(createElement(PrototypeViewer, { src: '/proto.html', assetKey: 'proto', title: 'Prototype', pins, annotate: true, onPoint: () => {} }));
  try {
    await settle();
    const pinEls = [...t.host.querySelectorAll('[data-point-pin]')];
    assert.equal(pinEls.length, 2);
    for (const pin of pinEls) {
      assert.ok(!pin.matches(ruleSelector('min-h-11')), 'the badge keeps its size over the prototype');
      assert.ok(covered(pin), 'and takes taps through a 44px square');
    }
    assert.deepEqual(uncovered(t.host), []);
  } finally { t.cleanup(); }
});
