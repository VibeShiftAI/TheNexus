/**
 * The initial backlog receipt: what the `record_backlog` intake operation checks and writes
 * (docs/project-intake.md, "The initial backlog receipt").
 *
 * Everything here runs inside the intake operation's transaction (db/project-intake.js), so the
 * tasks it creates and the receipt that names them commit together or not at all.
 *
 * The receipt records which tasks are the project's initial backlog, or why there are none yet.
 * It gives no task a schedule slot, starts no run and publishes nothing, and nothing outside
 * intake reads it.
 */
const crypto = require('crypto');
const { normalizeTaskBoardStatus } = require('@praxis/contract');
const { invalid } = require('./project-data');
const { knowledgeMetadataError } = require('../server/lib/task-knowledge');
const { normalizeSourceClaim } = require('../server/lib/provenance');

/** `detail` is the part of the error the intake route returns beside `error` and `code`. */
const fail = (message, code, status = 409, detail) => Object.assign(invalid(message, status), { code, ...(detail ? { detail } : {}) });
const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const bySlot = (a, b) => a.slot - b.slot;
const statusOf = task => normalizeTaskBoardStatus(task.status) || String(task.status || '').trim().toLowerCase();

/** A task in one of these states is not backlog: it was withdrawn, or it ended without delivering. */
const WITHDRAWN = new Set(['archived', 'cancelled', 'failed']);
/** Not open work: withdrawn, or finished. */
const CLOSED = new Set([...WITHDRAWN, 'completed']);
/**
 * Recorded as the source of created tasks when the caller claims none. Agent tier
 * (server/lib/provenance.js): produced through this system, never human-attested. A task with no
 * source at all would read as human-filed to Praxis's planner.
 */
const DEFAULT_SOURCE = 'nexus-api';
/** A deferral that rests on a declared hold instead of a message names it this way. */
const HOLD_PREFIX = 'hold:';
/** Every task the receipt creates is a proposal on the board. Status is not an input. */
const CREATED_STATUS = 'idea';

