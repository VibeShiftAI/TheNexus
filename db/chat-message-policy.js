/** Shared, conservative classification of stored operational chat receipts. */
const BACKGROUND_EVENT_TYPES = new Set([
    'document_delivery', 'task_qa_passed', 'task_qa_exempt', 'task_correction_redispatch',
    'day_schedule_approved', 'task_resumed_with_answer', 'feedback.answers_actioned',
    'feedback.questionnaire_answered', 'eod_commit_completed', 'eod_commit_rejected',
    'groundskeeper_decisions', 'decision_debt', 'attention_economics_report', 'groundskeeper_report',
    'project_reflection_completed', 'protocol_retrospective_completed', 'skill_gardener_completed',
    'cross_pollination_candidates', 'knowledge_council_completed',
    'day_schedule_approval_requested', 'eod_commit_approval_requested', 'board_approval_requested', 'board_maintenance_requested',
    'executor_circuit', 'qa_correction_withheld_paused', 'feedback_owner_dispatched',
    'human_query_sent', 'feedback.human_query_sent', 'task_answer_queued', 'task_answer_pending',
    'task_answer_already_delivered', 'task_operator_accepted', 'qa_spot_audit_reviewed',
    'executor_cli_upgraded', 'adhoc_task_completed', 'graph_health_recovered', 'runs_reconciled_at_boot',
    'cli_gate_stall_recovered', 'cli_sessions_swept', 'fleet_service_restored', 'dispatch_rerouted',
    'qa_reviewer_fallback', 'qa_reviewer_quota_redirect',
    'chat_dispatch.task_correction_redispatch', 'chat_dispatch.qa_dispatched',
    'chat_dispatch.task_dispatch_started', 'chat_dispatch.task_completed', 'chat_dispatch.task_resumed_with_answer',
]);
function metadataOf(row) {
    if (typeof row.metadata !== 'string') return row.metadata || {};
    try { return JSON.parse(row.metadata) || {}; } catch { return {}; }
}
function isActivityOnlyChatMessage(row) {
    if (row.role === 'user') return false;
    const metadata = metadataOf(row);
    // System receipts belong in Activity regardless of event type. Only a
    // failed direct reply stays in chat so the user's turn has an outcome.
    if (row.role === 'system') return !(metadata.responseFailed === true && metadata.replyTo);
    if (metadata.voiceAnnouncement || metadata.voiceDeliveryNotice || metadata.hitlAnnounce || metadata.hitlAck) return true;
    // Task-linked requests already have a canonical task_blocked notice.
    // Taskless questions may be the only actionable interruption.
    if (metadata.isHitlRequest && (metadata.taskId || metadata.task_id
        || ['trade_approval', 'day_schedule_approval', 'eod_commit_approval', 'board_maintenance'].includes(metadata.hitlType))) return true;
    if (metadata.chatDirectedFinal === true || metadata.requestedBriefing === true) return false;
    const type = metadata.eventType || metadata.event_type || row.eventType;
    if (type === 'task_answer_pending' && metadata.persisted === false) return false;
    if (BACKGROUND_EVENT_TYPES.has(type)) return true;
    if (['health_report', 'system_health_report', 'fleet_preflight', 'graph_health_breach', 'graph_health_read_failed', 'ingestion_collection_degraded'].includes(type)) {
        return !((metadata.severity || row.severity) === 'critical'
            && (metadata.requiresAction || metadata.requires_action || row.requiresAction || row.requires_action));
    }
    return false;
}
// Spoken updates remain archived in Activity and are also visible in chat.
function isChatVisibleMessage(row) {
    return (row.role === 'assistant' && metadataOf(row).voiceAnnouncement === true)
        || !isActivityOnlyChatMessage(row);
}
function isConversationalChatMessage(row) {
    return (row.role === 'user' || row.role === 'assistant') && !isActivityOnlyChatMessage(row);
}
function chatMessageActivityEvent(row) {
    const metadata = metadataOf(row);
    const eventType = metadata.eventType || metadata.event_type
        || (metadata.voiceAnnouncement ? 'voice_announcement' : metadata.voiceDeliveryNotice ? 'voice_delivery_notice' : metadata.isHitlRequest || metadata.hitlAnnounce || metadata.hitlAck ? 'hitl_announcement' : 'system_message');
    return {
        idempotency_key: `chat-message:${row.id}`, event_type: eventType, created_at: row.created_at,
        title: metadata.title || eventType.replace(/[_.]/g, ' '), message: row.content,
        severity: metadata.severity || 'info', source: metadata.source || 'nexus:chat-archive',
        task_id: metadata.taskId || metadata.task_id,
        metadata: { ...metadata, chatMessageId: row.id, conversationId: row.conversation_id, originalCreatedAt: row.created_at || null },
        requires_action: Boolean(metadata.requiresAction || metadata.requires_action),
    };
}
module.exports = { BACKGROUND_EVENT_TYPES, metadataOf, isChatVisibleMessage, isActivityOnlyChatMessage, isConversationalChatMessage, chatMessageActivityEvent };
