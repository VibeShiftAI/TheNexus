import test from 'node:test';
import assert from 'node:assert/strict';
import { alertFacts, currentVoiceAlert, eligibleAlert, voiceAlertArchive, voiceAlertSpeech } from '../voice-alerts';
import type { StreamEvent } from '@praxis/contract';
const event = { type: 'hitl.created', eventId: 'e1', at: '2026-10-06T12:00:00Z', request: { id: 'q1', question: 'Which staging URL should I use?', requestedAt: '2026-10-06T12:00:00Z', reason: 'explicit_request', workspace: '/tmp' } } as StreamEvent;
test('voice facts carry the exact question, action and targeted destination', () => {
  const facts = alertFacts(event);
  assert.equal(facts.question, 'Which staging URL should I use?');
  assert.equal(facts.actionHref, '/inbox#q1');
  assert.equal(facts.action, '');
});

test('a brief-backed alert speaks its brief once, preserves structured decisions and exact choices', () => {
  const brief = { project: 'Praxis', situation: 'The release is waiting for a destination.', problem: 'Production and staging are both available.', ask: 'Choose the destination and review window.' };
  const facts = alertFacts({ ...event, request: { ...(event as any).request, question: 'Technical wrapper worker=qa--123 and full diagnostics', options: ['Save both answers', 'Defer'], metadata: { brief, questions: [{ prompt: 'Which destination?', options: ['Production', 'Staging'] }, { prompt: 'Which review window?', options: ['Today', 'Tomorrow'] }] } } } as StreamEvent);
  const speech = voiceAlertSpeech('Generated duplicate asking for approval.', facts);
  assert.match(speech, /The release is waiting for a destination/);
  assert.match(speech, /Which destination\? \(Production \/ Staging\)/);
  assert.match(speech, /Which review window\? \(Today \/ Tomorrow\)/);
  assert.match(speech, /Save both answers/); assert.match(speech, /Defer/);
  assert.doesNotMatch(speech, /Generated duplicate|Technical wrapper|Open this request|Send Answer/);
  const archive = voiceAlertArchive(speech, facts);
  assert.equal(archive.split(brief.situation).length - 1, 1);
  assert.match(archive, /\(\/inbox#q1\)/);
  assert.doesNotMatch(archive, /Technical wrapper/);
});

test('a brief never erases an unstructured specific question or legacy exact choices', () => {
  const current = { ...event, request: { ...(event as any).request, options: ['staging-a', 'staging-b'], metadata: { brief: { project: 'Praxis', situation: 'Deployment is paused.', problem: 'A destination is missing.', ask: 'Choose a destination.' } } } } as StreamEvent;
  const speech = voiceAlertSpeech('', alertFacts(current));
  assert.match(speech, /Which staging URL should I use\?/);
  assert.match(speech, /staging-a \/ staging-b/);
  assert.match(voiceAlertArchive('Needs a destination.', alertFacts({ ...event, request: { ...(event as any).request, options: ['staging-a', 'staging-b'] } } as StreamEvent)), /staging-a \/ staging-b/);
});

test('a Markdown brief twin is not spoken twice and a distinct decision still survives', () => {
  const brief = { project: 'Praxis', situation: 'Deployment paused.', problem: 'A decision is missing.', ask: 'Use staging?' };
  const question = '**Project:** Praxis\n**What happened:** Deployment paused.\n**The problem:** A decision is missing.\n**What I need from you:** Use staging?';
  const facts = alertFacts({ ...event, request: { ...(event as any).request, question, metadata: { brief } } } as StreamEvent);
  assert.equal(voiceAlertArchive('', facts).split('Deployment paused.').length - 1, 1);
  const distinct = voiceAlertSpeech('', { ...facts, question: `${question}\nWhich maintenance window?` });
  assert.match(distinct, /Which maintenance window\?/);
});
test('voice archive has a deterministic linked action even if composed prose omits it', () => {
  const text = voiceAlertArchive('Praxis needs your input.', alertFacts(event));
  assert.match(text, /Which staging URL should I use\?/);
  assert.match(text, /\[Answer in Inbox\]\(\/inbox#q1\)/);
});
test('authoritative resolution or unavailable lookup suppresses stale spoken questions', async () => {
  assert.equal(await currentVoiceAlert(event, async () => Response.json({ ...(event as any).request, resolution: { choice: 'done' } })), null);
  assert.equal(await currentVoiceAlert(event, async () => new Response('', { status: 503 })), null);
  assert.equal(await currentVoiceAlert(event, async () => { throw new Error('offline'); }), null);
  const current = await currentVoiceAlert(event, async () => Response.json({ ...(event as any).request, question: 'Updated exact question?' }));
  assert.equal(current?.type === 'hitl.created' && current.request.question, 'Updated exact question?');
});
test('failed or blocked events cannot describe a task that is already running again', async () => {
  for (const type of ['task.failed', 'task.blocked']) {
    const stale = { type, taskId: 't1', eventId: 'old', at: event.at, error: 'stopped', reason: 'waiting' } as StreamEvent;
    assert.equal(await currentVoiceAlert(stale, async () => Response.json({ status: 'in_progress' })), null);
  }
});

test('expired requests cannot enter or remain in the voice queue', async () => {
  const expired = { ...event, request: { ...(event as any).request, requestedAt: '2000-01-01T00:00:00Z', ttlSeconds: 60 } } as StreamEvent;
  assert.equal(eligibleAlert(expired, 'conversational'), false);
  assert.equal(await currentVoiceAlert(event, async () => Response.json((expired as any).request)), null);
});

test('callback-owned failure is suppressed even before current-task lookup', async () => {
  const owned = { type: 'task.failed', eventId: 'attempt', taskId: 't1', at: event.at, error: 'Attempt failed', failureRecoveryOwner: 'callback' } as StreamEvent;
  let lookups = 0;
  const current = await currentVoiceAlert(owned, async () => { lookups++; return Response.json({ status: 'failed' }); });
  assert.equal(current, null);
  assert.equal(lookups, 0);
});
test('unowned failure remains current when a recovery request could not be created', async () => {
  const unowned = { type: 'task.failed', eventId: 'fallback', taskId: 't1', at: event.at, error: 'Recovery failed' } as StreamEvent;
  assert.equal(await currentVoiceAlert(unowned, async () => Response.json({ status: 'failed' })), unowned);
});
