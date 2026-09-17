import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../voice-chat';
test('announcements archive one assistant row with stable event identity and no autoplay', async () => {
  const bodies: any[] = [];
  assert.equal(typeof api.archiveVoiceAnnouncement, 'function');
  const rows = await api.archiveVoiceAnnouncement('event-1', 'The task failed.', 'selected', { pollIntervalMs: 1, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new Error('lost receipt');
    return Response.json({ ok: true, synced: 1, messages: bodies.at(-1).messages });
  } });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].conversationId, 'selected');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'assistant');
  assert.equal(rows[0].content, 'The task failed.');
  assert.equal(rows[0].metadata.suppressVoice, true);
  assert.equal(rows[0].metadata.eventId, 'event-1');
});
test('announcement storage failure rejects instead of reporting a saved announcement', async () => {
  await assert.rejects(api.archiveVoiceAnnouncement('event-2', 'Do not lose this.', 'selected', {
    pollIntervalMs: 1, fetch: async () => Response.json({ok:false,synced:0,messages:[]},{status:503}),
  }), /archival unavailable/i);
});

test('delivery failure is archived idempotently with speech suppressed', async () => {
  const bodies: any[] = [];
  const rows = await api.archiveVoiceDeliveryNotice('event-1', 'Voice update failed.', 'selected', { pollIntervalMs: 1, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new Error('lost receipt');
    return Response.json({ ok: true, synced: 1, messages: bodies.at(-1).messages });
  } });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(rows[0].id, 'voice-delivery:event-1');
  assert.equal(rows[0].metadata.suppressVoice, true);
  assert.equal(rows[0].metadata.voiceDeliveryNotice, true);
});
