/**
 * Durable state for the guided blind-labelling interface, in the board
 * SQLite file (nexus.db) through the raw writer handle, like
 * server/routes/dispatches.js. Browser storage is never the system of record.
 *
 * Model
 *  - A session is one annotator's run through one exact packet: it pins the
 *    packet file sha256 and the roster/guideline/controls/vpu digests the
 *    packet carries. A regenerated packet never silently rebinds a session;
 *    the router reports the mismatch and only a deliberate rebind creates a
 *    successor session (answers carried over as drafts, the old session kept).
 *  - Answers are one row per (session, stage, item). `state` is `draft`,
 *    `unsure` (return later) or `complete`; absence means never touched. The
 *    answer JSON keeps the explicit UNKNOWN sentinel and the explicit
 *    "no propositions" declaration, so unknown, skipped, missing and empty
 *    stay four different things. Each answer has its own revision for
 *    optimistic concurrency across devices.
 *  - A commit freezes a stage: the snapshot of every answer, its sha256, the
 *    packet sha256 and who committed. Stage A's committed answers are the
 *    blind baseline; after the commit the answer rows of that stage refuse
 *    writes. Opening a later stage's content is recorded as a reveal, and any
 *    later change to a Stage A reading is a separate revision row carrying
 *    the reveal timestamps it was made after.
 *  - Exports are logged with the path and sha256 written so a re-export can
 *    tell its own earlier file from somebody else's.
 */
const { randomUUID, createHash } = require('crypto');
const { openRaw, resolveNexusDbPath } = require('../../../db/raw');

const STAGES = ['A', 'B', 'C'];
const STAGE_ORDER = { A: 0, B: 1, C: 2 };
const now = () => new Date().toISOString();
const fail = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const hashJson = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groundrules_labeling_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT,
    annotator TEXT NOT NULL,
    packet_sha256 TEXT NOT NULL,
    packet_path TEXT,
    roster_sha256 TEXT,
    guideline_sha256 TEXT,
    controls_sha256 TEXT,
    vpu_sha256 TEXT,
    thresholds_sha256 TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    stage_a_committed_at TEXT,
    stage_b_committed_at TEXT,
    stage_c_committed_at TEXT,
    stage_b_revealed_at TEXT,
    stage_c_revealed_at TEXT,
    carried_from TEXT,
    superseded_by TEXT,
    created_by TEXT NOT NULL,
    created_authority TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groundrules_labeling_sessions_task ON groundrules_labeling_sessions(task_id, created_at);
