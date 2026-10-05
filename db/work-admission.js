const { createHash } = require('crypto');
const path = require('path');
const { canonicalPath } = require('./write-leases');

const DECISIONS = new Set(['new_work', 'covered_by_open', 'already_delivered', 'partial_overlap', 'needs_evidence']);
const RESOLUTION_WINDOW_MS = 15 * 60 * 1000;
const RETRIEVAL_VERSION = 2;
const TERMINAL_STATUSES = new Set(['completed', 'done', 'complete', 'cancelled', 'canceled', 'archived', 'failed']);
// A task is executing while an executor or QA session can be reading its brief:
// a started board status, or an open dispatch row for the task or its QA run.
const EXECUTING_STATUSES = new Set(['in_progress', 'dispatched', 'ready_for_review', 'review']);
const PAUSED_STATUSES = new Set(['suspended', 'needs_input']);
// Origins whose contract edits need no second approval: Robert himself, or a
// Praxis relay of a decision he already made. Everything else is recorded, and
// held when it lands during execution.
const AUTHORIZING_ORIGINS = new Set(['operator', 'operator_relayed']);
// Origins whose appended ruling is an authenticated addition: Robert's own
// credential, or the runtime that relays his answers. An entry appended by
// anyone else is recorded with its origin and grounds no relayed decision
// while a rewrite of the rulings is on record.
const VOUCHED_ANSWER_ORIGINS = new Set(['operator', 'operator_relayed', 'runtime']);
const ORIGIN_KINDS = new Set(['operator', 'operator_relayed', 'runtime', 'system', 'unverified']);
const CONTRACT_CHANGE_HISTORY = 30;
const CONTRACT_DRIFT_REASON = 'Contract changed during execution by an unverified source; review the recorded diff, then approve it or return to the authorized contract.';
const RULINGS_REWRITE_REASON = 'Recorded operator rulings were rewritten or removed; review the current scope before execution.';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const object = value => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const normalized = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return typeof value === 'string' ? normalized(value) : value ?? null;
}
const fail = (message, status = 409, code = 'work_admission_conflict', extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const dependencyList = value => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id))].sort() : [];
};
// Same reading as Praxis stringArray (orchestrator/acceptance-criteria.ts), so its own appends compare as appends.
const rulingEntries = value => Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry.trim()).map(entry => entry.trim()) : [];

function initializeWorkAdmission(db) {
    // The unique key and receipt commit with the task row; no reservation can
    // outlive a rolled-back insert, and a lost response is safe to retry.
    db.exec(`CREATE TABLE IF NOT EXISTS work_admissions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        identity_key TEXT UNIQUE,
        document TEXT NOT NULL
    );`);
}