/** Board timestamps are ISO; a row stamped by SQLite's own default carries "YYYY-MM-DD HH:MM:SS" in UTC. */
function boardTime(value) {
    const raw = String(value || '').trim().replace(' ', 'T');
    return raw ? Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}Z`) : NaN;
}
/** A stamp stored to the second cannot be ordered inside the second, so it counts from the acceptance second. */
function createdSince(task, acceptedAt) {
    const raw = String(task.created_at || ''), accepted = boardTime(acceptedAt);
    return boardTime(raw) >= (/\.\d/.test(raw) ? accepted : Math.floor(accepted / 1000) * 1000);
}
function metadataOf(row) {
    try { return plain(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata); } catch { return {}; }
}
/** A slot body is JSON, so two bodies are the same when their JSON is, whatever the order of their keys. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const sameBody = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The identity Nexus gives the task filed for one planned slot of one acceptance. The caller cannot set it. */
function backlogProposalId(projectId, acceptedAt, slot) {
    return `intake-backlog:${projectId}:${acceptedAt}:${slot}`;
}

/** Tasks on the project that are still open work: not archived, cancelled, failed or completed. */
function openTaskCount(db, projectId) {
    return db.prepare('SELECT status FROM tasks WHERE project_id = ?').all(projectId).filter(task => !CLOSED.has(statusOf(task))).length;
}

/**
 * A schema failure inside one proposal or remaining body, restated with its slot. Null for any
 * other failure. The shared contract checks body fields, so without this an empty name would be
 * reported by array position instead of by slot.
 */
function backlogProposalIssue(raw, issues) {
    if (!raw || raw.action !== 'record_backlog') return null;
    const issue = issues.find(i => ['proposals', 'remaining'].includes(i.path[0]) && Number.isInteger(i.path[1]));
    if (!issue) return null;
    const [list, index, ...field] = issue.path;
    const slot = raw[list]?.[index]?.slot;
    const named = Number.isInteger(slot) && slot > 0 ? `slot ${slot}` : `entry ${index + 1} (no valid slot)`;
    return fail(`${list} ${named}: ${field.join('.') || 'body'}: ${issue.message}. Nothing was created.`, 'INTAKE_BACKLOG_PROPOSAL_INVALID', 400,
        { list, ...(Number.isInteger(slot) && slot > 0 ? { slot } : { index }) });
}

/**
 * Check a `record_backlog` call against the acceptance, the current receipt and the board, create
 * the proposed tasks, and return the acceptance with the new receipt. Throws before anything is
 * created when a check fails; the caller's transaction rolls back whatever a later failure left.
 *
 * `batchCreateTasks` is the db layer's own batch create. It returns [] on an ordinary failure
 * instead of throwing, so its result is checked here.
 */
function recordBacklog({ db, batchCreateTasks, input, intake, project, at }) {
    const acceptance = intake.acceptance;
    if (!acceptance) throw fail('This intake has no recorded acceptance to file a backlog against', 'INTAKE_STATE_CONFLICT');
    const current = acceptance.backlog || null;
    const proposals = [...(input.proposals || [])].sort(bySlot), remaining = [...(input.remaining || [])].sort(bySlot);
    const covers = input.covers || [], taskIds = [...new Set(input.task_ids || [])];
    const proposalId = slot => backlogProposalId(project.id, acceptance.at, slot);

    if (input.brief_revision !== undefined && input.brief_revision !== intake.brief_revision) {
        throw fail(input.brief_revision < acceptance.brief_revision
            ? `brief_revision ${input.brief_revision} is older than the accepted brief (${acceptance.brief_revision}); plan against the current brief (${intake.brief_revision})`
            : `brief_revision ${input.brief_revision} is not the current brief (${intake.brief_revision}); read the intake and plan against it`,
        'INTAKE_BACKLOG_BRIEF_STALE', 409, { brief_revision: intake.brief_revision, accepted_brief_revision: acceptance.brief_revision });
    }

    // One receipt per acceptance. Replacing it has to name it, so no writer overwrites a receipt it has not read.
    if (current && input.supersedes !== current.operation_id) {
        throw fail(input.supersedes
            ? `supersedes names ${input.supersedes}, but the current receipt is ${current.operation_id}. Read it, then name it in supersedes.`
            : `An initial backlog is already recorded (${current.status}, operation ${current.operation_id}). Report its task_ids, or replace it by naming that operation in supersedes.`,
        'INTAKE_BACKLOG_EXISTS', 409, { backlog: current });
    }
    if (!current && input.supersedes) throw fail('supersedes names a receipt, but none is recorded for this acceptance', 'INTAKE_BACKLOG_SUPERSEDES_UNKNOWN', 409, { backlog: null });

    // ---- Which fields each status takes ----
    const shape = message => fail(message, 'INVALID_INTAKE', 400);
    if (input.status === 'generated' && !proposals.length && !taskIds.length && !covers.length) throw shape('generated needs proposals for Nexus to create, task_ids of tasks already filed, or both');
    if (input.status === 'existing') {
        if (!taskIds.length) throw shape('existing needs at least one task_id of an open task that covers the accepted next step');
        if (proposals.length || remaining.length) throw shape('existing records tasks that are already on the board; it takes no proposals and no remaining slots. Use generated to file or hold planned slots.');
    }
    if (input.status !== 'generated' && covers.length) throw shape('covers belongs to a generated receipt');
    if (covers.length && !current) throw shape('covers accounts for a slot the superseded receipt left unfiled; there is no receipt to supersede');
    if (input.status === 'deferred') {
        const hold = input.source_ref?.trim().startsWith(HOLD_PREFIX) ? input.source_ref.trim().slice(HOLD_PREFIX.length).trim() : null;
        if (!input.reason?.trim() || !input.source_ref?.trim() || hold === '') {
            throw fail(`A deferral needs a reason and a source_ref: the reference of Robert's message that asked for it, or "${HOLD_PREFIX}<name>" for a declared hold. A bare deferral is not recorded.`, 'INTAKE_BACKLOG_REASON_REQUIRED', 400);
        }
        if (hold && !input.reason.toLowerCase().includes(hold.toLowerCase())) {
            throw fail(`The deferral cites the hold "${hold}", so its reason has to name that hold`, 'INTAKE_BACKLOG_REASON_REQUIRED', 400);
        }
        if (proposals.length) throw shape('deferred files nothing; it takes no proposals');
        // A deferral may replace a receipt that already names work. It carries that work; it adds none.
        const added = taskIds.filter(id => !current?.task_ids.includes(id));
        const addedSlots = remaining.filter(body => !current?.remaining.some(prior => prior.slot === body.slot)).map(body => body.slot);
        if (added.length || addedSlots.length) throw shape('deferred may only carry the task_ids and remaining slots of the receipt it supersedes');
    }

    // ---- Proposal bodies: refused by slot, before anything is created ----
    const bad = (list, slot, message) => fail(`${list} slot ${slot}: ${message}. Nothing was created.`, 'INTAKE_BACKLOG_PROPOSAL_INVALID', 400, { list, slot });
    const filedBefore = new Map((current?.proposals || []).map(body => [body.slot, body.task_id]));
    const seen = new Map();
    for (const [list, bodies] of [['proposals', proposals], ['remaining', remaining], ['covers', covers]]) {
        for (const body of bodies) {
            if (seen.has(body.slot)) throw bad(list, body.slot, seen.get(body.slot) === list ? 'the slot appears more than once' : `the slot is also in ${seen.get(body.slot)}; a slot is accounted for in one way`);
            if (filedBefore.has(body.slot)) throw bad(list, body.slot, `the slot was already filed as task ${filedBefore.get(body.slot)} under the receipt being superseded`);
            seen.set(body.slot, list);
        }
    }
    for (const cover of covers) {
        if (!current.remaining.some(prior => prior.slot === cover.slot)) throw bad('covers', cover.slot, 'the superseded receipt holds no unfiled slot with this number');
    }
    // A dependency has to resolve to a real task id now. A slot: filed in this call, filed before, or
    // covered. A task id: one the receipt names, so it is checked below like every named task.
    const newIds = new Map(proposals.map(body => [body.slot, crypto.randomUUID()]));
    const slotTask = new Map([...filedBefore, ...covers.map(cover => [cover.slot, cover.task_id]), ...newIds]);
    const planned = new Set([...slotTask.keys(), ...remaining.map(body => body.slot)]);
    const namedTasks = new Set([...taskIds, ...covers.map(cover => cover.task_id), ...(current?.task_ids || [])]);
    for (const [list, bodies, known] of [['proposals', proposals, slotTask], ['remaining', remaining, planned]]) {
        for (const body of bodies) {
            for (const dependency of body.dependencies || []) {
                if (typeof dependency === 'string') {
                    if (!namedTasks.has(dependency)) throw bad(list, body.slot, `it depends on task ${dependency}, which this receipt does not name in task_ids`);
                    continue;
                }
                if (dependency === body.slot) throw bad(list, body.slot, 'it depends on its own slot');
                if (!known.has(dependency)) throw bad(list, body.slot, list === 'proposals'
                    ? `it depends on slot ${dependency}, which is not filed in this call or under the receipt being superseded`
                    : `it depends on slot ${dependency}, which is not part of this backlog`);
            }
            const metadataProblem = knowledgeMetadataError(body.metadata);
            if (metadataProblem) throw bad(list, body.slot, metadataProblem);
        }
    }
    // A chain of slots that leads back to where it started would file tasks that can never unblock.
    const edges = new Map([...proposals, ...remaining].map(body => [body.slot, (body.dependencies || []).filter(Number.isInteger)]));
    const reaches = (from, target, visited = new Set()) => (edges.get(from) || [])
        .some(next => next === target || (!visited.has(next) && reaches(next, target, visited.add(next))));
    for (const [list, bodies] of [['proposals', proposals], ['remaining', remaining]]) {
        for (const body of bodies) if (reaches(body.slot, body.slot)) throw bad(list, body.slot, 'its dependencies lead back to its own slot');
    }

    // ---- Tasks the call names: live on this project ----
    const board = new Map(db.prepare('SELECT id, status, created_at, metadata FROM tasks WHERE project_id = ?').all(project.id).map(row => [row.id, row]));
    // Ids the superseded receipt already holds were checked when it was written; a task archived since must not block the record.
    const carried = new Set(current?.task_ids || []);
    const problems = [];
    for (const id of [...taskIds.filter(id => !carried.has(id)), ...covers.map(cover => cover.task_id)]) {
        const row = board.get(id), status = row && statusOf(row);
        if (!row) problems.push({ task_id: id, problem: 'not a task on this project' });
        else if (WITHDRAWN.has(status)) problems.push({ task_id: id, problem: `the task is ${status}, so it is not backlog` });
        else if (input.status === 'existing' && status === 'completed') problems.push({ task_id: id, problem: 'the task is completed, so it is not open work for the next step' });
    }
    if (problems.length) {
        throw fail(`These task ids cannot be recorded as the backlog of this project: ${problems.map(p => `${p.task_id} (${p.problem})`).join('; ')}. Nothing was created.`,
            'INTAKE_BACKLOG_TASK_UNKNOWN', 400, { task_ids: problems.map(p => p.task_id), problems });
    }

    // ---- A superseding receipt may not lose work ----
    if (current) {
        const droppedIds = current.task_ids.filter(id => !taskIds.includes(id));
        const droppedSlots = [];
        for (const prior of current.remaining) {
            const carriedBody = remaining.find(body => body.slot === prior.slot);
            const cover = covers.find(entry => entry.slot === prior.slot);
            if (carriedBody) { if (!sameBody(carriedBody, prior)) droppedSlots.push({ slot: prior.slot, problem: 'carried in remaining with a changed body' }); }
            else if (cover) {
                const row = board.get(cover.task_id);
                if (!createdSince(row, acceptance.at) || plain(metadataOf(row).work_identity).proposal_id !== proposalId(prior.slot)) {
                    droppedSlots.push({ slot: prior.slot, problem: `task ${cover.task_id} was not filed for this slot after acceptance (its work_identity.proposal_id is not ${proposalId(prior.slot)})` });
                }
            } else if (!newIds.has(prior.slot)) droppedSlots.push({ slot: prior.slot, problem: 'not carried in remaining, not filed as a proposal and not named in covers' });
        }
        if (droppedIds.length || droppedSlots.length) {
            throw fail(['The superseding receipt would lose recorded work.',
                ...(droppedIds.length ? [`task_ids must still include ${droppedIds.join(', ')}.`] : []),
                ...droppedSlots.map(entry => `Slot ${entry.slot}: ${entry.problem}.`),
                'The current receipt is unchanged and nothing was created.'].join(' '),
            'INTAKE_BACKLOG_PARTIAL_DROPPED', 409, { dropped_task_ids: droppedIds, dropped_slots: droppedSlots.map(entry => entry.slot), backlog: current });
        }
    }

    // ---- Tasks filed since acceptance that no receipt names: record them, do not file a second backlog beside them ----
    if (proposals.length) {
        const named = new Set([...taskIds, ...covers.map(cover => cover.task_id), ...carried]);
        const unrecorded = [...board.values()].filter(row => !named.has(row.id) && !WITHDRAWN.has(statusOf(row)) && createdSince(row, acceptance.at)).map(row => row.id);
        if (unrecorded.length) {
            throw fail(`${unrecorded.length} task(s) were filed on this project since acceptance and no receipt names them: ${unrecorded.join(', ')}. Record them with generated and task_ids before filing more. Nothing was created.`,
                'INTAKE_BACKLOG_UNRECORDED_TASKS', 409, { task_ids: unrecorded });
        }
    }

    // ---- Create, inside the caller's transaction ----
    const claim = normalizeSourceClaim(input.source);
    if (claim.downgradedFrom) console.warn(`[Provenance] Refused operator-authorship claim "${claim.downgradedFrom}" on the intake backlog of project ${project.id}; recorded as "${claim.source}"`);
    const rows = proposals.map(body => ({
        id: newIds.get(body.slot), project_id: project.id, name: body.name, description: body.description, status: CREATED_STATUS,
        antigravity_payload: body.antigravity_payload,
        ...(body.dependencies?.length ? { dependencies: body.dependencies.map(dependency => (typeof dependency === 'string' ? dependency : slotTask.get(dependency))) } : {}),
        metadata: { ...(body.metadata || {}), work_identity: { ...plain(body.metadata?.work_identity), proposal_id: proposalId(body.slot) } },
        source: claim.source || DEFAULT_SOURCE,
        // The receipt's own timestamp, so "created by this operation" is exact and never earlier than the acceptance.
        created_at: at, last_activity_at: at,
    }));
    if (rows.length) {
        const notCreated = (where, detail) => fail(`The backlog could not be created: ${where}. Nothing was written: no task, no receipt, and the intake revision is unchanged. Correct the proposals and send them again under a new operation_id.`,
            'INTAKE_BACKLOG_CREATE_FAILED', 422, detail);
        let created;
        try { created = batchCreateTasks(rows); } catch (error) {
            // Admission refusing a proposal outright is the one failure the batch create throws.
            if (error.code !== 'work_admission_conflict') throw error;
            throw notCreated(`work admission refused a proposal (${error.message})`, { admission: error.message });
        }
        // One new task per proposal, in slot order, under the id minted for it. Admission handing back
        // an existing task for a slot is not a creation, so it fails here too.
        const complete = Array.isArray(created) && created.length === rows.length;
        const mismatch = complete ? created.findIndex((task, index) => !task || task.id !== rows[index].id) : -1;
        if (!complete) throw notCreated(`the board created ${Array.isArray(created) ? created.length : 0} of ${rows.length} tasks`);
        if (mismatch >= 0) {
            throw notCreated(`slot ${proposals[mismatch].slot} resolved to ${created[mismatch]?.id ? `existing task ${created[mismatch].id}` : 'no task'} instead of a new one`,
                { slot: proposals[mismatch].slot });
        }
    }

    const receipt = {
        status: input.status === 'generated' && remaining.length ? 'partial' : input.status,
        task_ids: [...new Set([...taskIds, ...covers.map(cover => cover.task_id), ...rows.map(row => row.id)])],
        // Bodies as the caller supplied them, each with the task it became. Earlier filings are carried forward.
        proposals: [...(current?.proposals || []),
            ...covers.map(cover => ({ ...current.remaining.find(prior => prior.slot === cover.slot), task_id: cover.task_id })),
            ...proposals.map(body => ({ ...body, task_id: newIds.get(body.slot) }))].sort(bySlot),
        remaining,
        ...(input.reason ? { reason: input.reason } : {}), ...(input.source_ref ? { source_ref: input.source_ref } : {}),
        brief_revision: intake.brief_revision, operation_id: input.operation_id, at,
        ...(current ? { supersedes: current.operation_id } : {}),
        replayed: false,
    };
    return { ...acceptance, backlog: receipt, ...(current ? { backlog_history: [...(acceptance.backlog_history || []), current] } : {}) };
}

/** The response to an identical retry of the operation that wrote a receipt says so; storage never does. */
function markBacklogReplayed(result, operationId) {
    for (const receipt of [result?.backlog, result?.intake?.acceptance?.backlog, result?.project?.intake?.acceptance?.backlog]) {
        if (receipt && receipt.operation_id === operationId) receipt.replayed = true;
    }
    return result;
}

module.exports = { recordBacklog, openTaskCount, backlogProposalId, backlogProposalIssue, markBacklogReplayed };
