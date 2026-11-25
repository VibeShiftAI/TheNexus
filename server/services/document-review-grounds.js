/**
 * Review grounds (contract docs/contracts/document-review-deliverables.md §15; task dcc2a7be, Robert's ruling of
 * 2026-11-25, "go with C"). A document reaches Needs your review only when something is waiting on it:
 *
 *   task              an active Nexus task on its waiting-task list cannot proceed until Robert decides
 *   decision          decision items bound to its current version, at least one without an answer Robert has sent,
 *                     or an agent's suggested edits to the current version waiting for his choices, or a decision the
 *                     one-time re-sort recorded from the document's own brief (question and recommendation) for its
 *                     current version, until he records a decision after it
 *   gated_action      its intended action is send, publish or implement, so his approval is what allows it
 *   operator_request  Robert asked to see it: a request of his cited by its saved Nexus chat message, his own
 *                     "Move to review queue" (request-review), or changes he requested on an earlier version.
 *                     A request counts until he records a decision after it.
 *
 * "Approve this as ready" on a finished report, a walkthrough, an evidence file or a sign-off on something already
 * merged or live is not a ground. A registration that asks for review without one is registered as reference
 * through the retirement record (ground `no_review_ground`, db/document-retirements.js): never refused, never
 * silently accepted, and the existing request-review call puts it back.
 *
 * Whether a ground is in force is computed in SQL by db/document-reviews.js (documentQuery: ground_task,
 * ground_decision, ground_action, ground_request, ground_in_force), so the list filter, the counts and every read
 * agree. This module parses what a caller names, keeps the stored ground record (review_documents.review_ground)
 * for the route and the re-sort alike, and words what is waiting on a document in plain language.
 */
const { parseBlockingTaskIds } = require('../../db/document-review-blockers');

const REVIEW_GROUND_TYPES = ['task', 'decision', 'gated_action', 'operator_request'];
/** Intended actions that only Robert's approval allows. */
const GATED_ACTIONS = new Set(['send', 'publish', 'implement']);
const DECISION_ID = /^[a-zA-Z0-9_-]+$/;
const MESSAGE_REF = /^nexus:\/\/conversation\/([^/]+)\/message\/([^/]+)$/;
/** The fields each named ground may carry besides its type. */
const ENTRY_FIELDS = {
    task: ['task_ids'],
    decision: ['decision_ids'],
    gated_action: ['intended_action'],
    operator_request: ['message_ref'],
};
const ACTION_WORDS = { send: 'sent', publish: 'published', implement: 'implemented' };

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A saved Nexus chat message reference (nexus://conversation/<id>/message/<id>) split into its ids, or null. */
function parseMessageRef(value) {
    if (typeof value !== 'string') return null;
    const ref = value.trim();
    const parts = MESSAGE_REF.exec(ref);
    if (!parts) return null;
    try {
        const conversationId = decodeURIComponent(parts[1]);
        const messageId = decodeURIComponent(parts[2]);
        return conversationId && messageId ? { ref, conversation_id: conversationId, message_id: messageId } : null;
    } catch {
        return null;
    }
}

function rejection(type, reason) {
    return { type: typeof type === 'string' ? type : null, reason };
}

/**
 * What a caller named in `review_ground`: one ground object or a list of them. Never refuses: a malformed entry is
 * returned in `rejected` with its reason, so a registration can say why it was registered as reference.
 */
function parseNamedGrounds(value) {
    if (value === undefined || value === null) return { entries: [], rejected: [] };
    const list = Array.isArray(value) ? value : [value];
    const entries = [];
    const rejected = [];
    if (!list.length) rejected.push(rejection(null, 'review_ground named no ground'));
    for (const raw of list) {
        if (!isPlainObject(raw) || !REVIEW_GROUND_TYPES.includes(raw.type)) {
            rejected.push(rejection(isPlainObject(raw) ? raw.type : null, `A review ground is an object whose type is one of ${REVIEW_GROUND_TYPES.join(', ')}`));
            continue;
        }
        const extra = Object.keys(raw).filter(key => key !== 'type' && !ENTRY_FIELDS[raw.type].includes(key));
        if (extra.length) {
            rejected.push(rejection(raw.type, `Unknown field(s) for a ${raw.type} ground: ${extra.join(', ')}`));
            continue;
        }
        if (raw.type === 'task') {
            // Without task_ids the ground is the document's waiting-task list as declared (deliverable.blocking_task_ids).
            const parsed = raw.task_ids === undefined ? null : parseBlockingTaskIds(raw.task_ids);
            if (parsed && (!parsed.ok || !parsed.value.length)) rejected.push(rejection('task', 'task_ids must be a list of the ids of tasks on this document’s waiting-task list'));
            else entries.push({ type: 'task', ...(parsed ? { task_ids: parsed.value } : {}) });
        } else if (raw.type === 'decision') {
            const ids = raw.decision_ids;
            if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !DECISION_ID.test(id)))) {
                rejected.push(rejection('decision', 'decision_ids must be a list of the ids of decision items declared on this version'));
            } else {
                entries.push({ type: 'decision', ...(ids ? { decision_ids: [...new Set(ids)] } : {}) });
            }
        } else if (raw.type === 'gated_action') {
            if (raw.intended_action !== undefined && !GATED_ACTIONS.has(raw.intended_action)) {
                rejected.push(rejection('gated_action', 'A gated action is send, publish or implement'));
            } else {
                entries.push({ type: 'gated_action', ...(raw.intended_action ? { intended_action: raw.intended_action } : {}) });
            }
        } else {
            const ref = parseMessageRef(raw.message_ref);
            if (!ref) rejected.push(rejection('operator_request', 'An operator request cites Robert’s saved chat message as nexus://conversation/<id>/message/<id>'));
            else entries.push({ type: 'operator_request', message_ref: ref.ref });
        }
    }
    return { entries, rejected };
}

