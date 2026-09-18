import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import {
  SLATE_STAGE_ORDER,
  describeSlate,
  describeStall,
  formatDuration,
  stageNotes,
  stageProgress,
  stageTone,
} from '../../lib/slate-lifecycle.ts';

const { buildSlateLifecycle } = createRequire(import.meta.url)('../../../../server/services/slate-lifecycle.js');

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
  stall: { stage: 'approved', since: '2026-09-17T10:01:00.000Z', waitingMs: 119 * 60_000, blocked: false, unknown: false, stalled: true, warn: true },
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
  assert.equal(stageTone(blocked, { stage: 'approved', since: null, waitingMs: null, blocked: true, unknown: false, stalled: true, warn: false }), 'blocked');
});

test('an absent approval record reads unknown, never done', () => {
  const unknown = stage('approved', { unknown: true });
  assert.equal(stageTone(unknown, { stage: 'approved', since: null, waitingMs: null, blocked: false, unknown: true, stalled: true, warn: false }), 'unknown');
});

test('the stall sentence names the stage and the clock', () => {
  assert.equal(describeStall(lifecycle()), 'Not approved for 1h 59m');
});

test('a rejected slate says it will not run instead of counting minutes', () => {
  const l = lifecycle({ stall: { stage: 'approved', since: null, waitingMs: null, blocked: true, unknown: false, stalled: true, warn: false } });
  assert.equal(describeStall(l), 'Slate rejected: it will not run today');
});

