/**
 * Guided blind-labelling API for the Groundrules gold-set packet.
 * Mounted at /api/groundrules-labeling (server/server.js). Services:
 * server/services/groundrules-labeling/*. Contract: docs/contracts/
 * groundrules-blind-labeling.md.
 *
 *   GET  /tasks/:taskId                 is this task linked; packet digests
 *                                       and counts; the session summary
 *   GET  /whoami                        redacted: does this request carry an
 *                                       operator proof (for the Save UI)
 *   POST /tasks/:taskId/session         start (or resume) the session bound
 *                                       to the current packet            [write]
 *   GET  /sessions/:id                  session, progress, Stage A content,
 *                                       answers of unlocked stages only
 *   GET  /sessions/:id/stages/:stage    stage content; B needs A committed,
 *                                       C needs B committed, and each is
 *                                       403 until its reveal was POSTed
 *   POST /sessions/:id/reveal/:stage    the operator's deliberate first
 *                                       disclosure of B or C; this POST,
 *                                       never a read, records exposure [write]
 *   PUT  /sessions/:id/answers/:stage/:itemId   save a draft/unsure/complete
 *                                       answer (optimistic revision)      [write]
 *   POST /sessions/:id/commit/:stage    freeze the stage; refuses incomplete
 *                                       or invalid records, keeps drafts  [write]
 *   POST /sessions/:id/revisions/:itemId   post-exposure revision of a
 *                                       committed Stage A reading         [write]
 *   POST /sessions/:id/exports/:kind    write labels/judgments/annotations
 *                                       into the Groundrules gold set     [write]
 *   POST /sessions/:id/rebind           deliberate rebind after the packet
 *                                       changed; answers carried as drafts [write]
 *
 * Stage gating is enforced here, not in the page: the Stage A response and
 * the session read never contain Part B or Part C content. Every write
 * carries the packet sha256 the page loaded and is refused when it differs
 * from the session's binding or from the packet on disk.
 */
const express = require('express');
const { createPacketSource, packetSummary } = require('../services/groundrules-labeling/packet');
const { createLabelingStore, STAGES } = require('../services/groundrules-labeling/store');
const { validateFor, ShapeError, STATES } = require('../services/groundrules-labeling/validation');
const { buildDocument, writeExport, KINDS, TARGETS } = require('../services/groundrules-labeling/export');
const { createLabelingWriteAuthority } = require('../services/groundrules-labeling/authority');
const links = require('../services/groundrules-labeling/links');

const ERROR_STATUSES = [400, 401, 403, 404, 409, 412, 422, 503];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const fail = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

function respondError(res, error) {
    const status = ERROR_STATUSES.includes(error.status) ? error.status : 500;
    if (status === 500) console.error('[GroundrulesLabeling] operation failed:', error);
    const { message, code, status: _s, stack: _st, ...extra } = error;
    res.status(status).json({ error: status === 500 ? 'Labeling operation failed' : message, ...(code ? { code } : {}), ...(status === 500 ? {} : extra) });
}