/**
 * Whether a cited chat message is Robert's own request, newer than the latest decision on the document. `message`
 * is the row Nexus read for the reference (null when there is none); `latestDecisionAt` the time of the document's
 * latest decision, if any. Returns { ok: true, requested_at } or { ok: false, reason }.
 */
function checkOperatorMessage(ref, message, latestDecisionAt) {
    const parsed = parseMessageRef(ref);
    if (!parsed) return { ok: false, reason: 'The message reference is malformed' };
    if (!message) return { ok: false, reason: `No saved Nexus chat message has the reference ${parsed.ref}` };
    if (message.conversation_id !== parsed.conversation_id) return { ok: false, reason: `Message ${parsed.message_id} belongs to another conversation` };
    if (message.role !== 'user') return { ok: false, reason: `Message ${parsed.message_id} is not Robert’s own message (its role is ${message.role})` };
    const at = typeof message.created_at === 'string' ? message.created_at : null;
    if (!at) return { ok: false, reason: `Message ${parsed.message_id} has no recorded time` };
    if (latestDecisionAt && !(at > latestDecisionAt)) {
        return { ok: false, reason: `Message ${parsed.message_id} was sent before the latest decision on this document (${latestDecisionAt}), so it asked for an earlier review` };
    }
    return { ok: true, requested_at: at };
}

/**
 * Check the task, decision and gated-action grounds a caller named against the document as registered. `inForce` is
 * the list of grounds in force built from the same state (the route's groundDetails); a named ground holds only when
 * that ground is in force and covers what was named. Operator requests are checked on their own
 * (checkOperatorMessage). Returns { held, rejected }: the entries that hold, and a reason for each one that does not.
 */
