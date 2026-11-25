#!/usr/bin/env node
/**
 * The one-time re-sort of Robert's Needs your review list under his ruling of 2026-11-25 ("go with C"), task
 * dcc2a7be (contract docs/contracts/document-review-deliverables.md section 15.6; report
 * docs/reports/2026-11-25-reviews-resort.md).
 *
 *   node scripts/reviews-resort.js --db <path to nexus.db> [--plan <plan.json>] [--execute]
 *
 * The plan (default scripts/reviews-resort-2026-11-25.json) lists every document waiting at the start of the task
 * with the outcome a reading of that document, its tasks, reviews, decisions and Robert's messages decided:
 *   move    nothing is waiting on it: it moves to Reference through the retirement record, with a review_resort
 *           ground citing the ruling and what the reading found (store.retireOnGround). No decision row is
 *           written, so Robert's request-review puts it back.
 *   record  decisions in its own text are waiting for Robert: they are recorded as review_resort decisions on its
 *           current version, a ground in force until his next decision on it. Nothing else changes.
 *   stay    a ground is already in force, or the reading was unsure: nothing is written.
 *
 * With --execute it first runs the review store's additive migrations (the review_ground column and the two new
 * retirement trigger types; the same migrations the Nexus API runs when it starts), then applies each document
 * under the write lock, re-checking it there:
 *   - a document that is gone, no longer waiting, on a different current version than the plan read, or decided
 *     by Robert since the plan's snapshot is skipped, with the reason;
 *   - a move needs no ground in force now (no waiting task, open decision, gated send or publish, or request of
 *     his) and every retirement guard clear (open replacement work, an unsent outgoing message, unsubmitted review
 *     work, waiting tasks, an agent review waiting for his choices); otherwise the document stays waiting and the
 *     reasons are printed. A document already moved under this ruling is never moved again, even after he put it
 *     back. One exception, named per document in the plan (`declared_decisions_answered`): declared decision items
 *     Robert answered in the free text of a review, which Nexus holds no structured answer for. The move goes ahead
 *     only when that is the sole ground in force and the Praxis decision record the plan names, read at run time,
 *     is for this document and its current version and holds an answer to every declared item.
 *   - recorded decisions pass the registration rules for decision items (parseDecisionItems) before anything is
 *     written; one invalid plan entry stops the run before the first write.
 * Without --execute it opens the database read-only and prints what each document would get; that needs a schema
 * that already carries review grounds, so to preview an unmigrated database run --execute on a copy of it.
 *
 * It never records approve or request-changes, never sends or publishes anything, and a second run reports what
 * the first one did instead of doing it again. Output: one JSON line per document, then one summary line with the
 * decision-row count before and after.
 *
 * Exit codes: 0 done; 1 the plan is invalid (nothing written); 2 usage error; 3 a read-only preview of a database
 * whose schema lacks review grounds.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../db/document-reviews');
const grounds = require('../server/services/document-review-grounds');
const { parseDecisionItems, REVISION_KEY } = require('../server/services/document-decision-items');

const EXIT = { ok: 0, plan: 1, usage: 2, schema: 3 };
const OUTCOMES = ['move', 'record', 'stay'];
const MESSAGE_REF = /^nexus:\/\/conversation\/[^/]+\/message\/[^/]+$/;
const text = value => typeof value === 'string' && value.trim().length > 0;

function usage(message) {
    if (message) console.error(`reviews-resort: ${message}`);
    console.error('usage: node scripts/reviews-resort.js --db <path to nexus.db> [--plan <plan.json>] [--execute]');
    process.exit(EXIT.usage);
}

function parseArgs(argv) {
    const args = { plan: path.join(__dirname, 'reviews-resort-2026-11-25.json'), execute: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--execute') args.execute = true;
        else if (arg === '--db' || arg === '--plan') {
            if (!text(argv[i + 1])) usage(`${arg} needs a value`);
            args[arg.slice(2)] = argv[i + 1];
            i += 1;
        } else usage(`unknown argument ${arg}`);
    }
    if (!args.db) usage('--db is required');
    return args;
}

/** Every problem with the plan, before the database is opened for writing. */
function planProblems(plan) {
    const problems = [];
    if (!MESSAGE_REF.test(plan?.ruling || '')) problems.push('ruling must be a saved chat message reference (nexus://conversation/<id>/message/<id>)');
    if (!text(plan?.task_id)) problems.push('task_id is required');
    if (!text(plan?.snapshot_at) || Number.isNaN(Date.parse(plan.snapshot_at))) problems.push('snapshot_at must be a date');
    if (!Array.isArray(plan?.documents) || plan.documents.length === 0) return [...problems, 'documents must be a non-empty list'];
    const seen = new Set();
    plan.documents.forEach((entry, index) => {
        const where = `documents[${index}]${text(entry?.id) ? ` (${entry.id})` : ''}`;
        if (!text(entry?.id)) problems.push(`${where}: id is required`);
        else if (seen.has(entry.id)) problems.push(`${where}: listed twice`);
        seen.add(entry?.id);
        if (!text(entry?.revision_id)) problems.push(`${where}: revision_id is required (the version the reading was of)`);
        if (!OUTCOMES.includes(entry?.outcome)) problems.push(`${where}: outcome must be one of ${OUTCOMES.join(', ')}`);
        if (!text(entry?.finding)) problems.push(`${where}: finding is required (what the reading found)`);
        if (entry?.outcome === 'record') {
            const parsed = parseDecisionItems(entry.decisions);
            if (!parsed.ok) problems.push(`${where}: ${parsed.error}`);
            else if (parsed.items.length === 0) problems.push(`${where}: record needs at least one decision`);
        } else if (entry?.decisions !== undefined) problems.push(`${where}: only a record outcome carries decisions`);
        const answered = entry?.declared_decisions_answered;
        if (answered !== undefined) {
            if (entry.outcome !== 'move') problems.push(`${where}: only a move names declared decisions answered elsewhere`);
            else if (!text(answered?.record) || !path.isAbsolute(answered.record) || !text(answered?.why)) {
                problems.push(`${where}: declared_decisions_answered needs the absolute path of the Praxis decision record and why`);
            }
        }
    });
    return problems;
}