CREATE TABLE IF NOT EXISTS groundrules_labeling_answers (
    session_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    item_id TEXT NOT NULL,
    state TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    errors_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_authority TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, stage, item_id)
);
CREATE TABLE IF NOT EXISTS groundrules_labeling_commits (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    packet_sha256 TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    committed_by TEXT NOT NULL,
    committed_authority TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    UNIQUE (session_id, stage)
);
CREATE TABLE IF NOT EXISTS groundrules_labeling_revisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    item_id TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    errors_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    exposure_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_authority TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groundrules_labeling_revisions_session ON groundrules_labeling_revisions(session_id, created_at);
CREATE TABLE IF NOT EXISTS groundrules_labeling_exports (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    exported_by TEXT NOT NULL,
    exported_authority TEXT NOT NULL,
    exported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groundrules_labeling_exports_session ON groundrules_labeling_exports(session_id, exported_at);
`;

// Committed answers are the blind baseline: no UPDATE or DELETE may touch a
// commit row, and the answer rows of a committed stage are frozen by trigger
// as well as by the store, so a stray SQL path cannot rewrite them either.
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_commits_immutable_update
BEFORE UPDATE ON groundrules_labeling_commits BEGIN
    SELECT RAISE(ABORT, 'groundrules labeling commits are immutable');
END;
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_commits_immutable_delete
BEFORE DELETE ON groundrules_labeling_commits BEGIN
    SELECT RAISE(ABORT, 'groundrules labeling commits are immutable');
END;
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_answers_frozen_update
BEFORE UPDATE ON groundrules_labeling_answers
WHEN EXISTS (SELECT 1 FROM groundrules_labeling_commits c WHERE c.session_id = OLD.session_id AND c.stage = OLD.stage) BEGIN
    SELECT RAISE(ABORT, 'answers of a committed stage are frozen');
END;
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_answers_frozen_delete
BEFORE DELETE ON groundrules_labeling_answers
WHEN EXISTS (SELECT 1 FROM groundrules_labeling_commits c WHERE c.session_id = OLD.session_id AND c.stage = OLD.stage) BEGIN
    SELECT RAISE(ABORT, 'answers of a committed stage are frozen');
END;
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_answers_frozen_insert
BEFORE INSERT ON groundrules_labeling_answers
WHEN EXISTS (SELECT 1 FROM groundrules_labeling_commits c WHERE c.session_id = NEW.session_id AND c.stage = NEW.stage) BEGIN
    SELECT RAISE(ABORT, 'answers of a committed stage are frozen');
END;
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_revisions_immutable_update
BEFORE UPDATE ON groundrules_labeling_revisions BEGIN
    SELECT RAISE(ABORT, 'groundrules labeling revisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS groundrules_labeling_exports_immutable_update
BEFORE UPDATE ON groundrules_labeling_exports BEGIN
    SELECT RAISE(ABORT, 'groundrules labeling exports are immutable');
END;
`;

function sessionView(row) {
    if (!row) return null;
    return {
        id: row.id,
        task_id: row.task_id,
        project_id: row.project_id,
        annotator: row.annotator,
        packet_sha256: row.packet_sha256,
        packet_path: row.packet_path,
        digests: {
            rosterSha256: row.roster_sha256,
            guidelineSha256: row.guideline_sha256,
            controlsSha256: row.controls_sha256,
            vpuSha256: row.vpu_sha256,
            thresholdsSha256: row.thresholds_sha256,
        },
        revision: row.revision,
        stages: {
            A: { committed_at: row.stage_a_committed_at, revealed_at: row.created_at },
            B: { committed_at: row.stage_b_committed_at, revealed_at: row.stage_b_revealed_at },
            C: { committed_at: row.stage_c_committed_at, revealed_at: row.stage_c_revealed_at },
        },
        carried_from: row.carried_from,
        superseded_by: row.superseded_by,
        created_by: row.created_by,
        created_authority: row.created_authority,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function answerView(row) {
    return {
        session_id: row.session_id,
        stage: row.stage,
        item_id: row.item_id,
        state: row.state,
        answer: parse(row.answer_json, {}),
        errors: parse(row.errors_json, []),
        revision: row.revision,
        updated_by: row.updated_by,
        updated_authority: row.updated_authority,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function commitView(row) {
    if (!row) return null;
    return {
        id: row.id,
        session_id: row.session_id,
        stage: row.stage,
        packet_sha256: row.packet_sha256,
        snapshot: parse(row.snapshot_json, {}),
        snapshot_sha256: row.snapshot_sha256,
        item_count: row.item_count,
        committed_by: row.committed_by,
        committed_authority: row.committed_authority,
        committed_at: row.committed_at,
    };
}

function revisionView(row) {
    return {
        id: row.id,
        session_id: row.session_id,
        stage: row.stage,
        item_id: row.item_id,
        answer: parse(row.answer_json, {}),
        errors: parse(row.errors_json, []),
        note: row.note,
        exposure: parse(row.exposure_json, {}),
        created_by: row.created_by,
        created_authority: row.created_authority,
        created_at: row.created_at,
    };
}

function exportView(row) {
    return {
        id: row.id,
        session_id: row.session_id,
        kind: row.kind,
        path: row.path,
        sha256: row.sha256,
        exported_by: row.exported_by,
        exported_authority: row.exported_authority,
        exported_at: row.exported_at,
    };
}

function createLabelingStore({ dbPath = resolveNexusDbPath() } = {}) {
    const db = openRaw(dbPath);
    db.exec(SCHEMA);
    db.exec(TRIGGERS);

    const stmt = {
        latestForTask: db.prepare(`SELECT * FROM groundrules_labeling_sessions WHERE task_id = ? AND annotator = ? AND superseded_by IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`),
        session: db.prepare(`SELECT * FROM groundrules_labeling_sessions WHERE id = ?`),
        insertSession: db.prepare(`INSERT INTO groundrules_labeling_sessions (id, task_id, project_id, annotator, packet_sha256, packet_path, roster_sha256, guideline_sha256, controls_sha256, vpu_sha256, thresholds_sha256, revision, carried_from, created_by, created_authority, created_at, updated_at)
            VALUES (@id, @task_id, @project_id, @annotator, @packet_sha256, @packet_path, @roster_sha256, @guideline_sha256, @controls_sha256, @vpu_sha256, @thresholds_sha256, 1, @carried_from, @created_by, @created_authority, @created_at, @updated_at)`),
        bump: db.prepare(`UPDATE groundrules_labeling_sessions SET revision = revision + 1, updated_at = ? WHERE id = ?`),
        supersede: db.prepare(`UPDATE groundrules_labeling_sessions SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL`),
        answers: db.prepare(`SELECT * FROM groundrules_labeling_answers WHERE session_id = ? AND stage = ? ORDER BY item_id`),
        answer: db.prepare(`SELECT * FROM groundrules_labeling_answers WHERE session_id = ? AND stage = ? AND item_id = ?`),
        insertAnswer: db.prepare(`INSERT INTO groundrules_labeling_answers (session_id, stage, item_id, state, answer_json, errors_json, revision, updated_by, updated_authority, created_at, updated_at)
            VALUES (@session_id, @stage, @item_id, @state, @answer_json, @errors_json, 1, @actor_id, @authority, @at, @at)`),
        updateAnswer: db.prepare(`UPDATE groundrules_labeling_answers SET state = @state, answer_json = @answer_json, errors_json = @errors_json, revision = revision + 1, updated_by = @actor_id, updated_authority = @authority, updated_at = @at
            WHERE session_id = @session_id AND stage = @stage AND item_id = @item_id AND revision = @base_revision`),
        commit: db.prepare(`SELECT * FROM groundrules_labeling_commits WHERE session_id = ? AND stage = ?`),
        insertCommit: db.prepare(`INSERT INTO groundrules_labeling_commits (id, session_id, stage, packet_sha256, snapshot_json, snapshot_sha256, item_count, committed_by, committed_authority, committed_at)
            VALUES (@id, @session_id, @stage, @packet_sha256, @snapshot_json, @snapshot_sha256, @item_count, @actor_id, @authority, @at)`),
        setCommitted: {
            A: db.prepare(`UPDATE groundrules_labeling_sessions SET stage_a_committed_at = ? WHERE id = ?`),
            B: db.prepare(`UPDATE groundrules_labeling_sessions SET stage_b_committed_at = ? WHERE id = ?`),
            C: db.prepare(`UPDATE groundrules_labeling_sessions SET stage_c_committed_at = ? WHERE id = ?`),
        },
        setRevealed: {
            B: db.prepare(`UPDATE groundrules_labeling_sessions SET stage_b_revealed_at = ? WHERE id = ? AND stage_b_revealed_at IS NULL`),
            C: db.prepare(`UPDATE groundrules_labeling_sessions SET stage_c_revealed_at = ? WHERE id = ? AND stage_c_revealed_at IS NULL`),
        },
        insertRevision: db.prepare(`INSERT INTO groundrules_labeling_revisions (id, session_id, stage, item_id, answer_json, errors_json, note, exposure_json, created_by, created_authority, created_at)
            VALUES (@id, @session_id, @stage, @item_id, @answer_json, @errors_json, @note, @exposure_json, @actor_id, @authority, @at)`),
        revisions: db.prepare(`SELECT * FROM groundrules_labeling_revisions WHERE session_id = ? ORDER BY created_at, rowid`),
        insertExport: db.prepare(`INSERT INTO groundrules_labeling_exports (id, session_id, kind, path, sha256, exported_by, exported_authority, exported_at)
            VALUES (@id, @session_id, @kind, @path, @sha256, @actor_id, @authority, @at)`),
        exports: db.prepare(`SELECT * FROM groundrules_labeling_exports WHERE session_id = ? ORDER BY exported_at, rowid`),
    };

    const requireSession = id => {
        const row = stmt.session.get(id);
        if (!row) throw fail(404, 'Labeling session not found', 'session_not_found');
        return row;
    };
    const requireStage = stage => {
        if (!STAGES.includes(stage)) throw fail(400, `Unknown stage ${stage}`, 'unknown_stage');
        return stage;
    };
    const committedAt = (row, stage) => row[`stage_${stage.toLowerCase()}_committed_at`];
    const revealedAt = (row, stage) => (stage === 'A' ? row.created_at : row[`stage_${stage.toLowerCase()}_revealed_at`]);
    /**
     * Which later stages had been shown before Stage A was committed (or so
     * far, while it is open). Non-empty means the Stage A record is not blind:
     * a session rebound after a reveal inherits the reveal times.
     */
    const exposureBeforeA = view => {
        const cutoff = view.stages.A.committed_at;
        const out = {};
        for (const stage of ['B', 'C']) {
            const at = view.stages[stage].revealed_at;
            out[stage] = at && (!cutoff || at <= cutoff) ? at : null;
        }
        return out;
    };

    /** Later stages open only once the previous stage is committed. */
    function stageAccess(row, stage) {
        if (stage === 'A') return { unlocked: true, reason: null };
        const previous = STAGES[STAGE_ORDER[stage] - 1];
        const at = committedAt(row, previous);
        return at ? { unlocked: true, reason: null } : { unlocked: false, reason: `stage_${previous}_not_committed` };
    }

    function getSessionForTask(taskId, annotator = 'robert') {
        return sessionView(stmt.latestForTask.get(taskId, annotator));
    }

    function createSession({ taskId, projectId, packet, actor, annotator = 'robert', carriedFrom = null }) {
        const at = now();
        const id = randomUUID();
        stmt.insertSession.run({
            id, task_id: taskId, project_id: projectId || null, annotator,
            packet_sha256: packet.sha256, packet_path: packet.path,
            roster_sha256: packet.digests.rosterSha256, guideline_sha256: packet.digests.guidelineSha256,
            controls_sha256: packet.digests.controlsSha256, vpu_sha256: packet.digests.vpuSha256,
            thresholds_sha256: packet.digests.thresholdsSha256,
            carried_from: carriedFrom, created_by: actor.id, created_authority: actor.authority,
            created_at: at, updated_at: at,
        });
        return sessionView(stmt.session.get(id));
    }

    function getSession(id) {
        return sessionView(requireSession(id));
    }

    function listAnswers(sessionId, stage) {
        return stmt.answers.all(sessionId, requireStage(stage)).map(answerView);
    }

    function getAnswer(sessionId, stage, itemId) {
        const row = stmt.answer.get(sessionId, requireStage(stage), itemId);
        return row ? answerView(row) : null;
    }

    /**
     * Save one answer. `baseRevision` must equal the stored revision, or be
     * null only when no record exists yet; otherwise the caller gets 409
     * stale_write with the current record so the human can decide. A
     * committed stage refuses.
     */
    const saveAnswer = db.transaction(({ sessionId, stage, itemId, baseRevision, state, answer, errors, actor }) => {
        const row = requireSession(sessionId);
        requireStage(stage);
        if (row.superseded_by) throw fail(409, 'This session was rebound to a newer packet; continue in its successor', 'session_superseded', { superseded_by: row.superseded_by });
        if (committedAt(row, stage)) throw fail(409, `Stage ${stage} is committed; its answers are frozen. Record a post-exposure revision instead.`, 'stage_committed', { committed_at: committedAt(row, stage) });
        const access = stageAccess(row, stage);
        if (!access.unlocked) throw fail(403, `Stage ${stage} is locked until the previous stage is committed`, 'stage_locked', { reason: access.reason });
        const at = now();
        const existing = stmt.answer.get(sessionId, stage, itemId);
        const payload = { session_id: sessionId, stage, item_id: itemId, state, answer_json: JSON.stringify(answer), errors_json: JSON.stringify(errors || []), actor_id: actor.id, authority: actor.authority, at };
        if (!existing) {
            if (baseRevision !== null && baseRevision !== undefined && baseRevision !== 0) {
                throw fail(409, 'This passage has no saved answer any more; reload before saving', 'stale_write', { current: null });
            }
            stmt.insertAnswer.run(payload);
        } else {
            // A null base revision means "first save". If a record already exists
            // (another device or tab saved after this client loaded), the write
            // is refused with the current record rather than silently replacing it.
            if (baseRevision === null || baseRevision === undefined) {
                throw fail(409, 'This passage already has a saved answer from another device or tab; reload before saving', 'stale_write', { current: answerView(existing) });
            }
            const result = stmt.updateAnswer.run({ ...payload, base_revision: baseRevision });
            if (result.changes !== 1) {
                throw fail(409, 'This passage was saved from another device or tab after you loaded it', 'stale_write', { current: answerView(stmt.answer.get(sessionId, stage, itemId)) });
            }
        }
        stmt.bump.run(at, sessionId);
        return { answer: answerView(stmt.answer.get(sessionId, stage, itemId)), session: sessionView(stmt.session.get(sessionId)) };
    });

    /**
     * Freeze a stage. The caller has already validated every item; this
     * records the snapshot and marks the stage committed, once.
     */
    const commitStage = db.transaction(({ sessionId, stage, packetSha256, expectedRevision, snapshot, actor }) => {
        const row = requireSession(sessionId);
        requireStage(stage);
        if (row.superseded_by) throw fail(409, 'This session was rebound to a newer packet; continue in its successor', 'session_superseded', { superseded_by: row.superseded_by });
        if (committedAt(row, stage)) throw fail(409, `Stage ${stage} is already committed`, 'already_committed', { committed_at: committedAt(row, stage) });
        const access = stageAccess(row, stage);
        if (!access.unlocked) throw fail(403, `Stage ${stage} is locked until the previous stage is committed`, 'stage_locked', { reason: access.reason });
        if (packetSha256 !== row.packet_sha256) throw fail(409, 'The packet you loaded differs from the one this session is bound to', 'packet_mismatch', { session_packet_sha256: row.packet_sha256, supplied_packet_sha256: packetSha256 });
        if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== row.revision) {
            throw fail(409, 'The session changed after you loaded it; reload and review before committing', 'stale_session', { current_revision: row.revision });
        }
        // The snapshot was assembled outside this transaction; every answer it
        // freezes must still be the stored revision, and nothing may have been
        // saved since that the snapshot does not carry.
        for (const stored of stmt.answers.all(sessionId, stage)) {
            const frozen = snapshot[stored.item_id];
            if (!frozen || frozen.revision !== stored.revision) {
                throw fail(409, `${stored.item_id} was saved while the commit was being prepared; reload and review again`, 'stale_session', { current_revision: row.revision, item_id: stored.item_id });
            }
        }
        const at = now();
        const id = randomUUID();
        const snapshot_sha256 = hashJson(snapshot);
        stmt.insertCommit.run({ id, session_id: sessionId, stage, packet_sha256: row.packet_sha256, snapshot_json: JSON.stringify(snapshot), snapshot_sha256, item_count: Object.keys(snapshot).length, actor_id: actor.id, authority: actor.authority, at });
        stmt.setCommitted[stage].run(at, sessionId);
        stmt.bump.run(at, sessionId);
        return { commit: commitView(stmt.commit.get(sessionId, stage)), session: sessionView(stmt.session.get(sessionId)) };
    });

    function getCommit(sessionId, stage) {
        return commitView(stmt.commit.get(sessionId, requireStage(stage)));
    }

    /** First disclosure of a later stage's content; later calls are no-ops. */
    const markRevealed = db.transaction((sessionId, stage) => {
        const row = requireSession(sessionId);
        requireStage(stage);
        if (stage === 'A') return { session: sessionView(row), stage, unlocked: true };
        const access = stageAccess(row, stage);
        if (!access.unlocked) return { session: sessionView(row), stage, unlocked: false, reason: access.reason };
        const at = now();
        const result = stmt.setRevealed[stage].run(at, sessionId);
        if (result.changes === 1) stmt.bump.run(at, sessionId);
        return { session: sessionView(stmt.session.get(sessionId)), stage, unlocked: true, revealed_at: revealedAt(stmt.session.get(sessionId), stage) };
    });

    /** A post-exposure change to a committed reading, kept beside the baseline. */
    const addRevision = db.transaction(({ sessionId, stage, itemId, answer, errors, note, actor }) => {
        const row = requireSession(sessionId);
        requireStage(stage);
        if (!committedAt(row, stage)) throw fail(409, `Stage ${stage} is not committed; edit the answer itself instead of recording a revision`, 'stage_not_committed');
        const at = now();
        const exposure = {
            committed_at: committedAt(row, stage),
            revealed: {
                B: row.stage_b_revealed_at,
                C: row.stage_c_revealed_at,
            },
            after_exposure_to: STAGES.filter(s => s !== 'A' && row[`stage_${s.toLowerCase()}_revealed_at`]),
            blind: false,
        };
        const id = randomUUID();
        stmt.insertRevision.run({ id, session_id: sessionId, stage, item_id: itemId, answer_json: JSON.stringify(answer), errors_json: JSON.stringify(errors || []), note: note || '', exposure_json: JSON.stringify(exposure), actor_id: actor.id, authority: actor.authority, at });
        stmt.bump.run(at, sessionId);
        const inserted = stmt.revisions.all(sessionId).find(r => r.id === id);
        return { revision: revisionView(inserted), session: sessionView(stmt.session.get(sessionId)) };
    });

    function listRevisions(sessionId) {
        requireSession(sessionId);
        return stmt.revisions.all(sessionId).map(revisionView);
    }

    function recordExport({ sessionId, kind, path: file, sha256, actor }) {
        requireSession(sessionId);
        const at = now();
        const id = randomUUID();
        stmt.insertExport.run({ id, session_id: sessionId, kind, path: file, sha256, actor_id: actor.id, authority: actor.authority, at });
        stmt.bump.run(at, sessionId);
        return stmt.exports.all(sessionId).map(exportView).find(e => e.id === id);
    }

    function listExports(sessionId) {
        requireSession(sessionId);
        return stmt.exports.all(sessionId).map(exportView);
    }

    /**
     * Deliberate rebind after the packet changed: a successor session bound
     * to the current packet, every uncommitted-or-committed answer carried
     * over as a draft with its origin recorded, the old session's reveal
     * times carried as exposure, the old session retained and marked
     * superseded. Nothing in the old session is changed or deleted.
     */
    const rebind = db.transaction(({ sessionId, packet, actor }) => {
        const old = requireSession(sessionId);
        if (old.superseded_by) throw fail(409, 'This session was already rebound', 'session_superseded', { superseded_by: old.superseded_by });
        if (old.packet_sha256 === packet.sha256) throw fail(409, 'The session is already bound to the current packet', 'packet_unchanged');
        const successor = createSession({ taskId: old.task_id, projectId: old.project_id, packet, actor, annotator: old.annotator, carriedFrom: old.id });
        const at = now();
        // Exposure is a property of the person, not the packet: whatever the
        // old session had already shown stays revealed in the successor, so a
        // Stage A re-committed after a rebind can never pass as blind.
        if (old.stage_b_revealed_at) stmt.setRevealed.B.run(old.stage_b_revealed_at, successor.id);
        if (old.stage_c_revealed_at) stmt.setRevealed.C.run(old.stage_c_revealed_at, successor.id);
        let carried = 0;
        for (const stage of STAGES) {
            for (const row of stmt.answers.all(old.id, stage)) {
                const answer = parse(row.answer_json, {});
                const carriedAnswer = { ...answer, carried_from: { session_id: old.id, packet_sha256: old.packet_sha256, state: row.state, revision: row.revision, committed_at: committedAt(old, stage) } };
                stmt.insertAnswer.run({ session_id: successor.id, stage, item_id: row.item_id, state: row.state === 'unsure' ? 'unsure' : 'draft', answer_json: JSON.stringify(carriedAnswer), errors_json: JSON.stringify([{ path: 'packet', message: 'Carried over from a session bound to an earlier packet; review this answer against the current passage before saving.' }]), actor_id: actor.id, authority: actor.authority, at });
                carried += 1;
            }
        }
        stmt.supersede.run(successor.id, at, old.id);
        stmt.bump.run(at, successor.id);
        return { session: sessionView(stmt.session.get(successor.id)), superseded: sessionView(stmt.session.get(old.id)), carried };
    });

    /** Per-stage progress for the entry card and the index. */
    function progress(sessionId, totals) {
        const row = requireSession(sessionId);
        const out = {};
        for (const stage of STAGES) {
            const answers = stmt.answers.all(sessionId, stage);
            const counts = { total: totals[stage] || 0, complete: 0, draft: 0, unsure: 0, untouched: 0 };
            for (const a of answers) counts[a.state] = (counts[a.state] || 0) + 1;
            counts.untouched = Math.max(0, counts.total - answers.length);
            out[stage] = { ...counts, ...stageAccess(row, stage), committed_at: committedAt(row, stage), revealed_at: revealedAt(row, stage) };
        }
        return out;
    }

    return {
        STAGES,
        getSessionForTask, createSession, getSession, listAnswers, getAnswer, saveAnswer,
        commitStage, getCommit, markRevealed, addRevision, listRevisions, recordExport, listExports,
        rebind, progress, exposureBeforeA, stageAccess: (sessionId, stage) => stageAccess(requireSession(sessionId), requireStage(stage)),
        hashJson,
    };
}

module.exports = { createLabelingStore, STAGES, hashJson };
