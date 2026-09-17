/**
 * Append-only member memory. The interaction_log migration can recover only
 * entries still present at first boot: previously pruned entries and truncated
 * text are unrecoverable. General legacy notes are never inferred into projects.
 */
const { randomUUID, createHash } = require('crypto');
const { MemberMemoryInputSchema } = require('@praxis/contract');

const OPTIONAL = ['fact_key', 'source_ref', 'occurred_at', 'valid_from', 'valid_until',
    'supersedes_id', 'target_id', 'owner', 'due_at', 'outcome', 'idempotency_key', 'legacy_at', 'legacy_source'];
const COLUMNS = ['id', 'member_id', 'project_id', 'recorded_at', 'kind', 'text', 'evidence', 'source', ...OPTIONAL];
function failure(status, message) { return Object.assign(new Error(message), { status }); }
function eventFromRow(row) {
    const event = { id: row.id, seq: row.seq, member_id: row.member_id, project_id: row.project_id,
        recorded_at: row.recorded_at, kind: row.kind, text: row.text, evidence: row.evidence, source: row.source };
    for (const key of OPTIONAL) if (row[key] !== null && row[key] !== undefined) event[key] = row[key];
    return event;
}
function insertEvent(db, event, requestJson) {
    const result = db.prepare(`INSERT INTO member_memory_events (${COLUMNS.join(', ')}, request_json)
        VALUES (${[...COLUMNS, 'request_json'].map(() => '?').join(', ')})`)
        .run(...COLUMNS.map(key => event[key] ?? null), requestJson);
    return { ...event, seq: Number(result.lastInsertRowid) };
}
function deterministicId(memberId, index, entry) {
    const hex = createHash('sha256').update(JSON.stringify(['interaction_log_v1', memberId, index, entry])).digest('hex').slice(0, 32).split('');
    hex[12] = '5'; hex[16] = '8';
    const value = hex.join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function initializeMemberMemory(db) {
    db.transaction(() => {
        // Whole-member erasure cascades; project unlink/deletion keeps historical
        // scope. Individual events remain immutable while their member exists.
        db.exec(`CREATE TABLE IF NOT EXISTS member_memory_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            member_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, project_id TEXT, recorded_at TEXT NOT NULL,
            kind TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL,
            fact_key TEXT, source_ref TEXT, occurred_at TEXT, valid_from TEXT, valid_until TEXT,
            supersedes_id TEXT REFERENCES member_memory_events(id), target_id TEXT REFERENCES member_memory_events(id),
            owner TEXT, due_at TEXT, outcome TEXT, idempotency_key TEXT, legacy_at TEXT, legacy_source TEXT,
            request_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_member_memory_scope ON member_memory_events(member_id, project_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_member_memory_idempotency
            ON member_memory_events(member_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS member_memory_no_update BEFORE UPDATE ON member_memory_events
            BEGIN SELECT RAISE(ABORT, 'Member memory is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS member_memory_no_delete BEFORE DELETE ON member_memory_events
            WHEN EXISTS (SELECT 1 FROM contacts WHERE id = OLD.member_id)
            BEGIN SELECT RAISE(ABORT, 'Member memory is append-only'); END;
        CREATE TABLE IF NOT EXISTS member_memory_migrations (name TEXT PRIMARY KEY, recorded_at TEXT NOT NULL);`);
        if (!db.prepare('PRAGMA table_info(member_memory_events)').all().some(column => column.name === 'legacy_source')) {
            db.exec('ALTER TABLE member_memory_events ADD COLUMN legacy_source TEXT');
        }
        if (db.prepare('SELECT 1 FROM member_memory_migrations WHERE name = ?').get('interaction_log_v1')) return;
        const recordedAt = new Date().toISOString();
        for (const row of db.prepare('SELECT id, interaction_log FROM contacts').all()) {
            let entries;
            try { entries = JSON.parse(row.interaction_log || '[]'); } catch { continue; }
            if (!Array.isArray(entries)) continue;
            entries.forEach((entry, index) => {
                if (!entry || typeof entry !== 'object' || entry.note === undefined || entry.note === null) return;
                const parsedSource = MemberMemoryInputSchema.safeParse({ kind: 'observation', text: 'legacy', evidence: 'observed', source: entry.source });
                const event = { id: deterministicId(row.id, index, entry), member_id: row.id, project_id: null,
                    recorded_at: recordedAt, kind: 'observation', text: typeof entry.note === 'string' ? entry.note : JSON.stringify(entry.note),
                    evidence: 'legacy', source: parsedSource.success ? parsedSource.data.source : 'legacy' };
                if (entry.source !== undefined) event.legacy_source = typeof entry.source === 'string' ? entry.source : JSON.stringify(entry.source);
                if (entry.at !== undefined && entry.at !== null) {
                    event.legacy_at = typeof entry.at === 'string' ? entry.at : JSON.stringify(entry.at);
                    const parsed = MemberMemoryInputSchema.safeParse({ kind: 'observation', text: 'legacy',
                        evidence: 'observed', source: 'legacy', occurred_at: entry.at });
                    if (parsed.success) event.occurred_at = parsed.data.occurred_at;
                }
                insertEvent(db, event, JSON.stringify(event));
            });
        }
        db.prepare('INSERT INTO member_memory_migrations VALUES (?, ?)').run('interaction_log_v1', recordedAt);
    }).immediate();
}

function effectiveAt(event) { return event.valid_from || event.recorded_at; }
function cancelledBeforeEffective(event, events) {
    return event.kind === 'fact' && events.some(retraction => retraction.kind === 'retraction'
        && retraction.target_id === event.id && retraction.recorded_at < effectiveAt(event));
}
function projectState(events, asOf) {
    const visible = events.filter(event => event.recorded_at <= asOf);
    const removedFacts = new Set();
    const closedCommitments = new Set();
    for (const event of visible) {
        // Once a correction becomes effective, expiry never revives its predecessor.
        if (event.supersedes_id && effectiveAt(event) <= asOf && !cancelledBeforeEffective(event, visible)) removedFacts.add(event.supersedes_id);
        if (event.kind === 'retraction') removedFacts.add(event.target_id);
        if (event.kind === 'resolution') closedCommitments.add(event.target_id);
    }
    return {
        current_facts: visible.filter(event => event.kind === 'fact' && !removedFacts.has(event.id)
            && effectiveAt(event) <= asOf && (!event.valid_until || event.valid_until > asOf)),
        open_commitments: visible.filter(event => event.kind === 'commitment' && !closedCommitments.has(event.id)),
    };
}
function validateReadOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw failure(400, 'Invalid memory query');
    const projectId = options.project_id ?? null;
    if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim())) throw failure(400, 'project_id must be a nonempty string');
    const limit = options.limit ?? 30;
    const before = options.before_seq ?? null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure(400, 'limit must be an integer from 1 to 100');
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw failure(400, 'before_seq must be a positive integer');
    return { project_id: projectId, limit, before_seq: before };
}

