const fs = require('fs');
const os = require('os');
const path = require('path');
let db, dir, oldPath;
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-policy-')); oldPath = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.isolateModules(() => { db = require('../../db'); });
});
afterAll(() => { if (oldPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
test('conversation filtering happens before pagination and archival is idempotent without deleting history', async () => {
    const conversation = await db.createConversation('praxis', 'Policy');
    await db.saveChatMessage({ id: 'dialogue', conversation_id: conversation.id, role: 'user', content: 'Explain this', mode: 'praxis' });
    for (let i = 0; i < 20; i++) await db.saveChatMessage({ id: `activity-${i}`, conversation_id: conversation.id, role: 'assistant', content: `Document ${i}`, mode: 'praxis', metadata: { eventType: 'document_delivery' } });
    expect((await db.getChatMessages(conversation.id, { limit: 12, conversationalOnly: true })).map(r => r.id)).toEqual(['dialogue']);
    expect((await db.getAgEvents({ limit: 100 })).filter(r => r.event_type === 'document_delivery')).toHaveLength(20);
    // Simulate a pre-policy historical receipt, bypassing the modern writer.
    const sqlite = new (require('better-sqlite3'))(path.join(dir, 'test.db'));
    sqlite.prepare('INSERT INTO chat_messages (id, conversation_id, role, content, mode, metadata) VALUES (?, ?, ?, ?, ?, ?)').run('legacy', conversation.id, 'assistant', 'old document', 'praxis', JSON.stringify({ eventType: 'document_delivery' }));
    sqlite.close();
    expect(await db.archiveBackgroundChatMessages()).toBe(1);
    expect(await db.archiveBackgroundChatMessages()).toBe(0);
    expect(await db.getChatMessages(conversation.id, { limit: 100 })).toHaveLength(22);
});
test('background policy preserves dialogue, explicit final responses and requested briefings', () => {
    const { isActivityOnlyChatMessage: hidden } = require('../../db/chat-message-policy');
    for (const eventType of ['document_delivery', 'task_qa_passed', 'task_qa_exempt', 'task_correction_redispatch', 'day_schedule_approved', 'task_resumed_with_answer', 'feedback.answers_actioned', 'feedback.questionnaire_answered', 'eod_commit_completed', 'eod_commit_rejected', 'groundskeeper_decisions', 'knowledge_council_completed', 'project_reflection_completed', 'skill_gardener_completed', 'cross_pollination_candidates', 'decision_debt', 'day_schedule_approval_requested', 'health_report']) {
        expect(hidden({ role: 'assistant', metadata: { eventType } })).toBe(true);
    }
    for (const flag of ['voiceAnnouncement', 'voiceDeliveryNotice', 'hitlAnnounce', 'hitlAck']) expect(hidden({ role: 'assistant', metadata: { [flag]: true } })).toBe(true);
    expect(hidden({ role: 'assistant', metadata: { voiceConversation: true } })).toBe(false);
    expect(hidden({ role: 'user', metadata: { eventType: 'task_qa_passed', voiceAnnouncement: true } })).toBe(false);
    expect(hidden({ role: 'system', metadata: { eventType: 'task_answer_pending', persisted: false } })).toBe(false);
    expect(hidden({ role: 'system', metadata: { eventType: 'chat_dispatch.task_correction_redispatch' } })).toBe(true);
    expect(hidden({ role: 'assistant', metadata: { eventType: 'task_qa_passed', chatDirectedFinal: true } })).toBe(false);
    expect(hidden({ role: 'assistant', metadata: { eventType: 'status_report_ready', requestedBriefing: true } })).toBe(false);
    expect(hidden({ role: 'assistant', metadata: { eventType: 'health_report', severity: 'critical', requiresAction: true } })).toBe(false);
    expect(hidden({ role: 'assistant', metadata: { eventType: 'health_report', requiresAction: true } })).toBe(true);
    for (const eventType of ['fleet_preflight', 'graph_health_breach', 'graph_health_read_failed', 'ingestion_collection_degraded']) {
        expect(hidden({ role: 'assistant', metadata: { eventType, severity: 'warning', requiresAction: true } })).toBe(true);
        expect(hidden({ role: 'assistant', metadata: { eventType, severity: 'critical', requiresAction: true } })).toBe(false);
    }
    expect(hidden({ role: 'assistant', metadata: { eventType: 'board_maintenance_requested' } })).toBe(true);
    expect(hidden({ role: 'assistant', metadata: { eventType: 'chat_dispatch.task_qa_passed' } })).toBe(false);
});
test('historical Activity keeps its timestamp and cannot evict more recent events', () => {
    const sqlite = new (require('better-sqlite3'))(':memory:');
    const { initializeActivityEvents, recordActivityEvent } = require('../../db/activity-events');
    initializeActivityEvents(sqlite);
    recordActivityEvent(sqlite, { event_type: 'recent', title: 'Recent', created_at: '2026-10-13T12:00:00Z' }, 2);
    recordActivityEvent(sqlite, { event_type: 'old', title: 'Old', created_at: '2025-01-01T12:00:00Z' }, 2);
    expect(sqlite.prepare("SELECT created_at FROM ag_events WHERE event_type = 'old'").get().created_at).toBe('2025-01-01T12:00:00Z');
    recordActivityEvent(sqlite, { event_type: 'new', title: 'New', created_at: '2026-10-13T13:00:00Z' }, 2);
    expect(sqlite.prepare('SELECT event_type FROM ag_events ORDER BY id').all().map(r => r.event_type)).toEqual(['recent', 'new']);
    sqlite.close();
});
test('real sync retries return canonical voice receipts once in Activity and history paginates dialogue', async () => {
    const express = require('express');
    const http = require('http');
    const conversation = await db.createConversation('praxis', 'Sync policy');
    const io = { emit: jest.fn() };
    const app = express(); app.use(express.json()); app.use('/chat', require('../routes/chat-history')({ db, io }));
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/chat`;
    try {
        for (let i = 0; i < 3; i++) await db.saveChatMessage({ id: `turn-${i}`, conversation_id: conversation.id, role: 'user', content: `Question ${i}`, created_at: `2026-10-13T01:0${i}:00Z` });
        const announcement = { id: 'voice-alert:test-real', role: 'assistant', content: 'Canonical announcement', metadata: { voiceAnnouncement: true, eventId: 'test-real', suppressVoice: true, playbackOwner: 'voice' } };
        for (const content of [announcement.content, 'Regenerated sentence']) {
            const response = await fetch(`${base}/messages/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conversation.id, messages: [{ ...announcement, content }] }) });
            expect(response.status).toBe(200);
            expect((await response.json()).messages[0].content).toBe(announcement.content);
        }
        expect(io.emit).toHaveBeenCalledTimes(1);
        expect(io.emit).toHaveBeenCalledWith('activity:event', expect.objectContaining({ event_type: 'voice_announcement' }));
        expect((await db.getAgEvents({ limit: 100 })).filter(r => r.metadata.chatMessageId === announcement.id)).toHaveLength(1);
        const active = await (await fetch(`${base}/active?limit=2`)).json();
        expect(active.messages.map(r => r.id)).toEqual(['turn-1', 'turn-2']);
        expect(active).toMatchObject({ total_count: 3, hasMore: true });
        const history = await (await fetch(`${base}/history?conversationId=${conversation.id}&limit=2&before=2026-10-13T01:01:00Z`)).json();
        expect(history.messages.map(r => r.id)).toEqual(['turn-0']);
        expect(history.hasMore).toBe(false);
        const switched = await (await fetch(`${base}/conversations/${conversation.id}/switch?limit=2`, { method: 'PUT' })).json();
        expect(switched.messages.map(r => r.id)).toEqual(['turn-1', 'turn-2']);
        expect(switched.total_count).toBe(3);
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('history preserves canonical system blockers and chat-directed finals while context stays dialogue-only', async () => {
    const conversation = await db.createConversation('praxis', 'Canonical notices');
    for (const [id, metadata] of [['blocked', { eventType: 'task_blocked' }], ['final', { eventType: 'chat_dispatch.task_qa_passed' }], ['routine', { eventType: 'day_schedule_approved' }]]) {
        await db.saveChatMessage({ id, conversation_id: conversation.id, role: 'system', content: id, metadata });
    }
    expect((await db.getChatMessages(conversation.id, { chatVisibleOnly: true })).map(r => r.id)).toEqual(['blocked', 'final']);
    expect(await db.getChatMessages(conversation.id, { conversationalOnly: true })).toEqual([]);
    expect(await db.countChatMessages(conversation.id, { chatVisibleOnly: true })).toBe(2);
});
test('Activity write failure rolls back a new background receipt and retry can succeed', async () => {
    const conversation = await db.createConversation('praxis', 'Atomic archive');
    const sqlite = new (require('better-sqlite3'))(path.join(dir, 'test.db'));
    sqlite.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON ag_event_receipts BEGIN SELECT RAISE(ABORT, 'synthetic archive failure'); END");
    const message = { id: 'atomic-document', conversation_id: conversation.id, role: 'assistant', content: 'Delivered', metadata: { eventType: 'document_delivery' } };
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        expect(await db.saveChatMessage(message)).toBeNull();
        expect(await db.getChatMessageById(message.id)).toBeNull();
    } finally { sqlite.exec('DROP TRIGGER fail_archive'); sqlite.close(); warn.mockRestore(); }
    expect(await db.saveChatMessage(message)).not.toBeNull();
    expect((await db.getAgEvents({ limit: 100 })).filter(r => r.metadata.chatMessageId === message.id)).toHaveLength(1);
});
test('normal feed retention never removes the durable representation of hidden chat receipts', () => {
    const sqlite = new (require('better-sqlite3'))(':memory:');
    const { initializeActivityEvents, recordActivityEvent } = require('../../db/activity-events');
    initializeActivityEvents(sqlite);
    recordActivityEvent(sqlite, { event_type: 'document_delivery', title: 'Archived', created_at: '2025-01-01T00:00:00Z', metadata: { chatMessageId: 'hidden' } }, null);
    recordActivityEvent(sqlite, { event_type: 'recent', title: 'Recent', created_at: '2026-10-13T12:00:00Z' }, 1);
    recordActivityEvent(sqlite, { event_type: 'new', title: 'New', created_at: '2026-10-13T13:00:00Z' }, 1);
    expect(sqlite.prepare('SELECT event_type FROM ag_events ORDER BY id').all().map(r => r.event_type)).toEqual(['document_delivery', 'new']);
    sqlite.close();
});
test('startup migrates legacy rows with their original dates and a second startup remains idempotent', async () => {
    const conversation = await db.createConversation('praxis', 'Legacy startup');
    const sqlite = new (require('better-sqlite3'))(path.join(dir, 'test.db'));
    sqlite.prepare('INSERT INTO chat_messages (id, conversation_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-boot', conversation.id, 'assistant', 'Original historical announcement', JSON.stringify({ voiceAnnouncement: true }), '2025-05-01T12:00:00Z');
    let reloaded;
    jest.isolateModules(() => { reloaded = require('../../db'); });
    expect((await reloaded.getChatMessages(conversation.id, { chatVisibleOnly: true }))).toEqual([]);
    const event = sqlite.prepare("SELECT * FROM ag_events WHERE json_extract(metadata, '$.chatMessageId') = 'legacy-boot'").get();
    expect(event.created_at).toBe('2025-05-01T12:00:00Z');
    expect(event.message).toBe('Original historical announcement');
    jest.isolateModules(() => { reloaded = require('../../db'); });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ag_events WHERE json_extract(metadata, '$.chatMessageId') = 'legacy-boot'").get().n).toBe(1);
    expect((await reloaded.getChatMessages(conversation.id))).toHaveLength(1);
    sqlite.close();
});

