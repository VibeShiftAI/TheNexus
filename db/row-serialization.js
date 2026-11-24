/** Deserialise a JSON TEXT column back to JS */
function deser(val) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'string') return val;
    const t = val.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

/** Deserialise known JSON columns on a row */
const JSON_COLS = new Set([
    'stack', 'urls', 'tasks_list', 'task_ledger', 'supervisor_details',
    'graph_config', 'context', 'checkpoint', 'metadata',
    'agent_configuration', 'parameters', 'capabilities', 'default_parameters', 'parameters_summary', 'config',
    'trigger_config', 'configuration', 'target_projects', 'progress',
    'allowed_tools', 'denied_tools', 'details', 'data',
    'value',
    'stages', 'outputs',
    'antigravity_payload', 'dependencies',
    'suspended_context', 'resume_action',
    'tags',
    'intake', 'needs', 'end_state_history', 'end_state_criteria', 'endpoint', 'end_state_assessment', 'checkpoints',
    'preferences', 'expertise', 'interests', 'claims', 'interaction_log',
    // Stakeholder governance (2026-08-22): per-project comms controls, the
    // branded report template, and calendar attendee lists.
    'comms_settings', 'report_template', 'attendees'
]);

function deserRow(row) {
    if (!row) return row;
    for (const key of Object.keys(row)) {
        if (JSON_COLS.has(key)) {
            row[key] = deser(row[key]);
        }
        // SQLite booleans back to JS booleans
        if (key === 'is_template' || key === 'is_active' || key === 'is_enabled' || key === 'resolved' || key === 'pinned' || key === 'local_only_active' || key === 'fallback_used' || key === 'decision_maker') {
            row[key] = row[key] === 1 || row[key] === true;
        }
    }
    return row;
}

module.exports = { deser, deserializeRow: deserRow, JSON_COLS };
