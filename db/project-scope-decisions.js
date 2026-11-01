/** An operator instruction is the decision. Its canonical effect and immutable
 * receipt share the existing board transaction, including knowledge routing. */
const crypto = require('crypto');
const { EndpointDefinitionSchema } = require('@praxis/contract');
const { invalid } = require('./project-data');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (message, code = 'SCOPE_DECISION_INVALID', status = 400) => Object.assign(invalid(message, status), { code });
const FIELDS = new Set(['name', 'description', 'type', 'vibe', 'stack', 'urls', 'path', 'status', 'priority', 'end_state', 'tags', 'upgrade_posture', 'end_state_criteria', 'endpoint', 'checkpoints', 'comms_settings', 'report_template', 'end_state_source', 'end_state_reason', 'expected_end_state_updated_at', 'expected_status', 'expected_checkpoints_revision']);
const GUARDS = new Set(['expected_end_state_updated_at', 'expected_status', 'expected_checkpoints_revision', 'end_state_source', 'end_state_reason']);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function validateScopeDecision(input) {
    if (!object(input)) throw fail('Scope decision must be an object');
    for (const key of Object.keys(input)) if (!['operation_id', 'expected_updated_at', 'decision_ref', 'updates'].includes(key)) throw fail(`Unsupported scope decision field: ${key}`);
    if (typeof input.operation_id !== 'string' || !input.operation_id.trim() || input.operation_id.length > 200) throw fail('operation_id must be a nonempty string of at most 200 characters');
    if (!own(input, 'expected_updated_at')) throw fail('expected_updated_at is required from the project snapshot', 'SCOPE_REVISION_REQUIRED', 428);
    if (input.expected_updated_at !== null && typeof input.expected_updated_at !== 'string') throw fail('expected_updated_at must be a string or null');
    const ref = input.decision_ref;
    if (!object(ref) || !['chat_instruction', 'questionnaire', 'inbox_answer'].includes(ref.kind)) throw fail('decision_ref.kind must be chat_instruction, questionnaire or inbox_answer');
    for (const key of Object.keys(ref)) if (!['kind', 'id', 'instruction', 'source_ref', 'instructed_at', 'attestation'].includes(key)) throw fail(`Unsupported decision reference field: ${key}`);
    for (const key of ['id', 'instruction']) if (typeof ref[key] !== 'string' || !ref[key].trim()) throw fail(`decision_ref.${key} must contain the actual instruction or its named reference`);
    for (const key of ['source_ref', 'instructed_at']) if (own(ref, key) && (typeof ref[key] !== 'string' || !ref[key].trim())) throw fail(`decision_ref.${key} must be a nonempty string when supplied`);
    if (own(ref, 'attestation') && ref.attestation !== 'runtime_attestation') throw fail('Generated references must be labelled runtime_attestation');
    if (!object(input.updates) || !Object.keys(input.updates).some(key => !GUARDS.has(key))) throw fail('updates must contain requested project fields');
    for (const key of Object.keys(input.updates)) if (!FIELDS.has(key)) throw fail(`Unsupported project field: ${key}`);
    const u = input.updates;
    for (const key of ['name', 'description', 'type', 'vibe', 'path', 'end_state', 'end_state_source', 'end_state_reason']) if (own(u, key) && typeof u[key] !== 'string') throw fail(`${key} must be a string`);
    if (own(u, 'status') && !['active', 'parked', 'paused', 'completed', 'archived'].includes(u.status)) throw fail('Invalid project status');
    if (own(u, 'upgrade_posture') && !['auto', 'propose', 'off'].includes(u.upgrade_posture)) throw fail('Invalid upgrade_posture');
    if (own(u, 'priority') && (typeof u.priority !== 'number' || !Number.isInteger(u.priority))) throw fail('priority must be an integer');
    for (const key of ['tags']) if (own(u, key) && (!Array.isArray(u[key]) || u[key].some(v => typeof v !== 'string'))) throw fail(`${key} must be an array of strings`);
    for (const key of ['urls', 'comms_settings', 'report_template']) if (own(u, key) && (u[key] !== null && !object(u[key]) || JSON.stringify(u[key]).length > 64 * 1024)) throw fail(`${key} must be a JSON object of at most 64 KB`);
    if (own(u, 'stack') && u.stack !== null && typeof u.stack !== 'object') throw fail('stack must be a JSON object or array');
    if (own(u, 'endpoint')) {
        if (!object(u.endpoint)) throw fail('endpoint must be an object');
        for (const key of Object.keys(u.endpoint)) if (!own(EndpointDefinitionSchema.shape, key)) throw fail(`Unsupported endpoint field: ${key}`);
    }
    return input;
}
const intentUpdates = updates => Object.fromEntries(Object.entries(updates).filter(([key]) => !key.startsWith('expected_')));
function initializeProjectScopeDecisions(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_scope_decisions (
        operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_scope_decisions_project ON project_scope_decisions(project_id, created_at);
    CREATE TRIGGER IF NOT EXISTS project_scope_decisions_immutable_update BEFORE UPDATE ON project_scope_decisions
        BEGIN SELECT RAISE(ABORT, 'Project scope decision receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS project_scope_decisions_immutable_delete BEFORE DELETE ON project_scope_decisions
        BEGIN SELECT RAISE(ABORT, 'Project scope decision receipts are immutable'); END;`);
}
function createProjectScopeDecisions(db, { deserialize, writeProject }) {
    const readProject = id => deserialize(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
    const history = (id, operationId) => {
        if (!readProject(id) && !db.prepare('SELECT 1 FROM project_scope_decisions WHERE project_id = ?').get(id)) throw fail('Project not found', 'PROJECT_NOT_FOUND', 404);
        return db.prepare(`SELECT receipt FROM project_scope_decisions WHERE project_id = ?${operationId ? ' AND operation_id = ?' : ''} ORDER BY created_at, operation_id`).all(...(operationId ? [id, operationId] : [id])).map(row => JSON.parse(row.receipt));
    };
    const apply = (id, input, origin) => db.transaction(() => {
        validateScopeDecision(input);
        if (!['operator', 'operator_relayed'].includes(origin?.kind) || !origin.authority) throw fail('Verified operator authority required', 'SCOPE_DECISION_UNVERIFIED', 403);
        const current = readProject(id);
        if (!current) throw fail('Project not found', 'PROJECT_NOT_FOUND', 404);
        // CAS is not intent: retry with a fresher snapshot must still find the
        // original receipt instead of overwriting a subsequent decision.
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(stable({ project_id: id, decision_ref: input.decision_ref, updates: intentUpdates(input.updates) }))).digest('hex');
        const prior = db.prepare('SELECT * FROM project_scope_decisions WHERE operation_id = ?').get(input.operation_id);
        if (prior) {
            if (prior.project_id !== id || prior.fingerprint !== fingerprint) throw fail('operation_id already names a different scope decision', 'SCOPE_OPERATION_CONFLICT', 409);
            return { ...JSON.parse(prior.result), replayed: true };
        }
        if ((current.updated_at ?? null) !== input.expected_updated_at) throw fail('Project changed; read and reconcile the current project before retrying this instruction', 'SCOPE_REVISION_STALE', 409);
        const updates = { ...input.updates, expected_updated_at: input.expected_updated_at };
        for (const key of ['comms_settings', 'report_template']) if (updates[key] === null) updates[key] = {};
        const project = writeProject(id, updates); // synchronous, throws; never the swallowing async facade
        // The existing description/end-state trigger already invalidates those
        // edits. Endpoint-only boundaries must fence stale proposals too, while
        // a proposed_next suggestion cannot revoke unrelated authority.
        if (project.description === current.description && project.end_state === current.end_state &&
            ['scope', 'beneficiary', 'exclusions'].some(key => (current.endpoint?.[key] ?? '') !== (project.endpoint?.[key] ?? ''))) {
            db.prepare(`INSERT INTO stakeholder_proposal_events(task_id, revision, state, document)
                SELECT r.task_id, r.revision, 'invalidated', ? FROM stakeholder_proposal_revisions r
                WHERE r.project_id = ? AND r.revision = (SELECT MAX(revision) FROM stakeholder_proposal_revisions WHERE task_id = r.task_id)`)
                .run(JSON.stringify({ type: 'invalidation', at: new Date().toISOString(), reason: 'Project scope boundaries changed' }), id);
        }
        const fields = Object.keys(input.updates).filter(key => !GUARDS.has(key));
        const values = row => Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
        const receipt = { project_id: id, operation_id: input.operation_id, decision_ref: input.decision_ref,
            origin, reference_verification: origin.kind === 'operator_relayed' ? 'runtime_attestation' : 'operator_attestation',
            supplied_fields: fields, updates: input.updates, before: values(current), after: values(project),
            expected_updated_at: input.expected_updated_at, applied_updated_at: project.updated_at, at: new Date().toISOString() };
        const result = { project, receipt, replayed: false };
        db.prepare('INSERT INTO project_scope_decisions (operation_id, project_id, fingerprint, receipt, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(input.operation_id, id, fingerprint, JSON.stringify(receipt), JSON.stringify(result), receipt.at);
        return result;
    })();
    return { apply, history };
}
module.exports = { initializeProjectScopeDecisions, createProjectScopeDecisions, validateScopeDecision };
