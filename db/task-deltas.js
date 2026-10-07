/** Narrow task edits merged into canonical storage, never a copied dispatch projection. */
const { createHash } = require('crypto');
const sha = text => createHash('sha256').update(text.trim()).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'task_delta_invalid' }); };
function fields(input, allowed) {
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('Unknown or invalid task delta fields');
    if (input.expected_version !== undefined && (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0)) fail('expected_version must be a non-negative safe integer');
}
function string(value, label, max = 2000) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must be a non-empty string of at most ${max} characters`);
    return value;
}
function payloadOf(task) {
    if (task.antigravity_payload != null && !object(task.antigravity_payload)) fail('Task payload is not an object');
    return task.antigravity_payload || {};
}
function storedParts(entry) {
    const at = entry.lastIndexOf('  (');
    return at >= 0 && entry.endsWith(')') ? { text: entry.slice(0, at), stamp: entry.slice(at + 3, -1) } : { text: entry, stamp: '' };
}
function appendRuling(task, input) {
    fields(input, ['ruling', 'source', 'provenance', 'source_scoped', 'expected_version']);
    const text = string(input.ruling, 'ruling', 100000).trim();
    if (input.source !== undefined) string(input.source, 'source');
    if (input.source_scoped !== undefined && typeof input.source_scoped !== 'boolean') fail('source_scoped must be boolean');
    const provenance = input.provenance;
    if (provenance !== undefined) {
        fields(provenance, ['kind', 'id', 'instructed_at']);
        if (!['inbox_answer', 'questionnaire', 'chat_instruction'].includes(provenance.kind)) fail('Invalid ruling provenance kind');
        string(provenance.id, 'provenance.id');
        if (provenance.instructed_at !== undefined) string(provenance.instructed_at, 'provenance.instructed_at', 100);
    }
    const source = [input.source, provenance ? `${provenance.kind} ${provenance.id}${provenance.instructed_at ? ` answered at ${provenance.instructed_at}` : ''}` : ''].filter(Boolean).join('; ');
    const clipped = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
    const id = sha(text).slice(0, 16);
    const stamp = [source, text.length > 1200 ? `clipped from ${text.length} chars, full-text id ${id}` : ''].filter(Boolean).join('; ');
    const entry = stamp ? `${clipped}  (${stamp})` : clipped;
    const payload = payloadOf(task);
    const existing = Array.isArray(payload.operator_rulings) ? payload.operator_rulings : [];
    const audit = task.metadata?.work_admission?.operator_answers || [];
    const duplicate = existing.some((value, index) => {
        if (typeof value !== 'string') return false;
        const stored = storedParts(value.trim());
        if (stored.text !== clipped || (text.length > 1200 && /full-text id ([0-9a-f]{16})/.exec(stored.stamp)?.[1] !== id)) return false;
        if (provenance) {
            const key = `${provenance.kind} ${provenance.id}`;
            if (stored.stamp.split('; ').some(part => part === key || part.startsWith(`${key} answered at `))) return true;
            if (input.source_scoped) return false;
            const latest = audit.filter(answer => answer.index === index).at(-1);
            return latest?.sha256 === sha(value) && ['operator', 'operator_relayed', 'runtime'].includes(latest.origin);
        }
        return !input.source_scoped || stored.stamp === source || stored.stamp.startsWith(`${source}; `);
    });
    return duplicate ? null : { ...payload, operator_rulings: [...existing, entry] };
}
function ledgerPayload(task, ledger) {
    fields(ledger, ['binding_constraints', 'binding_constraints_text']);
    if (!Array.isArray(ledger.binding_constraints) || typeof ledger.binding_constraints_text !== 'string') fail('payload_ledger requires binding_constraints and binding_constraints_text');
    if (!object(task.antigravity_payload)) fail('Ledger delta requires an existing payload');
    return { ...task.antigravity_payload, ...ledger };
}
function workspaceDelta(task, input) {
    fields(input, ['workspace', 'workspace_roots', 'history', 'payload_ledger', 'expected_version', 'contract_change']);
    if (input.workspace !== undefined) string(input.workspace, 'workspace');
    if (!Array.isArray(input.workspace_roots) || input.workspace_roots.some(root => typeof root !== 'string' || !root.trim())) fail('workspace_roots must list paths');
    if (!object(input.history)) fail('history must be an object');
    fields(input.history, ['from', 'to', 'action', 'at', 'reason', 'by']);
    string(input.history.to, 'history.to'); string(input.history.at, 'history.at', 100);
    if (!['add', 'move'].includes(input.history.action)) fail('history.action must be add or move');
    if (input.payload_ledger !== undefined && input.expected_version === undefined) fail('Ledger delta requires expected_version');
    const payload = input.payload_ledger === undefined ? payloadOf(task) : ledgerPayload({ ...task, antigravity_payload: payloadOf(task) }, input.payload_ledger);
    return { ...payload, ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        workspace_roots: [...new Set([...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []), ...input.workspace_roots])],
        workspace_history: [...(Array.isArray(payload.workspace_history) ? payload.workspace_history : []), input.history] };
}
function payloadDelta(task, delta) {
    fields(delta, ['prompt', 'workspace', 'acceptance_criteria', 'context_files', 'target_files', 'scope', 'commands', 'constraints',
        'declared_paths', 'workspace_roots', 'additional_workspaces', 'binding_constraints', 'binding_constraints_text', 'repair_context', 'improvement_issue']);
    const payload = { ...payloadOf(task) };
    for (const [key, value] of Object.entries(delta)) {
        if (value === null) delete payload[key]; else payload[key] = value;
    }
    return payload;
}
function appendCriteria(task, additions) {
    if (!Array.isArray(additions) || additions.some(value => typeof value !== 'string' || !value.trim())) fail('acceptance_criteria_append must list non-empty criteria');
    const payload = payloadOf(task);
    if (payload.acceptance_criteria != null && !Array.isArray(payload.acceptance_criteria)) fail('Stored acceptance criteria must be an array');
    const criteria = [...(payload.acceptance_criteria || [])];
    for (const value of additions) {
        if (!criteria.some(existing => typeof existing === 'string' && existing.trim().toLowerCase() === value.trim().toLowerCase())) criteria.push(value);
    }
    return { ...payload, acceptance_criteria: criteria };
}
module.exports = { appendRuling, workspaceDelta, ledgerPayload, payloadDelta, appendCriteria };