const flag = value => value === 1 || value === true;

/** Where a document stands now: in the queue or not, its bucket, and which grounds are in force. */
function standing(store, id) {
    const doc = store.getDocument(id);
    if (!doc) return null;
    const position = store.queuePosition(doc);
    const row = position.row;
    return {
        waiting: position.waiting,
        bucket: position.bucket,
        requires_review: flag(row.requires_review),
        current_revision_id: doc.current_revision_id || null,
        ground_in_force: flag(row.ground_in_force),
        grounds_in_force: groundsHeld(row),
        ...(position.waiting ? {} : { reasons: position.reasons }),
    };
}

/** Why the plan no longer applies to `doc`, or null when it does. */
function staleReason(store, doc, entry, snapshotAt) {
    const position = store.queuePosition(doc);
    if (!position.waiting) return { result: 'skipped_not_waiting', reasons: position.reasons };
    if (doc.current_revision_id !== entry.revision_id) {
        return { result: 'skipped_revision_changed', reasons: [{ code: 'revision_changed', message: `Its current version is ${doc.current_revision_id}, not the version the reading was of (${entry.revision_id})` }] };
    }
    const latest = store.latestDecision(doc.id);
    if (latest && new Date(latest.created_at).toISOString() > snapshotAt) {
        return { result: 'skipped_decided_since', reasons: [{ code: 'decided_since', message: `Robert recorded a decision on it (${latest.decision}, ${latest.created_at}) after the reading` }] };
    }
    return null;
}

function resortGround(plan, entry) {
    return { type: 'review_resort', message_ref: plan.ruling, task_id: plan.task_id, finding: entry.finding };
}

const groundsHeld = row => ['task', 'decision', 'action', 'request'].filter(key => flag(row[`ground_${key}`]));

/**
 * Whether the Praxis decision record `spec.record` shows every decision item declared on `doc`'s current version
 * answered: the one case where the declared-decision ground is read wrongly from Nexus alone (answers given in a
 * review's free text). Only when that ground is the sole one in force, with no agent review or re-sort decision.
 */