test('taskless HITL questions remain visible; duplicates and routine approvals go to Activity', () => {
    const { isActivityOnlyChatMessage: hidden } = require('../../db/chat-message-policy');
    for (const hitlType of ['low_confidence', 'subjective_validation', undefined]) {
        expect(hidden({ role: 'system', metadata: { isHitlRequest: true, hitlType } })).toBe(false);
        expect(hidden({ role: 'system', metadata: { isHitlRequest: true, hitlType, taskId: 'task-1' } })).toBe(true);
    }
    expect(hidden({ role: 'system', metadata: { isHitlRequest: true, hitlType: 'trade_approval' } })).toBe(true);
});
test('Activity since compares mixed SQLite and ISO timestamps chronologically', async () => {
    await db.recordAgEvent({ event_type: 'time_before', title: 'Before', created_at: '2030-01-01T01:00:00Z' });
    await db.recordAgEvent({ event_type: 'time_after', title: 'After', created_at: '2030-01-01 03:00:00' });
    expect((await db.getAgEvents({ since: '2030-01-01T02:00:00Z' })).map(e => e.event_type)).toEqual(['time_after']);
    expect((await db.getAgEvents({ since: '2030-01-01 02:00:00' })).map(e => e.event_type)).toEqual(['time_after']);
});
