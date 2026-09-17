/** Project evidence and revision invariants, shared by every database writer. */
const crypto = require('crypto');
const { isDeepStrictEqual: equal } = require('util');
const { ProjectNeedSchema, EndStateCriterionSchema, EndpointDefinitionSchema, EndStateAssessmentSchema, checkpointProgress, projectWideRequiredNeeds, knowledgeProgress, assessmentVerifies } = require('@praxis/contract');
const { normalizeCheckpointPlan, clearPendingAssessments, needsLinkedToCheckpoints } = require('./project-checkpoints');

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
}
function parse(schema, value, name) {
    const result = schema.safeParse(value);
    if (!result.success) throw invalid(`${name}: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    return result.data;
}
function timestamp(current) {
    return new Date(Math.max(Date.now(), (Date.parse(current || '') || 0) + 1)).toISOString();
}
function normalizeCriteria(raw, existing = [], at, label = 'end_state_criteria') {
    if (!Array.isArray(raw) || raw.length > 20) throw invalid(`${label} must be an array of at most 20 entries`);
    const ids = new Set();
    return raw.map(item => {
        object(item, 'criterion');
        const previous = existing.find(c => c.id === item.id);
        const candidate = { ...previous, ...item, id: item.id || crypto.randomUUID().slice(0, 8), created_at: item.created_at || previous?.created_at || at };
        // Omission preserves prior data; explicit null clears an observation over JSON.
        if (item.observation === null) delete candidate.observation;
        const criterion = parse(EndStateCriterionSchema, candidate, 'criterion');
        if (!criterion.id.trim() || ids.has(criterion.id)) throw invalid('criterion ids must be nonempty and unique');
        ids.add(criterion.id);
        if (!criterion.description.trim()) throw invalid('each criterion requires a description');
        if (criterion.kind === 'url_up' && !/^https?:\/\//.test(criterion.url || '')) throw invalid('url_up criterion requires an http(s) url');
        if (criterion.kind === 'command' && !criterion.command?.trim()) throw invalid('command criterion requires a command');
        if (criterion.kind === 'task_set' && !criterion.task_ids?.length) throw invalid('task_set criterion requires a non-empty task_ids array');
        // Keep legacy and future fields that this writer does not own.
        return { ...candidate, ...criterion };
    });
}
function reopen(need, reason) {
    const out = { ...need, status: 'open', knowledge: { ...need.knowledge, research_status: 'stale', review_reason: reason } };
    delete out.resolved_at;
    return out;
}
function normalizeNeed(item, previous, project, at, actor) {
    object(item, 'need');
    if (own(item, 'knowledge')) object(item.knowledge, 'knowledge');
    const candidate = { ...previous, ...item, id: previous?.id || item.id || crypto.randomUUID().slice(0, 8), created_at: previous?.created_at || item.created_at || at };
    // Attribution records the original declarer. PATCH source identifies the verifier.
    if (previous?.source) candidate.source = previous.source;
    if (previous?.knowledge || item.knowledge) candidate.knowledge = { ...previous?.knowledge, ...item.knowledge };
    let need = { ...candidate, ...parse(ProjectNeedSchema, candidate, 'need') };
    if (!need.id.trim() || !need.description.trim()) throw invalid('each need requires an id and description');
    if (need.knowledge) {
        const k = need.knowledge;
        const before = previous?.knowledge;
        const criterionIds = new Set([...(project.end_state_criteria || []), ...(project.checkpoints?.items || []).flatMap(cp => cp.criteria || [])].map(c => c.id));
        for (const id of k.criterion_ids) {
            const historicalLink = before?.criterion_ids?.includes(id) && before.research_status === 'stale' && need.status !== 'met';
            if (!criterionIds.has(id) && !historicalLink) throw invalid(`Unknown criterion link: ${id}`);
        }
        if (k.criterion_ids.some(id => (project.end_state_criteria || []).some(c => c.id === id))) {
            if (project.end_state_updated_at) k.endpoint_revision = project.end_state_updated_at;
            else delete k.endpoint_revision;
        }
        // Verification is server-owned. Unrelated edits retain the last historical check.
        for (const field of ['verified_at', 'verified_by']) {
            if (before?.[field] !== undefined) k[field] = before[field];
            else delete k[field];
        }
        const scopeChanged = before && (before.question !== k.question || before.satisfaction_test !== k.satisfaction_test ||
            !equal([...(before.criterion_ids || [])].sort(), [...k.criterion_ids].sort()));
        const badApplication = !equal(before?.application, k.application) && ['insufficient', 'outdated'].includes(k.application?.status);
        const answerChanged = previous?.status === 'met' && before && (!equal(before.answer, k.answer) || !equal(before.evidence, k.evidence));
        if (scopeChanged || badApplication || answerChanged) {
            // A changed acceptance question cannot reuse the previous answer as automatic proof.
            need = reopen(need, badApplication ? `Application reported ${k.application.status}` : scopeChanged ? 'Knowledge question or acceptance scope changed' : 'Verified answer or evidence changed');
        } else if (need.status === 'met' && previous?.status === 'met' && k.research_status === 'stale') {
            need = reopen(need, 'Research marked stale for review');
        } else if (need.status === 'met') {
            if (!k.answer?.trim() || !k.evidence.length) throw invalid('Satisfying a structured need requires an answer and evidence reference');
            if (previous?.status !== 'met' || !before) {
                k.research_status = 'evidence_ready';
                k.verified_at = at;
                k.verified_by = actor || item.source || previous?.source || 'api';
                delete k.review_reason;
                need.resolved_at = at;
            }
        } else if (previous?.status === 'met' && need.status === 'open') {
            need = reopen(need, 'Explicitly reopened for review');
        }
    }
    if (need.status === 'open') delete need.resolved_at;
    else if (previous?.status !== need.status || !need.resolved_at) need.resolved_at = at;
    return need;
}
function definition(endpoint = {}) {
    const { proposed_next, ...current } = endpoint || {};
    return { completion_policy: 'propose_next', ...current };
}
function criterionDefinitions(criteria = []) {
    return (criteria || []).map(({ observation, created_at, source, ...criterion }) => ({ enabled: true, ...criterion }));
}

/** Pure preparation. Caller holds a SQLite transaction from read through write. */
function prepareProjectPatch(current, updates, { needMutation } = {}) {
    object(updates, 'project patch');
    const patch = { ...updates };
    if (own(patch, 'checkpoints') && current.id && !own(updates, 'expected_checkpoints_revision')) throw invalid('Checkpoint saves require expected_checkpoints_revision from the read snapshot', 428);
    if (current.checkpoints && ['end_state', 'endpoint', 'end_state_criteria'].some(key => own(patch, key)) && !own(updates, 'expected_updated_at')) throw invalid('Endpoint edits with checkpoints require expected_updated_at', 428);
    if (own(patch, 'expected_checkpoints_revision')) {
        // The checkpoint plan has its own revision so concurrent plan edits and advances never silently overwrite each other.
        if (patch.expected_checkpoints_revision !== null && typeof patch.expected_checkpoints_revision !== 'string') throw invalid('expected_checkpoints_revision must be a string or null');
        if ((current.checkpoints?.revision ?? null) !== patch.expected_checkpoints_revision) throw Object.assign(invalid('Checkpoint plan changed: reload before saving.', 409), { code: 'CHECKPOINT_REVISION_STALE' });
        delete patch.expected_checkpoints_revision;
    }
    for (const [guard, field] of [['expected_updated_at', 'updated_at'], ['expected_end_state_updated_at', 'end_state_updated_at'], ['expected_status', 'status']]) {
        if (!own(patch, guard)) continue;
        if (patch[guard] !== null && typeof patch[guard] !== 'string') throw invalid(`${guard} must be a string or null`);
        if ((current[field] ?? null) !== patch[guard]) throw invalid(`Project changed: ${field} does not match. Reload before saving.`, 409);
        delete patch[guard];
    }
    const at = timestamp(current.updated_at);
    if (own(patch, 'end_state') && typeof patch.end_state !== 'string') throw invalid('end_state must be a string');
    if (own(patch, 'endpoint')) {
        object(patch.endpoint, 'endpoint');
        patch.endpoint = parse(EndpointDefinitionSchema, { ...current.endpoint, ...patch.endpoint }, 'endpoint');
    }
    if (own(patch, 'end_state_criteria')) patch.end_state_criteria = normalizeCriteria(patch.end_state_criteria, current.end_state_criteria || [], at);
    let next = { ...current, ...patch };
    const changed = (own(patch, 'end_state') && (current.end_state || '') !== patch.end_state) ||
        (own(patch, 'endpoint') && !equal(definition(current.endpoint), definition(patch.endpoint))) ||
        (own(patch, 'end_state_criteria') && !equal(criterionDefinitions(current.end_state_criteria), criterionDefinitions(patch.end_state_criteria)));
    if (changed) {
        const revisionAt = timestamp(current.end_state_updated_at);
        const revision = { end_state: next.end_state || '', at: revisionAt, endpoint: next.endpoint || {}, end_state_criteria: next.end_state_criteria || [] };
        if (patch.end_state_source) revision.source = patch.end_state_source;
        if (patch.end_state_reason) revision.reason = patch.end_state_reason;
        patch.end_state_history = [...(current.end_state_history || []), revision];
        patch.end_state_updated_at = revisionAt;
        next.end_state_updated_at = revisionAt;
    }
    if (own(patch, 'needs')) {
        if (!Array.isArray(patch.needs) || patch.needs.length > 50) throw invalid('needs must be an array of at most 50 entries');
        const existing = current.needs || [];
        if (!needMutation && current.id && [...existing, ...patch.needs].some(n => n?.knowledge) && !own(updates, 'expected_updated_at')) {
            throw invalid('Whole needs-array saves require expected_updated_at; use per-need PATCH for independent changes.', 428);
        }
        const ids = new Set();
        patch.needs = patch.needs.map(item => {
            const previous = existing.find(n => n?.id === item?.id);
            // Adding/patching a different need must never rewrite legacy records.
            let need = equal(item, previous) ? previous : normalizeNeed(item, previous, next, at, needMutation?.source || patch.end_state_source);
            if (ids.has(need.id)) throw invalid('Need ids must be unique');
            ids.add(need.id);
            return need;
        });
    }
    if (changed) {
        patch.needs = (patch.needs || current.needs || []).map(need => {
            if (!need.knowledge?.criterion_ids?.some(id => [...(current.end_state_criteria || []), ...(next.end_state_criteria || [])].some(c => c.id === id)) || need.status === 'dropped') return need;
            const reopened = reopen(need, 'Linked endpoint or criteria changed; review prior evidence');
            reopened.knowledge.endpoint_revision = patch.end_state_updated_at;
            return reopened;
        });
    }
    if (own(patch, 'end_state_assessment') && patch.end_state_assessment !== null) {
        if (current.id && !own(updates, 'expected_updated_at')) throw invalid('Assessment writes require expected_updated_at from the evaluated project snapshot.', 428);
        patch.end_state_assessment = parse(EndStateAssessmentSchema, patch.end_state_assessment, 'end_state_assessment');
        if ((patch.end_state_assessment.endpoint_revision ?? null) !== (next.end_state_updated_at ?? null)) throw invalid('Assessment endpoint revision is stale', 409);
    }
    // Any changed criterion evidence or knowledge invalidates the persisted evaluation.
    if (changed || (own(patch, 'end_state_criteria') && !equal(current.end_state_criteria, patch.end_state_criteria)) ||
        (own(patch, 'needs') && !equal(current.needs, patch.needs))) patch.end_state_assessment = null;
    // Checkpoint plan (docs/project-checkpoints.md): a replacement array merged by stable id. Writers that
    // omit the field never touch it; the long-term end_state and its revision are untouched by plan edits.
    if (own(patch, 'checkpoints')) {
        if (patch.checkpoints === null) {
            if (current.checkpoints?.items?.length || current.checkpoints?.archived?.length) throw invalid('checkpoints cannot be cleared; remove entries from the array to archive them');
        } else {
            const needsNow = patch.needs || current.needs || [];
            const { plan, changed: planChanged, changedIds } = normalizeCheckpointPlan(patch.checkpoints, current.checkpoints || null, at, {
                normalizeCriteria, source: updates.end_state_source, needs: needsNow,
            });
            if (!planChanged) delete patch.checkpoints;
            else {
                patch.checkpoints = plan;
                patch.end_state_assessment = null;
                if (changedIds.length) {
                    // A checkpoint whose definition moved cannot keep the knowledge verified against the old one.
                    const linked = needsLinkedToCheckpoints(plan, changedIds, needsNow);
                    if (linked.size) {
                        patch.needs = needsNow.map(need => linked.has(need.id) && need.status !== 'dropped'
                            ? reopen(need, 'Linked checkpoint definition changed; review prior evidence')
                            : need);
                    }
                }
            }
        }
    }
    if (current.checkpoints && own(patch, 'needs') && !equal(current.needs, patch.needs)) {
        const changedNeedIds = new Set([...(current.needs || []), ...(patch.needs || [])].filter(n =>
            !equal((current.needs || []).find(old => old.id === n.id), (patch.needs || []).find(nextNeed => nextNeed.id === n.id))).map(n => n.id));
        const plan = patch.checkpoints || current.checkpoints;
        const cleared = clearPendingAssessments(plan, [...(current.needs || []), ...(patch.needs || [])].filter(need => changedNeedIds.has(need.id)));
        // Fence in-flight evaluation, but retain assessments of unrelated checkpoints.
        patch.checkpoints = { ...cleared, revision: at };
    }
    if (patch.end_state_assessment && (patch.checkpoints || current.checkpoints)?.items?.length) {
        const plan = patch.checkpoints || current.checkpoints;
        const progress = checkpointProgress(plan);
        const knowledge = knowledgeProgress(projectWideRequiredNeeds(plan, patch.needs || current.needs || []), next.end_state_updated_at);
        const assessment = patch.end_state_assessment;
        assessment.knowledge = { required: knowledge.required, satisfied: knowledge.satisfied, unresolved: knowledge.unresolved };
        assessment.checkpoints = { total: progress.total, completed: progress.completed.length, current_id: progress.current?.id ?? null, sequence_complete: progress.sequenceComplete };
        assessment.achieved = progress.sequenceComplete && assessmentVerifies(assessment, patch.end_state_criteria || current.end_state_criteria || []);
    }
    delete patch.end_state_source;
    delete patch.end_state_reason;
    // Never allow writers to supply their own project concurrency token.
    patch.updated_at = at;
    return patch;
}
module.exports = { prepareProjectPatch, invalid, timestamp };