function createGroundrulesLabelingRouter({ db, dbPath, packetSource = createPacketSource(), authorizeWrite = createLabelingWriteAuthority(), store: injectedStore, operatorInspect } = {}) {
    const router = express.Router();
    const store = injectedStore || createLabelingStore(dbPath ? { dbPath } : {});

    const loadPacket = () => {
        try {
            return packetSource.load();
        } catch (err) {
            throw fail(503, `The packet could not be read: ${err.code || err.message}`, 'packet_unavailable');
        }
    };
    const totals = packet => ({ A: packet.counts.rows, B: packet.counts.controls, C: packet.counts.pairs });
    const itemsFor = (packet, stage) => (stage === 'A' ? Array.from(packet.rowsById.values()) : stage === 'B' ? packet.stageB.items : packet.stageC.items);
    const itemFor = (packet, stage, itemId) => (stage === 'A' ? packet.rowsById.get(itemId) : stage === 'B' ? packet.controlsById.get(itemId) : packet.pairsById.get(itemId));
    const stageParam = value => {
        const stage = String(value || '').toUpperCase();
        if (!STAGES.includes(stage)) throw fail(400, `Unknown stage ${value}`, 'unknown_stage');
        return stage;
    };
    const conflictFor = (session, packet) => (session && packet && session.packet_sha256 !== packet.sha256
        ? { session_packet_sha256: session.packet_sha256, current_packet_sha256: packet.sha256, message: 'The packet on disk changed after this session started. Your answers are kept; rebind deliberately to continue against the current packet.' }
        : null);
    const sessionSummary = (session, packet) => {
        if (!session) return null;
        const exposure_before_a = store.exposureBeforeA(session);
        return {
            ...session,
            progress: packet ? store.progress(session.id, totals(packet)) : null,
            packet_conflict: packet ? conflictFor(session, packet) : null,
            // False once Part B or C was shown before Stage A was committed
            // (only possible through a rebind); the labels export says so too.
            blind: !exposure_before_a.B && !exposure_before_a.C,
            exposure_before_a,
            route: links.routeFor(session.task_id),
        };
    };

    async function requireWrite(req) {
        const outcome = await authorizeWrite(req);
        if (!outcome.ok) throw fail(outcome.status, outcome.error, outcome.code, outcome.reason ? { reason: outcome.reason } : {});
        return outcome.actor;
    }
    function requirePacketMatch(body, session, packet) {
        const supplied = body?.packet_sha256;
        if (typeof supplied !== 'string' || !SHA256_HEX.test(supplied)) throw fail(400, 'packet_sha256 (the sha256 of the packet you loaded) is required', 'packet_sha256_required');
        if (supplied !== session.packet_sha256) throw fail(409, 'The packet you loaded is not the one this session is bound to', 'packet_mismatch', { session_packet_sha256: session.packet_sha256, supplied_packet_sha256: supplied });
        const conflict = conflictFor(session, packet);
        if (conflict) throw fail(409, conflict.message, 'packet_changed', conflict);
    }

    router.get('/whoami', async (req, res) => {
        try {
            let inspect = operatorInspect;
            if (!inspect) {
                const { createOperatorAuthenticator } = require('../services/operator-access');
                inspect = createOperatorAuthenticator().inspect;
                operatorInspect = inspect;
            }
            const outcome = await inspect(req);
            const key = process.env.NEXUS_OPERATOR_APPROVAL_KEY || '';
            res.json({
                operator_session: Boolean(outcome.operator),
                identity: outcome.identity || null,
                reason: outcome.reason,
                operator_credential_configured: key.length >= 32,
                user_id: req.user?.id || null,
            });
        } catch (error) { respondError(res, error); }
    });

    router.get('/tasks/:taskId', (req, res) => {
        try {
            const taskId = req.params.taskId;
            if (!links.isLinked(taskId)) return res.json({ linked: false, task_id: taskId });
            let packet = null;
            let packetError = null;
            try { packet = loadPacket(); } catch (err) { packetError = { code: err.code, message: err.message }; }
            const session = store.getSessionForTask(taskId);
            res.json({
                linked: true,
                task_id: taskId,
                route: links.routeFor(taskId),
                project_id: links.PROJECT_ID,
                related_tasks: links.RELATED_TASKS,
                need_id: links.NEED_ID,
                packet: packet ? packetSummary(packet) : null,
                packet_error: packetError,
                session: sessionSummary(session, packet),
            });
        } catch (error) { respondError(res, error); }
    });

    router.post('/tasks/:taskId/session', async (req, res) => {
        try {
            const taskId = req.params.taskId;
            if (!links.isLinked(taskId)) throw fail(404, 'This task carries no labeling packet', 'task_not_linked');
            const actor = await requireWrite(req);
            const packet = loadPacket();
            let session = store.getSessionForTask(taskId);
            if (session && session.packet_sha256 !== packet.sha256) {
                throw fail(409, 'A session exists for an earlier packet; rebind it deliberately or continue there', 'packet_changed', { session: sessionSummary(session, packet) });
            }
            let created = false;
            if (!session) {
                let projectId = links.PROJECT_ID;
                try {
                    const task = db && typeof db.getTask === 'function' ? await db.getTask(taskId) : null;
                    if (task?.project_id) projectId = task.project_id;
                } catch { /* the pinned project id stands */ }
                session = store.createSession({ taskId, projectId, packet, actor });
                created = true;
            }
            res.status(created ? 201 : 200).json({ session: sessionSummary(session, packet), created });
        } catch (error) { respondError(res, error); }
    });

    router.get('/sessions/:id', (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            const summary = sessionSummary(session, packet);
            const answers = {};
            for (const stage of STAGES) {
                if (summary.progress[stage].unlocked) answers[stage] = store.listAnswers(session.id, stage);
            }
            const commits = {};
            for (const stage of STAGES) {
                const commit = store.getCommit(session.id, stage);
                if (commit) commits[stage] = { id: commit.id, snapshot_sha256: commit.snapshot_sha256, item_count: commit.item_count, committed_at: commit.committed_at, committed_authority: commit.committed_authority, packet_sha256: commit.packet_sha256 };
            }
            res.json({
                session: summary,
                packet: { ...packetSummary(packet), protocol: packet.protocol, filling: packet.filling, guideline: packet.guideline, alignmentMinJaccard: packet.alignmentMinJaccard },
                // Part A only. Part B and C content is served by /stages/:stage after the gate.
                stageA: packet.stageA,
                answers,
                commits,
                revisions: store.listRevisions(session.id),
                exports: store.listExports(session.id),
                export_targets: TARGETS,
                related_tasks: links.RELATED_TASKS,
                need_id: links.NEED_ID,
            });
        } catch (error) { respondError(res, error); }
    });

    router.get('/sessions/:id/stages/:stage', (req, res) => {
        try {
            const stage = stageParam(req.params.stage);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            const access = store.stageAccess(session.id, stage);
            if (!access.unlocked) {
                return res.status(403).json({ error: `Stage ${stage} is locked until the previous stage is committed`, code: 'stage_locked', reason: access.reason });
            }
            // Reading never reveals: the first disclosure is the operator's own
            // POST /reveal/:stage, so an executor or a stray reader cannot stamp
            // Robert's exposure time.
            if (stage !== 'A' && !session.stages[stage].revealed_at) {
                return res.status(403).json({ error: `Stage ${stage} has not been opened yet; open it deliberately first (POST reveal/${stage})`, code: 'stage_not_revealed' });
            }
            const payload = { stage, session: sessionSummary(session, packet), answers: store.listAnswers(session.id, stage), revealed_at: session.stages[stage].revealed_at };
            if (stage === 'A') payload.content = packet.stageA;
            if (stage === 'B') {
                payload.content = packet.stageB;
                const commit = store.getCommit(session.id, 'A');
                // Robert's own committed readings of the control rows, so he can
                // judge a proposal beside what he labelled blind.
                payload.committed_rows = {};
                for (const item of packet.stageB.items) {
                    const row = packet.rowsById.get(item.rowId);
                    const record = commit?.snapshot?.[item.rowId];
                    payload.committed_rows[item.rowId] = { row: row ? { id: row.id, label: row.label, text: row.text, contexts: row.contexts, citation: row.citation, provisionId: row.provisionId } : null, answer: record ? record.answer : null };
                }
            }
            if (stage === 'C') payload.content = packet.stageC;
            res.json(payload);
        } catch (error) { respondError(res, error); }
    });

    // The deliberate first disclosure of Part B or Part C. Needs the operator
    // (the person whose exposure it records) and the packet hash the client
    // holds; later calls are no-ops that return the recorded time.
    router.post('/sessions/:id/reveal/:stage', async (req, res) => {
        try {
            const stage = stageParam(req.params.stage);
            if (stage === 'A') throw fail(400, 'Stage A is open from the start; nothing to reveal', 'bad_stage');
            await requireWrite(req);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            requirePacketMatch(req.body || {}, session, packet);
            const access = store.stageAccess(session.id, stage);
            if (!access.unlocked) throw fail(403, `Stage ${stage} is locked until the previous stage is committed`, 'stage_locked', { reason: access.reason });
            const first = !session.stages[stage].revealed_at;
            const reveal = store.markRevealed(session.id, stage);
            res.status(first ? 201 : 200).json({ stage, first, revealed_at: reveal.session.stages[stage].revealed_at, session: sessionSummary(reveal.session, packet) });
        } catch (error) { respondError(res, error); }
    });

    router.put('/sessions/:id/answers/:stage/:itemId', async (req, res) => {
        try {
            const stage = stageParam(req.params.stage);
            const actor = await requireWrite(req);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            const body = req.body || {};
            requirePacketMatch(body, session, packet);
            const item = itemFor(packet, stage, req.params.itemId);
            if (!item) throw fail(404, `Stage ${stage} has no item ${req.params.itemId}`, 'unknown_item');
            const requestedState = body.state === undefined || body.state === null ? 'draft' : body.state;
            if (!['draft', 'unsure'].includes(requestedState)) throw fail(400, 'state must be draft or unsure; completeness is decided by validation', 'bad_state');
            const baseRevision = body.base_revision === undefined ? null : body.base_revision;
            if (baseRevision !== null && (!Number.isInteger(baseRevision) || baseRevision < 0)) throw fail(400, 'base_revision must be a non-negative integer or null', 'bad_revision');
            const validation = validateFor(stage, item, body.answer, { unitText: packet.unitText });
            const state = requestedState === 'unsure' ? 'unsure' : (validation.complete ? 'complete' : 'draft');
            const saved = store.saveAnswer({ sessionId: session.id, stage, itemId: item.id, baseRevision, state, answer: validation.answer, errors: validation.errors, actor });
            // The same session summary every read returns (progress, stages, conflict), so the client can replace its copy.
            res.json({ answer: saved.answer, session: sessionSummary(saved.session, packet), validation: { complete: validation.complete, errors: validation.errors }, saved_at: saved.answer.updated_at });
        } catch (error) { respondError(res, error); }
    });

    router.post('/sessions/:id/commit/:stage', async (req, res) => {
        try {
            const stage = stageParam(req.params.stage);
            const actor = await requireWrite(req);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            const body = req.body || {};
            requirePacketMatch(body, session, packet);
            const expectedRevision = body.expected_revision === undefined ? null : body.expected_revision;
            if (expectedRevision !== null && !Number.isInteger(expectedRevision)) throw fail(400, 'expected_revision must be an integer or null', 'bad_revision');
            const access = store.stageAccess(session.id, stage);
            if (!access.unlocked) throw fail(403, `Stage ${stage} is locked until the previous stage is committed`, 'stage_locked', { reason: access.reason });
            if (session.stages[stage].committed_at) throw fail(409, `Stage ${stage} is already committed`, 'already_committed', { committed_at: session.stages[stage].committed_at });
            const answers = new Map(store.listAnswers(session.id, stage).map(a => [a.item_id, a]));
            const missing = [];
            const unsure = [];
            const invalid = [];
            const snapshot = {};
            for (const item of itemsFor(packet, stage)) {
                const saved = answers.get(item.id);
                if (!saved) { missing.push(item.id); continue; }
                if (saved.state === 'unsure') { unsure.push(item.id); continue; }
                // Re-validate at commit time against the packet on disk; a stored
                // "complete" is not trusted blindly.
                const validation = validateFor(stage, item, saved.answer, { unitText: packet.unitText });
                if (!validation.complete) { invalid.push({ item_id: item.id, errors: validation.errors }); continue; }
                snapshot[item.id] = { state: saved.state, answer: validation.answer, revision: saved.revision, updated_at: saved.updated_at, updated_authority: saved.updated_authority };
            }
            if (missing.length || unsure.length || invalid.length) {
                return res.status(422).json({
                    error: `Stage ${stage} cannot be committed yet: ${missing.length} untouched, ${unsure.length} marked unsure, ${invalid.length} incomplete or invalid. Drafts are kept.`,
                    code: 'incomplete',
                    missing, unsure, invalid,
                });
            }
            const result = store.commitStage({ sessionId: session.id, stage, packetSha256: body.packet_sha256, expectedRevision, snapshot, actor });
            res.status(201).json({ session: sessionSummary(result.session, packet), commit: { id: result.commit.id, stage, snapshot_sha256: result.commit.snapshot_sha256, item_count: result.commit.item_count, committed_at: result.commit.committed_at, committed_authority: result.commit.committed_authority } });
        } catch (error) { respondError(res, error); }
    });

    router.post('/sessions/:id/revisions/:itemId', async (req, res) => {
        try {
            const actor = await requireWrite(req);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            const body = req.body || {};
            requirePacketMatch(body, session, packet);
            const row = packet.rowsById.get(req.params.itemId);
            if (!row) throw fail(404, `Stage A has no row ${req.params.itemId}`, 'unknown_item');
            if (!session.stages.A.committed_at) throw fail(409, 'Stage A is not committed; edit the answer itself', 'stage_not_committed');
            const validation = validateFor('A', row, body.answer, { unitText: packet.unitText });
            const note = typeof body.note === 'string' ? body.note.slice(0, 4000) : '';
            const result = store.addRevision({ sessionId: session.id, stage: 'A', itemId: row.id, answer: validation.answer, errors: validation.errors, note, actor });
            res.status(201).json({ ...result, session: sessionSummary(result.session, packet), validation: { complete: validation.complete, errors: validation.errors } });
        } catch (error) { respondError(res, error); }
    });

    router.post('/sessions/:id/exports/:kind', async (req, res) => {
        try {
            const kind = req.params.kind;
            if (!KINDS.includes(kind)) throw fail(400, `Unknown export kind ${kind}`, 'unknown_export');
            const actor = await requireWrite(req);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            requirePacketMatch(req.body || {}, session, packet);
            const stage = kind === 'revisions' ? 'A' : kind;
            const commit = store.getCommit(session.id, stage);
            if (!commit) throw fail(412, `Stage ${stage} is not committed; nothing to export`, 'stage_not_committed');
            const revisions = kind === 'revisions' ? store.listRevisions(session.id) : [];
            if (kind === 'revisions' && !revisions.length) throw fail(412, 'No post-exposure revisions to export', 'nothing_to_export');
            const document = buildDocument(kind, { packet, session, commit, revisions });
            const result = writeExport({ goldDir: packetSource.goldDir, kind, document, priorExports: store.listExports(session.id) });
            const record = store.recordExport({ sessionId: session.id, kind, path: result.path, sha256: result.sha256, actor });
            res.status(result.written ? 201 : 200).json({
                export: record,
                written: result.written,
                identical: result.identical,
                replaced_sha256: result.replaced_sha256 || null,
                target: TARGETS[kind],
                scorer_command: packet.filling[1] || null,
            });
        } catch (error) { respondError(res, error); }
    });

    router.post('/sessions/:id/rebind', async (req, res) => {
        try {
            const actor = await requireWrite(req);
            const session = store.getSession(req.params.id);
            const packet = loadPacket();
            const body = req.body || {};
            if (body.confirm !== true) throw fail(400, 'Rebinding needs confirm: true', 'confirm_required');
            if (body.from_packet_sha256 !== session.packet_sha256) throw fail(409, 'from_packet_sha256 does not match the session', 'packet_mismatch', { session_packet_sha256: session.packet_sha256 });
            if (body.to_packet_sha256 !== packet.sha256) throw fail(409, 'to_packet_sha256 does not match the packet on disk', 'packet_mismatch', { current_packet_sha256: packet.sha256 });
            const result = store.rebind({ sessionId: session.id, packet, actor });
            res.status(201).json({ session: sessionSummary(result.session, packet), superseded: result.superseded, carried: result.carried });
        } catch (error) { respondError(res, error); }
    });

    router.use((error, _req, res, _next) => {
        if (error instanceof ShapeError) return res.status(400).json({ error: error.message, code: error.code, field: error.field });
        return respondError(res, error);
    });

    router.store = store;
    router.packetSource = packetSource;
    return router;
}

module.exports = createGroundrulesLabelingRouter;
module.exports.STATES = STATES;