function declaredAnsweredInPraxis(store, doc, row, spec) {
    const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
    const declared = Array.isArray(metadata.decision_items) ? metadata.decision_items.map(item => item?.id).filter(text) : [];
    if (!declared.length || metadata[REVISION_KEY] !== doc.current_revision_id) return { ok: false, message: 'No decision items are declared on its current version' };
    if (flag(row.agent_review_ready) || grounds.recordedDecisions(doc.review_ground, doc.current_revision_id, store.latestDecision(doc.id)).length) {
        return { ok: false, message: 'An agent review or a recorded decision also keeps it waiting' };
    }
    let record;
    try { record = JSON.parse(fs.readFileSync(spec.record, 'utf8')); } catch (error) { return { ok: false, message: `Cannot read the Praxis decision record: ${error.message}` }; }
    if (record.document_id !== doc.id || record.revision_id !== doc.current_revision_id) {
        return { ok: false, message: `The Praxis decision record is for ${record.document_id} at ${record.revision_id}, not this document's current version` };
    }
    const answers = new Map((Array.isArray(record.items) ? record.items : []).map(item => [item?.definition?.id, Array.isArray(item?.answers) ? item.answers : []]));
    const open = declared.filter(id => !(answers.get(id) || []).some(answer => text(answer?.answer)));
    if (open.length) return { ok: false, message: `${open.length} of ${declared.length} declared decisions have no answer in the Praxis decision record` };
    const statuses = {};
    for (const id of declared) {
        const list = answers.get(id);
        const status = list[list.length - 1]?.status || 'unknown';
        statuses[status] = (statuses[status] || 0) + 1;
    }
    return { ok: true, record: spec.record, declared: declared.length, answered: declared.length, last_answer_statuses: statuses, why: spec.why };
}

function movedUnderRuling(store, docId, ruling) {
    return store.listRetirements(docId).find(r => r.trigger === 'review_resort' && r.ground?.message_ref === ruling) || null;
}

function recordedUnderRuling(doc, ruling, revisionId) {
    const record = doc.review_ground;
    const list = record && Array.isArray(record.grounds) ? record.grounds : [];
    return list.filter(g => g?.type === 'decision' && g.source === 'review_resort' && g.ruling === ruling && g.revision_id === revisionId);
}

/** What applying `entry` does now (execute) or would do (preview). Run inside the write transaction when executing. */
function apply(store, plan, entry, { execute, snapshotAt, actorId }) {
    const doc = store.getDocument(entry.id);
    if (!doc) return { result: 'missing' };
    if (entry.outcome === 'stay') return { result: 'stayed', reason: entry.unsure ? { code: 'unsure', message: entry.unsure } : { code: 'ground_in_force', message: entry.finding } };

    if (entry.outcome === 'move') {
        const earlier = movedUnderRuling(store, doc.id, plan.ruling);
        if (earlier && !earlier.reopened_at) return { result: 'already_moved', retirement_id: earlier.id, retired_at: earlier.retired_at };
        if (earlier) {
            return { result: 'left_waiting', reasons: [{ code: 'put_back', message: `It was moved under this ruling on ${earlier.retired_at} and put back on ${earlier.reopened_at} (${earlier.reopened_via}); it is never moved again`, retirement_id: earlier.id }] };
        }
        const stale = staleReason(store, doc, entry, snapshotAt);
        if (stale) return stale;
        const row = store.getDocumentListRow(doc.id);
        let answeredElsewhere = null;
        if (flag(row.ground_in_force)) {
            const held = groundsHeld(row);
            const stays = { result: 'left_waiting', reasons: [{ code: 'ground_in_force', message: `Something is waiting on it now (${held.join(', ')}), so it stays`, grounds: held }] };
            if (!entry.declared_decisions_answered || held.join() !== 'decision') return stays;
            answeredElsewhere = declaredAnsweredInPraxis(store, doc, row, entry.declared_decisions_answered);
            if (!answeredElsewhere.ok) return { ...stays, reasons: [...stays.reasons, { code: 'declared_decisions_not_answered', message: answeredElsewhere.message }] };
        }
        const check = store.retirementCheck(doc);
        if (check.outcome !== 'retirable') return { result: check.outcome === 'not_waiting' ? 'skipped_not_waiting' : 'left_waiting', reasons: check.reasons };
        const exception = answeredElsewhere ? { declared_decisions_answered: answeredElsewhere } : {};
        if (!execute) return { result: 'would_move', ...exception };
        const retirement = store.retireOnGround({ target: doc, ground: resortGround(plan, entry) });
        if (!retirement) return { result: 'left_waiting', reasons: [{ code: 'not_retired', message: 'The retirement store declined to move it; see the standing below' }] };
        return { result: 'moved', retirement_id: retirement.id, retired_at: retirement.retired_at, trigger: retirement.trigger, previous: retirement.previous, ...exception };
    }

    const items = parseDecisionItems(entry.decisions).items;
    const already = new Set(recordedUnderRuling(doc, plan.ruling, entry.revision_id).map(g => g.id));
    if (items.every(item => already.has(item.id))) return { result: 'already_recorded', decision_ids: items.map(item => item.id) };
    const stale = staleReason(store, doc, entry, snapshotAt);
    if (stale) return stale;
    if (!execute) return { result: 'would_record', decision_ids: items.map(item => item.id) };
    const record = grounds.writeGroundRecord(store, doc.id, {
        actorId,
        add: items.map(item => ({ type: 'decision', source: 'review_resort', ...item, revision_id: entry.revision_id, ruling: plan.ruling, task_id: plan.task_id })),
    });
    return { result: 'recorded', decision_ids: items.map(item => item.id), recorded_at: record.recorded_at };
}

