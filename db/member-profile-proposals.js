/** Source-bound proposals over the immutable member-memory ledger. */
const { randomUUID, createHash } = require('crypto');
const { z } = require('zod');

const uuid = z.string().uuid();
const submitSchema = z.object({
    capture_id: uuid,
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_event_ids: z.array(uuid).min(1).max(32).refine(ids => new Set(ids).size === ids.length, 'Duplicate source event'),
    extractor_version: z.literal('member-profile-v1'),
    candidates: z.array(z.object({ category: z.enum(['preference', 'goal', 'expertise', 'commitment']),
        quote: z.string().max(2000).refine(value => value.trim().length > 0) }).strict()).max(8),
}).strict();
const reviewSchema = z.object({ decision: z.enum(['accept', 'dismiss']),
    expected_memory_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const listSchema = z.object({ project_id: z.string().min(1).refine(value => value.trim().length > 0).nullable().default(null),
    status: z.enum(['pending', 'applied', 'dismissed']).default('pending'),
    before_created_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(50).default(20),
}).strict();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
function parse(schema, input, message) {
    const result = schema.safeParse(input);
    // Never echo input, source text, or schema diagnostics into errors/logs.
    if (!result.success) throw failure(400, message);
    return result.data;
}
const directPreference = quote => /^I prefer (?:email|phone|the portal)\.?$/i.test(quote);
function factKey(category, quote) {
    if (category === 'commitment') return undefined;
    if (category === 'preference' && directPreference(quote)) return 'profile.preference.contact_channel';
    return `profile.${category}.${sha256(quote.trim().replace(/\s+/g, ' ').toLowerCase()).slice(0, 24)}`;
}

function initializeMemberProfileProposals(db) {
    db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS member_profile_proposal_batches (
            id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
            project_id TEXT, capture_id TEXT NOT NULL, extractor_version TEXT NOT NULL,
            source_hash TEXT NOT NULL, source_event_ids TEXT NOT NULL, source_response TEXT NOT NULL,
            source_question TEXT NOT NULL, source_origin TEXT NOT NULL, source_occurred_at TEXT NOT NULL,
            created_at TEXT NOT NULL, UNIQUE(member_id, capture_id, extractor_version)
        );
        CREATE TABLE IF NOT EXISTS member_profile_proposals (
            created_seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            batch_id TEXT NOT NULL REFERENCES member_profile_proposal_batches(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, project_id TEXT,
            category TEXT NOT NULL, quote TEXT NOT NULL, fact_key TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'dismissed')),
            reason TEXT NOT NULL, event_id TEXT, created_at TEXT NOT NULL, reviewed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_member_profile_proposals_scope
            ON member_profile_proposals(member_id, project_id, status, created_seq);
        CREATE INDEX IF NOT EXISTS idx_member_profile_proposals_batch ON member_profile_proposals(batch_id, created_seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_member_profile_source_batch
            ON member_profile_proposal_batches(member_id, extractor_version, source_hash);
        CREATE TRIGGER IF NOT EXISTS member_profile_batches_no_update BEFORE UPDATE ON member_profile_proposal_batches
            BEGIN SELECT RAISE(ABORT, 'Profile source is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS member_profile_batches_no_delete BEFORE DELETE ON member_profile_proposal_batches
            WHEN EXISTS (SELECT 1 FROM contacts WHERE id = OLD.member_id)
            BEGIN SELECT RAISE(ABORT, 'Profile source is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS member_profile_proposals_no_delete BEFORE DELETE ON member_profile_proposals
            WHEN EXISTS (SELECT 1 FROM contacts WHERE id = OLD.member_id)
            BEGIN SELECT RAISE(ABORT, 'Profile proposal is durable'); END;
        CREATE TRIGGER IF NOT EXISTS member_profile_proposals_immutable_source BEFORE UPDATE ON member_profile_proposals
            WHEN NEW.created_seq IS NOT OLD.created_seq OR NEW.id IS NOT OLD.id OR NEW.batch_id IS NOT OLD.batch_id
                OR NEW.member_id IS NOT OLD.member_id OR NEW.project_id IS NOT OLD.project_id
                OR NEW.category IS NOT OLD.category OR NEW.quote IS NOT OLD.quote OR NEW.fact_key IS NOT OLD.fact_key
                OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
            BEGIN SELECT RAISE(ABORT, 'Profile proposal source is immutable'); END;`);
    }).immediate();
}

const joined = `SELECT p.*, b.capture_id, b.source_event_ids, b.source_response, b.source_question,
    b.source_origin, b.source_occurred_at FROM member_profile_proposals p
    JOIN member_profile_proposal_batches b ON b.id = p.batch_id`;
function proposalFromRow(row) {
    const proposal = { id: row.id, created_seq: row.created_seq, capture_id: row.capture_id,
        category: row.category, quote: row.quote, source_event_ids: JSON.parse(row.source_event_ids),
        source_response: row.source_response, source_question: row.source_question, source_origin: row.source_origin,
        source_occurred_at: row.source_occurred_at, status: row.status, reason: row.reason, created_at: row.created_at };
    for (const key of ['fact_key', 'event_id', 'reviewed_at']) if (row[key] !== null) proposal[key] = row[key];
    return proposal;
}

function createMemberProfileProposals(db, ledger, { now = () => new Date().toISOString() } = {}) {
    function assertMember(memberId) {
        if (!uuid.safeParse(memberId).success || !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(memberId)) {
            throw failure(404, 'Member not found');
        }
    }
    function assertCurrentScope(memberId, projectId) {
        if (projectId === null) return;
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw failure(404, 'Project not found');
        if (!db.prepare('SELECT 1 FROM project_contacts WHERE contact_id = ? AND project_id = ?').get(memberId, projectId)) {
            throw failure(409, 'Member is not linked to this project');
        }
    }
    function memoryVersion(memberId, projectId) {
        return db.prepare('SELECT COALESCE(MAX(seq), 0) AS version FROM member_memory_events WHERE member_id = ? AND project_id IS ?')
            .get(memberId, projectId).version;
    }
    function readSource(memberId, input) {
        const invalid = () => failure(400, 'Invalid consultation source');
        const events = input.source_event_ids.map(id => db.prepare('SELECT * FROM member_memory_events WHERE id = ?').get(id));
        const first = events[0];
        if (!first) throw invalid();
        let consultationId, status, referencePrefix;
        const pieces = events.map((event, index) => {
            if (!event || event.member_id !== memberId || event.project_id !== first.project_id
                || event.kind !== 'observation' || event.evidence !== 'self_reported'
                || !['consultation', 'consultation:operator_relay'].includes(event.source)
                || event.source !== first.source || event.occurred_at !== first.occurred_at) throw invalid();
            const header = /^Consultation ([^,\r\n]+), ([^,\r\n]+), source part ([1-9]\d*)\/([1-9]\d*)\n/.exec(event.text);
            if (!header || Number(header[3]) !== index + 1 || Number(header[4]) !== events.length) throw invalid();
            if (index === 0) { consultationId = header[1]; status = header[2]; }
            if (header[1] !== consultationId || header[2] !== status || status !== 'answered') throw invalid();
            const suffix = `:part:${index + 1}/${events.length}`;
            if (typeof event.source_ref !== 'string' || !event.source_ref.endsWith(suffix)) throw invalid();
            const prefix = event.source_ref.slice(0, -suffix.length);
            if (index === 0) referencePrefix = prefix;
            if (prefix !== referencePrefix) throw invalid();
            return event.text.slice(header[0].length);
        });
        const serialized = pieces.join('');
        if (sha256(serialized) !== input.source_hash) throw invalid();
        let source;
        try { source = JSON.parse(serialized); } catch { throw invalid(); }
        if (!source || typeof source !== 'object' || Array.isArray(source)
            || source.consultationId !== consultationId || source.memberId !== memberId
            || source.projectId !== first.project_id || source.status !== 'answered'
            || typeof source.responseText !== 'string' || typeof source.question !== 'string'
            || !Object.hasOwn(source, 'responseOrigin')) throw invalid();
        let response = source.responseText;
        if (Object.hasOwn(source, 'email')) {
            if (!source.email || typeof source.email !== 'object' || Array.isArray(source.email)
                || typeof source.email.messageId !== 'string' || !source.email.messageId.trim()
                || typeof source.email.bodyText !== 'string') throw invalid();
            const emailKey = sha256(`${consultationId}\0${source.email.messageId}`);
            if (referencePrefix !== `consultation:${consultationId}:email:${emailKey}`) throw invalid();
            response = source.email.bodyText;
        } else if (referencePrefix !== `consultation:${consultationId}:revision:${input.capture_id}`) throw invalid();
        if (!response.trim() || response.length > 24000) throw invalid();
        const origin = first.source === 'consultation:operator_relay' || source.responseOrigin === 'operator_relay'
            ? 'operator_relay' : source.responseOrigin === 'member_reply' ? 'member_reply' : 'unknown';
        return { project_id: first.project_id, response, question: source.question, origin,
            occurred_at: first.occurred_at || first.recorded_at };
    }
    function batchResult(batch) {
        return { member_id: batch.member_id, project_id: batch.project_id, capture_id: batch.capture_id,
            proposals: db.prepare(`${joined} WHERE p.batch_id = ? ORDER BY p.created_seq`).all(batch.id).map(proposalFromRow) };
    }
    function appendProposal(memberId, row, automatic) {
        return ledger.append(memberId, {
            project_id: row.project_id, kind: row.category === 'commitment' ? 'commitment' : 'fact', text: row.quote,
            ...(row.category === 'commitment' ? { owner: 'member' } : { fact_key: row.fact_key }),
            evidence: row.source_origin === 'member_reply' ? 'self_reported' : 'inferred',
            source: automatic ? 'member_profile:auto' : 'member_profile:review',
            source_ref: `profile_proposal:${row.id}:source_events:${JSON.parse(row.source_event_ids).join(',')}`,
            occurred_at: row.source_occurred_at,
        });
    }
    function submit(memberId, input) {
        const request = parse(submitSchema, input, 'Invalid profile proposal request');
        return db.transaction(() => {
            assertMember(memberId);
            const prior = db.prepare('SELECT * FROM member_profile_proposal_batches WHERE member_id = ? AND capture_id = ? AND extractor_version = ?')
                .get(memberId, request.capture_id, request.extractor_version);
            const eventIds = JSON.stringify(request.source_event_ids);
            if (prior && (prior.source_hash !== request.source_hash || prior.source_event_ids !== eventIds)) {
                throw failure(409, 'Capture was already submitted with different source evidence');
            }
            // Email references contain message identity but no capture UUID. Bind the
            // immutable content once so another caller cannot replay it as a new batch.
            if (!prior && db.prepare('SELECT 1 FROM member_profile_proposal_batches WHERE member_id = ? AND extractor_version = ? AND source_hash = ?')
                .get(memberId, request.extractor_version, request.source_hash)) {
                throw failure(409, 'Source evidence was already submitted under another capture');
            }
            const source = readSource(memberId, request);
            const candidates = request.candidates.filter((candidate, index, all) => {
                if (!source.response.includes(candidate.quote)) throw failure(400, 'Candidate must quote the original response exactly');
                return all.findIndex(other => other.category === candidate.category && other.quote === candidate.quote) === index;
            });
            if (prior) return batchResult(prior);
            assertCurrentScope(memberId, source.project_id);
            const createdAt = now();
            const batch = { id: randomUUID(), member_id: memberId, project_id: source.project_id, capture_id: request.capture_id };
            db.prepare(`INSERT INTO member_profile_proposal_batches
                (id, member_id, project_id, capture_id, extractor_version, source_hash, source_event_ids,
                 source_response, source_question, source_origin, source_occurred_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(batch.id, memberId, source.project_id, request.capture_id,
                request.extractor_version, request.source_hash, eventIds, source.response, source.question, source.origin, source.occurred_at, createdAt);
            for (const candidate of candidates) {
                const eligible = candidate.category === 'preference' && source.response.trim() === candidate.quote && directPreference(candidate.quote);
                // Include corrected/retracted/operator facts: no past assertion is silently revived.
                const existingMemory = db.prepare("SELECT 1 FROM member_memory_events WHERE member_id = ? AND project_id IS ? AND kind = 'fact' LIMIT 1")
                    .get(memberId, source.project_id);
                const automatic = source.origin === 'member_reply' && eligible && !existingMemory;
                const reason = source.origin === 'operator_relay' ? 'operator_relay' : source.origin !== 'member_reply' ? 'unknown_origin'
                    : eligible && existingMemory ? 'existing_memory' : automatic ? 'explicit_preference' : 'needs_review';
                const id = randomUUID();
                db.prepare(`INSERT INTO member_profile_proposals
                    (id, batch_id, member_id, project_id, category, quote, fact_key, status, reason, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, batch.id, memberId, source.project_id,
                    candidate.category, candidate.quote, factKey(candidate.category, candidate.quote) ?? null, reason, createdAt);
                if (automatic) {
                    const row = db.prepare(`${joined} WHERE p.id = ?`).get(id);
                    const event = appendProposal(memberId, row, true);
                    db.prepare("UPDATE member_profile_proposals SET status = 'applied', event_id = ?, reviewed_at = ? WHERE id = ?")
                        .run(event.id, createdAt, id);
                }
            }
            return batchResult(batch);
        }).immediate();
    }
    function list(memberId, options = {}) {
        const scope = parse(listSchema, options, 'Invalid profile proposal query');
        return db.transaction(() => {
            assertMember(memberId);
            const total = db.prepare('SELECT COUNT(*) AS total FROM member_profile_proposals WHERE member_id = ? AND project_id IS ? AND status = ?')
                .get(memberId, scope.project_id, scope.status).total;
            const rows = db.prepare(`${joined} WHERE p.member_id = ? AND p.project_id IS ? AND p.status = ?
                ${scope.before_created_seq === undefined ? '' : 'AND p.created_seq < ?'} ORDER BY p.created_seq DESC LIMIT ?`)
                .all(memberId, scope.project_id, scope.status, ...(scope.before_created_seq === undefined ? [] : [scope.before_created_seq]), scope.limit + 1);
            const page = rows.slice(0, scope.limit).map(proposalFromRow);
            return { member_id: memberId, project_id: scope.project_id, memory_version: memoryVersion(memberId, scope.project_id),
                proposals: page, next_before_created_seq: rows.length > scope.limit ? page.at(-1).created_seq : null, total };
        })();
    }
    function review(memberId, proposalId, input) {
        const request = parse(reviewSchema, input, 'Invalid profile proposal review');
        parse(uuid, proposalId, 'Invalid profile proposal ID');
        return db.transaction(() => {
            assertMember(memberId);
            const row = db.prepare(`${joined} WHERE p.member_id = ? AND p.id = ?`).get(memberId, proposalId);
            if (!row) throw failure(404, 'Profile proposal not found');
            const desiredStatus = request.decision === 'accept' ? 'applied' : 'dismissed';
            if (row.status !== 'pending') {
                if (row.status !== desiredStatus) throw failure(409, 'Profile proposal was already reviewed differently');
                return { proposal: proposalFromRow(row) };
            }
            assertCurrentScope(memberId, row.project_id);
            let eventId = null;
            if (request.decision === 'accept') {
                if (memoryVersion(memberId, row.project_id) !== request.expected_memory_version) {
                    throw failure(409, 'Member memory changed; refresh before accepting');
                }
                eventId = appendProposal(memberId, row, false).id;
            }
            db.prepare('UPDATE member_profile_proposals SET status = ?, event_id = ?, reviewed_at = ? WHERE id = ?')
                .run(desiredStatus, eventId, now(), proposalId);
            return { proposal: proposalFromRow(db.prepare(`${joined} WHERE p.id = ?`).get(proposalId)) };
        }).immediate();
    }
    return { submit, list, review };
}

module.exports = { initializeMemberProfileProposals, createMemberProfileProposals };
