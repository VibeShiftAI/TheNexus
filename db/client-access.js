/**
 * Client project access (2026-10-02): the explicit, project-scoped entitlement
 * that lets an external client lead read their own project, plus the
 * immutable artifact-version and client-review ledger that records exactly
 * which authenticated member accepted exactly which published version.
 *
 * Authorization source: /Volumes/Projects/shared-mind/memories/
 * feedback_joey_lautrup_client_workflow_2026-10-02.md ("full access to his
 * own project's requirements, tasks, deliverables, code/preview links,
 * decisions, feedback and progress. This is project-scoped access, not other
 * clients' data, global Nexus administration or operator credentials.").
 *
 * Model
 *  - An entitlement is granted for one (member, project) pair and is honored
 *    only while the member exists and is active, is still linked to that
 *    project (`project_contacts`), still matches the identity captured at
 *    grant time, and the entitlement has not been revoked. Unlinking the
 *    member, marking them dormant or revoking the entitlement each remove
 *    access. Nothing here reaches past that one project: no other project,
 *    no operator control, no credential.
 *  - Artifacts are immutable published versions: a captured document
 *    revision, a preview URL at a stated version, a code link or a
 *    deliverable. `version_hash` is the sha256 of the canonical identity, so
 *    an acceptance can only ever name one exact version.
 *  - Reviews are append-only. `comment` and `request_changes` are feedback;
 *    only `accept` is acceptance, and it is bound to member, project,
 *    artifact, `version_hash` and the hash of the authenticated portal
 *    session the trusted runtime presented. Acceptance never mutates tasks,
 *    checkpoints, gates or stakeholder proposals; it yields an evidence
 *    reference the steward cites when it records a checkpoint observation.
 *    Every acknowledged `client_decision_id` is reserved in
 *    `client_review_keys` against the payload it answered, so a key can never
 *    be reused for a different review.
 *  - Links are projected only as credential-free absolute http(s) URLs, from
 *    project settings and from published artifacts alike; anything else is
 *    dropped on read and refused on publish.
 *  - Nothing is ever authorized from stored state: every read and write
 *    resolves the entitlement live, and a lookup that cannot run denies.
 *  - Nothing in this module is a credential. The routes decide who may call
 *    what (server/routes/client-access.js); this store enforces the
 *    entitlement and ledger invariants for every read and write.
 *
 * Runs on the raw better-sqlite3 connection the facade owns, like
 * db/stakeholder-policy.js; route code reaches it through `db.clientAccess`.
 * There are deliberately no foreign keys to contacts or projects: history
 * must outlive a deleted member or project, and the immutability triggers
 * would otherwise block those deletes.
 */
const { createHash, randomUUID } = require('crypto');

const SCOPE = 'client_project';
const ARTIFACT_KINDS = ['document', 'preview', 'code', 'deliverable'];
const REVIEW_DECISIONS = ['comment', 'request_changes', 'accept'];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_BODY = 20000;
const MAX_TEXT = 500;
const EVIDENCE_PREFIX = 'nexus:client-review:';