function checkNamedGrounds(entries, inForce, declaredDecisionIds = new Set()) {
    const byType = type => inForce.filter(ground => ground.type === type);
    const held = [];
    const rejected = [];
    for (const entry of entries) {
        if (entry.type === 'task') {
            const waiting = new Set(byType('task').flatMap(ground => ground.task_ids || []));
            if (entry.task_ids ? !entry.task_ids.some(id => waiting.has(id)) : !waiting.size) {
                rejected.push(rejection('task', entry.task_ids
                    ? 'None of the named tasks is an active task on this document’s waiting-task list (deliverable.blocking_task_ids)'
                    : 'No active task is on this document’s waiting-task list (deliverable.blocking_task_ids)'));
            } else held.push(entry);
        } else if (entry.type === 'decision') {
            const open = new Set(byType('decision').flatMap(ground => ground.decision_ids || []));
            const agentReview = byType('decision').some(ground => ground.source === 'agent_review');
            const unknown = (entry.decision_ids || []).filter(id => !declaredDecisionIds.has(id));
            if (unknown.length) rejected.push(rejection('decision', `Not declared on this version: ${unknown.join(', ')}`));
            else if (entry.decision_ids ? !entry.decision_ids.some(id => open.has(id)) : !open.size && !agentReview) {
                rejected.push(rejection('decision', entry.decision_ids
                    ? 'None of the named decisions is still waiting for an answer'
                    : 'No decision item declared on this version is waiting for an answer'));
            } else held.push(entry);
        } else if (entry.type === 'gated_action') {
            const action = byType('gated_action')[0]?.intended_action;
            if (!action) rejected.push(rejection('gated_action', 'The document’s intended action is none, so no approval gates an action'));
            else if (entry.intended_action && entry.intended_action !== action) {
                rejected.push(rejection('gated_action', `The document’s intended action is ${action}, not ${entry.intended_action}`));
            } else held.push({ type: 'gated_action', intended_action: action });
        }
    }
    return { held, rejected };
}

// ── The stored ground record ──────────────────────────────────────────────
// What registrations named that held, the re-sort's recorded grounds and Robert's own requests. Named grounds are
// stamped with when they were recorded, so they place a document in the queue only until it next leaves it.

function recordGrounds(record) {
    return isPlainObject(record) && Array.isArray(record.grounds) ? record.grounds.filter(isPlainObject) : [];
}

/** Robert's requests in a stored ground record that still count: recorded after `latest` (the latest decision), if any. */
function activeRequests(record, latest) {
    const after = latest?.created_at || '';
    return recordGrounds(record).filter(g => g.type === 'operator_request' && typeof g.requested_at === 'string' && g.requested_at > after);
}

/**
 * Robert's request-review put-backs that still count: retirements reopened with it after `latest` (the latest
 * decision), newest first, as requests. Code from before recorded requests marks a put-back only on the retirement.
 */
function reopenedRequests(retirements, latest) {
    const after = latest?.created_at || '';
    return (Array.isArray(retirements) ? retirements : [])
        .filter(r => r && r.reopened_via === 'request_review' && typeof r.reopened_at === 'string' && r.reopened_at > after)
        .sort((a, b) => (a.reopened_at < b.reopened_at ? 1 : a.reopened_at > b.reopened_at ? -1 : 0))
        .map(r => ({ type: 'operator_request', via: 'request_review', requested_at: r.reopened_at, requested_by: r.reopened_by || null, retirement_id: r.id }));
}

/** When a document last left the review queue: its latest decision or retirement (reopened ones included). */
function groundCutoff(store, docId) {
    const times = [store.latestDecision(docId)?.created_at, ...store.listRetirements(docId).map(r => r.retired_at)];
    return times.filter(t => typeof t === 'string').sort().pop() || '';
}

/**
 * The grounds a registration or the re-sort named that held, as recorded since the document last left the queue
 * (`cutoff`, groundCutoff): they placed it there and it has stayed. Older ones belong to a time it was decided or
 * moved out since.
 */
function currentNamedGrounds(record, cutoff) {
    return recordGrounds(record).filter(g => g.type !== 'operator_request' && typeof g.recorded_at === 'string' && g.recorded_at > cutoff);
}

/** Decisions the re-sort recorded from the document's brief that hold on `revisionId`: none answered by a later decision. */
function recordedDecisions(record, revisionId, latest) {
    const after = latest?.created_at || '';
    return recordGrounds(record).filter(g => g.type === 'decision' && g.source === 'review_resort' && revisionId && g.revision_id === revisionId
        && typeof g.recorded_at === 'string' && g.recorded_at > after);
}

