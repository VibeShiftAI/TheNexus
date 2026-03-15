/**
 * Audit Logger Service
 * 
 * Records all agent actions for debugging, compliance, and analysis.
 * Stores truncated summaries to protect privacy while enabling traceability.
 */

const db = require('../../db');

// Truncate strings to prevent storing huge payloads
const MAX_SUMMARY_LENGTH = 500;

function truncate(str, maxLen = MAX_SUMMARY_LENGTH) {
    if (!str) return null;
    const s = typeof str === 'string' ? str : JSON.stringify(str);
    return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
}

/**
 * Log an agent action to the audit trail
 */
async function logAction({
    userId = null,
    projectId = null,
    workflowId = null,
    agentId = null,
    actionType,      // 'tool_call', 'llm_request', 'state_change', 'error'
    actionName,      // e.g., 'github_create_issue', 'gemini-2.5-flash'
    mcpServer = null,
    input = null,
    output = null,
    tokensUsed = 0,
    cost = 0,
    durationMs = null,
    status = 'success',
    errorMessage = null,
    wasHumanApproved = false,
    wasRateLimited = false,
}) {
    if (!db.isDatabaseEnabled()) {
        console.log(`[AuditLog] ${actionType}: ${actionName} (DB disabled)`);
        return null;
    }

    try {
        const result = await db.insertAuditLog({
            action: actionType,
            actor: agentId || userId,
            target_type: actionType,
            target_id: projectId || workflowId,
            details: {
                user_id: userId,
                project_id: projectId,
                workflow_id: workflowId,
                agent_id: agentId,
                action_type: actionType,
                action_name: actionName,
                mcp_server: mcpServer,
                input_summary: truncate(input),
                output_summary: truncate(output),
                tokens_used: tokensUsed,
                cost: cost,
                duration_ms: durationMs,
                status: status,
                error_message: errorMessage,
                was_human_approved: wasHumanApproved,
                was_rate_limited: wasRateLimited,
            },
        });

        return result?.id || null;
    } catch (e) {
        console.error('[AuditLog] Error:', e);
        return null;
    }
}

/**
 * Log a tool call
 */
async function logToolCall(context, toolName, input, output, { durationMs, status = 'success', error = null } = {}) {
    return logAction({
        ...context,
        actionType: 'tool_call',
        actionName: toolName,
        input,
        output,
        durationMs,
        status,
        errorMessage: error,
    });
}

/**
 * Log an LLM request
 */
async function logLLMRequest(context, model, prompt, response, { tokensUsed, cost, durationMs } = {}) {
    return logAction({
        ...context,
        actionType: 'llm_request',
        actionName: model,
        input: prompt,
        output: response,
        tokensUsed,
        cost,
        durationMs,
        status: 'success',
    });
}

/**
 * Log an error
 */
async function logError(context, errorMessage, details = null) {
    return logAction({
        ...context,
        actionType: 'error',
        actionName: 'error',
        input: details,
        status: 'error',
        errorMessage,
    });
}

/**
 * Log a rate limit block
 */
async function logRateLimited(context, reason, limit) {
    return logAction({
        ...context,
        actionType: 'error',
        actionName: 'rate_limited',
        input: { reason, limit },
        status: 'rate_limited',
        errorMessage: reason,
        wasRateLimited: true,
    });
}

/**
 * Query recent audit logs
 */
async function getRecentLogs({ userId, projectId, limit = 50, actionType = null } = {}) {
    if (!db.isDatabaseEnabled()) return [];

    try {
        const filters = { limit };
        if (actionType) filters.action = actionType;
        // userId and projectId are stored within the details JSON
        // For now, return all logs matching action type and limit
        const logs = await db.getAuditLogs(filters);

        // Filter by userId/projectId from details if needed
        return logs.filter(log => {
            const d = log.details || {};
            if (userId && d.user_id !== userId) return false;
            if (projectId && d.project_id !== projectId) return false;
            return true;
        });
    } catch (e) {
        console.error('[AuditLog] Error:', e);
        return [];
    }
}

/**
 * Get usage summary for a time period
 */
async function getUsageSummary({ userId, projectId, days = 7 } = {}) {
    if (!db.isDatabaseEnabled()) return null;

    try {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString();

        // Get all recent logs and filter
        const logs = await db.getAuditLogs({ limit: 10000 });
        const data = logs.filter(log => {
            if (log.created_at < sinceStr) return false;
            const d = log.details || {};
            if (userId && d.user_id !== userId) return false;
            if (projectId && d.project_id !== projectId) return false;
            return true;
        });

        const summary = {
            totalRequests: data.length,
            totalTokens: data.reduce((sum, r) => sum + ((r.details || {}).tokens_used || 0), 0),
            totalCost: data.reduce((sum, r) => sum + parseFloat((r.details || {}).cost || 0), 0),
            byActionType: {},
            byModel: {},
        };

        data.forEach(r => {
            const d = r.details || {};
            summary.byActionType[d.action_type] = (summary.byActionType[d.action_type] || 0) + 1;
            if (d.action_type === 'llm_request') {
                summary.byModel[d.action_name] = (summary.byModel[d.action_name] || 0) + 1;
            }
        });

        return summary;
    } catch (e) {
        console.error('[AuditLog] Error:', e);
        return null;
    }
}

module.exports = {
    logAction,
    logToolCall,
    logLLMRequest,
    logError,
    logRateLimited,
    getRecentLogs,
    getUsageSummary,
};
