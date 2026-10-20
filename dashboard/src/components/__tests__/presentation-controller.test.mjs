import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { TravelPresentationLauncher, PresentDocumentButton } from '../presentation/presentation-controller.tsx';

test('neither the global launcher nor exact-review button renders in a standalone browser', async () => {
  delete window.__NEXUS_DISPLAYS__;
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement('div', {}, createElement(TravelPresentationLauncher), createElement(PresentDocumentButton, { documentId: 'd', revisionId: 'r', contentHash: 'a'.repeat(64) }))));
    assert.equal(div.textContent, '');
  } finally { act(() => root.unmount()); div.remove(); }
});

test('document controller button relays the exact displayed revision, never asks for latest', async () => {
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'windows' };
  let selected; const receive = event => { selected = event.detail; };
  window.addEventListener('nexus:present-document', receive);
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(PresentDocumentButton, { documentId: 'doc', revisionId: 'older-revision', contentHash: 'a'.repeat(64) })));
    act(() => div.querySelector('button').click());
    assert.deepEqual(selected, { kind: 'document', documentId: 'doc', revisionId: 'older-revision', contentHash: 'a'.repeat(64) });
  } finally { act(() => root.unmount()); div.remove(); window.removeEventListener('nexus:present-document', receive); delete window.__NEXUS_DISPLAYS__; }
});