function createWorkAdmission(db, { now = Date.now, lookup } = {}) {
    const snapshotCache = new Map();
    let cacheDataVersion;
    const readTask = id => {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row) throw fail('Task not found', 404);
        const metadata = object(row.metadata), receipt = readReceipt(id);
        if (receipt) metadata.work_admission = receipt;
        else delete metadata.work_admission;
        return { ...row, metadata, antigravity_payload: object(row.antigravity_payload) };
    };
    const readReceipt = id => {
        const row = db.prepare('SELECT document FROM work_admissions WHERE task_id = ?').get(id);
        return row ? JSON.parse(row.document) : null;
    };
    function contract(task, projectPath, { legacyRulings = false } = {}) {
        const metadata = object(task.metadata), identity = object(metadata.work_identity), payload = object(task.antigravity_payload);
        const workspacePath = projectPath === undefined ? db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id)?.path : projectPath;
        const requestedWorkspace = payload.workspace || workspacePath || identity.workspace || '';
        let workspace = requestedWorkspace;
        if (path.isAbsolute(requestedWorkspace)) workspace = canonicalPath(requestedWorkspace);
        if (identity.workspace && canonicalPath(identity.workspace) !== canonicalPath(requestedWorkspace)) throw fail('Declared identity workspace disagrees with executable workspace', 400);
        // Executor repair/session/routing state is operational context, not a
        // changed request. Bind only executable scope and acceptance fields.
        // Operator rulings are Robert's answers delivered to executor and QA;
        // saving one is not a scope change (2026-10-01, task 444a0be0). Only
        // guardUpdate's append-only check and the legacy rebind read them.
        const scopePayload = Object.fromEntries(['prompt', 'workspace', 'acceptance_criteria', 'context_files', 'target_files',
            'scope', 'commands', 'constraints', 'declared_paths', 'workspace_roots', 'additional_workspaces', ...(legacyRulings ? ['operator_rulings'] : []), 'binding_constraints', 'binding_constraints_text'].filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
        if (Array.isArray(scopePayload.binding_constraints)) scopePayload.binding_constraints = scopePayload.binding_constraints.filter(rule => !rule?.generated);
        if (Array.isArray(scopePayload.binding_constraints) && !scopePayload.binding_constraints.length) delete scopePayload.binding_constraints;
        // Generated text is a redundant projection with task-local links; authored structured constraints remain authoritative.
        if (Array.isArray(payload.binding_constraints) && payload.binding_constraints.some(rule => rule?.generated)) delete scopePayload.binding_constraints_text;
        return stable({ project_id: task.project_id, workspace, proposal_id: identity.proposal_id || null,
            name: task.name || task.title || '', description: task.description || '',
            scope: identity.scope || '', acceptance: identity.acceptance || payload.acceptance_criteria || [],
            payload: scopePayload, dispatch_instructions: task.dispatch_instructions || '',
            recurrence: identity.recurrence || null });
    }
    // Receipts written before 2026-10-01 fingerprinted rulings as scope. Such a
    // receipt still covers exactly this task when it matches that old digest.
    function legacyFingerprint(task) {
        return object(task.antigravity_payload).operator_rulings === undefined ? null : digest(contract(task, undefined, { legacyRulings: true }));
    }
    // The governed contract, field by field. Hashes come from the same stable
    // reading the fingerprint uses; raw values are what a return to the
    // authorized contract writes back. Dependencies are governed here even
    // though the fingerprint never bound them: adding or removing a
    // prerequisite changes what the executor must wait for.
    function governedFields(task, projectPath) {
        const c = contract(task, projectPath);
        const payload = object(task.antigravity_payload), identity = object(object(task.metadata).work_identity);
        const raw = { project_id: task.project_id ?? null, workspace: c.workspace, name: task.name || task.title || '', description: task.description || '',
            dispatch_instructions: task.dispatch_instructions || '', dependencies: dependencyList(task.dependencies) };
        const hashed = { project_id: c.project_id, workspace: c.workspace, name: c.name, description: c.description,
            dispatch_instructions: c.dispatch_instructions, dependencies: stable(raw.dependencies) };
        if (identity.proposal_id) { raw['identity.proposal_id'] = identity.proposal_id; hashed['identity.proposal_id'] = c.proposal_id; }
        if (identity.scope) { raw['identity.scope'] = identity.scope; hashed['identity.scope'] = c.scope; }
        if (identity.acceptance) { raw['identity.acceptance'] = identity.acceptance; hashed['identity.acceptance'] = c.acceptance; }
        if (identity.recurrence) { raw['identity.recurrence'] = identity.recurrence; hashed['identity.recurrence'] = c.recurrence; }
        for (const key of Object.keys(c.payload)) { raw[`payload.${key}`] = payload[key]; hashed[`payload.${key}`] = c.payload[key]; }
        const hashes = Object.fromEntries(Object.keys(hashed).sort().map(key => [key, sha256(JSON.stringify(hashed[key]))]));
        return { raw, hashes, hash: digest(hashes), fingerprint: digest(c) };
    }
    // Baseline fields are stored sorted and without removed (null) entries, so
    // the stored hash is the hash governedFields() computes for the same
    // reading; a return compares the two exactly, whatever order fields were
    // added in.
    const canonicalFields = fields => Object.fromEntries(Object.keys(fields).filter(key => fields[key] !== null && fields[key] !== undefined).sort().map(key => [key, fields[key]]));
    const authorizedBaseline = (fields, version, authorized_by, { fingerprint = null } = {}) => {
        const canonical = canonicalFields(fields.hashes ?? fields);
        return { version, hash: digest(canonical), fingerprint, fields: canonical, authorized_at: new Date(now()).toISOString(), authorized_by };
    };
    const holdOpen = receipt => Boolean(receipt?.contract_hold);
    const dispatchTableExists = () => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_dispatches'").get());
    function openDispatches(taskId) {
        if (!taskId || !dispatchTableExists()) return [];
        try {
            return db.prepare("SELECT id, task_id, kind, executor, started_at FROM task_dispatches WHERE outcome = 'running' AND task_id IN (?, ?) ORDER BY started_at, id")
                .all(taskId, `qa--${taskId}`);
        } catch { return []; }
    }
    // Phase is judged from the stored row and the status this write moves to,
    // so a single write cannot start a task and rewrite its brief unexamined.
    function executionPhase(task, updates = {}) {
        const open = openDispatches(task.id);
        const executing = EXECUTING_STATUSES.has(task.status) || EXECUTING_STATUSES.has(updates.status) || open.length > 0;
        const phase = executing ? 'executing' : TERMINAL_STATUSES.has(task.status) ? 'after_execution' : PAUSED_STATUSES.has(task.status) ? 'suspended' : 'before_execution';
        return { phase, executing, status: task.status ?? null, ...(updates.status !== undefined && updates.status !== task.status ? { next_status: updates.status } : {}),
            task_version: task.version ?? null, open_dispatches: open };
    }
    function normalizeOrigin(origin) {
        const given = object(origin);
        const kind = ORIGIN_KINDS.has(given.kind) ? given.kind : 'unverified';
        const result = { kind, authority: typeof given.authority === 'string' ? given.authority : null,
            requester: typeof given.requester === 'string' ? given.requester : 'unauthenticated' };
        if (normalized(given.reason)) result.reason = String(given.reason).trim().slice(0, 2000);
        if (given.decision_ref) result.decision_ref = given.decision_ref;
        if (Array.isArray(given.fields)) result.declared_fields = given.fields.filter(f => typeof f === 'string');
        // A verified origin is a credential checked by the route, never a label in the payload.
        if (AUTHORIZING_ORIGINS.has(kind) && !result.authority) throw fail('A verified operator origin requires a checked authority', 403, 'contract_change_unverified');
        if (kind === 'operator_relayed' && !result.decision_ref) throw fail('A relayed operator decision needs the decision it relays', 400, 'contract_change_invalid');
        return result;
    }
    // References Nexus can check are checked here against the task's own
    // record; a runtime attestation stays labelled as such and never verified.
    function verifyDecisionRef(task, previous, ref) {
        const given = object(ref);
        if (given.kind === 'operator_ruling') {
            const index = given.index, rulings = rulingEntries(object(task.antigravity_payload).operator_rulings);
            if (!Number.isInteger(index) || index < 0 || typeof given.sha256 !== 'string') throw fail('operator_ruling reference needs index and sha256', 400, 'contract_change_invalid');
            if (rulings[index] === undefined || sha256(rulings[index]) !== given.sha256.toLowerCase()) {
                throw fail('Referenced operator ruling is not recorded on this task', 409, 'decision_ref_mismatch');
            }
            const cited = given.sha256.toLowerCase(), answers = previous?.operator_answers || [];
            const answer = answers.find(entry => entry.index === index && entry.sha256 === cited) || answers.find(entry => entry.index === index);
            // While a rewrite of the rulings is on record, adjudicated or not, a
            // relayed decision is grounded only in what Robert recorded: the
            // words the concern recorded, or an answer appended since under his
            // credential or the runtime's. The text an executor put on the row
            // is not his decision, whichever index it sits at.
            const review = (previous?.concerns || []).filter(concern => concern.kind === 'rulings_rewrite');
            if (review.length) {
                const recordedWords = review.some(concern => (Array.isArray(concern.recorded) ? concern.recorded : []).includes(cited));
                const vouched = answers.some(entry => entry.index === index && entry.sha256 === cited && VOUCHED_ANSWER_ORIGINS.has(entry.origin));
                if (!recordedWords && !vouched) {
                    const concern = review.find(item => (Array.isArray(item.rewritten) ? item.rewritten : []).includes(cited)) || review[review.length - 1];
                    throw fail('Referenced operator ruling was written by an unverified source and is under review; it is not a decision Robert recorded', 409, 'decision_ref_under_review', { concern_key: concern.key });
                }
            }
            return { kind: 'operator_ruling', index, sha256: cited, verified: true, verification: 'operator_ruling_sha256',
                ...(answer?.recorded_at ? { recorded_at: answer.recorded_at } : {}), ...(answer?.origin && answer.sha256 === cited ? { recorded_by: answer.origin } : {}) };
        }
        if (given.kind === 'document_decision') {
            if (!normalized(given.id)) throw fail('document_decision reference needs id', 400, 'contract_change_invalid');
            const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_document_decisions'").get();
            const row = exists ? db.prepare('SELECT id, document_id, revision_id, content_hash, decision, authority, created_at FROM review_document_decisions WHERE id = ?').get(String(given.id)) : null;
            if (!row) throw fail('Referenced document decision is not recorded', 409, 'decision_ref_mismatch');
            return { kind: 'document_decision', id: row.id, document_id: row.document_id, revision_id: row.revision_id, content_hash: row.content_hash,
                decision: row.decision, authority: row.authority, decided_at: row.created_at, verified: true, verification: 'review_document_decisions' };
        }
        if (['chat_instruction', 'inbox_answer', 'questionnaire'].includes(given.kind)) {
            if (!normalized(given.id) || !normalized(given.instruction)) throw fail(`${given.kind} reference needs id and the instruction text`, 400, 'contract_change_invalid');
            return { kind: given.kind, id: String(given.id).slice(0, 200), instruction: String(given.instruction).trim().slice(0, 4000),
                ...(normalized(given.instructed_at) ? { instructed_at: String(given.instructed_at) } : {}), verified: false, verification: 'runtime_attested' };
        }
        throw fail('Unsupported decision reference kind', 400, 'contract_change_invalid');
    }
    const fieldDiff = (beforeHashes, afterHashes, beforeRaw, afterRaw, { values = false } = {}) => [...new Set([...Object.keys(beforeHashes), ...Object.keys(afterHashes)])].sort()
        .filter(field => beforeHashes[field] !== afterHashes[field])
        .map(field => ({ field, before_sha256: beforeHashes[field] ?? null, after_sha256: afterHashes[field] ?? null,
            ...(values ? { ...(beforeRaw && field in beforeRaw ? { before: beforeRaw[field] } : {}), ...(field in afterRaw ? { after: afterRaw[field] } : {}) } : {}) }));
    function appendChange(previous, entry) {
        const history = [...(previous?.contract_changes || []), entry];
        let dropped = previous?.contract_changes_dropped || 0;
        while (history.length > CONTRACT_CHANGE_HISTORY) {
            const index = history.findIndex(item => !(item.outcome === 'held' && !item.resolution));
            if (index < 0) break;
            history.splice(index, 1); dropped++;
        }
        return { contract_changes: history, ...(dropped ? { contract_changes_dropped: dropped } : {}) };
    }
    const priorDecision = receipt => Object.fromEntries(['decision', 'reason', 'resolved_at', 'authority', 'evidence', 'remaining_scope', 'repeat_id']
        .filter(key => receipt?.[key] !== undefined).map(key => [key, receipt[key]]));
    const sameEntries = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => entry === right[index]);
    function appendRulingsChange(previous, entry) {
        const history = [...(previous?.rulings_changes || []), entry];
        let dropped = previous?.rulings_changes_dropped || 0;
        while (history.length > CONTRACT_CHANGE_HISTORY) { history.shift(); dropped++; }
        return { rulings_changes: history, ...(dropped ? { rulings_changes_dropped: dropped } : {}) };
    }
    /**
     * Rulings are Robert's recorded words, not contract fields. A rewrite or
     * removal by anyone else is a durable concern of its own, so no drift
     * decision, return or executor revert can clear it: it ends by its own
     * resolution (/work-admission/resolve with evidence), or by Robert himself,
     * under his credential, rewriting the rulings or putting his recorded
     * words back (exactly, or followed by new answers; the row he restores
     * from may be empty). An answer he appends on top of an executor's text
     * decides nothing about that text. Putting his words back without his
     * credential adds no second concern and clears nothing. A relayed decision
     * is about contract fields, not about what he said, so it is held like any
     * other. An append by anyone is an answer (444a0be0), never a concern.
     */
    function rulingsConcernsFor({ previous, task, updates, origin, recorded, rulings, rewritten }) {
        const concerns = previous?.concerns || [];
        const unchanged = { concerns, history: {}, cleared: false, restores: false };
        if (sameEntries(recorded, rulings)) return unchanged;
        const before = recorded.map(sha256), after = rulings.map(sha256), recordedAt = new Date(now()).toISOString();
        const open = concerns.filter(concern => concern.kind === 'rulings_rewrite');
        // Robert's words are what the earliest open concern recorded. A chained
        // rewrite is measured against them, never against the executor's own
        // earlier text, and only his words coming back is a restore.
        const authorized = open.length && Array.isArray(open[0].recorded) ? open[0].recorded : before;
        const entry = { recorded_at: recordedAt, task_version: task.version ?? null, before, after,
            origin: { kind: origin.kind, authority: origin.authority, requester: origin.requester } };
        if (origin.kind === 'operator') {
            // His recorded words back at the front of the row, whatever the
            // executor had left there, possibly followed by his new answers.
            const restores = open.length > 0 && after.length >= authorized.length && authorized.every((sha, index) => after[index] === sha);
            if (!open.length || (!rewritten && !restores)) return unchanged;
            return { concerns: concerns.filter(concern => concern.kind !== 'rulings_rewrite'), cleared: true, restores,
                history: appendRulingsChange(previous, { ...entry, outcome: 'authorized', cleared_concern_keys: open.map(concern => concern.key), ...(restores ? { restores_recorded: true } : {}) }) };
        }
        if (!rewritten) return unchanged;
        if (open.length && sameEntries(authorized, after)) {
            return { concerns, cleared: false, restores: true,
                history: appendRulingsChange(previous, { ...entry, outcome: 'held', concern_key: open[0].key, restores_recorded: true }) };
        }
        const concern = { key: digest({ rulings_rewrite: { task: task.id ?? null, before: authorized, after } }), kind: 'rulings_rewrite', reason: RULINGS_REWRITE_REASON,
            recorded: authorized, rewritten: after, recorded_at: recordedAt, task_version: task.version ?? null,
            origin: origin.kind, requester: origin.requester, phase: executionPhase(task, updates).phase };
        return { concerns: concerns.some(item => item.key === concern.key) ? concerns : [...concerns, concern], cleared: false, restores: false,
            history: appendRulingsChange(previous, { ...entry, outcome: 'held', concern_key: concern.key }) };
    }
    /**
     * Classify one write of the governed contract. `before` is the stored row,
     * `after` the row this write produces, `previous` the receipt in force.
     * Returns the next receipt body (without overlap inspection) and the
     * recorded entry, or null when nothing governed changed.
     */
    function classifyContractChange({ before, after, previous, origin, execution, unattributed = false }) {
        const beforeFields = governedFields(before), afterFields = governedFields(after);
        const baseline = previous.contract || authorizedBaseline(beforeFields, 1, { origin: 'legacy', authority: null, basis: 'receipt_without_contract' }, { fingerprint: previous.fingerprint });
        // An unattributed change (a write that bypassed the guard) is measured
        // against the baseline itself; the values it replaced are unknown.
        const written = unattributed ? fieldDiff(baseline.fields, afterFields.hashes) : fieldDiff(beforeFields.hashes, afterFields.hashes, beforeFields.raw, afterFields.raw);
        // A relayed decision is checked even when the write changes nothing
        // governed; a bogus reference never rides a no-op or a rulings edit.
        const decisionRef = origin.decision_ref ? verifyDecisionRef(before, previous, origin.decision_ref) : undefined;
        if (!written.length) return null;
        const authorizing = AUTHORIZING_ORIGINS.has(origin.kind);
        if (authorizing && origin.declared_fields) {
            const undeclared = written.map(change => change.field).filter(field => !origin.declared_fields.includes(field));
            if (undeclared.length) throw fail('This write changes contract fields the relayed decision did not declare; send them as a separate unverified edit', 409, 'contract_change_mixed', { undeclared_fields: undeclared });
        }
        const recordedOrigin = { kind: origin.kind, authority: origin.authority, requester: origin.requester,
            ...(origin.reason ? { reason: origin.reason } : {}), ...(decisionRef ? { decision_ref: decisionRef } : {}) };
        const recordedAt = new Date(now()).toISOString();
        const hold = previous.contract_hold ? { ...previous.contract_hold, authorized_values: { ...previous.contract_hold.authorized_values }, change_ids: [...previous.contract_hold.change_ids] } : null;
        const authorizedBy = extra => ({ origin: recordedOrigin.kind, authority: recordedOrigin.authority, requester: recordedOrigin.requester,
            ...(recordedOrigin.reason ? { reason: recordedOrigin.reason } : {}), ...(decisionRef ? { decision_ref: decisionRef } : {}), ...extra });
        let contract = baseline, outcome, resolvedEntries = [];
        if (authorizing) {
            outcome = 'authorized';
            contract = authorizedBaseline({ ...baseline.fields, ...Object.fromEntries(written.map(c => [c.field, c.after_sha256])) }, baseline.version + 1, authorizedBy({ basis: 'operator_change' }));
        } else if (!execution.executing && !hold) {
            // Nobody has executed against the previous reading; the next
            // dispatch admits the task against this contract. Once a hold is
            // open the baseline moves only by Robert's decision, whatever the
            // phase of the write that follows.
            outcome = 'recorded';
            contract = authorizedBaseline(afterFields, baseline.version + 1, authorizedBy({ basis: 'edited_outside_execution', phase: execution.phase }));
        } else {
            outcome = 'held';
        }
        const driftedNow = fieldDiff(contract.fields, afterFields.hashes).map(change => change.field);
        let nextHold = hold;
        if (driftedNow.length) {
            // `prior` keeps the pre-drift decision with the comparison it was
            // made against, so a later approve or return can tell whether the
            // same compared owners still stand.
            nextHold = hold || { since: recordedAt, change_ids: [], drifted_fields: [], authorized_values: {},
                prior: { ...priorDecision(previous), relevant_hash: previous.relevant_hash, fingerprint: previous.fingerprint,
                    concern_keys: (previous.concerns || []).map(concern => concern.key) } };
            // A field keeps the value it had the moment it first drifted; that
            // value is the authorized one, because every undrifted field hashes
            // to the baseline.
            for (const field of driftedNow) if (!(field in nextHold.authorized_values) && field in beforeFields.raw && beforeFields.hashes[field] === contract.fields[field]) nextHold.authorized_values[field] = beforeFields.raw[field];
            for (const field of Object.keys(nextHold.authorized_values)) if (!driftedNow.includes(field)) delete nextHold.authorized_values[field];
            nextHold.drifted_fields = driftedNow;
        } else if (hold) {
            nextHold = null;
            resolvedEntries = hold.change_ids;
        }
        // A write is held only when what it wrote is drift. Undoing drift, or
        // touching already-held fields back toward the baseline, is recorded.
        if (outcome === 'held' && !written.some(change => driftedNow.includes(change.field))) outcome = 'recorded';
        // A hold clears either because the fields are back at the authorized
        // reading, or because Robert's own edit made a new reading authoritative.
        const restoresBaseline = Boolean(hold && !nextHold && contract.hash === baseline.hash);
        const clearedBy = hold && !nextHold ? (restoresBaseline ? 'reverted_by_edit' : 'superseded_by_authorized_edit') : null;
        const entry = { id: `change-${digest({ task: before.id, version: before.version, recordedAt, written }).slice(0, 16)}`, recorded_at: recordedAt, task_version: before.version ?? null,
            fields: outcome === 'held' ? fieldDiff(unattributed ? baseline.fields : beforeFields.hashes, afterFields.hashes, unattributed ? null : beforeFields.raw, afterFields.raw, { values: true }) : written,
            origin: recordedOrigin, execution, outcome, contract_version: contract.version, ...(restoresBaseline ? { restores_baseline: true } : {}) };
        if (outcome === 'held' && nextHold) nextHold.change_ids = [...new Set([...nextHold.change_ids, entry.id])];
        const history = appendChange(previous, entry);
        if (resolvedEntries.length) history.contract_changes = history.contract_changes.map(item => resolvedEntries.includes(item.id) && !item.resolution
            ? { ...item, resolution: { decision: clearedBy, recorded_at: recordedAt, by: recordedOrigin } } : item);
        if (nextHold) contract.fingerprint = null; else contract.fingerprint = afterFields.fingerprint;
        return { contract, hold: nextHold, history, entry, outcome, baselineAdvanced: contract.version !== baseline.version };
    }
    function identityKey(task, repeat) {
        const c = contract(task);
        // A title is a retrieval signal, never exact-identity authority. A
        // declared identity is still bound to scope/acceptance/workspace/run.
        if (!c.proposal_id && !c.description && !c.scope && !Object.keys(c.payload).length) return null;
        return digest({ ...c, ...(c.proposal_id ? { name: null } : {}), repeat_id: repeat?.repeat_id || null });
    }
    const stopWords = new Set('the and for with task work before after from that this into only have when then been what where which must will should can could would use using does done all any how was are but its our their they them you your each through across existing current record'.split(' '));
    const tokens = text => new Set((normalized(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
        .filter(word => !stopWords.has(word))
        .map(word => word.replace(/(?:ations?|ions?|ing|ed|es|s)$/, '').replace(/e$/, '')));
    // These generated appendices contain a whole ingestion batch or universal
    // instructions, not the requested outcome. Only retrieval drops them: the
    // full contract, fingerprint and evidence supplied for review stay intact.
    const requestedText = text => normalized(text).split(/(?:Evidence \(overnight ingestion \d{4}-\d{2}-\d{2}\):|### Binding constraints — prerequisite)/)[0];
    const scopeText = c => [requestedText(c.description), JSON.stringify(c.scope), JSON.stringify(c.acceptance),
        requestedText(c.payload.prompt), ...['scope', 'target_files', 'declared_paths', 'commands', 'constraints'].map(key => JSON.stringify(c.payload[key]))].join(' ');
    function corpusWeights(documents) {
        const frequency = new Map();
        for (const document of documents) for (const word of new Set([...document.scopeTokens, ...document.titleTokens])) {
            frequency.set(word, (frequency.get(word) || 0) + 1);
        }
        return new Map([...frequency].map(([word, count]) => [word, Math.log1p((documents.length + 1) / (count + 1)) ** 2]));
    }
    function cosine(a, b, weights) {
        let dot = 0, left = 0, right = 0, common = 0;
        for (const word of a) {
            const weight = weights.get(word) || 0;
            left += weight;
            if (b.has(word)) { dot += weight; common++; }
        }
        for (const word of b) right += weights.get(word) || 0;
        return { similarity: left && right ? dot / Math.sqrt(left * right) : 0, common };
    }
    function score(left, right, weights) {
        const scope = cosine(left.scopeTokens, right.scopeTokens, weights);
        const title = cosine(left.titleTokens, right.titleTokens, weights);
        // Cosine penalizes a small generic subset of a much larger contract;
        // document frequency downweights shared boilerplate. Strong scope can
        // retrieve a renamed/paraphrased outcome without requiring its title.
        if (scope.common >= 3 && (scope.similarity >= 0.7 || scope.similarity >= 0.38 && title.similarity >= 0.3)) {
            return scope.similarity + title.similarity * 0.2;
        }
        // Legacy title-only items remain review candidates, never merges.
        if ((!left.scopeTokens.size || !right.scopeTokens.size) && left.titleTokens.size &&
            left.titleTokens.size === right.titleTokens.size && title.common === left.titleTokens.size) return 0.4;
        return 0;
    }
    function distinctRuns(a, b) {
        const left = object(a.recurrence), right = object(b.recurrence);
        return left.run_id && right.run_id && left.observation_window && right.observation_window &&
            left.run_id !== right.run_id && JSON.stringify(left.observation_window) !== JSON.stringify(right.observation_window);
    }
    function inspect(task, concerns = []) {
        const c = contract(task), fingerprint = digest(c);
        try {
            const dataVersion = db.pragma('data_version', { simple: true });
            if (cacheDataVersion !== dataVersion || snapshotCache.size > 5000) snapshotCache.clear();
            cacheDataVersion = dataVersion;
            const projectPath = db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id)?.path || '';
            const snapshot = row => {
                const cached = snapshotCache.get(row.id);
                if (cached?.task.version === row.version && cached.projectPath === projectPath) return cached;
                const full = lookup ? row : db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
                const scope = contract(full, projectPath);
                const result = { task: full, contract: scope, projectPath, fingerprint: digest(scope),
                    evidence_hash: digest([full.walkthrough, full.research_output, full.plan_output]),
                    scopeTokens: tokens(scopeText(scope)), titleTokens: tokens(scope.name) };
                snapshotCache.set(row.id, result);
                return result;
            };
            // Cheap version scan covers retained history. Reuse lexical/hash
            // snapshots until the database revision or project workspace changes.
            const rows = lookup ? lookup(task.project_id) : db.prepare('SELECT id, version FROM tasks WHERE project_id = ? AND id != ?').all(task.project_id, task.id || '');
            if (!Array.isArray(rows)) throw new Error('Invalid lookup response');
            const candidates = rows.filter(t => t.id !== task.id).map(snapshot)
                .filter(t => t.contract.workspace === c.workspace);
            // Receipt refreshes, sort order and activity stamps do not change
            // the compared work. Including the row revision here would make
            // two related receipts invalidate one another forever.
            const coverage_hash = digest(candidates.map(({ task: t, fingerprint: fp, evidence_hash }) => [t.id, fp, t.status, t.archived_at,
                evidence_hash]).sort((a, b) => a[0].localeCompare(b[0])));
            const explicit = new Set(concerns.map(x => x.existing_task_id).filter(Boolean));
            const wanted = { scopeTokens: tokens(scopeText(c)), titleTokens: tokens(c.name) };
            const weights = corpusWeights([...candidates, wanted]);
            const relevant = candidates.filter(t => !distinctRuns(c, t.contract)).map(candidate => {
                const t = candidate.task;
                return { task_id: t.id, task_version: t.version, status: t.status, title: t.name,
                    fingerprint: candidate.fingerprint, score: explicit.has(t.id) ? 2 : score(wanted, candidate, weights),
                    evidence_hash: candidate.evidence_hash };
            }).filter(t => t.score > 0).sort((a, b) => b.score - a.score || a.task_id.localeCompare(b.task_id));
            const relevant_hash = digest(relevant.map(({task_id,fingerprint,status,evidence_hash})=>({task_id,fingerprint,status,evidence_hash}))
                .sort((left, right) => left.task_id.localeCompare(right.task_id)));
            const matches = relevant.slice(0,3);
            return { fingerprint, retrieval_version: RETRIEVAL_VERSION, matches, relevant_hash, coverage_hash, coverage: { project_id: task.project_id, workspace: c.workspace,
                searched_count: candidates.length, relevant_count: relevant.length, retained_history: true, shortlist_limit: 3 }, lookup_failed: false };
        } catch (error) {
            return { fingerprint, retrieval_version: RETRIEVAL_VERSION, matches: [], coverage_hash: null, coverage: { project_id: task.project_id, workspace: c.workspace,
                retained_history: true, shortlist_limit: 3, error: 'lookup_unavailable' }, lookup_failed: true };
        }
    }
    function baseReceipt(task, concerns = [], previous, { contract: baseline, basis = 'admitted_contract' } = {}) {
        const inspected = inspect(task, concerns);
        const decision = inspected.lookup_failed || inspected.matches.length || concerns.length ? 'needs_evidence' : 'new_work';
        // The authorized baseline is history, not a comparison result: it
        // survives every re-inspection. Without one, the task as it stands is
        // the authorized reading (new receipts, and receipts older than this field).
        const contract = baseline || previous?.contract || authorizedBaseline(governedFields(task), 1, { origin: previous ? 'legacy' : 'proposal', authority: null, basis: previous ? 'receipt_without_contract' : basis }, { fingerprint: inspected.fingerprint });
        // An open rulings rewrite names itself whenever admission is recomputed;
        // it is not a duplicate concern and must not read like one.
        const rulingsGate = concerns.filter(concern => concern.kind === 'rulings_rewrite').at(-1);
        return { schema_version: 1, ...inspected, decision, checked_at: new Date(now()).toISOString(), owner: 'work-admission', concerns,
            reason: inspected.lookup_failed ? 'Project lookup unavailable; evidence review is required.' :
                rulingsGate ? rulingsGate.reason :
                    concerns.length ? 'A duplicate concern requires a bounded evidence comparison.' :
                        inspected.matches.length ? 'Possible scope overlap requires a bounded evidence comparison.' : 'No relevant overlap found within recorded project/workspace coverage.',
            ...(previous ? { previous_decision: previous.decision } : {}),
            ...(previous?.operator_answers ? { operator_answers: previous.operator_answers } : {}),
            contract, ...(previous?.contract_changes ? { contract_changes: previous.contract_changes } : {}),
            ...(previous?.contract_changes_dropped ? { contract_changes_dropped: previous.contract_changes_dropped } : {}),
            ...(previous?.rulings_changes ? { rulings_changes: previous.rulings_changes } : {}),
            ...(previous?.rulings_changes_dropped ? { rulings_changes_dropped: previous.rulings_changes_dropped } : {}) };
    }
    // A manual overlap resolution stays valid across an authorized contract
    // change when the compared owners and their evidence are unchanged.
    // A resolution adjudicated exactly the concerns recorded when it was made,
    // so it is carried only while no new concern (explicit or reopen) has
    // joined the receipt since; a newer concern is decided fresh.
    function carryResolution(receipt, previous) {
        if (!previous?.resolved_at || receipt.lookup_failed || !previous.relevant_hash || previous.relevant_hash !== receipt.relevant_hash) return receipt;
        const adjudicated = new Set(previous.concern_keys ?? (previous.concerns || []).map(concern => concern.key));
        if ((receipt.concerns || []).some(concern => !adjudicated.has(concern.key))) return receipt;
        return { ...receipt, ...priorDecision(previous), resolution_carried_from: previous.fingerprint };
    }
    // A held receipt names its hold; when Robert's rulings were also rewritten,
    // it names both, on every path that writes or re-reads it.
    const holdReason = receipt => {
        const gate = (receipt.concerns || []).filter(concern => concern.kind === 'rulings_rewrite').at(-1);
        return gate ? `${CONTRACT_DRIFT_REASON} ${gate.reason}` : CONTRACT_DRIFT_REASON;
    };
    const withHold = (receipt, hold) => hold
        ? { ...receipt, decision: 'needs_evidence', reason: holdReason(receipt), hold_kind: 'contract_drift', contract_hold: hold }
        : (({ hold_kind, contract_hold, ...rest }) => rest)(receipt);
    function save(task, receipt, { mutation = false } = {}) {
        db.prepare('INSERT INTO work_admissions (task_id, document) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document').run(task.id, JSON.stringify(receipt));
        // Ordinary reads refresh the authoritative receipt projection without
        // manufacturing a task edit. Explicit decisions/concerns remain CAS
        // protected task mutations and bump the normal task version.
        if (mutation) {
            const metadata = { ...object(task.metadata), work_admission: receipt };
            db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), task.id);
        }
        return readTask(task.id);
    }
    function admit(input, insert, options = {}) {
        return db.transaction(() => {
            const repeat = options.repeat;
            if (repeat && options.authority !== 'operator_credential') throw fail('Trusted operator repeat authority required', 403);
            if (repeat && (!normalized(repeat.repeat_id) || !normalized(repeat.reason))) throw fail('Repeat requires repeat_id and reason', 400);
            const task = { ...input, metadata: { ...object(input.metadata) } };
            delete task.metadata.work_admission;
            const identity = identityKey(task, repeat);
            const reserved = identity && db.prepare('SELECT task_id FROM work_admissions WHERE identity_key = ?').get(identity);
            if (reserved) {
                const owner = readTask(reserved.task_id);
                if (identityKey(owner, repeat) !== identity) throw fail(`Reserved task ${owner.id} changed scope; reconcile it before retrying this proposal`);
                return owner;
            }
            const existing = task.id && db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id);
            if (existing) {
                if (digest(contract(readTask(task.id))) !== digest(contract(task))) throw fail('Task id already owns a different proposal contract');
                return readTask(task.id);
            }
            const receipt = baseReceipt(task);
            if (repeat && !receipt.lookup_failed) Object.assign(receipt, { decision: 'new_work', reason: repeat.reason,
                authority: options.authority, repeat_id: repeat.repeat_id });
            task.metadata.work_admission = receipt;
            insert(task);
            // Creation already includes metadata; avoid an artificial task version.
            db.prepare('INSERT INTO work_admissions (task_id, identity_key, document) VALUES (?, ?, ?)').run(task.id, identity, JSON.stringify(receipt));
            return readTask(task.id);
        }).immediate();
    }
    function current(id) {
        return db.transaction(() => {
            let task = readTask(id), previous = readReceipt(id);
            const inspected = inspect(task, previous?.concerns || []);
            if (previous && previous.fingerprint !== inspected.fingerprint && previous.fingerprint === legacyFingerprint(task)) {
                task = save(task, { ...previous, fingerprint: inspected.fingerprint, legacy_fingerprint: previous.fingerprint });
                previous = task.metadata.work_admission;
            }
            if (previous && !previous.contract) {
                // Receipts written before contract baselines existed: the task
                // as stored is the only authorized reading Nexus can attest to.
                task = save(task, { ...previous, contract: authorizedBaseline(governedFields(task), 1, { origin: 'legacy', authority: null, basis: 'receipt_without_contract' }, { fingerprint: inspected.fingerprint }) });
                previous = task.metadata.work_admission;
            } else if (previous && previous.fingerprint !== inspected.fingerprint) {
                // A write reached the row without passing the guard. Nexus
                // records that honestly as an unattributed change.
                const origin = normalizeOrigin({ kind: 'unverified', requester: 'unattributed_write' });
                const change = classifyContractChange({ before: task, after: task, previous, execution: executionPhase(task), unattributed: true, origin });
                if (change) {
                    const receipt = withHold(carryIf(change, baseReceipt(task, previous.concerns || [], previous, { contract: change.contract }), previous), change.hold);
                    task = save(task, { ...receipt, ...change.history });
                    previous = task.metadata.work_admission;
                } else if (previous.contract_hold && governedFields(task).hash === previous.contract.hash) {
                    // The row is back at the authorized contract, again without
                    // passing the guard: nothing is left for Robert to decide.
                    const resolution = { decision: 'reverted_by_edit', recorded_at: new Date(now()).toISOString(), by: origin };
                    const history = (previous.contract_changes || []).map(item => previous.contract_hold.change_ids.includes(item.id) && !item.resolution ? { ...item, resolution } : item);
                    const refreshed = carryResolution(baseReceipt(task, previous.concerns || [], previous, { contract: { ...previous.contract, fingerprint: inspected.fingerprint } }), previous.contract_hold.prior);
                    task = save(task, withHold({ ...refreshed, contract_changes: history }, null));
                    previous = task.metadata.work_admission;
                }
            }
            const unchangedRelevantEvidence = previous?.resolved_at && previous.fingerprint === inspected.fingerprint && previous.relevant_hash && previous.relevant_hash === inspected.relevant_hash;
            if (previous && previous.retrieval_version === inspected.retrieval_version && previous.fingerprint === inspected.fingerprint && (previous.coverage_hash === inspected.coverage_hash || unchangedRelevantEvidence) && !inspected.lookup_failed) {
                const expired = !previous.resolved_at && now() - Date.parse(previous.checked_at) > RESOLUTION_WINDOW_MS;
                if (!expired && previous.coverage_hash === inspected.coverage_hash && JSON.stringify(previous.matches) === JSON.stringify(inspected.matches)) return task;
                return save(task, { ...previous, matches: inspected.matches, relevant_hash: inspected.relevant_hash, coverage_hash: inspected.coverage_hash, coverage: inspected.coverage,
                    ...(expired ? { checked_at: new Date(now()).toISOString() } : {}) });
            }
            // A re-inspection (retrieval version, lookup failure) never clears an open drift hold.
            const refreshed = baseReceipt(task, previous?.concerns || [], previous);
            return save(task, previous?.contract_hold ? withHold(refreshed, previous.contract_hold) : refreshed);
        }).immediate();
    }
    // Carry a manual overlap resolution only across changes that did not
    // alter the authorized baseline in an unverified way: an authorized edit
    // keeps Robert's prior decision, a pre-execution edit by anyone else is a
    // fresh proposal that admission compares again.
    const carryIf = (change, receipt, previous) => {
        // Drift undone, by its author or by Robert: the pre-drift decision applies again when the compared owners still stand.
        if (previous?.contract_hold && !change.hold) return carryResolution(receipt, previous.contract_hold.prior);
        return change.outcome === 'authorized' || (!change.baselineAdvanced && !change.hold) ? carryResolution(receipt, previous) : receipt;
    };
    /**
     * Guard one task write. `context.origin` is the route's verified reading of
     * who is writing: Robert's session or operator credential, a Praxis relay
     * of his recorded decision, the runtime itself, or nothing provable.
     * Robert's own contract changes advance the authorized baseline at any
     * phase; anyone else's are recorded before or after execution and held,
     * with the diff, while an executor or QA session can be reading the brief.
     */
    function guardUpdate(task, updates, context = {}) {
        const previous = readReceipt(task.id);
        const origin = normalizeOrigin(context.origin);
        const reopening = TERMINAL_STATUSES.has(task.status) && updates.status !== undefined && !TERMINAL_STATUSES.has(updates.status);
        if (!previous && !reopening) {
            // No receipt to govern, but a relayed decision is still checked: a
            // bogus reference never lands anywhere.
            if (origin.decision_ref) verifyDecisionRef(task, previous, origin.decision_ref);
            if (updates.metadata !== undefined) {
                updates.metadata = { ...object(updates.metadata) }; delete updates.metadata.work_admission;
            }
            return updates;
        }
        // Generic metadata writers may neither clear a hold nor swap the
        // proposal identity. Scope edits invalidate the server-owned decision.
        const metadata = { ...object(updates.metadata === undefined ? task.metadata : updates.metadata) };
        const priorMetadata = object(task.metadata);
        if (priorMetadata.work_identity) metadata.work_identity = priorMetadata.work_identity;
        const after = { ...task, ...updates, metadata };
        const fingerprint = digest(contract(after));
        // Appending an answer keeps admission; rewriting or removing a recorded
        // ruling is an edit of what the executor and QA were told, not an answer,
        // unless Robert himself rewrote it.
        const recorded = rulingEntries(object(task.antigravity_payload).operator_rulings);
        const rulings = updates.antigravity_payload === undefined ? recorded : rulingEntries(object(updates.antigravity_payload).operator_rulings);
        const rewritten = recorded.some((entry, index) => rulings[index] !== entry);
        // Each appended answer records who appended it: an entry Robert or the
        // runtime recorded is an authenticated addition a relay may cite; an
        // executor's is recorded as such and grounds nothing (verifyDecisionRef).
        const answers = [...(previous?.operator_answers || []), ...(rewritten ? [] : rulings.slice(recorded.length).map((entry, offset) => ({
            index: recorded.length + offset, sha256: sha256(entry), recorded_at: new Date(now()).toISOString(), origin: origin.kind, requester: origin.requester })))];
        const audit = answers.length ? { operator_answers: answers } : {};
        // A rewrite by anyone but Robert joins the receipt as a durable concern
        // (rulingsConcernsFor); his own rewrite clears an open one.
        const rulingsNow = rulingsConcernsFor({ previous, task, updates, origin, recorded, rulings, rewritten });
        let next;
        // Only Robert himself may rewrite a recorded ruling without a hold; a
        // relayed decision is about contract fields, not about what he said.
        if (reopening || (rewritten && origin.kind !== 'operator')) {
            const concerns = [...rulingsNow.concerns];
            if (reopening) concerns.push({ key: digest({ terminal_reopen: task.status, version: task.version }),
                reason: `Task reopened from ${task.status}; retained prior work requires fresh evidence or an explicitly reasoned repeat.` });
            const change = previous ? classifyContractChange({ before: task, after, previous, origin, execution: executionPhase(task, updates) }) : null;
            let body = { ...baseReceipt(after, concerns, previous, change ? { contract: change.contract } : {}), ...audit, ...(change ? change.history : {}), ...rulingsNow.history };
            // An open drift hold survives a reopen or a rulings rewrite in the same write.
            const hold = change ? change.hold : previous?.contract_hold;
            // Robert's recorded words coming back exactly reopens nothing: a
            // resolution already recorded for that concern stays in force.
            if (!reopening && rulingsNow.restores && !hold) body = carryResolution(body, previous);
            next = hold ? withHold(body, hold) : body;
            // The reopen reason names the hold a reviewer must clear first; a
            // rewrite names itself (withHold names both holds when drift is open).
            if (reopening) { next.decision = 'needs_evidence'; next.reason = concerns[concerns.length - 1].reason; }
            else if (!hold && !next.resolved_at) { next.decision = 'needs_evidence'; next.reason = RULINGS_REWRITE_REASON; }
        } else {
            const change = classifyContractChange({ before: task, after, previous, origin, execution: executionPhase(task, updates) });
            if (change) {
                const receipt = baseReceipt(after, rulingsNow.concerns, previous, { contract: change.contract });
                next = { ...withHold(carryIf(change, receipt, previous), change.hold), ...audit, ...change.history, ...rulingsNow.history };
            } else if (rulingsNow.cleared) {
                // Robert rewrote his ruling himself: the executor's rewrite is
                // superseded and admission is recomputed without that concern.
                // An open drift hold is a separate matter and stays.
                next = { ...withHold(carryResolution(baseReceipt(after, rulingsNow.concerns, previous), previous), previous.contract_hold || null), ...audit, ...rulingsNow.history };
            } else if (fingerprint !== previous.fingerprint || answers.length !== (previous.operator_answers || []).length) {
                // A legacy receipt whose fingerprint predates the current reading, or an appended answer.
                next = { ...previous, ...audit, ...(fingerprint !== previous.fingerprint ? { fingerprint, legacy_fingerprint: previous.fingerprint } : {}) };
            }
        }
        if (next) db.prepare('INSERT INTO work_admissions (task_id, document) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document').run(task.id, JSON.stringify(next));
        metadata.work_admission = next || previous;
        return { ...updates, metadata };
    }
    function requireVersion(task, input) {
        if (!Number.isSafeInteger(input.expected_task_version) || input.expected_task_version !== task.version) throw fail('Task changed since admission was read');
    }
    function concerns(id, input, authority) {
        if (authority !== 'runtime_credential') throw fail('Trusted runtime credential required', 403);
        return db.transaction(() => {
            const task = current(id); requireVersion(task, input);
            if (!Array.isArray(input.concerns) || input.concerns.length < 1 || input.concerns.length > 3 ||
                input.concerns.some(c => !normalized(c.reason))) throw fail('Provide one to three reasoned duplicate concerns', 400);
            const previous = readReceipt(id), merged = [...(previous.concerns || [])];
            for (const concern of input.concerns) {
                const value = { reason: normalized(concern.reason), ...(concern.existing_task_id ? { existing_task_id: String(concern.existing_task_id) } : {}),
                    ...(concern.seat_id ? { seat_id: String(concern.seat_id) } : {}) };
                value.key = digest({ reason: value.reason, existing_task_id: value.existing_task_id });
                if (!merged.some(c => c.key === value.key)) merged.push(value);
            }
            if (merged.length === (previous.concerns || []).length) return task;
            // A new concern joins an open drift hold; it does not replace it.
            const receipt = withHold(baseReceipt(task, merged, previous), previous.contract_hold || null);
            return save(task, receipt, { mutation: true });
        }).immediate();
    }
    function resolve(id, input, authority) {
        if (authority !== 'runtime_credential' && authority !== 'operator_credential') throw fail('Trusted admission credential required', 403);
        return db.transaction(() => {
            const task = current(id); requireVersion(task, input);
            const previous = readReceipt(id);
            // Overlap evidence cannot stand in for Robert's decision on drift.
            if (holdOpen(previous)) throw fail('A contract drift hold is open; decide it through /work-admission/contract first', 409, 'contract_hold_open');
            if (input.fingerprint !== previous.fingerprint || input.checked_at !== previous.checked_at ||
                now() - Date.parse(input.checked_at) > RESOLUTION_WINDOW_MS || Date.parse(input.checked_at) > now()) throw fail('Admission comparison expired or changed; refresh before resolving');
            if (!DECISIONS.has(input.decision) || !normalized(input.reason)) throw fail('Valid admission decision and reason required', 400);
            if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 10 ||
                input.evidence.some(e => !normalized(e.ref) || !/^[a-f0-9]{64}$/i.test(e.hash))) throw fail('Resolution requires referenced SHA-256 evidence', 400);
            const expectedMatches = previous.matches.map(m => [m.task_id, m.task_version]).sort();
            const providedMatches = Array.isArray(input.matched_tasks) ? input.matched_tasks.map(m => [m.task_id, m.task_version]).sort() : [];
            if (JSON.stringify(expectedMatches) !== JSON.stringify(providedMatches)) throw fail('Compared task versions do not match current admission');
            if (['covered_by_open', 'already_delivered'].includes(input.decision) && !expectedMatches.length) throw fail('Coverage decision requires a matched owner/delivery', 400);
            if (input.decision === 'covered_by_open' && previous.matches.every(m => ['completed', 'cancelled', 'failed', 'archived'].includes(m.status))) throw fail('No current open owner in the compared tasks', 400);
            if (input.decision === 'partial_overlap' && (!Array.isArray(input.remaining_scope) || !input.remaining_scope.length || input.remaining_scope.some(s => !normalized(s)))) throw fail('Partial overlap requires concrete remaining scope clauses', 400);
            if (previous.lookup_failed) throw fail('Cannot resolve while comparison lookup is unavailable');
            const receipt = { ...previous, decision: input.decision, reason: normalized(input.reason), authority,
                resolved_at: new Date(now()).toISOString(), evidence: input.evidence.map(e => ({ ref: e.ref, hash: e.hash })),
                ...(input.decision === 'partial_overlap' ? { remaining_scope: input.remaining_scope } : {}) };
            return save(task, receipt, { mutation: true });
        }).immediate();
    }
    /**
     * Robert's decision on a genuine executor or QA contract drift. `approve`
     * makes the drifted contract the authorized one; `return_to_authorized`
     * writes the authorized values back and restores the decision the task had
     * before the drift. Either way the hold clears exactly once.
     */
    function resolveContract(id, input, origin) {
        const decided = normalizeOrigin(origin);
        if (!AUTHORIZING_ORIGINS.has(decided.kind)) throw fail('Robert’s verified session, operator credential or a relayed decision is required', 403, 'contract_decision_unauthorized');
        if (!['approve', 'return_to_authorized'].includes(input?.decision)) throw fail('decision must be approve or return_to_authorized', 400, 'contract_change_invalid');
        return db.transaction(() => {
            const task = current(id); requireVersion(task, input);
            const previous = readReceipt(id);
            if (!holdOpen(previous)) throw fail('No contract hold is open on this task', 409, 'no_contract_hold');
            const hold = previous.contract_hold;
            if (Array.isArray(input.change_ids) && (input.change_ids.length !== hold.change_ids.length || input.change_ids.some(x => !hold.change_ids.includes(x)))) {
                throw fail('The hold changed since it was read; refresh before deciding', 409, 'contract_hold_changed', { change_ids: hold.change_ids });
            }
            const decisionRef = decided.decision_ref ? verifyDecisionRef(task, previous, decided.decision_ref) : undefined;
            const recordedAt = new Date(now()).toISOString();
            const resolution = { decision: input.decision, recorded_at: recordedAt, authority: decided.authority, origin: decided.kind, requester: decided.requester,
                ...(decided.reason ? { reason: decided.reason } : {}), ...(decisionRef ? { decision_ref: decisionRef } : {}) };
            const resolvedHistory = (previous.contract_changes || []).map(item => hold.change_ids.includes(item.id) && !item.resolution ? { ...item, resolution } : item);
            const finish = receipt => ({ ...receipt, ...(previous.operator_answers ? { operator_answers: previous.operator_answers } : {}), contract_changes: resolvedHistory,
                ...(previous.contract_changes_dropped ? { contract_changes_dropped: previous.contract_changes_dropped } : {}) });
            if (input.decision === 'approve') {
                const fields = governedFields(task);
                const contract = authorizedBaseline(fields, previous.contract.version + 1, { origin: decided.kind, authority: decided.authority, basis: 'approved_drift',
                    decided_change_ids: hold.change_ids, ...(decided.reason ? { reason: decided.reason } : {}), ...(decisionRef ? { decision_ref: decisionRef } : {}) }, { fingerprint: fields.fingerprint });
                // The decision the task had before the drift addressed the same
                // compared owners; it stays valid when they are unchanged.
                const fresh = baseReceipt(task, previous.concerns || [], previous, { contract });
                const receipt = withHold(carryResolution(fresh, hold.prior), null);
                return save(task, finish(receipt), { mutation: true });
            }
            // Return to the authorized contract: write the authorized values back
            // in the same row update that records the decision, one version bump.
            const restore = {};
            const payloadRestore = () => (restore.antigravity_payload = restore.antigravity_payload || { ...object(task.antigravity_payload) });
            for (const field of hold.drifted_fields) {
                const authorized = field in hold.authorized_values, value = hold.authorized_values[field];
                if (field.startsWith('payload.')) { const key = field.slice('payload.'.length); if (authorized) payloadRestore()[key] = value; else delete payloadRestore()[key]; }
                else if (['name', 'description', 'dispatch_instructions', 'dependencies', 'project_id'].includes(field)) restore[field] = authorized ? value : field === 'dependencies' ? [] : field === 'project_id' ? task.project_id : '';
            }
            const restored = { ...task, ...restore };
            const fields = governedFields(restored);
            if (fields.hash !== previous.contract.hash) throw fail('The authorized contract cannot be restored exactly from the recorded values', 409, 'contract_restore_failed', { restored_hash: fields.hash, authorized_hash: previous.contract.hash });
            // The pre-drift resolution applies again only when the compared
            // owners still stand; an overlap that appeared meanwhile, or an
            // open concern, is not hidden by the restored contract.
            const fresh = baseReceipt(restored, previous.concerns || [], previous, { contract: { ...previous.contract, fingerprint: fields.fingerprint } });
            const receipt = finish(withHold(carryResolution(fresh, hold.prior), null));
            const columns = Object.keys(restore);
            const metadata = { ...object(task.metadata), work_admission: receipt };
            const result = db.prepare(`UPDATE tasks SET ${columns.map(c => `${c} = ?, `).join('')}metadata = ?, updated_at = ? WHERE id = ? AND version = ?`)
                .run(...columns.map(c => typeof restore[c] === 'string' || restore[c] === null ? restore[c] : JSON.stringify(restore[c])), JSON.stringify(metadata), recordedAt, id, task.version);
            if (!result.changes) throw fail('Task changed since admission was read');
            snapshotCache.delete(id);
            db.prepare('INSERT INTO work_admissions (task_id, document) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document').run(id, JSON.stringify(receipt));
            return readTask(id);
        }).immediate();
    }
    return { admit, current, resolve, concerns, guardUpdate, resolveContract, contract, governedFields, readReceipt, forget: id => snapshotCache.delete(id) };
}

module.exports = { initializeWorkAdmission, createWorkAdmission, RESOLUTION_WINDOW_MS, CONTRACT_DRIFT_REASON, RULINGS_REWRITE_REASON };