test('an unknown stage says there is no record, not that it did not happen', () => {
  const l = lifecycle({ stall: { stage: 'approved', since: null, waitingMs: null, blocked: false, unknown: true, stalled: true, warn: false } });
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


/**
 * QA 2026-09-18. Two readings the strip must keep apart on its own surface,
 * not only in a tooltip: a partly finished stage from a finished one, and work
 * that resolved WITHOUT the dispatch plane from work that passed QA.
 */

test('a reached stage that is not finished reads partial, never done', () => {
  const partial = stage('verified', { reached: true, complete: false, counts: { verified: 3, live: 12 } });
  const whole = stage('verified', { reached: true, complete: true, counts: { verified: 12, live: 12 } });
  assert.equal(stageTone(partial, null), 'partial');
  assert.equal(stageTone(whole, null), 'done');
});

test('the progress fraction is on the stage itself, for the chip to render', () => {
  assert.deepEqual(stageProgress(stage('verified', { counts: { verified: 3, live: 12 } })), { done: 3, total: 12 });
  assert.deepEqual(stageProgress(stage('attempted', { counts: { attempted: 10, live: 12 } })), { done: 10, total: 12 });
  // Drafted and approved are properties of the slate, not counts of slots.
  assert.equal(stageProgress(stage('drafted', { counts: { slots: 12 } })), null);
  assert.equal(stageProgress(stage('verified', { counts: { verified: 0, live: 0 } })), null);
});

test('outcomes that are not a QA pass get their own visible label', () => {
  const notes = stageNotes(stage('verified', { counts: { verified: 1, live: 5, operatorAccepted: 1, outOfBand: 2, unproven: 1 } }));
  assert.deepEqual(notes.map((n) => n.label), ['1 operator-accepted', '2 out of band', '1 unproven']);
  // Each label carries the sentence behind it, so the chip is not the only copy.
  assert.match(notes[1].title, /dispatch plane never ran it/);
});

test('a completion with no reviewer verdict gets a label of its own', () => {
  // The 2026-09-18 finding on the surface: a reconciled completion must not be
  // silently folded into the QA-passed count, nor into "unproven" (the plane
  // really did run it), so it needs its own word on the chip.
  const notes = stageNotes(stage('verified', { counts: { verified: 1, live: 3, operatorAccepted: 0, outOfBand: 0, unproven: 0, qaUnverified: 2 } }));
  assert.deepEqual(notes.map((n) => n.label), ['2 not QA-reviewed']);
  assert.match(notes[0].title, /verification ledger/);
});

test('a stage with nothing to qualify carries no labels at all', () => {
  assert.deepEqual(stageNotes(stage('verified', { counts: { verified: 5, live: 5, operatorAccepted: 0, outOfBand: 0, unproven: 0 } })), []);
});

test('a settled slate is neutral, not amber with a clock (QA 2026-09-18)', () => {
  const settled = { stage: 'attempted', since: '2026-09-17T10:00:00.000Z', waitingMs: 2 * 3_600_000, blocked: false, unknown: false, stalled: false, warn: false };
  const waiting = { ...settled, stalled: true, warn: true };
  assert.equal(stageTone(stage('attempted'), settled), 'upcoming');
  assert.equal(stageTone(stage('attempted'), waiting), 'waiting');
});

test('a slate with no live work left is not described as a stall waiting to clear', () => {
  const l = lifecycle({ stall: { stage: 'attempted', since: '2026-09-17T10:00:00.000Z', waitingMs: 2 * 3_600_000, blocked: false, unknown: false, stalled: false, warn: false } });
  assert.equal(describeStall(l), 'Nothing left to run; never attempted');
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

// Payloads below come from server/services/slate-lifecycle.js: captured output
// for the stable scenarios, and a fresh projection for the unreadable ledger:
//
//   RUNNING_SLATE            the live 2026-09-17 slate, including a slot done
//                            on the board out of band and one Robert accepted
//                            over a QA rejection.
//   NEVER_APPROVED_SLATE     the same slate replayed in the never-approved
//                            state the whole surface exists to make visible.
//   RECONCILED_SLATE         the 2026-09-18 QA finding: a usage-limit-suspended
//                            slot Praxis flipped to completed when the board
//                            said done, its suspension stamp still in place and
//                            no reviewer verdict anywhere.
//   UNREADABLE_LEDGER_SLATE  the same slate with the verification ledger
//                            unreadable, which is unknown, not zero passes.
//   SETTLED_SLATE            every slot withdrawn: nothing left to run, so the
//                            stage it stopped in is not waiting for anything.

const RUNNING_SLATE = {
  "at": "2026-09-18T00:35:26.213Z",
  "available": true,
  "date": "2026-09-17",
  "scheduleId": "morning-2026-09-17-run-2026-09-17-gp2r4j2z",
  "morningRunId": "run-2026-09-17-gp2r4j2z",
  "createdAt": "2026-09-17T19:28:06.286Z",
  "stale": false,
  "carriedOver": false,
  "liveSlots": 2,
  "qaEvidence": {
    "available": true
  },
  "stages": [
    {
      "stage": "drafted",
      "reached": true,
      "at": "2026-09-17T19:28:06.286Z",
      "detail": "6 slots planned",
      "counts": {
        "slots": 6
      }
    },
    {
      "stage": "approved",
      "reached": true,
      "at": "2026-09-17T19:35:53.180Z",
      "detail": "Approved by Robert",
      "counts": {
        "standingConsent": 0
      }
    },
    {
      "stage": "attempted",
      "reached": true,
      "at": "2026-09-17T19:54:04.374Z",
      "detail": "3 of 5 slots dispatched; 1 landed out of band",
      "counts": {
        "attempted": 3,
        "live": 5,
        "withdrawn": 1,
        "spineUnrecorded": 0,
        "outOfBand": 1,
        "unproven": 0
      }
    },
    {
      "stage": "verified",
      "reached": true,
      "complete": false,
      "at": "2026-09-17T20:02:41.118Z",
      "detail": "1 of 5 slots QA-passed; 1 operator-accepted over a QA rejection; 1 landed out of band, not QA-passed",
      "counts": {
        "verified": 1,
        "live": 5,
        "operatorAccepted": 1,
        "outOfBand": 1,
        "unproven": 0,
        "qaUnverified": 0
      },
      "qaEvidence": true
    }
  ],
  "stall": null,
  "slots": [
    {
      "slotNumber": 1,
      "taskId": "bde6ca6b",
      "title": "A finished slot",
      "status": "completed",
      "executor": "codex",
      "startTime": "2026-09-17T19:37:01.932Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": true,
      "dispatchProven": true,
      "verified": true,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": true,
      "qaOutcome": "pass",
      "qaVerdict": "uncertain",
      "qaReviewer": "codex",
      "qaAt": "2026-09-17T20:02:41.118Z",
      "provenanceAt": "2026-09-17T19:54:04.374Z",
      "provenanceVia": "advance-callback",
      "spineUnrecorded": false
    },
    {
      "slotNumber": 2,
      "taskId": "c1ea77a0",
      "title": "A slot done on the board",
      "status": "completed",
      "executor": "claude-code",
      "startTime": "2026-09-17T20:40:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": true,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": "2026-09-17T20:41:12.004Z",
      "provenanceVia": "out-of-band",
      "spineUnrecorded": false
    },
    {
      "slotNumber": 3,
      "taskId": "ab31f5c2",
      "title": "A slot Robert accepted over QA",
      "status": "operator-accepted",
      "executor": "claude-code",
      "startTime": "2026-09-17T21:45:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": true,
      "dispatchProven": true,
      "verified": false,
      "operatorAccepted": true,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": "2026-09-17T22:50:03.117Z",
      "provenanceVia": "operator-accept",
      "spineUnrecorded": false
    },
    {
      "slotNumber": 4,
      "taskId": "e6d0b914",
      "title": "A slot still running",
      "status": "dispatched",
      "executor": "codex",
      "startTime": "2026-09-17T23:50:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": true,
      "dispatchProven": true,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 5,
      "taskId": "f4a2c761",
      "title": "A slot waiting its turn",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T01:05:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 6,
      "taskId": "d917e13b",
      "title": "A skipped slot",
      "status": "skipped",
      "executor": "claude-code",
      "startTime": "2026-09-18T03:28:06.286Z",
      "withdrawn": true,
      "skipSource": "human",
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    }
  ]
};

const NEVER_APPROVED_SLATE = {
  "at": "2026-09-18T00:35:43.388Z",
  "available": true,
  "date": "2026-09-17",
  "scheduleId": null,
  "morningRunId": null,
  "createdAt": "2026-09-17T22:30:36.003Z",
  "stale": false,
  "carriedOver": false,
  "liveSlots": 12,
  "qaEvidence": {
    "available": true
  },
  "stages": [
    {
      "stage": "drafted",
      "reached": true,
      "at": "2026-09-17T22:30:36.003Z",
      "detail": "12 slots planned",
      "counts": {
        "slots": 12
      }
    },
    {
      "stage": "approved",
      "reached": false,
      "waitingSince": "2026-09-17T22:36:36.003Z",
      "at": null,
      "detail": "Waiting on Robert at the [MORNING PLAN] card",
      "counts": {
        "standingConsent": 5
      }
    },
    {
      "stage": "attempted",
      "reached": false,
      "at": null,
      "detail": "0 of 12 slots dispatched",
      "counts": {
        "attempted": 0,
        "live": 12,
        "withdrawn": 0,
        "spineUnrecorded": 0,
        "outOfBand": 0,
        "unproven": 0
      }
    },
    {
      "stage": "verified",
      "reached": false,
      "at": null,
      "detail": "0 of 12 slots QA-passed",
      "counts": {
        "verified": 0,
        "live": 12,
        "operatorAccepted": 0,
        "outOfBand": 0,
        "unproven": 0,
        "qaUnverified": 0
      },
      "qaEvidence": true
    }
  ],
  "stall": {
    "stage": "approved",
    "since": "2026-09-17T22:36:36.003Z",
    "waitingMs": 7147385,
    "blocked": false,
    "unknown": false,
    "stalled": true,
    "warn": true
  },
  "slots": [
    {
      "slotNumber": 1,
      "taskId": "task-1",
      "title": "Slot 1",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-17T23:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 2,
      "taskId": "task-2",
      "title": "Slot 2",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T00:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 3,
      "taskId": "task-3",
      "title": "Slot 3",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T01:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 4,
      "taskId": "task-4",
      "title": "Slot 4",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T02:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 5,
      "taskId": "task-5",
      "title": "Slot 5",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T03:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 6,
      "taskId": "task-6",
      "title": "Slot 6",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T04:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 7,
      "taskId": "task-7",
      "title": "Slot 7",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T05:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 8,
      "taskId": "task-8",
      "title": "Slot 8",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T06:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 9,
      "taskId": "task-9",
      "title": "Slot 9",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T07:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 10,
      "taskId": "task-10",
      "title": "Slot 10",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T08:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 11,
      "taskId": "task-11",
      "title": "Slot 11",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T09:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 12,
      "taskId": "task-12",
      "title": "Slot 12",
      "status": "pending",
      "executor": "claude-code",
      "startTime": "2026-09-18T10:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    }
  ]
};

const RECONCILED_SLATE = {
  "at": "2026-09-18T00:35:26.213Z",
  "available": true,
  "date": "2026-09-17",
  "scheduleId": null,
  "morningRunId": null,
  "createdAt": "2026-09-17T19:28:06.286Z",
  "stale": false,
  "carriedOver": false,
  "liveSlots": 0,
  "qaEvidence": {
    "available": true
  },
  "stages": [
    {
      "stage": "drafted",
      "reached": true,
      "at": "2026-09-17T19:28:06.286Z",
      "detail": "2 slots planned",
      "counts": {
        "slots": 2
      }
    },
    {
      "stage": "approved",
      "reached": true,
      "at": "2026-09-17T19:35:53.180Z",
      "detail": "Approved by Robert",
      "counts": {
        "standingConsent": 0
      }
    },
    {
      "stage": "attempted",
      "reached": true,
      "at": "2026-09-17T19:54:04.374Z",
      "detail": "2 of 2 slots dispatched",
      "counts": {
        "attempted": 2,
        "live": 2,
        "withdrawn": 0,
        "spineUnrecorded": 0,
        "outOfBand": 0,
        "unproven": 0
      }
    },
    {
      "stage": "verified",
      "reached": true,
      "complete": false,
      "at": "2026-09-17T20:02:41.118Z",
      "detail": "1 of 2 slots QA-passed; 1 completed with no QA verdict",
      "counts": {
        "verified": 1,
        "live": 2,
        "operatorAccepted": 0,
        "outOfBand": 0,
        "unproven": 0,
        "qaUnverified": 1
      },
      "qaEvidence": true
    }
  ],
  "stall": null,
  "slots": [
    {
      "slotNumber": 1,
      "taskId": "bde6ca6b",
      "title": "A slot that really passed QA",
      "status": "completed",
      "executor": "codex",
      "startTime": "2026-09-17T19:37:01.932Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": true,
      "dispatchProven": true,
      "verified": true,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": true,
      "qaOutcome": "pass",
      "qaVerdict": "uncertain",
      "qaReviewer": "codex",
      "qaAt": "2026-09-17T20:02:41.118Z",
      "provenanceAt": "2026-09-17T19:54:04.374Z",
      "provenanceVia": "advance-callback",
      "spineUnrecorded": false
    },
    {
      "slotNumber": 2,
      "taskId": "a7f10c33",
      "title": "A slot suspended, then finished by hand",
      "status": "completed",
      "executor": "claude-code",
      "startTime": "2026-09-17T21:00:00.000Z",
      "withdrawn": false,
      "skipSource": null,
      "attempted": true,
      "dispatchProven": true,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": true,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": "2026-09-17T21:42:10.000Z",
      "provenanceVia": "usage-limit-suspension",
      "spineUnrecorded": false
    }
  ]
};

const UNREADABLE_LEDGER_SLATE = buildSlateLifecycle({
  date: '2026-09-17',
  createdAt: '2026-09-17T19:28:06.286Z',
  approval: { status: 'approved', resolvedAt: '2026-09-17T19:35:53.180Z' },
  slots: ['advance-callback', 'usage-limit-suspension'].map((via, index) => ({
    slotNumber: index + 1,
    nexusTaskId: `task-${index + 1}`,
    title: 'Completed with dispatch evidence',
    status: 'completed',
    startTime: '2026-09-17T19:37:01.932Z',
    provenance: { via, attemptId: `attempt-${index}`, at: '2026-09-17T19:54:04.374Z' },
  })),
}, new Date('2026-09-18T00:35:26.213Z'), {
  available: false, reason: 'SQLITE_CANTOPEN', records: new Map(),
});

const SETTLED_SLATE = {
  "at": "2026-09-18T00:35:26.213Z",
  "available": true,
  "date": "2026-09-17",
  "scheduleId": null,
  "morningRunId": null,
  "createdAt": "2026-09-17T19:28:06.286Z",
  "stale": false,
  "carriedOver": false,
  "liveSlots": 0,
  "qaEvidence": {
    "available": true
  },
  "stages": [
    {
      "stage": "drafted",
      "reached": true,
      "at": "2026-09-17T19:28:06.286Z",
      "detail": "2 slots planned",
      "counts": {
        "slots": 2
      }
    },
    {
      "stage": "approved",
      "reached": true,
      "at": "2026-09-17T19:35:53.180Z",
      "detail": "Approved by Robert",
      "counts": {
        "standingConsent": 0
      }
    },
    {
      "stage": "attempted",
      "reached": false,
      "at": null,
      "detail": "Every slot was withdrawn before dispatch",
      "counts": {
        "attempted": 0,
        "live": 0,
        "withdrawn": 2,
        "spineUnrecorded": 0,
        "outOfBand": 0,
        "unproven": 0
      }
    },
    {
      "stage": "verified",
      "reached": false,
      "at": null,
      "detail": "0 of 0 slots QA-passed",
      "counts": {
        "verified": 0,
        "live": 0,
        "operatorAccepted": 0,
        "outOfBand": 0,
        "unproven": 0,
        "qaUnverified": 0
      },
      "qaEvidence": true
    }
  ],
  "stall": {
    "stage": "attempted",
    "since": "2026-09-17T19:35:53.180Z",
    "waitingMs": 17973033,
    "blocked": false,
    "unknown": false,
    "stalled": false,
    "warn": false
  },
  "slots": [
    {
      "slotNumber": 1,
      "taskId": "e11a0c92",
      "title": "A slot Robert pulled",
      "status": "skipped",
      "executor": "claude-code",
      "startTime": "2026-09-17T19:37:00.000Z",
      "withdrawn": true,
      "skipSource": "human",
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    },
    {
      "slotNumber": 2,
      "taskId": "b3c7d410",
      "title": "A slot Praxis found already done",
      "status": "skipped",
      "executor": "claude-code",
      "startTime": "2026-09-17T21:00:00.000Z",
      "withdrawn": true,
      "skipSource": "reconciliation",
      "attempted": false,
      "dispatchProven": false,
      "verified": false,
      "operatorAccepted": false,
      "outOfBand": false,
      "unprovenCompletion": false,
      "qaUnverified": false,
      "qaPassed": false,
      "qaOutcome": null,
      "qaVerdict": null,
      "qaReviewer": null,
      "qaAt": null,
      "provenanceAt": null,
      "provenanceVia": null,
      "spineUnrecorded": false
    }
  ]
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
    assert.equal(toggle.textContent, '6 slots');
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

test('a partly verified slate does not wear the same chip as a finished one', async () => {
  const view = await mountWith(RUNNING_SLATE);
  try {
    // The counts are on the chips, readable without a hover: this is the
    // improvement QA asked for after round 1, where "1 of 5 QA-passed" lived
    // only in the title attribute and a touch device saw plain green.
    assert.match(view.text, /1\/5/);
    assert.match(view.text, /3\/5/);
    assert.match(view.text, /1 out of band/);
    assert.match(view.text, /1 operator-accepted/);
    assert.match(view.text, /1 withdrawn/);
    // Partial stages are cyan; only the stages that really are finished for
    // every slot (drafted, approved) keep the emerald "done" palette.
    assert.match(view.html, /cyan/);
  } finally {
    view.cleanup();
  }
});

test('work that never entered the dispatch plane says so in its row', async () => {
  const view = await mountWith(RUNNING_SLATE);
  try {
    const toggle = view.container.querySelector('button[aria-expanded]');
    await act(async () => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const rows = view.container.textContent;
    assert.match(rows, /done out of band \(no plane run\)/);
    assert.match(rows, /operator-accepted \(not QA-passed\)/);
    // And the one slot that DID pass QA still reads as plain completed.
    assert.match(rows, /A finished slot/);
  } finally {
    view.cleanup();
  }
});

test('a manually completed slot is reported as unproven, not as QA-passed', async () => {
  const manual = {
    ...RUNNING_SLATE,
    stages: RUNNING_SLATE.stages.map((s) => (s.stage === 'verified'
      ? { ...s, reached: false, complete: false, detail: '0 of 1 slot QA-passed; 1 completed with no dispatch evidence', counts: { verified: 0, live: 1, operatorAccepted: 0, outOfBand: 0, unproven: 1 } }
      : s)),
    slots: [{ ...RUNNING_SLATE.slots[0], verified: false, attempted: false, dispatchProven: false, unprovenCompletion: true, provenanceAt: null, provenanceVia: null }],
  };
  const view = await mountWith(manual);
  try {
    assert.match(view.text, /1 unproven/);
    const toggle = view.container.querySelector('button[aria-expanded]');
    await act(async () => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.match(view.container.textContent, /completed \(no dispatch evidence\)/);
  } finally {
    view.cleanup();
  }
});

/**
 * QA 2026-09-18 (the finding). A slot Praxis reconciled to `completed` after
 * the board said the task was done keeps whatever attempt stamp it already
 * had, so dispatch evidence survives and QA evidence never existed. The strip
 * has to show both halves: the attempt stands, the QA claim does not.
 */

test('a reconciled completion keeps its attempt evidence and loses the QA claim', async () => {
  const view = await mountWith(RECONCILED_SLATE);
  try {
    // Attempted counts it; Verified does not.
    assert.match(view.text, /2\/2/);
    assert.match(view.text, /1\/2/);
    assert.match(view.text, /1 not QA-reviewed/);
    const toggle = view.container.querySelector('button[aria-expanded]');
    await act(async () => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const rows = view.container.textContent;
    assert.match(rows, /completed \(not QA-reviewed\)/);
    // And the genuine pass beside it still reads as a plain completion.
    assert.match(rows, /A slot that really passed QA/);
    assert.equal(/A slot that really passed QA\s*completed \(not QA-reviewed\)/.test(rows), false);
  } finally {
    view.cleanup();
  }
});

test('the reviewer behind a real pass is on the row, not only in the count', async () => {
  const view = await mountWith(RECONCILED_SLATE);
  try {
    const toggle = view.container.querySelector('button[aria-expanded]');
    await act(async () => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.match(view.container.innerHTML, /QA pass by codex/);
  } finally {
    view.cleanup();
  }
});

test('an unreadable QA ledger reads as unknown, never as zero passes', async () => {
  const view = await mountWith(UNREADABLE_LEDGER_SLATE);
  try {
    assert.match(view.text, /QA evidence unreadable/);
    assert.match(view.text, /Attempted2\/2/);
    const chip = view.container.querySelector('[title^="Verified:"]');
    assert.match(chip.textContent, /QA unknown/);
    assert.match(chip.className, /text-slate-400/);
    assert.doesNotMatch(chip.textContent, /0\/2/);
    assert.doesNotMatch(view.html, /0 of 2 slots QA-passed|not QA-reviewed|no reviewer verdict|never verified|No record that this slate was verified/);
    assert.match(view.text, /Nothing left to run; verification unknown/);
    assert.match(view.html, /SQLITE_CANTOPEN/);
    const toggle = view.container.querySelector('button[aria-expanded]');
    await act(async () => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    // Both rows say the evidence could not be read, not that QA failed them.
    assert.equal(view.container.textContent.match(/completed \(QA evidence unreadable\)/g).length, 2);
    const states = [...view.container.querySelectorAll('li span')]
      .filter((node) => node.textContent === 'completed (QA evidence unreadable)');
    assert.equal(states.length, 2);
    for (const state of states) {
      assert.match(state.className, /text-slate-400/);
      assert.doesNotMatch(state.className, /text-amber/);
    }
    assert.equal(/not QA-passed|failed/.test(view.container.textContent), false);
  } finally {
    view.cleanup();
  }
});

test('unreadable QA with live work has no verification delay claim or clock', async () => {
  const payload = {
    ...UNREADABLE_LEDGER_SLATE,
    stall: { ...UNREADABLE_LEDGER_SLATE.stall, stalled: true },
  };
  const view = await mountWith(payload);
  try {
    assert.match(view.text, /Verification unknown; QA evidence unreadable/);
    assert.doesNotMatch(view.text, /Not verified|never verified|waiting/);
    assert.equal(stageProgress(payload.stages[3]), null);
    assert.equal(stageTone(payload.stages[3], payload.stall), 'unknown');
  } finally {
    view.cleanup();
  }
});

test('a settled slate wears a neutral chip with no elapsed clock', async () => {
  const view = await mountWith(SETTLED_SLATE);
  try {
    assert.match(view.text, /Nothing left to run/);
    // The improvement QA asked for: no waiting chip, no running clock, and no
    // amber, beside a sentence that says there is nothing to wait for.
    assert.equal(/waiting \d/.test(view.text), false);
    assert.equal(/amber/.test(view.html), false);
    assert.match(view.html, /Every slot was withdrawn before dispatch/);
  } finally {
    view.cleanup();
  }
});