function hasGroundSchema(db) {
    const columns = db.pragma('table_info(review_documents)').map(column => column.name);
    const retirementSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'review_document_retirements'").get()?.sql || '';
    return columns.includes('review_ground') && retirementSql.includes("'review_resort'");
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    let plan;
    try { plan = JSON.parse(fs.readFileSync(args.plan, 'utf8')); } catch (error) { usage(`cannot read the plan ${args.plan}: ${error.message}`); }
    const problems = planProblems(plan);
    if (problems.length) {
        for (const problem of problems) console.error(`reviews-resort: plan: ${problem}`);
        process.exit(EXIT.plan);
    }
    if (!fs.existsSync(args.db)) usage(`no database at ${args.db}`);

    const db = new Database(args.db, args.execute ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 15000');
    if (args.execute) {
        db.pragma('foreign_keys = ON');
        initializeDocumentReviews(db);
    } else if (!hasGroundSchema(db)) {
        console.error('reviews-resort: this database has no review grounds yet (the review_ground column and the review_resort retirement type); a read-only preview cannot add them. Run --execute on a copy (sqlite3 .backup) to see the effect.');
        process.exit(EXIT.schema);
    }
    const store = createDocumentReviewStore(db);
    const snapshotAt = new Date(plan.snapshot_at).toISOString();
    const actorId = `review_resort:${plan.task_id}`;
    const decisionRows = () => db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS max_rowid FROM review_document_decisions').get();
    const decisionsBefore = decisionRows();
    const tally = {};
    for (const entry of plan.documents) {
        const run = () => apply(store, plan, entry, { execute: args.execute, snapshotAt, actorId });
        const outcome = args.execute ? db.transaction(run).immediate() : run();
        tally[outcome.result] = (tally[outcome.result] || 0) + 1;
        const doc = store.getDocument(entry.id);
        console.log(JSON.stringify({ id: entry.id, title: doc?.title ?? entry.title, plan: entry.outcome, ...outcome, standing: standing(store, entry.id) }));
    }
    const decisionsAfter = decisionRows();
    console.log(JSON.stringify({
        summary: { mode: args.execute ? 'execute' : 'preview', documents: plan.documents.length, ...tally },
        decision_rows: { before: decisionsBefore, after: decisionsAfter },
        retirements_under_ruling: db.prepare("SELECT COUNT(*) AS n FROM review_document_retirements WHERE trigger = 'review_resort' AND json_extract(ground, '$.message_ref') = ?").get(plan.ruling).n,
    }));
    db.close();
}

if (require.main === module) main();

module.exports = { planProblems, apply };