/**
 * Store a document's ground record (review_documents.review_ground) through `store` (db/document-reviews.js).
 * `add` are grounds that hold now: each named one is stamped with the registration that named it (if any) and when,
 * replacing an earlier one of its type; earlier named grounds of other types recorded since the document last left
 * the queue are carried, as are Robert's requests that still count (one per chat message, one for his own
 * request-review). `rejected`, `registrationId` and `revisionId` describe the registration that named them; left
 * undefined (a review request, the re-sort), the record's own are kept. Run inside the caller's transaction.
 */
function writeGroundRecord(store, docId, { add = [], rejected, registrationId, revisionId, actorId = null }) {
    const doc = store.getDocument(docId);
    const previous = isPlainObject(doc.review_ground) ? doc.review_ground : null;
    const now = new Date().toISOString();
    const requests = new Map();
    for (const g of [...activeRequests(previous, store.latestDecision(docId)), ...add.filter(g => g.type === 'operator_request')]) {
        requests.set(g.via === 'chat' ? `chat:${g.message_ref}` : g.via, g);
    }
    const added = add.filter(g => g.type !== 'operator_request').map(g => ({ ...g, registration_id: registrationId ?? null, recorded_at: now }));
    const addedTypes = new Set(added.map(g => g.type));
    const carried = currentNamedGrounds(previous, groundCutoff(store, docId)).filter(g => !addedTypes.has(g.type));
    const record = {
        grounds: [...carried, ...added, ...requests.values()],
        rejected: rejected !== undefined ? rejected : (Array.isArray(previous?.rejected) ? previous.rejected : []),
        registration_id: registrationId !== undefined ? registrationId : (previous?.registration_id ?? null),
        revision_id: revisionId !== undefined ? revisionId : (previous?.revision_id ?? null),
        recorded_at: now,
        recorded_by: actorId || 'unknown',
    };
    store.updateDocument(docId, { review_ground: record });
    return record;
}

/** One plain sentence naming what is waiting on a document for each ground in force. */
function groundSummary(ground) {
    switch (ground.type) {
        case 'task': {
            const names = (ground.tasks || []).map(task => task.title || task.id);
            if (names.length === 1) return `Task “${names[0]}” is waiting on your review.`;
            return `${names.length} tasks are waiting on your review: ${names.join('; ')}.`;
        }
        case 'decision': {
            if (ground.source === 'agent_review') return 'An agent’s suggested edits to this version are waiting for your choices.';
            if (ground.source === 'review_resort') return `A decision is waiting for your answer: ${ground.question}`;
            const open = (ground.decision_ids || []).length;
            if (!open) return 'Decisions on this version are waiting for your answers.';
            const total = ground.declared_count || open;
            if (open === total) return open === 1 ? '1 decision is waiting for your answer.' : `${open} decisions are waiting for your answers.`;
            return `${open} of ${total} decisions are still waiting for your answer${open === 1 ? '' : 's'}.`;
        }
        case 'gated_action':
            return `Your approval is what allows it to be ${ACTION_WORDS[ground.intended_action] || ground.intended_action}.`;
        case 'operator_request':
            if (ground.via === 'changes_requested') {
                return ground.on_current ? 'You asked for changes to this version.' : 'You asked for changes to an earlier version; this is the new version.';
            }
            if (ground.via === 'request_review') return 'You put it in your review queue yourself.';
            return 'You asked to see it in chat.';
        default:
            return '';
    }
}

module.exports = {
    REVIEW_GROUND_TYPES,
    GATED_ACTIONS,
    parseMessageRef,
    parseNamedGrounds,
    checkOperatorMessage,
    checkNamedGrounds,
    activeRequests,
    reopenedRequests,
    groundCutoff,
    currentNamedGrounds,
    recordedDecisions,
    writeGroundRecord,
    groundSummary,
};
