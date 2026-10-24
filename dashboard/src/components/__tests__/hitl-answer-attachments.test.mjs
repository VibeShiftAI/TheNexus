/**
 * Photo attachments on the inbox answer card (task 0df94949, 2026-10-24).
 *
 * The card mounts for real (jsdom); the upload API is a fetch stub. These
 * tests pin the flow Robert hit: pick a screenshot, see it, remove it, send
 * it with text; and the recoveries: a refused file, a failed upload and a
 * failed send keep the typed answer and the photo on the card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HitlRequestCard } from '../hitl-card.tsx';

const request = {
  id: 'ask-robert-photo-fixture', taskId: 'd88e7186', reason: 'explicit_request', requestedAt: '2026-10-24T15:49:05.223Z',
  question: '3. Gmail app, either message: one column, no sideways scrolling, full-width buttons? Attach a screenshot.',
  metadata: { kind: 'ask-robert', subject: 'Status report email: phone screenshots', taskTitle: 'Send status reports as phone-first HTML email', projectName: 'Praxis',
    questions: [{ id: 'q3', prompt: 'Gmail app: one column, full-width buttons? Attach a screenshot.', kind: 'text' }] },
};
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const png = (name = 'gmail-screenshot.png') => new File([PNG], name, { type: 'image/png' });
const reference = { fileId: '2a5d0f8e-4d2e-4b0a-9b8e-0c1d2e3f4a5b', url: '/api/chat/files/2a5d0f8e-4d2e-4b0a-9b8e-0c1d2e3f4a5b', mimeType: 'image/png', originalName: 'gmail-screenshot.png', size: PNG.length };
const textareaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

async function mount(onResolve) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(HitlRequestCard, { request, resolving: false, onResolve })));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
  return {
    container,
    textarea: () => container.querySelector('textarea'),
    send: () => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send Answer' || b.textContent.trim() === 'Uploading photo…'),
    chips: () => [...container.querySelectorAll('[data-hitl-attachment]')].map((li) => li.getAttribute('data-hitl-attachment')),
    notice: () => container.querySelector('[data-hitl-attach-error]')?.textContent ?? null,
    async pick(...files) {
      const input = container.querySelector('[data-hitl-attach-input]');
      Object.defineProperty(input, 'files', { value: files, configurable: true });
      await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
    },
    async type(value) {
      await act(async () => { textareaValue.call(this.textarea(), value); this.textarea().dispatchEvent(new window.Event('input', { bubbles: true })); });
    },
    async click(button) { await act(async () => { button.click(); await settle(); }); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

function stubUpload(handler) {
  const original = globalThis.fetch;
  const uploads = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/chat/files/upload');
    const file = init.body.get('file');
    uploads.push(file.name);
    return handler(file, uploads.length);
  };
  return { uploads, restore: () => { globalThis.fetch = original; } };
}

test('a screenshot can be picked, seen, removed, picked again and sent with the typed answer', async () => {
  const calls = [];
  const stub = stubUpload(() => Response.json(reference));
  const card = await mount(async (...args) => { calls.push(args); });
  try {
    assert.ok(card.container.querySelector('[data-hitl-attach-button]'), 'the card offers a photo button');
    assert.equal(card.send().disabled, true, 'nothing to send yet');
    await card.pick(png());
    assert.deepEqual(card.chips(), ['gmail-screenshot.png']);
    assert.ok(card.container.querySelector('[data-hitl-attachment] img')?.getAttribute('src'), 'a thumbnail preview is shown');
    assert.equal(card.send().disabled, false, 'a photo alone can be sent');
    await card.click(card.container.querySelector('button[aria-label="Remove gmail-screenshot.png"]'));
    assert.deepEqual(card.chips(), [], 'removed before sending');
    assert.equal(card.send().disabled, true);
    await card.pick(png());
    await card.type('Gmail looks good: one column, full-width buttons.');
    await card.click(card.send());
    assert.deepEqual(stub.uploads, ['gmail-screenshot.png']);
    assert.deepEqual(calls, [[request.id, { choice: undefined, freeText: 'Gmail looks good: one column, full-width buttons.', payload: { attachments: [reference] } }]]);
    assert.equal(card.textarea().value, '', 'the composer clears after a successful send');
    assert.deepEqual(card.chips(), []);
    assert.equal(card.notice(), null);
  } finally { await card.close(); stub.restore(); }
});

test('a failed upload keeps the answer and the photo and does not resolve the question', async () => {
  const calls = [];
  let failing = true;
  const stub = stubUpload(() => failing ? new Response(JSON.stringify({ error: 'disk full' }), { status: 500 }) : Response.json(reference));
  const card = await mount(async (...args) => { calls.push(args); });
  try {
    await card.pick(png());
    await card.type('See the screenshot.');
    await card.click(card.send());
    assert.equal(calls.length, 0, 'the question was not resolved');
    assert.match(card.notice(), /Upload of "gmail-screenshot\.png" failed \(500: disk full\)\. Your answer and photo are still here; try again\./);
    assert.equal(card.textarea().value, 'See the screenshot.');
    assert.deepEqual(card.chips(), ['gmail-screenshot.png']);
    failing = false;
    await card.click(card.send());
    assert.equal(calls.length, 1, 'the retry resolves with the same answer');
    assert.deepEqual(calls[0][1].payload.attachments, [reference]);
    assert.equal(card.notice(), null);
  } finally { await card.close(); stub.restore(); }
});

test('a failed send keeps everything on the card and the retry does not upload the photo twice', async () => {
  let attempt = 0;
  const stub = stubUpload(() => Response.json(reference));
  const card = await mount(async () => { attempt += 1; if (attempt === 1) throw new Error('Resolve failed with 502'); });
  try {
    await card.pick(png());
    await card.type('Attached.');
    await card.click(card.send());
    assert.match(card.notice(), /Your answer was not sent \(Resolve failed with 502\)\. It is still here; try again\./);
    assert.equal(card.textarea().value, 'Attached.');
    assert.deepEqual(card.chips(), ['gmail-screenshot.png']);
    assert.match(card.container.querySelector('[data-hitl-attachment]').textContent, /uploaded/);
    await card.click(card.send());
    assert.equal(attempt, 2);
    assert.deepEqual(stub.uploads, ['gmail-screenshot.png'], 'the already uploaded photo was reused');
    assert.equal(card.textarea().value, '');
  } finally { await card.close(); stub.restore(); }
});

test('an unsupported or oversized file is refused in words and discards nothing', async () => {
  const calls = [];
  const stub = stubUpload(() => { throw new Error('upload must not be attempted'); });
  const card = await mount(async (...args) => { calls.push(args); });
  try {
    await card.type('Typed before picking.');
    await card.pick(new File(['%PDF-1.4'], 'notes.pdf', { type: 'application/pdf' }));
    assert.match(card.notice(), /"notes\.pdf" is not a photo or screenshot/);
    assert.deepEqual(card.chips(), []);
    const huge = new File([PNG], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 25 * 1024 * 1024 + 1 });
    await card.pick(huge);
    assert.match(card.notice(), /"huge\.png" is 25\.0 MB; photos up to 25\.0 MB can be attached/);
    assert.deepEqual(card.chips(), []);
    assert.equal(card.textarea().value, 'Typed before picking.');
    await card.pick(png('ok.png'));
    assert.deepEqual(card.chips(), ['ok.png']);
    assert.equal(card.notice(), null, 'a good pick clears the refusal');
    assert.equal(calls.length, 0);
  } finally { await card.close(); stub.restore(); }
});

test('text-only and choice answers send exactly what they sent before', async () => {
  const calls = [];
  const stub = stubUpload(() => { throw new Error('upload must not be attempted'); });
  const choice = { ...request, options: ['approve', 'reject'] };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(HitlRequestCard, { request: choice, resolving: false, onResolve: async (...args) => { calls.push(args); } })));
    const textarea = container.querySelector('textarea');
    await act(async () => { textareaValue.call(textarea, 'proceed with the gmail approval'); textarea.dispatchEvent(new window.Event('input', { bubbles: true })); });
    const send = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send Answer');
    await act(async () => { send.click(); await new Promise((r) => setTimeout(r, 10)); });
    const approve = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'approve');
    await act(async () => { approve.click(); await new Promise((r) => setTimeout(r, 10)); });
    assert.deepEqual(calls, [
      [request.id, { choice: undefined, freeText: 'proceed with the gmail approval' }],
      [request.id, { choice: 'approve', freeText: undefined }],
    ]);
    assert.equal(stub.uploads.length, 0);
  } finally { await act(async () => root.unmount()); container.remove(); stub.restore(); }
});
