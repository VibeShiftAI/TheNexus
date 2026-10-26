import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageRow } from '../chat/message-row.tsx';
for (const [role, content] of [['user', 'Hello'], ['assistant', 'Update'], ['system', 'Working'], ['system', 'First line\nSecond line'], ['user', 'PRAXIS_DISPLAY_REPORT {"action":"open","ok":true}']]) {
  test(`timestamp is visible on ${role}: ${content}`, () => {
    const timestamp = new Date('2026-10-22T15:04:05Z');
    const markup = renderToStaticMarkup(createElement(MessageRow, {
      msg: { role, content, timestamp }, rowKey: 'row', i: 0,
      dismissedVoice: new Set(), listenedVoice: new Set(), readyForReview: new Set(),
    }));
    const host = document.createElement('div'); host.innerHTML = markup;
    const time = host.querySelector('time');
    assert.ok(time, 'each transcript row has a visible timestamp');
    assert.equal(time.dateTime, timestamp.toISOString());
    assert.equal(time.textContent, timestamp.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }));
  });
}
