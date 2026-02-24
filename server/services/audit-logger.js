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
    if (!db.supabase) {
        console.log(`[AuditLog] ${actionType}: ${actionName} (DB disabled)`);
        return null;
    }

    try {
        const { data, error } = await db.supabase
            .from('agent_audit_log')
            .insert({
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
            })
            .select('id')
            .single();

        if (error) {
            console.error('[AuditLog] Failed to log action:', error.message);
            return null;
        }

        return data?.id;
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
    if (!db.supabase) return [];

    try {
        let query = db.supabase
            .from('agent_audit_log')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (userId) query = query.eq('user_id', userId);
        if (projectId) query = query.eq('project_id', projectId);
        if (actionType) query = query.eq('action_type', actionType);

        const { data, error } = await query;

        if (error) {
            console.error('[AuditLog] Query error:', error.message);
            return [];
        }

        return data || [];
    } catch (e) {
        console.error('[AuditLog] Error:', e);
        return [];
    }
}

/**
 * Get usage summary for a time period
 */
async function getUsageSummary({ userId, projectId, days = 7 } = {}) {
    if (!db.supabase) return null;

    try {
        const since = new Date();
        since.setDate(since.getDate() - days);

        let query = db.supabase
            .from('agent_audit_log')
            .select('action_type, action_name, tokens_used, cost')
            .gte('created_at', since.toISOString());

        if (userId) query = query.eq('user_id', userId);
        if (projectId) query = query.eq('project_id', projectId);

        const { data, error } = await query;

        if (error || !data) return null;

        // Aggregate
        const summary = {
            totalRequests: data.length,
            totalTokens: data.reduce((sum, r) => sum + (r.tokens_used || 0), 0),
            totalCost: data.reduce((sum, r) => sum + parseFloat(r.cost || 0), 0),
            byActionType: {},
            byModel: {},
        };

        data.forEach(r => {
            summary.byActionType[r.action_type] = (summary.byActionType[r.action_type] || 0) + 1;
            if (r.action_type === 'llm_request') {
                summary.byModel[r.action_name] = (summary.byModel[r.action_name] || 0) + 1;
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
