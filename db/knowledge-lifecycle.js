/** Pure knowledge lifecycle rules. The caller owns the read/write transaction. */
const crypto = require('crypto');
const { isDeepStrictEqual: equal } = require('util');
const { KnowledgeNeedSchema, KnowledgeEvidenceSchema, KnowledgeApplicationSchema, KnowledgeVerificationSchema } = require('@praxis/contract');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const ROUTING_RECEIPT_PREFIX = 'knowledge-change:';
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
function parse(schema, value, label) {
    const result = schema.safeParse(value);
    if (!result.success) throw invalid(`${label}: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    return result.data;
}
function reopenKnowledge(need, reason, at) {
    if (!need.knowledge) return need;
    const out = { ...need, status: 'open', knowledge: { ...need.knowledge, research_status: 'stale', review_reason: reason } };
    if (at) {
        out.knowledge.revision = (need.knowledge.revision ?? 0) + 1;
        out.knowledge.history = [...(need.knowledge.history || []), snapshot(need.knowledge, at)];
    }
    delete out.resolved_at;
    return out;
}
function uniqueEvidence(evidence) {
    const refs = new Set();
    return evidence.filter(item => !refs.has(item.ref) && refs.add(item.ref));
}
function snapshot(before, at) {
    const out = { revision: before.revision ?? 0, question: before.question, satisfaction_test: before.satisfaction_test, evidence: before.evidence || [], at };
    if (before.answer !== undefined) out.answer = before.answer;
    if (before.verification) out.verification = before.verification;
    return out;
}
function legacyApplication(application) {
    return { ...application, id: application.id || `legacy:${crypto.createHash('sha256').update(JSON.stringify(application)).digest('hex').slice(0, 24)}` };
}
function appendApplication(k, before, raw, need, at, legacy = false) {
    const application = parse(KnowledgeApplicationSchema, raw, 'application');
    if (application.id?.startsWith(ROUTING_RECEIPT_PREFIX)) throw invalid('Knowledge change routing receipts are server-owned');
    if (legacy && !application.id) application.id = legacyApplication(application).id;
    if (!application.id) throw invalid('record_application requires a stable id');
    const history = [...(k.applications || [])];
    if (before?.application) {
        const prior = legacyApplication(before.application);
        if (!history.some(item => item.id === prior.id)) history.unshift(prior);
    }
    const existing = history.find(item => item.id === application.id);
    if (existing) {
        const comparison = { ...existing };
        if (!own(application, 'at')) delete comparison.at;
        if (!equal(comparison, application)) throw invalid('Application id already records a different result', 409);
        k.applications = history;
        return false;
    }
    if (!application.task_id?.trim() || !application.notes?.trim()) throw invalid('record_application requires task_id and explanatory notes');
    if (['applied', 'validated', 'successful'].includes(application.status)) {
        if (!application.task_id?.trim() || !application.notes?.trim() || !application.evidence_ref?.trim()) throw invalid('Applied knowledge requires a task, explanation and evidence reference');
        if (need.status !== 'met' || k.research_status === 'stale' || !k.verification || k.verification.revision !== k.revision || application.answer_revision !== k.revision) {
            throw invalid('Application requires a currently verified matching answer_revision', 409);
        }
    }
    application.at = application.at || at;
    k.applications = [...history, application];
    k.application = application; // Compatibility projection; the append-only list is authoritative.
    return ['insufficient', 'outdated'].includes(application.status) && (legacy || application.challenges_knowledge === true);
}

function normalizeKnowledgeLifecycle(candidate, previous, input, { at, actor, scoped = false } = {}) {
    let need = { ...candidate };
    const before = previous?.knowledge;
    if ((!previous || previous.kind !== 'information' || (!before && input.knowledge)) && need.kind === 'information' && (!need.knowledge?.purpose?.trim() || !need.knowledge?.resolution)) {
        throw invalid('New information needs require structured knowledge with question, purpose and resolution');
    }
    const guarded = own(input, 'expected_knowledge_revision');
    if (guarded) {
        const expected = input.expected_knowledge_revision;
        if (!Number.isInteger(expected) || expected < 0) throw invalid('expected_knowledge_revision must be a nonnegative integer');
        if (!before || expected !== (before.revision ?? 0)) {
            // A lost response must not turn an already-recorded immutable operation into a conflict.
            // No other mutation may ride along with this receipt-only retry.
            if (before && input.record_application && Object.keys(input).every(key => ['record_application', 'expected_knowledge_revision', 'source'].includes(key))) {
                const replay = parse(KnowledgeApplicationSchema, input.record_application, 'application');
                const stored = before.applications?.find(item => item.id === replay.id);
                if (stored) {
                    const comparable = { ...stored };
                    if (!own(replay, 'at')) delete comparable.at;
                    if (equal(comparable, replay)) return { ...previous };
                }
            }
            throw invalid('Knowledge revision changed; reload before saving', 409);
        }
    }
    if (!need.knowledge) {
        if (own(input, 'append_evidence') || own(input, 'record_application')) throw invalid('Knowledge operations require a structured information need');
        return need;
    }
    // Only a scoped explicit command or a real transition may verify. Whole-card
    // round-trips of met records must retain historical verification unchanged.
    const verifying = input.status === 'met' && (scoped || previous?.status !== 'met');
    const incomingVerification = input.knowledge?.verification;
    const supplied = { ...need.knowledge };
    for (const field of ['revision', 'history', 'applications', 'verified_at', 'verified_by', 'verification', 'application']) {
        if (before?.[field] !== undefined) supplied[field] = before[field];
        else delete supplied[field];
    }
    let k = parse(KnowledgeNeedSchema, supplied, 'knowledge');
    if (own(input, 'append_evidence')) {
        if (own(input.knowledge, 'evidence')) throw invalid('Use either append_evidence or knowledge.evidence replacement');
        if (!Array.isArray(input.append_evidence)) throw invalid('append_evidence must be an array');
        const appended = input.append_evidence.map(item => parse(KnowledgeEvidenceSchema, item, 'append_evidence'));
        k.evidence = uniqueEvidence([...k.evidence, ...appended]);
    } else k.evidence = uniqueEvidence(k.evidence);
    const scopeChanged = before && (before.question !== k.question || before.satisfaction_test !== k.satisfaction_test || !equal([...(before.criterion_ids || [])].sort(), [...k.criterion_ids].sort()));
    if (!verifying && before && !guarded && (!equal(before.answer, k.answer) || scopeChanged || (own(input.knowledge, 'evidence') && !equal(before.evidence || [], k.evidence)))) throw invalid('Question, answer or evidence replacement requires expected_knowledge_revision', 428);
    const changed = before && (scopeChanged || !equal(before.answer, k.answer) || !equal(before.evidence || [], k.evidence));
    // Retired applied questions must be explicitly restored or their successor
    // revised. In particular, scope invalidation below must not implicitly
    // reactivate a dropped question and create unreachable follow-up work.
    if (changed && (need.status === 'dropped' || k.superseded_by?.length) &&
        [...(before.applications || []), ...(before.application ? [before.application] : [])].some(application => ['applied', 'validated', 'successful'].includes(application.status))) {
        throw invalid('Reopen this retired question or revise its successor before changing applied knowledge.', 409);
    }
    k.revision = before ? (before.revision ?? 0) + (changed ? 1 : 0) : 1;
    k.history = changed ? [...(before.history || []), snapshot(before, at)] : [...(before?.history || [])];
    need.knowledge = k;
    if (verifying) {
        if (!k.answer?.trim() || !k.evidence.length) throw invalid('Satisfying a structured need requires an answer and evidence reference');
        if (changed || !before) throw invalid('Save the changed question, answer or evidence before verifying its new revision');
        if (!guarded) throw invalid('Knowledge verification requires expected_knowledge_revision', 428);
        const verification = parse(KnowledgeVerificationSchema, incomingVerification, 'knowledge.verification');
        if (verification.evidence_refs.some(ref => !k.evidence.some(item => item.ref === ref))) throw invalid('Verification evidence_refs must reference the current answer evidence');
        k.verification = { rationale: verification.rationale, evidence_refs: [...new Set(verification.evidence_refs)], revision: k.revision, at, by: actor || input.source || previous?.source || 'api' };
        k.verified_at = at;
        k.verified_by = k.verification.by;
        k.research_status = 'evidence_ready';
        delete k.review_reason;
        need.resolved_at = at;
    } else if (scopeChanged || (changed && previous?.status === 'met')) {
        need = reopenKnowledge(need, scopeChanged ? 'Knowledge question or acceptance scope changed' : 'Verified answer or evidence changed');
    } else if (previous?.status === 'met' && (need.status === 'open' || k.research_status === 'stale')) {
        need = reopenKnowledge(need, need.status === 'open' ? 'Explicitly reopened for review' : 'Research marked stale for review', changed ? undefined : at);
    } else if (changed && k.research_status !== 'stale' && k.evidence.length) {
        k.research_status = k.answer?.trim() ? 'evidence_received' : 'awaiting_answer';
    }
    // A negative application never creates verification. New application commands
    // distinguish task failure from a challenge to the underlying knowledge.
    k = need.knowledge;
    const legacyChanged = own(input.knowledge, 'application') && !equal(before?.application, input.knowledge.application);
    if (legacyChanged && own(input, 'record_application')) throw invalid('Use either record_application or knowledge.application');
    const challenge = legacyChanged ? appendApplication(k, before, input.knowledge.application, need, at, true)
        : own(input, 'record_application') ? appendApplication(k, before, input.record_application, need, at) : false;
    if (challenge) {
        if (verifying) throw invalid('A knowledge challenge cannot also verify the answer');
        need = reopenKnowledge(need, `Application reported ${k.application.status}`, changed ? undefined : at);
    }
    return need;
}
module.exports = { normalizeKnowledgeLifecycle, reopenKnowledge, legacyApplication, ROUTING_RECEIPT_PREFIX };
