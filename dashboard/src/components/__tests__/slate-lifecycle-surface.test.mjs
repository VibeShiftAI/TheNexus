import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLATE_STAGE_ORDER,
  describeSlate,
  describeStall,
  formatDuration,
  stageTone,
} from '../../lib/slate-lifecycle.ts';

/**
 * The slate lifecycle on screen (contract: docs/contracts/slate-lifecycle.md).
 *
 * The 2026-08-24 slate was invisible because "never approved" and "quiet day"
 * looked the same. So every assertion below is about keeping two readings
 * apart: the stalled stage from the ones merely ahead of it, a rejected slate
 * from a late one, an absent approval record from an approval, and yesterday's
 * file on disk from today's slate.
 */

const stage = (name, over = {}) => ({
  stage: name,
  reached: false,
  at: null,
  detail: '',
  counts: {},
  ...over,
});

const lifecycle = (over = {}) => ({
  at: '2026-09-17T12:00:00.000Z',
  available: true,
  date: '2026-09-17',
  stale: false,
  carriedOver: false,
  stages: [
    stage('drafted', { reached: true, at: '2026-09-17T10:00:00.000Z', detail: '12 slots planned' }),
    stage('approved', { waitingSince: '2026-09-17T10:01:00.000Z', detail: 'Waiting on Robert at the [MORNING PLAN] card' }),
    stage('attempted'),
    stage('verified'),
  ],
  stall: { stage: 'approved', since: '2026-09-17T10:01:00.000Z', waitingMs: 119 * 60_000, blocked: false, unknown: false, warn: true },
  slots: [],
  ...over,
});

test('the four stages are the lifecycle, in order', () => {
  assert.deepEqual(SLATE_STAGE_ORDER, ['drafted', 'approved', 'attempted', 'verified']);
});

test('only the stalled stage reads as waiting, the ones behind it are upcoming', () => {
  const l = lifecycle();
  const tones = l.stages.map((s) => stageTone(s, l.stall));
  assert.deepEqual(tones, ['done', 'waiting', 'upcoming', 'upcoming']);
});

test('a rejected slate is blocked, which must not look like waiting', () => {
  const blocked = stage('approved', { blocked: true });
  assert.equal(stageTone(blocked, { stage: 'approved', since: null, waitingMs: null, blocked: true, unknown: false, warn: false }), 'blocked');
});

test('an absent approval record reads unknown, never done', () => {
  const unknown = stage('approved', { unknown: true });
  assert.equal(stageTone(unknown, { stage: 'approved', since: null, waitingMs: null, blocked: false, unknown: true, warn: false }), 'unknown');
});

test('the stall sentence names the stage and the clock', () => {
  assert.equal(describeStall(lifecycle()), 'Not approved for 1h 59m');
});

test('a rejected slate says it will not run instead of counting minutes', () => {
  const l = lifecycle({ stall: { stage: 'approved', since: null, waitingMs: null, blocked: true, unknown: false, warn: false } });
  assert.equal(describeStall(l), 'Slate rejected: it will not run today');
});

test('an unknown stage says there is no record, not that it did not happen', () => {
  const l = lifecycle({ stall: { stage: 'approved', since: null, waitingMs: null, blocked: false, unknown: true, warn: false } });
  assert.equal(describeStall(l), 'No record that this slate was approved');
});

test('a slate that reached every stage has no stall sentence at all', () => {
  assert.equal(describeStall(lifecycle({ stall: null })), null);
});

test('durations read as a person reads them', () => {
  assert.equal(formatDuration(119 * 60_000), '1h 59m');
  assert.equal(formatDuration(45 * 60_000), '45m');
  assert.equal(formatDuration(8_000), '8s');
  assert.equal(formatDuration(Number.NaN), '—');
});

test("yesterday's file is never headlined as today's slate", () => {
  assert.equal(describeSlate(lifecycle()), 'Slate 2026-09-17');
  assert.equal(
    describeSlate(lifecycle({ date: '2026-09-10', stale: true })),
    'Last slate (2026-09-10); no slate for today',
  );
  assert.equal(
    describeSlate(lifecycle({ date: '2026-09-16', carriedOver: true })),
    'Slate 2026-09-16 (running past midnight)',
  );
});

test('an unreadable slate says so rather than claiming there is none', () => {
  assert.equal(describeSlate({ available: false, reason: 'ENOENT', date: null, stages: [], stall: null, slots: [], at: '' }), 'Slate not readable');
  assert.equal(describeStall({ available: false, reason: 'ENOENT', date: null, stages: [], stall: null, slots: [], at: '' }), null);
});

// ── The strip itself, mounted ────────────────────────────────────────────────
//
// Mounts the real component against a stubbed /api/slate/lifecycle so the
// fetch, the live-refetch subscription, the stage chips and the stall sentence
// are exercised together. The two payloads are verbatim captures from the
// server: the live 2026-09-17 slate, and the same slate replayed in the
// never-approved state the whole surface exists to make visible.

import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { SlateLifecycleStrip } from '../slate-lifecycle-strip.tsx';

