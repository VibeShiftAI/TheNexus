import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AITerminal } from '../ai-terminal';
import { cortexTestStore } from '../../../test/stubs/cortex-provider.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const stream of [false, true]) test(`typed ${stream ? 'streaming' : 'JSON'} reply retains suppression without losing replay audio`, async t => {
  cortexTestStore.reset(); localStorage.clear();
  const result = { type: 'final', assistantMessageId: `saved-${stream}`, response: 'Report started.', suppressVoice: true, voiceData: [{ audio: 'saved-audio', mimeType: 'audio/wav' }] };
  t.mock.method(globalThis, 'fetch', async input => String(input).startsWith('/api/ai/chat?')
    ? stream ? new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json(result)
    : Response.json({}));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(React.createElement(AITerminal, { isOpen: true, onClose() {} })); await tick(); });
  const field = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'status report');
    field.dispatchEvent(new window.Event('input', { bubbles: true })); await tick();
  });
  await act(async () => { (host.querySelector('[aria-label="Send message"]') as HTMLButtonElement).click(); await tick(); await tick(); });
  const saved = cortexTestStore.messages.find((m: any) => m.id === result.assistantMessageId);
  assert.ok(saved); assert.equal(saved.metadata?.suppressVoice, true);
  assert.deepEqual(saved.voiceData, result.voiceData);
});
