import test from 'node:test';
import assert from 'node:assert/strict';
import { alertFacts, currentVoiceAlert, eligibleAlert, voiceAlertArchive } from '../voice-alerts';
import type { StreamEvent } from '@praxis/contract';
const event = { type: 'hitl.created', eventId: 'e1', at: '2026-10-06T12:00:00Z', request: { id: 'q1', question: 'Which staging URL should I use?', requestedAt: '2026-10-06T12:00:00Z', reason: 'explicit_request', workspace: '/tmp' } } as StreamEvent;
test('voice facts carry the exact question, action and targeted destination', () => {
  const facts = alertFacts(event);
  assert.equal(facts.question, 'Which staging URL should I use?');
  assert.equal(facts.actionHref, '/inbox#q1');
  assert.match(String(facts.action), /answer/i);
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