const RUNNING_SLATE = {
  at: '2026-09-18T00:35:26.213Z',
  available: true,
  date: '2026-09-17',
  scheduleId: 'morning-2026-09-17-run-2026-09-17-gp2r4j2z',
  morningRunId: 'run-2026-09-17-gp2r4j2z',
  createdAt: '2026-09-17T19:28:06.286Z',
  stale: false,
  carriedOver: false,
  stages: [
    { stage: 'drafted', reached: true, at: '2026-09-17T19:28:06.286Z', detail: '12 slots planned', counts: { slots: 12 } },
    { stage: 'approved', reached: true, at: '2026-09-17T19:35:53.180Z', detail: 'Approved (5 pre-approved by project policy)', counts: { standingConsent: 5 } },
    { stage: 'attempted', reached: true, at: '2026-09-17T19:54:04.374Z', detail: '10 of 11 slots dispatched', counts: { attempted: 10, live: 11, withdrawn: 1, spineUnrecorded: 0 } },
    { stage: 'verified', reached: true, complete: false, at: '2026-09-18T00:21:14.347Z', detail: '8 of 11 slots QA-passed', counts: { verified: 8, live: 11, operatorAccepted: 0 } },
  ],
  stall: null,
  slots: [
    { slotNumber: 1, taskId: 'bde6ca6b', title: 'A finished slot', status: 'completed', executor: 'codex', startTime: '2026-09-17T19:37:01.932Z', withdrawn: false, skipSource: null, attempted: true, verified: true, operatorAccepted: false, provenanceAt: '2026-09-17T19:54:04.374Z', provenanceVia: 'advance-callback', spineUnrecorded: false },
    { slotNumber: 6, taskId: 'd917e13b', title: 'A skipped slot', status: 'skipped', executor: 'claude-code', startTime: '2026-09-18T03:28:06.286Z', withdrawn: true, skipSource: 'human', attempted: false, verified: false, operatorAccepted: false, provenanceAt: null, provenanceVia: null, spineUnrecorded: false },
  ],
};

const NEVER_APPROVED_SLATE = {
  at: '2026-09-18T00:35:43.388Z',
  available: true,
  date: '2026-09-17',
  createdAt: '2026-09-17T22:30:36.003Z',
  stale: false,
  carriedOver: false,
  stages: [
    { stage: 'drafted', reached: true, at: '2026-09-17T22:30:36.003Z', detail: '12 slots planned', counts: { slots: 12 } },
    { stage: 'approved', reached: false, waitingSince: '2026-09-17T22:36:36.003Z', at: null, detail: 'Waiting on Robert at the [MORNING PLAN] card', counts: { standingConsent: 5 } },
    { stage: 'attempted', reached: false, at: null, detail: '0 of 12 slots dispatched', counts: { attempted: 0, live: 12, withdrawn: 0, spineUnrecorded: 0 } },
    { stage: 'verified', reached: false, at: null, detail: '0 of 12 slots QA-passed', counts: { verified: 0, live: 12, operatorAccepted: 0 } },
  ],
  stall: { stage: 'approved', since: '2026-09-17T22:36:36.003Z', waitingMs: 7147375, blocked: false, unknown: false, warn: true },
  slots: [],
};

async function mountWith(payload) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/slate\/lifecycle/);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SlateLifecycleStrip, {}));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    container,
    text: container.textContent,
    html: container.innerHTML,
    cleanup() {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
    },
  };
}

test('a healthy slate renders all four stages with their stamps and no alarm', async () => {
  const view = await mountWith(RUNNING_SLATE);
  try {
    for (const label of ['Drafted', 'Approved', 'Attempted', 'Verified']) {
      assert.match(view.text, new RegExp(label));
    }
    assert.match(view.text, /Slate 2026-09-17/);
    // Every stage reached → emerald throughout, and nothing to warn about.
    assert.equal(/amber/.test(view.html), false);
    assert.match(view.html, /emerald/);
    assert.equal(/waiting/.test(view.text), false);
  } finally {
    view.cleanup();
  }
});

test('the never-approved slate shows WHERE it is stuck and for how long', async () => {
  const view = await mountWith(NEVER_APPROVED_SLATE);
  try {
    assert.match(view.text, /Not approved for 1h 59m/);
    assert.match(view.text, /waiting 1h 59m/);
    assert.match(view.html, /amber/);
    // The stage detail is reachable without leaving the board.
    assert.match(view.html, /Waiting on Robert at the \[MORNING PLAN\] card/);
  } finally {
    view.cleanup();
  }
});

test('the slot list separates withdrawn slots from work that actually ran', async () => {
  const view = await mountWith(RUNNING_SLATE);
  try {
    const toggle = view.container.querySelector('button[aria-expanded]');
    assert.equal(toggle.textContent, '2 slots');
    await act(async () => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.match(view.container.textContent, /A finished slot/);
    assert.match(view.container.textContent, /skipped \(human\)/);
  } finally {
    view.cleanup();
  }
});

test('an unreadable slate renders as unknown, never as "no slate"', async () => {
  const view = await mountWith({ at: '', available: false, reason: 'ENOENT: no such file', date: null, stages: [], stall: null, slots: [] });
  try {
    assert.match(view.text, /could not be read/);
    assert.match(view.text, /ENOENT/);
    assert.equal(/no slate today/i.test(view.text), false);
  } finally {
    view.cleanup();
  }
});
