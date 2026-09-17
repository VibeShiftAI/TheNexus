/**
 * Checkpoint plan normalization and the single advancement transition
 * (Nexus 143abc00, design: docs/project-checkpoints.md).
 *
 * A checkpoint plan is an ordered set of endpoints under the project's
 * long-term end_state. The first pending checkpoint is current. Editing is a
 * replacement array like end_state_criteria: ids are stable, server-owned
 * fields (status, completion, assessment, history, revisions) are preserved
 * for unchanged definitions, removed checkpoints are archived with their
 * evidence, and a changed definition can never reuse an earlier success.
 *
 * Pure functions: the caller (db/index.js) holds the SQLite transaction from
 * read through write and supplies the monotonic timestamp.
 */
const crypto = require('crypto');
const { isDeepStrictEqual: equal } = require('util');
const {
    CheckpointDefinitionSchema, CheckpointPlanSchema, CheckpointAssessmentSchema,
    currentCheckpoint, checkpointLinksNeed, checkpointRequiredNeeds, knowledgeProgress, assessmentVerifies,
} = require('@praxis/contract');

const MAX_CHECKPOINTS = 30;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_RESULT_AGE_MS = 15 * 60_000;
const MS_PER_DAY = 86_400_000;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function invalid(message, status = 400, code) { return Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); }
function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
}
function parse(schema, value, name) {
    const result = schema.safeParse(value);
    if (!result.success) throw invalid(`${name}: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    return result.data;
}
function criterionDefinitions(criteria = []) {
    return (criteria || []).map(({ observation, created_at, source, ...criterion }) => ({ enabled: true, ...criterion }));
}
/** The author-owned identity of a checkpoint; the title is a label, evidence and server fields are excluded. */
function definitionOf(checkpoint) {
    return {
        goal: (checkpoint.goal || '').trim(),
        criteria: criterionDefinitions(checkpoint.criteria),
        need_ids: [...new Set(checkpoint.need_ids || [])].sort(),
    };
}
function snapshot(cp) {
    return { id: cp.id, title: cp.title, goal: cp.goal || '', criteria: cp.criteria || [], need_ids: cp.need_ids || [] };
}
function event(kind, at, definitionRevision, extra = {}) {
    const out = { kind, at, definition_revision: definitionRevision };
    for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== null) out[key] = value;
    return out;
}
function emptyPlan() {
    return { items: [], archived: [], revision: null, sequence_completed_at: null };
}

/**
 * Merge an authored ordered array (or `{items: [...]}`) into the stored plan.
 * Returns `{ plan, changed, changedIds }`; `changed` is false when the input
 * restates the stored plan exactly, so a no-op save does not bump the revision.
 */
function normalizeCheckpointPlan(raw, existingPlan, at, { normalizeCriteria, source, needs = [] }) {
    const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.items) ? raw.items : null;
    if (!items) throw invalid('checkpoints must be an ordered array of checkpoint definitions (or an object with an items array)');
    if (items.length > MAX_CHECKPOINTS) throw invalid(`checkpoints must contain at most ${MAX_CHECKPOINTS} entries`);
    const existing = existingPlan && typeof existingPlan === 'object' ? { ...emptyPlan(), ...existingPlan } : emptyPlan();
    const known = new Map([...(existing.items || []), ...(existing.archived || [])].map(cp => [cp.id, cp]));
    const knownNeeds = new Set((needs || []).map(need => need && need.id));
    const ids = new Set();
    const changedIds = [];
    let changed = !existingPlan;
    const nextItems = items.map(item => {
        object(item, 'checkpoint');
        const previous = typeof item.id === 'string' ? known.get(item.id) : undefined;
        const id = previous ? previous.id : (typeof item.id === 'string' && item.id.trim()) || crypto.randomUUID().slice(0, 8);
        if (ids.has(id)) throw invalid('checkpoint ids must be unique');
        ids.add(id);
        const criteria = normalizeCriteria(own(item, 'criteria') ? item.criteria : previous?.criteria || [], previous?.criteria || [], at, `checkpoint ${id} criteria`);
        const definition = parse(CheckpointDefinitionSchema, {
            id,
            title: own(item, 'title') ? item.title : previous?.title,
            goal: own(item, 'goal') ? item.goal ?? '' : previous?.goal ?? '',
            criteria,
            need_ids: own(item, 'need_ids') ? item.need_ids : previous?.need_ids ?? [],
        }, `checkpoint ${id}`);
        for (const needId of definition.need_ids) {
            // An unknown link is an invalid selection, never a silently dropped requirement.
            if (!knownNeeds.has(needId)) throw invalid(`checkpoint ${id}: unknown need link ${needId}`);
        }
        if (!previous) {
            // A brand-new checkpoint has no prior evidence to invalidate; linking an
            // already-satisfied need to it does not reopen that need.
            changed = true;
            return { ...definition, created_at: at, definition_revision: at, status: 'pending', completion: null, assessment: null, history: [] };
        }
        const checkpoint = { ...previous, ...definition, history: [...(previous.history || [])] };
        if (previous.status === 'archived') {
            checkpoint.status = previous.completion ? 'completed' : 'pending';
            delete checkpoint.archived_at;
            checkpoint.history.push(event('restored', at, previous.definition_revision, { source }));
            changed = true;
        }
        if (!equal(definitionOf(previous), definitionOf(definition))) {
            // Evidence stays attached to the definition it verified; the new definition starts unverified.
            if (checkpoint.status === 'completed' && previous.completion) {
                checkpoint.history.push(event('reopened', at, previous.completion.definition_revision, {
                    source, definition: snapshot(previous), reason: 'Definition changed after completion; prior evidence retained as history', assessment: previous.completion.assessment,
                }));
            }
            checkpoint.status = 'pending';
            checkpoint.completion = null;
            checkpoint.assessment = null;
            checkpoint.definition_revision = at;
            checkpoint.history.push(event('definition_changed', at, previous.definition_revision, { source, definition: snapshot(previous), assessment: previous.assessment || previous.completion?.assessment }));
            // Acceptance is for the previous definition, even when a client copied it.
            checkpoint.criteria = checkpoint.criteria.map(({ observation, ...criterion }) => criterion);
            changed = true;
            changedIds.push(id);
        } else if (!equal(previous.criteria, checkpoint.criteria)) {
            // Observation evidence changed under the same definition: a pending evaluation is stale.
            if (checkpoint.status === 'pending') checkpoint.assessment = null;
            changed = true;
        }
        // The title is a label: renaming keeps the definition revision and its evidence.
        if (previous.title !== checkpoint.title) changed = true;
        return checkpoint;
    });
    const order = list => (list || []).map(cp => cp.id).join('|');
    if (order(existing.items) !== order(nextItems)) changed = true;
    const removed = (existing.items || []).filter(cp => !ids.has(cp.id)).map(cp => ({
        ...cp, status: 'archived', archived_at: at, history: [...(cp.history || []), event('archived', at, cp.definition_revision, { source })],
    }));
    if (removed.length) changed = true;
    if (!changed) return { plan: existingPlan, changed: false, changedIds: [] };
    const archived = [...(existing.archived || []).filter(cp => !ids.has(cp.id)), ...removed];
    const sequenceComplete = nextItems.length > 0 && nextItems.every(cp => cp.status === 'completed');
    const plan = {
        items: nextItems,
        archived,
        revision: at,
        sequence_completed_at: sequenceComplete ? existing.sequence_completed_at || at : null,
    };
    return { plan: parse(CheckpointPlanSchema, plan, 'checkpoints'), changed: true, changedIds };
}

/** Pending checkpoints lose their cached evaluation when the evidence they depend on moved. */
function clearPendingAssessments(plan, changedNeeds) {
    if (!plan || !Array.isArray(plan.items)) return plan;
    if (!plan.items.some(cp => cp.status === 'pending' && cp.assessment)) return plan;
    return { ...plan, items: plan.items.map(cp => cp.status === 'pending' && cp.assessment && (!changedNeeds || changedNeeds.some(need => checkpointLinksNeed(cp, need))) ? { ...cp, assessment: null } : cp) };
}

/** Needs linked to any of the given checkpoints (by need_ids or owned criteria). */
function needsLinkedToCheckpoints(plan, checkpointIds, needs) {
    const targets = (plan?.items || []).filter(cp => checkpointIds.includes(cp.id));
    return new Set((needs || []).filter(need => need?.knowledge && targets.some(cp => checkpointLinksNeed(cp, need))).map(need => need.id));
}

function duplicate(plan, checkpointId, reason) {
    const current = currentCheckpoint(plan);
    return {
        plan, changed: false,
        transition: { outcome: 'duplicate', checkpoint_id: checkpointId, verified: false, completed_checkpoint_id: null, current_checkpoint_id: current ? current.id : null, sequence_completed_at: plan.sequence_completed_at ?? null, reason },
    };
}

/** Explain why a claimed passing result cannot verify the current definition. */
function staleResultReason(result, criterion, target, plan, evaluated) {
    const checked = Date.parse(result.checked_at);
    const earliestValidResult = Math.max(Date.parse(target.definition_revision), Date.parse(plan.revision));
    const predatesRevision = !(checked >= earliestValidResult); // also rejects an invalid timestamp
    const beyondEvaluation = checked > evaluated + MAX_CLOCK_SKEW_MS;
    const beyondClock = checked > Date.now() + MAX_CLOCK_SKEW_MS;
    const expired = Date.now() - checked > MAX_RESULT_AGE_MS;
    let reason;
    if (predatesRevision || beyondEvaluation || beyondClock || expired) {
        reason = 'Result is stale for this definition or evaluation';
    }
    // Preserve the more specific acceptance explanation when both checks fail.
    if (criterion && ['manual', 'metric'].includes(criterion.kind)) {
        const observation = criterion.observation;
        const age = observation ? Date.now() - Date.parse(observation.observed_at) : NaN;
        if (!observation || !observation.evidence_ref?.trim() || !Number.isFinite(age) ||
            age < -MAX_CLOCK_SKEW_MS || observation.status !== 'pass') {
            reason = 'No authoritative passing acceptance observation';
        } else if (target.history?.some(event => ['definition_changed', 'reopened'].includes(event.kind)) &&
            Date.parse(observation.observed_at) < Date.parse(target.definition_revision)) {
            reason = 'Acceptance predates the current checkpoint definition';
        } else if (criterion.kind === 'metric') {
            const metric = criterion.metric;
            if (!metric || !Number.isFinite(observation.value) ||
                (metric.window_days && age > metric.window_days * MS_PER_DAY) ||
                (metric.min_samples && !(observation.sample_size >= metric.min_samples)) ||
                !(metric.operator === 'gte' ? observation.value >= metric.target :
                    metric.operator === 'lte' ? observation.value <= metric.target : observation.value === metric.target)) {
                reason = 'Recorded metric does not meet the adopted target, freshness or sample requirement';
            }
        }
    }
    return reason;
}

/**
 * The one revision-guarded transition. Verifies the CURRENT checkpoint from a
 * fresh assessment of its exact definition, recomputes the verdict server-side
 * (criteria all pass, at least one criterion, applicable required knowledge
 * satisfied against the project's own needs), and either records a completion
 * (bumping the plan revision so a concurrent duplicate fails its guard) or
 * stores the assessment as waiting-for-evidence without moving anything.
 */
function applyCheckpointTransition(project, input, at) {
    object(input, 'checkpoint transition');
    const plan = project.checkpoints;
    if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) throw invalid('Project has no checkpoint plan', 404, 'NO_CHECKPOINTS');
    const { checkpoint_id: checkpointId, definition_revision: definitionRevision, source } = input;
    if (typeof checkpointId !== 'string' || !checkpointId.trim()) throw invalid('checkpoint_id is required');
    if (typeof definitionRevision !== 'string' || !definitionRevision.trim()) throw invalid('definition_revision is required');
    if (!own(input, 'expected_checkpoints_revision')) throw invalid('expected_checkpoints_revision is required for a checkpoint transition', 428);
    if (input.expected_checkpoints_revision !== plan.revision) throw invalid('Checkpoint plan changed: reload before submitting evidence.', 409, 'CHECKPOINT_REVISION_STALE');
    const target = plan.items.find(cp => cp.id === checkpointId);
    if (!target) throw invalid('Checkpoint not found', 404, 'CHECKPOINT_NOT_FOUND');
    if (!input.assessment || typeof input.assessment !== 'object') throw invalid('assessment is required');
    const submitted = parse(CheckpointAssessmentSchema, { ...input.assessment, checkpoint_id: checkpointId, definition_revision: definitionRevision }, 'assessment');
    const current = currentCheckpoint(plan);
    if (target.status === 'completed') {
        // A replay of the verifying evidence (retry, restart) is a duplicate, never a second advance.
        if (target.completion?.assessment?.evaluated_at === submitted.evaluated_at) return duplicate(plan, checkpointId, 'Checkpoint already completed by this evidence');
        throw invalid('Checkpoint is already completed', 409, 'CHECKPOINT_NOT_CURRENT');
    }
    if (!current || current.id !== target.id) throw invalid(`Checkpoint ${target.id} is not the current checkpoint (current: ${current ? current.id : 'none'})`, 409, 'CHECKPOINT_NOT_CURRENT');
    if (definitionRevision !== target.definition_revision) throw invalid('Checkpoint definition changed since this evidence was gathered', 409, 'CHECKPOINT_DEFINITION_STALE');
    const evaluated = Date.parse(submitted.evaluated_at);
    if (!(evaluated > Date.parse(target.definition_revision))) throw invalid('Assessment predates the checkpoint definition', 409, 'ASSESSMENT_NOT_FRESH');
    if (evaluated > Date.now() + MAX_CLOCK_SKEW_MS) throw invalid('Assessment is dated in the future', 409, 'ASSESSMENT_NOT_FRESH');
    if (target.assessment && evaluated <= Date.parse(target.assessment.evaluated_at)) return duplicate(plan, checkpointId, 'Assessment is not newer than the recorded evaluation');
    // Server-owned verdict: knowledge is recomputed from the registry, never taken from the caller.
    const knowledge = knowledgeProgress(checkpointRequiredNeeds(target, project.needs || []), project.end_state_updated_at);
    const assessment = { ...submitted, knowledge: { required: knowledge.required, satisfied: knowledge.satisfied, unresolved: knowledge.unresolved } };
    // A new envelope cannot make old or contradictory evidence fresh.
    assessment.results = assessment.results.map(result => {
        if (result.status !== 'pass' || result.pass !== true) return result; // retain evaluator fail/unavailable distinctions
        const criterion = target.criteria.find(c => c.id === result.id);
        const reason = staleResultReason(result, criterion, target, plan, evaluated);
        return reason ? { ...result, pass: false, status: 'unknown', detail: reason } : result;
    });
    const verified = assessmentVerifies(assessment, target.criteria || []);
    assessment.achieved = verified;
    const items = plan.items.map(cp => {
        if (cp.id !== target.id) return cp;
        if (!verified) return { ...cp, assessment };
        const completion = { at, definition_revision: cp.definition_revision, ...(source ? { source } : {}), assessment };
        return { ...cp, status: 'completed', assessment, completion, history: [...(cp.history || []), event('completed', at, cp.definition_revision, { source, assessment, definition: snapshot(cp) })] };
    });
    const sequenceComplete = items.every(cp => cp.status === 'completed');
    const nextPlan = verified
        ? { ...plan, items, revision: at, sequence_completed_at: sequenceComplete ? at : null }
        : { ...plan, items };
    const next = currentCheckpoint(nextPlan);
    return {
        plan: parse(CheckpointPlanSchema, nextPlan, 'checkpoints'),
        changed: true,
        transition: {
            outcome: verified ? 'advanced' : 'recorded',
            checkpoint_id: checkpointId,
            verified,
            completed_checkpoint_id: verified ? target.id : null,
            current_checkpoint_id: next ? next.id : null,
            sequence_completed_at: nextPlan.sequence_completed_at ?? null,
            knowledge,
        },
    };
}

/** Operator-initiated regression: a completed checkpoint becomes pending again, its completion kept as history. */
function applyCheckpointReopen(project, checkpointId, input, at) {
    object(input, 'checkpoint reopen');
    const plan = project.checkpoints;
    if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) throw invalid('Project has no checkpoint plan', 404, 'NO_CHECKPOINTS');
    if (!own(input, 'expected_checkpoints_revision')) throw invalid('expected_checkpoints_revision is required', 428);
    if (input.expected_checkpoints_revision !== plan.revision) throw invalid('Checkpoint plan changed: reload before saving.', 409, 'CHECKPOINT_REVISION_STALE');
    const target = plan.items.find(cp => cp.id === checkpointId);
    if (!target) throw invalid('Checkpoint not found', 404, 'CHECKPOINT_NOT_FOUND');
    if (target.status !== 'completed') throw invalid('Only a completed checkpoint can be reopened', 409, 'CHECKPOINT_NOT_COMPLETED');
    const items = plan.items.map(cp => cp.id !== target.id ? cp : {
        ...cp, status: 'pending', definition_revision: at, criteria: cp.criteria.map(({ observation, ...criterion }) => criterion), completion: null, assessment: null,
        history: [...(cp.history || []), event('reopened', at, cp.definition_revision, { source: input.source, reason: input.reason || 'Reopened by operator', definition: snapshot(cp), assessment: cp.completion?.assessment })],
    });
    const nextPlan = { ...plan, items, revision: at, sequence_completed_at: null };
    return { plan: parse(CheckpointPlanSchema, nextPlan, 'checkpoints'), current_checkpoint_id: currentCheckpoint(nextPlan)?.id ?? null };
}

module.exports = { normalizeCheckpointPlan, clearPendingAssessments, needsLinkedToCheckpoints, applyCheckpointTransition, applyCheckpointReopen, MAX_CHECKPOINTS };