function createMemberMemoryLedger(db, { now = () => new Date().toISOString() } = {}) {
    function assertMember(memberId) {
        if (!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(memberId)) throw failure(404, 'Member not found');
    }
    function stateEvents(memberId, projectId) {
        // Observations never affect fact/commitment state. Keep their potentially
        // long text out of projections and transition validation.
        return db.prepare(`SELECT * FROM member_memory_events WHERE member_id = ? AND project_id IS ?
            AND kind IN ('fact', 'commitment', 'retraction', 'resolution') ORDER BY seq DESC`)
            .all(memberId, projectId).map(eventFromRow);
    }
    function append(memberId, input, { onAppend, legacyAt } = {}) {
        const parsed = MemberMemoryInputSchema.safeParse(input);
        if (!parsed.success) throw failure(400, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
        const normalized = parsed.data;
        if (legacyAt !== undefined) normalized.legacy_at = String(legacyAt);
        const requestJson = JSON.stringify(normalized);
        return db.transaction(() => {
            assertMember(memberId);
            if (normalized.idempotency_key) {
                const existing = db.prepare('SELECT * FROM member_memory_events WHERE member_id = ? AND idempotency_key = ?')
                    .get(memberId, normalized.idempotency_key);
                if (existing) {
                    if (existing.request_json !== requestJson) throw failure(409, 'idempotency_key was already used for a different request');
                    return eventFromRow(existing);
                }
            }
            if (normalized.project_id !== null) {
                if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(normalized.project_id)) throw failure(404, 'Project not found');
                if (!db.prepare('SELECT 1 FROM project_contacts WHERE project_id = ? AND contact_id = ?')
                    .get(normalized.project_id, memberId)) throw failure(409, 'Member is not linked to this project');
            }
            const recordedAt = now();
            const targetId = normalized.supersedes_id || normalized.target_id;
            if (targetId) {
                const events = stateEvents(memberId, normalized.project_id);
                const target = events.find(event => event.id === targetId);
                if (!target) throw failure(409, 'Target must belong to this member and exact project scope');
                // The IMMEDIATE transaction serializes competing writers. A cancelled
                // pending correction releases its predecessor for a new correction.
                const claimed = events.some(event => (event.supersedes_id === targetId || event.target_id === targetId)
                    && !cancelledBeforeEffective(event, events));
                if (claimed) throw failure(409, 'Target has already been corrected, retracted, or resolved');
                const state = projectState(events, recordedAt);
                if (normalized.kind === 'resolution') {
                    if (!state.open_commitments.some(event => event.id === targetId)) throw failure(409, 'Resolution requires an open commitment');
                } else {
                    const scheduledRetraction = normalized.kind === 'retraction' && target.kind === 'fact' && effectiveAt(target) > recordedAt;
                    if (!scheduledRetraction && !state.current_facts.some(event => event.id === targetId)) throw failure(409, 'Correction requires an active fact; retraction requires an active or scheduled fact');
                    if (normalized.supersedes_id && target.fact_key !== normalized.fact_key) throw failure(409, 'Correction must retain the same fact_key');
                }
            }
            const event = insertEvent(db, { ...normalized, id: randomUUID(), member_id: memberId, recorded_at: recordedAt }, requestJson);
            if (onAppend) onAppend(event);
            return event;
        }).immediate();
    }
    function snapshot(memberId, options = {}) {
        const scope = validateReadOptions(options);
        return db.transaction(() => {
            assertMember(memberId);
            const asOf = now();
            const totalEvents = db.prepare('SELECT COUNT(*) AS total FROM member_memory_events WHERE member_id = ? AND project_id IS ?')
                .get(memberId, scope.project_id).total;
            if (scope.project_id !== null && !totalEvents && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(scope.project_id)) {
                throw failure(404, 'Project not found');
            }
            const state = projectState(stateEvents(memberId, scope.project_id), asOf);
            const groups = new Map();
            for (const fact of state.current_facts) {
                if (!groups.has(fact.fact_key)) groups.set(fact.fact_key, []);
                groups.get(fact.fact_key).push(fact);
            }
            const conflicts = [...groups].filter(([, facts]) => new Set(facts.map(fact => fact.text)).size > 1)
                .map(([fact_key, facts]) => ({ fact_key, events: facts }));
            const cursorClause = scope.before_seq === null ? '' : ' AND seq < ?';
            const params = [memberId, scope.project_id];
            if (scope.before_seq !== null) params.push(scope.before_seq);
            params.push(scope.limit + 1);
            const page = db.prepare(`SELECT * FROM member_memory_events WHERE member_id = ? AND project_id IS ?${cursorClause}
                ORDER BY seq DESC LIMIT ?`).all(...params).map(eventFromRow);
            const timeline = page.slice(0, scope.limit);
            return { member_id: memberId, project_id: scope.project_id, as_of: asOf, ...state, conflicts, timeline,
                total_events: totalEvents, next_before_seq: page.length > scope.limit ? timeline.at(-1).seq : null };
        })();
    }
    return { append, snapshot };
}

module.exports = { initializeMemberMemory, createMemberMemoryLedger };
