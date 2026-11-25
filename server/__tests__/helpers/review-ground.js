/**
 * Review grounds for test registrations (contract docs/contracts/document-review-deliverables.md §15, task dcc2a7be).
 * A request for Robert's review lands in Needs your review only with something waiting on it. Fixtures that model a
 * document waiting for his review, with nothing else waiting on it, name his own request as that ground: a saved chat
 * message of his, cited by its Nexus message reference.
 */

/**
 * Resolve once the clock is past the millisecond this was called in. Timestamps are ISO strings to the millisecond
 * (db/index.js now()), so anything saved after this is stamped strictly later than anything saved before it.
 */
async function nextMillisecond() {
    const start = Date.now();
    while (Date.now() <= start) await new Promise(resolve => setImmediate(resolve));
}

/** Save a chat message of Robert's asking to see a document and return the review ground that cites it. */
async function robertAsks(db, content = 'Show me this when it is ready.') {
    // A request counts until his next decision, so it must be recorded strictly after any decision made before it.
    await nextMillisecond();
    const conversation = await db.createConversation('praxis');
    const message = await db.saveChatMessage({ conversation_id: conversation.id, role: 'user', content });
    return { type: 'operator_request', message_ref: `nexus://conversation/${conversation.id}/message/${message.id}` };
}

/**
 * For suites whose db is a stub without chat: one saved message of Robert's, the ground citing it, and the
 * getChatMessageById reader the documents router uses to verify it.
 */
function stubbedAsk({ conversationId = 'conversation-robert', messageId = 'message-robert-asks', createdAt = new Date().toISOString() } = {}) {
    const message = { rowid: 1, id: messageId, conversation_id: conversationId, role: 'user', content: 'Show me this when it is ready.', created_at: createdAt };
    return {
        ground: { type: 'operator_request', message_ref: `nexus://conversation/${conversationId}/message/${messageId}` },
        getChatMessageById: async id => (id === messageId ? { ...message } : null),
    };
}

module.exports = { robertAsks, stubbedAsk };