const now = () => new Date().toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
function parse(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function text(value, name, { required = false, max = MAX_TEXT } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw fail(400, `${name} is required`);
        return null;
    }
    if (typeof value !== 'string') throw fail(400, `${name} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) {
        if (required) throw fail(400, `${name} is required`);
        return null;
    }
    if (trimmed.length > max) throw fail(400, `${name} is too long (max ${max} characters)`);
    return trimmed;
}
/**
 * The only link shape a client may ever receive: an absolute http(s) URL with
 * no embedded credentials. Returns the normalized URL or null. `javascript:`,
 * `file:`, relative values and `user:pass@host` forms are neither projected
 * from project settings nor accepted for publication (QA repair 2026-10-02).
 */
function safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.length > 2000) return null;
    let parsed;
    try { parsed = new URL(raw); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
}
function httpUrl(value, name, { required = false } = {}) {
    const raw = text(value, name, { required, max: 2000 });
    if (raw === null) return null;
    const safe = safeHttpUrl(raw);
    if (!safe) throw fail(400, `${name} must be an absolute http(s) URL without embedded credentials`, 'unsafe_url');
    return safe;
}
/** The identity an entitlement is bound to: a later name or email edit requires a fresh grant. */
const identityOf = member => ({
    id: member.id,
    name: typeof member.name === 'string' ? member.name : '',
    email: typeof member.email === 'string' && member.email.trim() ? member.email.trim().toLowerCase() : null,
});
const evidenceRef = reviewId => `${EVIDENCE_PREFIX}${reviewId}`;

function initializeClientAccess(db) {
    db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS client_project_entitlements (
            id TEXT PRIMARY KEY, member_id TEXT NOT NULL, project_id TEXT NOT NULL, scope TEXT NOT NULL,
            member_snapshot TEXT NOT NULL, granted_by TEXT NOT NULL, authority TEXT NOT NULL,
            source TEXT, note TEXT, granted_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS client_entitlement_member ON client_project_entitlements(member_id, project_id);
        CREATE INDEX IF NOT EXISTS client_entitlement_project ON client_project_entitlements(project_id);
        CREATE TABLE IF NOT EXISTS client_access_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, entitlement_id TEXT NOT NULL, kind TEXT NOT NULL, document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS client_access_event_entitlement ON client_access_events(entitlement_id, seq);
        CREATE TABLE IF NOT EXISTS client_artifacts (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
            version TEXT NOT NULL, version_hash TEXT NOT NULL, document_id TEXT, revision_id TEXT, content_hash TEXT,
            url TEXT, checkpoint_id TEXT, task_id TEXT, notes TEXT, supersedes_id TEXT,
            published_by TEXT NOT NULL, authority TEXT NOT NULL, published_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS client_artifact_project ON client_artifacts(project_id, published_at);
        CREATE INDEX IF NOT EXISTS client_artifact_supersedes ON client_artifacts(supersedes_id);
        CREATE TABLE IF NOT EXISTS client_artifact_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL, kind TEXT NOT NULL, document TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS client_artifact_event_artifact ON client_artifact_events(artifact_id, seq);
        CREATE TABLE IF NOT EXISTS client_reviews (
            id TEXT PRIMARY KEY, client_decision_id TEXT NOT NULL, member_id TEXT NOT NULL, project_id TEXT NOT NULL,
            artifact_id TEXT NOT NULL, version_hash TEXT NOT NULL, decision TEXT NOT NULL, body TEXT NOT NULL,
            request_hash TEXT NOT NULL, session_sha256 TEXT NOT NULL, session_expires_at TEXT NOT NULL,
            authority TEXT NOT NULL, member_snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(member_id, project_id, client_decision_id)
        );
        CREATE INDEX IF NOT EXISTS client_review_artifact ON client_reviews(artifact_id, created_at);
        CREATE INDEX IF NOT EXISTS client_review_project ON client_reviews(project_id, created_at);
        CREATE TABLE IF NOT EXISTS client_review_keys (
            member_id TEXT NOT NULL, project_id TEXT NOT NULL, client_decision_id TEXT NOT NULL,
            request_hash TEXT NOT NULL, review_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
            PRIMARY KEY (member_id, project_id, client_decision_id)
        );`);
        // Every acknowledged client_decision_id is reserved against the payload it was acknowledged
        // for, including keys that resolved to an existing acceptance without a new review row
        // (QA repair 2026-10-02). Rows written before this table existed are reserved here too.
        db.exec(`INSERT OR IGNORE INTO client_review_keys(member_id, project_id, client_decision_id, request_hash, review_id, recorded_at)
            SELECT member_id, project_id, client_decision_id, request_hash, id, created_at FROM client_reviews;`);
        for (const table of ['client_project_entitlements', 'client_access_events', 'client_artifacts', 'client_artifact_events', 'client_reviews', 'client_review_keys']) {
            for (const verb of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${verb.toLowerCase()}
                BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT, 'Client access history is immutable'); END;`);
        }
    }).immediate();
}

function createClientAccess(db) {
    const memberRow = id => (typeof id === 'string' && id ? db.prepare('SELECT id, name, email, kind, status FROM contacts WHERE id = ?').get(id) : null) || null;
    const projectRow = id => (typeof id === 'string' && id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(id) : null) || null;
    const linkRow = (projectId, memberId) => db.prepare('SELECT role, decision_maker, added_at FROM project_contacts WHERE project_id = ? AND contact_id = ?').get(projectId, memberId) || null;
    const publicReview = row => ({
        id: row.id, client_decision_id: row.client_decision_id, member: parse(row.member_snapshot, {}),
        artifact_id: row.artifact_id, version_hash: row.version_hash, decision: row.decision, body: row.body,
        created_at: row.created_at, evidence_ref: evidenceRef(row.id),
    });
    const fullReview = row => ({
        ...publicReview(row), member_id: row.member_id, project_id: row.project_id, authority: row.authority,
        session_sha256: row.session_sha256, session_expires_at: row.session_expires_at,
    });

    // ── Entitlements ──────────────────────────────────────────────────────
    function hydrateEntitlement(row) {
        const events = db.prepare('SELECT * FROM client_access_events WHERE entitlement_id = ? ORDER BY seq').all(row.id)
            .map(event => ({ ...parse(event.document, {}), kind: event.kind, seq: event.seq }));
        const revoked = events.find(event => event.kind === 'revoked') || null;
        return {
            id: row.id, member_id: row.member_id, project_id: row.project_id, scope: row.scope,
            member_snapshot: parse(row.member_snapshot, {}), granted_by: row.granted_by, authority: row.authority,
            source: row.source ?? null, note: row.note ?? null, granted_at: row.granted_at,
            state: revoked ? 'revoked' : 'active',
            revoked: revoked ? { at: revoked.at, reason: revoked.reason ?? null, by: revoked.by ?? null, authority: revoked.authority ?? null } : null,
            events,
        };
    }
    const entitlementsFor = (memberId, projectId) => db.prepare(
        'SELECT * FROM client_project_entitlements WHERE member_id = ? AND project_id = ? ORDER BY granted_at DESC, rowid DESC',
    ).all(memberId, projectId).map(hydrateEntitlement);
    const activeEntitlement = (memberId, projectId) => entitlementsFor(memberId, projectId).find(e => e.state === 'active') || null;
    function recordAccessEvent(entitlement, kind, details) {
        db.prepare('INSERT INTO client_access_events(entitlement_id, kind, document) VALUES (?, ?, ?)')
            .run(entitlement.id, kind, JSON.stringify({ id: randomUUID(), at: now(), member_id: entitlement.member_id, project_id: entitlement.project_id, ...details }));
    }

    /**
     * Decide whether `memberId` may read `projectId` right now. Every reason
     * is a fixed word; the client-facing routes collapse all of them into one
     * uniform denial so a caller cannot probe for other members or projects.
     */
    function resolveAccess(memberId, projectId) {
        const deny = reason => ({ ok: false, reason });
        if (typeof memberId !== 'string' || !memberId || typeof projectId !== 'string' || !projectId) return deny('invalid');
        const member = memberRow(memberId);
        if (!member) return deny('member_missing');
        if ((member.status || 'active') === 'dormant') return deny('member_dormant');
        const project = projectRow(projectId);
        if (!project) return deny('project_missing');
        const membership = linkRow(projectId, memberId);
        if (!membership) return deny('not_linked');
        const history = entitlementsFor(memberId, projectId);
        const entitlement = history.find(e => e.state === 'active') || null;
        if (!entitlement) return deny(history.length ? 'revoked' : 'not_entitled');
        if (hash(identityOf(member)) !== hash(entitlement.member_snapshot)) return deny('identity_changed');
        return { ok: true, member, project, membership, entitlement };
    }
    /**
     * Fail closed: when the entitlement lookup itself cannot run (ledger table
     * missing, database error), the answer is a denial, never a stored or
     * cached projection. The client surface reports 503 `entitlement_unavailable`
     * so a consumer knows to stop serving, not to fall back to a snapshot.
     */
    const lookupUnavailable = error => {
        console.error('[ClientAccess] entitlement lookup failed; access denied:', error && error.message ? error.message : error);
        return fail(503, 'Entitlement lookup unavailable; project access is denied', 'entitlement_unavailable');
    };
    const requireAccess = (memberId, projectId) => {
        let access;
        try { access = resolveAccess(memberId, projectId); } catch (error) { throw lookupUnavailable(error); }
        if (!access.ok) throw fail(403, 'Project access is not granted', 'not_entitled');
        return access;
    };

    function grant(projectId, input, { by, authority }) {
        return db.transaction(() => {
            if (!projectRow(projectId)) throw fail(404, 'Project not found');
            const memberId = text(input?.member_id, 'member_id', { required: true, max: 200 });
            const member = memberRow(memberId);
            if (!member) throw fail(404, 'Member not found');
            if ((member.status || 'active') === 'dormant') throw fail(409, 'Member is dormant; reactivate the member before granting access');
            if (!linkRow(projectId, memberId)) throw fail(409, 'Member is not linked to this project; link the member first (project access never creates membership)');
            if (typeof by !== 'string' || !by.trim() || typeof authority !== 'string' || !authority.trim()) throw fail(500, 'Grant authority is not identified');
            const identity = identityOf(member);
            const existing = activeEntitlement(memberId, projectId);
            if (existing) {
                if (hash(existing.member_snapshot) === hash(identity)) return { entitlement: existing, duplicate: true };
                // The member's recorded identity changed: close the stale grant in the ledger and start a fresh one.
                recordAccessEvent(existing, 'revoked', { reason: 'identity_changed_regrant', by, authority });
            }
            const row = {
                id: randomUUID(), member_id: memberId, project_id: projectId, scope: SCOPE,
                member_snapshot: JSON.stringify(identity), granted_by: by.trim(), authority: authority.trim(),
                source: text(input?.source, 'source', { max: 1000 }), note: text(input?.note, 'note', { max: 2000 }), granted_at: now(),
            };
            db.prepare(`INSERT INTO client_project_entitlements(id, member_id, project_id, scope, member_snapshot, granted_by, authority, source, note, granted_at)
                VALUES (@id, @member_id, @project_id, @scope, @member_snapshot, @granted_by, @authority, @source, @note, @granted_at)`).run(row);
            const entitlement = hydrateEntitlement(db.prepare('SELECT * FROM client_project_entitlements WHERE id = ?').get(row.id));
            recordAccessEvent(entitlement, 'granted', { by: row.granted_by, authority: row.authority, source: row.source, note: row.note });
            return { entitlement: hydrateEntitlement(db.prepare('SELECT * FROM client_project_entitlements WHERE id = ?').get(row.id)), duplicate: false };
        }).immediate();
    }

    function revoke(projectId, entitlementId, input, { by, authority }) {
        return db.transaction(() => {
            const row = typeof entitlementId === 'string' && entitlementId
                ? db.prepare('SELECT * FROM client_project_entitlements WHERE id = ? AND project_id = ?').get(entitlementId, projectId) : null;
            if (!row) throw fail(404, 'Entitlement not found');
            const entitlement = hydrateEntitlement(row);
            if (entitlement.state === 'revoked') return { entitlement, duplicate: true };
            if (typeof by !== 'string' || !by.trim() || typeof authority !== 'string' || !authority.trim()) throw fail(500, 'Revocation authority is not identified');
            recordAccessEvent(entitlement, 'revoked', { reason: text(input?.reason, 'reason', { max: 2000 }), by: by.trim(), authority: authority.trim() });
            return { entitlement: hydrateEntitlement(row), duplicate: false };
        }).immediate();
    }

    // ── Artifacts (immutable published versions) ──────────────────────────
    function reviewsForArtifact(artifactId) {
        return db.prepare('SELECT * FROM client_reviews WHERE artifact_id = ? ORDER BY created_at, rowid').all(artifactId);
    }
    function hydrateArtifact(row, { reviewView = publicReview } = {}) {
        const events = db.prepare('SELECT * FROM client_artifact_events WHERE artifact_id = ? ORDER BY seq').all(row.id)
            .map(event => ({ ...parse(event.document, {}), kind: event.kind, seq: event.seq }));
        const withdrawn = events.find(event => event.kind === 'withdrawn') || null;
        const successor = db.prepare('SELECT id FROM client_artifacts WHERE supersedes_id = ? ORDER BY published_at, rowid LIMIT 1').get(row.id) || null;
        const reviews = reviewsForArtifact(row.id).map(reviewView);
        return {
            id: row.id, project_id: row.project_id, kind: row.kind, title: row.title, version: row.version, version_hash: row.version_hash,
            // Re-checked on every read so a stored row can never project an unsafe link, whatever wrote it.
            url: safeHttpUrl(row.url),
            document: row.document_id ? { id: row.document_id, title: documentTitle(row.document_id), revision_id: row.revision_id, content_hash: row.content_hash } : null,
            checkpoint_id: row.checkpoint_id ?? null, task_id: row.task_id ?? null, notes: row.notes ?? null,
            supersedes_id: row.supersedes_id ?? null, superseded_by: successor ? successor.id : null,
            state: withdrawn ? 'withdrawn' : successor ? 'superseded' : 'current',
            published_by: row.published_by, authority: row.authority, published_at: row.published_at,
            withdrawn: withdrawn ? { at: withdrawn.at, reason: withdrawn.reason ?? null, by: withdrawn.by ?? null, authority: withdrawn.authority ?? null } : null,
            reviews,
            accepted: reviews.filter(review => review.decision === 'accept' && review.version_hash === row.version_hash),
        };
    }
    function documentTitle(documentId) {
        const doc = db.prepare('SELECT title FROM review_documents WHERE id = ?').get(documentId);
        return doc ? doc.title : null;
    }
    const artifactRow = (projectId, artifactId) => (typeof artifactId === 'string' && artifactId
        ? db.prepare('SELECT * FROM client_artifacts WHERE id = ? AND project_id = ?').get(artifactId, projectId) : null) || null;
    const projectArtifacts = (projectId, options) => db.prepare('SELECT * FROM client_artifacts WHERE project_id = ? ORDER BY published_at, rowid').all(projectId)
        .map(row => hydrateArtifact(row, options));

    function publishArtifact(projectId, input, { by, authority }) {
        return db.transaction(() => {
            const project = projectRow(projectId);
            if (!project) throw fail(404, 'Project not found');
            if (typeof by !== 'string' || !by.trim() || typeof authority !== 'string' || !authority.trim()) throw fail(500, 'Publish authority is not identified');
            const kind = text(input?.kind, 'kind', { required: true, max: 40 });
            if (!ARTIFACT_KINDS.includes(kind)) throw fail(400, `kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
            const title = text(input?.title, 'title', { required: true, max: 300 });
            const notes = text(input?.notes, 'notes', { max: 4000 });
            let documentId = null, revisionId = null, contentHash = null, url = null;
            let version = text(input?.version, 'version', { max: 200 });
            if (kind === 'document') {
                documentId = text(input?.document_id, 'document_id', { required: true, max: 200 });
                const doc = db.prepare('SELECT id, project_id, current_revision_id FROM review_documents WHERE id = ?').get(documentId);
                if (!doc) throw fail(404, 'Document not found');
                if (doc.project_id !== projectId) throw fail(409, 'Document is not registered to this project', 'document_project_mismatch');
                revisionId = text(input?.revision_id, 'revision_id', { max: 200 }) || doc.current_revision_id || null;
                if (!revisionId) throw fail(409, 'Document has no captured revision to publish', 'document_revision_missing');
                const revision = db.prepare('SELECT id, document_id, content_hash FROM review_document_revisions WHERE id = ?').get(revisionId);
                if (!revision || revision.document_id !== documentId) throw fail(409, 'Revision does not belong to this document', 'document_revision_mismatch');
                contentHash = revision.content_hash;
                if (!version) version = contentHash.slice(0, 12);
            } else {
                url = httpUrl(input?.url, 'url', { required: kind !== 'deliverable' });
                if (!version) throw fail(400, 'version is required so acceptance names one exact version');
            }
            const checkpointId = text(input?.checkpoint_id, 'checkpoint_id', { max: 200 });
            if (checkpointId) {
                const plan = parse(project.checkpoints, null);
                if (!Array.isArray(plan?.items) || !plan.items.some(cp => cp && cp.id === checkpointId)) throw fail(409, 'checkpoint_id is not in this project plan');
            }
            const taskId = text(input?.task_id, 'task_id', { max: 200 });
            if (taskId && !db.prepare('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?').get(taskId, projectId)) throw fail(409, 'task_id is not a task of this project');
            const supersedesId = text(input?.supersedes_id, 'supersedes_id', { max: 200 });
            // An identical retry is recognized before any supersession rule can reject it (QA repair
            // 2026-10-02): the same identity that is already current returns that artifact, unless the
            // retry names a different predecessor, which is a competing claim rather than a retry.
            const versionHash = hash({ project_id: projectId, kind, title, version, url, document_id: documentId, revision_id: revisionId, content_hash: contentHash });
            const existing = db.prepare('SELECT * FROM client_artifacts WHERE project_id = ? AND version_hash = ? ORDER BY published_at DESC, rowid DESC').all(projectId, versionHash)
                .map(row => hydrateArtifact(row)).find(artifact => artifact.state === 'current');
            if (existing) {
                if (supersedesId && existing.supersedes_id !== supersedesId) throw fail(409, 'That version is already published and names a different supersedes_id', 'publish_conflict');
                return { artifact: existing, duplicate: true };
            }
            if (supersedesId) {
                const prior = artifactRow(projectId, supersedesId);
                if (!prior) throw fail(409, 'supersedes_id is not an artifact of this project');
                if (db.prepare('SELECT 1 FROM client_artifacts WHERE supersedes_id = ?').get(supersedesId)) throw fail(409, 'That artifact is already superseded', 'artifact_already_superseded');
            }
            const row = {
                id: randomUUID(), project_id: projectId, kind, title, version, version_hash: versionHash, document_id: documentId, revision_id: revisionId,
                content_hash: contentHash, url, checkpoint_id: checkpointId, task_id: taskId, notes, supersedes_id: supersedesId,
                published_by: by.trim(), authority: authority.trim(), published_at: now(),
            };
            db.prepare(`INSERT INTO client_artifacts(id, project_id, kind, title, version, version_hash, document_id, revision_id, content_hash, url,
                checkpoint_id, task_id, notes, supersedes_id, published_by, authority, published_at)
                VALUES (@id, @project_id, @kind, @title, @version, @version_hash, @document_id, @revision_id, @content_hash, @url,
                @checkpoint_id, @task_id, @notes, @supersedes_id, @published_by, @authority, @published_at)`).run(row);
            db.prepare('INSERT INTO client_artifact_events(artifact_id, kind, document) VALUES (?, ?, ?)')
                .run(row.id, 'published', JSON.stringify({ id: randomUUID(), at: row.published_at, by: row.published_by, authority: row.authority, version_hash: versionHash }));
            return { artifact: hydrateArtifact(db.prepare('SELECT * FROM client_artifacts WHERE id = ?').get(row.id)), duplicate: false };
        }).immediate();
    }

    function withdrawArtifact(projectId, artifactId, input, { by, authority }) {
        return db.transaction(() => {
            const row = artifactRow(projectId, artifactId);
            if (!row) throw fail(404, 'Artifact not found');
            const artifact = hydrateArtifact(row);
            if (artifact.state === 'withdrawn') return { artifact, duplicate: true };
            if (typeof by !== 'string' || !by.trim() || typeof authority !== 'string' || !authority.trim()) throw fail(500, 'Withdraw authority is not identified');
            db.prepare('INSERT INTO client_artifact_events(artifact_id, kind, document) VALUES (?, ?, ?)')
                .run(row.id, 'withdrawn', JSON.stringify({ id: randomUUID(), at: now(), reason: text(input?.reason, 'reason', { max: 2000 }), by: by.trim(), authority: authority.trim() }));
            return { artifact: hydrateArtifact(row), duplicate: false };
        }).immediate();
    }

    // ── Client reviews (append-only, version-bound) ───────────────────────
    function recordReview(memberId, projectId, artifactId, input, { session, authority }) {
        return db.transaction(() => {
            const access = requireAccess(memberId, projectId);
            if (!session || typeof session !== 'object' || !SHA256_HEX.test(String(session.sha256 || ''))) throw fail(401, 'Authenticated client session assertion required', 'session_required');
            const expiresAt = Date.parse(String(session.expires_at || ''));
            if (!Number.isFinite(expiresAt)) throw fail(401, 'Client session assertion is malformed', 'session_invalid');
            if (expiresAt <= Date.now()) throw fail(401, 'Client session has expired', 'session_expired');
            if (typeof authority !== 'string' || !authority.trim()) throw fail(500, 'Review authority is not identified');
            const row = artifactRow(projectId, artifactId);
            if (!row) throw fail(404, 'Artifact not found', 'artifact_not_found');
            const decisionId = text(input?.client_decision_id, 'client_decision_id', { required: true, max: 200 });
            const decision = text(input?.decision, 'decision', { required: true, max: 40 });
            if (!REVIEW_DECISIONS.includes(decision)) throw fail(400, `decision must be one of: ${REVIEW_DECISIONS.join(', ')}`);
            const versionHash = text(input?.version_hash, 'version_hash', { required: true, max: 64 });
            if (!SHA256_HEX.test(versionHash)) throw fail(400, 'version_hash must be the artifact sha256 version hash');
            const body = text(input?.body, 'body', { required: decision !== 'accept', max: MAX_BODY }) || '';
            const requestHash = hash({ artifact_id: row.id, decision, version_hash: versionHash, body });
            // Every acknowledged key is reserved against its payload in client_review_keys, including a
            // key that resolved to an existing acceptance, so reuse with a different payload is always
            // 409 `decision_conflict` and an identical replay always returns the same review.
            const acknowledge = (stored, duplicate) => {
                db.prepare(`INSERT OR IGNORE INTO client_review_keys(member_id, project_id, client_decision_id, request_hash, review_id, recorded_at)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(memberId, projectId, decisionId, requestHash, stored.id, now());
                return { review: publicReview(stored), artifact: hydrateArtifact(artifactRow(projectId, stored.artifact_id)), duplicate, evidence_ref: evidenceRef(stored.id) };
            };
            const reserved = db.prepare('SELECT request_hash, review_id FROM client_review_keys WHERE member_id = ? AND project_id = ? AND client_decision_id = ?').get(memberId, projectId, decisionId);
            if (reserved) {
                if (reserved.request_hash !== requestHash) throw fail(409, 'client_decision_id was already used for a different review', 'decision_conflict');
                const stored = db.prepare('SELECT * FROM client_reviews WHERE id = ?').get(reserved.review_id);
                if (!stored) throw fail(409, 'client_decision_id was already used for a different review', 'decision_conflict');
                return acknowledge(stored, true);
            }
            const artifact = hydrateArtifact(row);
            if (versionHash !== artifact.version_hash) throw fail(409, 'version_hash does not name the published version of this artifact', 'version_mismatch');
            if (artifact.state !== 'current') throw fail(409, `Artifact is ${artifact.state}; review the current version`, 'artifact_not_current');
            const priorAccept = reviewsForArtifact(row.id).find(r => r.member_id === memberId && r.decision === 'accept');
            if (priorAccept) {
                if (decision === 'accept') return acknowledge(priorAccept, true);
                if (decision === 'request_changes') throw fail(409, 'This version is already accepted by this member; publish a new version to reopen review', 'already_accepted');
            }
            const review = {
                id: randomUUID(), client_decision_id: decisionId, member_id: memberId, project_id: projectId, artifact_id: row.id,
                version_hash: versionHash, decision, body, request_hash: requestHash, session_sha256: session.sha256,
                session_expires_at: new Date(expiresAt).toISOString(), authority: authority.trim(),
                member_snapshot: JSON.stringify(identityOf(access.member)), created_at: now(),
            };
            db.prepare(`INSERT INTO client_reviews(id, client_decision_id, member_id, project_id, artifact_id, version_hash, decision, body, request_hash,
                session_sha256, session_expires_at, authority, member_snapshot, created_at)
                VALUES (@id, @client_decision_id, @member_id, @project_id, @artifact_id, @version_hash, @decision, @body, @request_hash,
                @session_sha256, @session_expires_at, @authority, @member_snapshot, @created_at)`).run(review);
            return acknowledge(db.prepare('SELECT * FROM client_reviews WHERE id = ?').get(review.id), false);
        }).immediate();
    }
    const projectReviews = (projectId, view = publicReview) => db.prepare('SELECT * FROM client_reviews WHERE project_id = ? ORDER BY created_at, rowid').all(projectId).map(view);

    // ── Client-safe projections ───────────────────────────────────────────
    const SAFE_URL_KEYS = ['production', 'repo', 'docs'];
    function projectView(project) {
        const urls = parse(project.urls, {}) || {};
        const safeUrls = {};
        // Allowlisted keys only, and only credential-free http(s) values: a project setting is operator
        // input and may hold an authenticated clone URL, a local file path or anything else.
        for (const key of SAFE_URL_KEYS) {
            const safe = safeHttpUrl(urls[key]);
            if (safe) safeUrls[key] = safe;
        }
        const needs = (Array.isArray(parse(project.needs, [])) ? parse(project.needs, []) : []).filter(need => need && typeof need === 'object').map(need => ({
            id: String(need.id ?? ''), kind: typeof need.kind === 'string' ? need.kind : null, description: typeof need.description === 'string' ? need.description : '',
            status: typeof need.status === 'string' ? need.status : 'open', blocking: need.knowledge?.blocking === true,
            question: typeof need.knowledge?.question === 'string' ? need.knowledge.question : null,
            satisfaction_test: typeof need.knowledge?.satisfaction_test === 'string' ? need.knowledge.satisfaction_test : null,
            created_at: typeof need.created_at === 'string' ? need.created_at : null,
        }));
        const criteria = (Array.isArray(parse(project.end_state_criteria, [])) ? parse(project.end_state_criteria, []) : []).filter(c => c && typeof c === 'object').map(c => ({
            id: String(c.id ?? ''), description: typeof c.description === 'string' ? c.description : '', kind: typeof c.kind === 'string' ? c.kind : null, enabled: c.enabled !== false,
        }));
        const plan = parse(project.checkpoints, null);
        const items = Array.isArray(plan?.items) ? plan.items.filter(cp => cp && typeof cp === 'object') : [];
        const currentId = items.find(cp => (cp.status || 'pending') === 'pending')?.id ?? null;
        return {
            project: {
                id: project.id, name: project.name, description: project.description ?? null, status: project.status ?? 'active',
                urls: safeUrls, created_at: project.created_at ?? null, updated_at: project.updated_at ?? null,
            },
            requirements: { end_state: project.end_state ?? null, end_state_updated_at: project.end_state_updated_at ?? null, criteria, needs },
            checkpoints: {
                current_id: currentId, sequence_completed_at: plan?.sequence_completed_at ?? null,
                items: items.map(cp => ({
                    id: String(cp.id ?? ''), title: typeof cp.title === 'string' ? cp.title : '', goal: typeof cp.goal === 'string' ? cp.goal : '',
                    status: typeof cp.status === 'string' ? cp.status : 'pending', current: cp.id === currentId,
                    completed_at: typeof cp.completion?.at === 'string' ? cp.completion.at : null,
                    criteria: (Array.isArray(cp.criteria) ? cp.criteria : []).filter(c => c && typeof c === 'object').map(c => ({
                        id: String(c.id ?? ''), description: typeof c.description === 'string' ? c.description : '', kind: typeof c.kind === 'string' ? c.kind : null,
                    })),
                })),
            },
        };
    }
    /** Task progress only: no descriptions, prompts, executor outputs, model or dispatch fields leave the server. */
    function taskProgress(projectId) {
        return db.prepare(`SELECT id, name, status, priority, created_at, updated_at, last_activity_at, metadata FROM tasks
            WHERE project_id = ? AND archived_at IS NULL ORDER BY sort_order ASC, priority DESC, created_at DESC`).all(projectId).map(row => {
            const metadata = parse(row.metadata, {}) || {};
            const gate = metadata.stakeholder_gate;
            return {
                id: row.id, name: row.name, status: row.status, priority: row.priority ?? 0, created_at: row.created_at,
                updated_at: row.updated_at ?? null, last_activity_at: row.last_activity_at ?? null,
                summary: typeof metadata.client_summary === 'string' ? metadata.client_summary.slice(0, 2000) : null,
                checkpoint_id: typeof metadata.checkpoint_id === 'string' ? metadata.checkpoint_id : null,
                request_status: gate && typeof gate === 'object' && typeof gate.status === 'string' ? gate.status : null,
            };
        });
    }
    function workspace(memberId, projectId) {
        const access = requireAccess(memberId, projectId);
        const reviews = projectReviews(projectId);
        return {
            generated_at: now(),
            member: identityOf(access.member),
            entitlement: { id: access.entitlement.id, scope: access.entitlement.scope, granted_at: access.entitlement.granted_at },
            membership: { role: access.membership.role ?? null, decision_maker: access.membership.decision_maker === 1 || access.membership.decision_maker === true },
            ...projectView(access.project),
            tasks: taskProgress(projectId),
            artifacts: projectArtifacts(projectId),
            decisions: reviews.filter(review => review.decision === 'accept'),
            feedback: reviews.filter(review => review.decision !== 'accept'),
        };
    }
    function artifactForMember(memberId, projectId, artifactId) {
        requireAccess(memberId, projectId);
        const row = artifactRow(projectId, artifactId);
        if (!row) throw fail(404, 'Artifact not found', 'artifact_not_found');
        const artifact = hydrateArtifact(row);
        let content = null;
        if (row.revision_id) {
            // Declared deliverables hash their original bytes, not normalized display text.
            const revision = db.prepare(`SELECT COALESCE(e.exact_content, r.content) AS content,
                r.content_hash, r.byte_length, r.line_count, r.captured_at
                FROM review_document_revisions r LEFT JOIN review_document_revision_exact e ON e.revision_id = r.id
                WHERE r.id = ? AND r.document_id = ?`).get(row.revision_id, row.document_id);
            if (revision) content = { content: revision.content, content_hash: revision.content_hash, byte_length: revision.byte_length, line_count: revision.line_count, captured_at: revision.captured_at };
        }
        return { artifact, content };
    }
    function listMemberProjects(memberId) {
        if (typeof memberId !== 'string' || !memberId) return [];
        const projects = [];
        try {
            const rows = db.prepare('SELECT DISTINCT project_id FROM client_project_entitlements WHERE member_id = ?').all(memberId);
            for (const { project_id: projectId } of rows) {
                const access = resolveAccess(memberId, projectId);
                if (!access.ok) continue;
                projects.push({ id: access.project.id, name: access.project.name, status: access.project.status ?? 'active', granted_at: access.entitlement.granted_at, entitlement_id: access.entitlement.id, role: access.membership.role ?? null });
            }
        } catch (error) { throw lookupUnavailable(error); }
        return projects;
    }
    /** Operator view: every grant with its live resolution, every artifact, every review (session hashes included). */
    function listForProject(projectId) {
        if (!projectRow(projectId)) throw fail(404, 'Project not found');
        const entitlements = db.prepare('SELECT * FROM client_project_entitlements WHERE project_id = ? ORDER BY granted_at, rowid').all(projectId).map(row => {
            const entitlement = hydrateEntitlement(row);
            const member = memberRow(row.member_id);
            const resolution = resolveAccess(row.member_id, projectId);
            // `access` is this row's live answer: its own revocation first, then the member's resolution
            // (`granted` through this row, `superseded` when a newer grant carries the access, else the denial reason).
            const access = entitlement.state === 'revoked' ? 'revoked'
                : resolution.ok ? (resolution.entitlement.id === entitlement.id ? 'granted' : 'superseded') : resolution.reason;
            return { ...entitlement, member: member ? { ...identityOf(member), status: member.status || 'active' } : null, access };
        });
        return { project_id: projectId, scope: SCOPE, entitlements, artifacts: projectArtifacts(projectId, { reviewView: fullReview }), reviews: projectReviews(projectId, fullReview) };
    }

    return {
        SCOPE, ARTIFACT_KINDS, REVIEW_DECISIONS, evidenceRef,
        resolveAccess, grant, revoke, publishArtifact, withdrawArtifact, recordReview,
        workspace, artifactForMember, listMemberProjects, listForProject,
    };
}

module.exports = { initializeClientAccess, createClientAccess, SCOPE, ARTIFACT_KINDS, REVIEW_DECISIONS, EVIDENCE_PREFIX, evidenceRef, identityOf, safeHttpUrl };
