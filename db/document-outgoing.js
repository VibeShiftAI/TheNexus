/** Durable exact-envelope grants. This store has no delivery capability. */
const { randomUUID, createHash } = require('crypto');
const now = () => new Date().toISOString();
const fail = (code, message) => { throw Object.assign(new Error(message), { status: 409, code }); };
const terminal = new Set(['delivering', 'sent', 'uncertain']);
const operators = new Set(['access_user', 'access_device', 'operator_credential']);

function initializeDocumentOutgoing(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_document_outgoing (
        document_id TEXT PRIMARY KEY REFERENCES review_documents(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL UNIQUE,
        revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        content_hash TEXT NOT NULL,
        envelope_hash TEXT NOT NULL,
        envelope TEXT NOT NULL,
        provenance TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'delivering', 'sent', 'uncertain', 'cancelled')),
        grant TEXT,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        claimed_at TEXT,
        receipt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_document_outgoing_events (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id),
        event TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_document_outgoing_events_document
        ON review_document_outgoing_events(document_id, created_at);
    CREATE TRIGGER IF NOT EXISTS review_document_outgoing_events_no_update
        BEFORE UPDATE ON review_document_outgoing_events
        BEGIN SELECT RAISE(ABORT, 'outgoing events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS review_document_outgoing_events_no_delete
        BEFORE DELETE ON review_document_outgoing_events
        BEGIN SELECT RAISE(ABORT, 'outgoing events are append-only'); END;`);
}

function createDocumentOutgoingStore(db) {
    function getOutgoing(id) {
        const row = db.prepare('SELECT * FROM review_document_outgoing WHERE document_id = ?').get(id);
        if (!row) return null;
        for (const key of ['envelope', 'provenance', 'grant', 'receipt']) row[key] = row[key] ? JSON.parse(row[key]) : null;
        return row;
    }
    function save(row, event, actor = { id: 'runtime', authority: 'runtime_credential' }) {
        const data = { ...row };
        for (const key of ['envelope', 'provenance', 'grant', 'receipt']) data[key] = data[key] == null ? null : JSON.stringify(data[key]);
        const keys = Object.keys(data);
        db.prepare(`INSERT INTO review_document_outgoing (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})
            ON CONFLICT(document_id) DO UPDATE SET ${keys.filter(k => k !== 'document_id').map(k => `${k}=excluded.${k}`).join(',')}`)
            .run(...keys.map(k => data[k]));
        db.prepare('INSERT INTO review_document_outgoing_events (id, document_id, event, actor_id, authority, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), row.document_id, event, actor.id, actor.authority, JSON.stringify(row), now());
        return getOutgoing(row.document_id);
    }
    function listOutgoingEvents(id) {
        return db.prepare('SELECT * FROM review_document_outgoing_events WHERE document_id = ? ORDER BY created_at, rowid').all(id)
            .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
    }
    const invalidateOutgoing = db.transaction((id, reason) => {
        // Once claimed, the durable claim/receipt is the truth. Never rearm it.
        const row = getOutgoing(id);
        if (!row || !['draft', 'approved'].includes(row.status) || row.invalidated_at) return;
        save({ ...row, status: 'draft', grant: null, invalidated_at: now(), invalidation_reason: reason, updated_at: now() },
            'invalidated', { id: 'document_registry', authority: 'registry' });
    });
    function exact(row, input) {
        if (!row || row.revision_id !== input.revision_id || row.envelope_hash !== input.envelope_hash) {
            fail('outgoing_conflict', 'The outgoing message changed; reload and review the exact current message');
        }
    }
    function current(id, revisionId) {
        const doc = db.prepare('SELECT * FROM review_documents WHERE id = ?').get(id);
        if (!doc || doc.current_revision_id !== revisionId) fail('stale_revision', 'The document revision changed; prepare and review the current message');
        if (!doc.deliverable_key || !doc.requires_review || doc.intended_action !== 'send') fail('send_not_declared', 'A send requires a declared document deliverable intended for send');
        return doc;
    }
    function fresh(row) {
        current(row.document_id, row.revision_id);
        if (row.invalidated_at) fail('outgoing_invalidated', 'The document changed or became unavailable; prepare and review a new message version');
    }
    return {
        getOutgoing,
        listOutgoingEvents,
        invalidateOutgoing,
        prepareOutgoing: db.transaction((id, revision, input) => {
            const doc = current(id, revision.id);
            const existing = getOutgoing(id);
            if (existing && terminal.has(existing.status)) fail('delivery_locked', 'This delivery has already been claimed and cannot be changed or retried');
            const metadata = JSON.parse(doc.metadata || '{}');
            if (input.provenance.project_id !== (metadata.stakeholder_project_id || doc.project_id)
                || input.provenance.task_id !== doc.task_id
                || (metadata.member_id && input.provenance.member_id !== metadata.member_id)
                || (input.provenance.commitment_id ?? null) !== (metadata.commitment_id ?? null)
                || (Object.hasOwn(metadata, 'source_refs') && JSON.stringify(input.provenance.source_refs) !== JSON.stringify(metadata.source_refs))) {
                fail('provenance_mismatch', 'Outgoing provenance must match the document source and stakeholder');
            }
            if (existing && ['member_id', 'project_id', 'task_id', 'commitment_id'].some(key => existing.provenance[key] !== input.provenance[key])) {
                fail('provenance_mismatch', 'The logical outgoing message provenance cannot be reassigned');
            }
            if (input.expected_envelope_hash !== undefined && input.expected_envelope_hash !== existing?.envelope_hash) {
                fail('outgoing_conflict', 'The outgoing message changed; reload before replacing it');
            }
            const same = existing && existing.revision_id === revision.id && JSON.stringify(existing.envelope) === JSON.stringify(input.envelope)
                && JSON.stringify(existing.provenance) === JSON.stringify(input.provenance);
            if (existing?.status === 'cancelled') {
                if (same) return existing;
                fail('outgoing_cancelled', 'Cancellation is permanent for this document');
            }
            if (same && !existing.invalidated_at) return existing;
            if (existing && input.expected_envelope_hash !== existing.envelope_hash) fail('outgoing_conflict', 'Replacing a message requires its expected_envelope_hash');
            const deliveryId = existing?.delivery_id || randomUUID();
            // Include an unguessable version nonce: A -> B -> A never revives A's grant.
            const envelopeHash = createHash('sha256').update(JSON.stringify({ nonce: randomUUID(), document_id: id,
                delivery_id: deliveryId, revision_id: revision.id, content_hash: revision.content_hash,
                envelope: input.envelope, provenance: input.provenance })).digest('hex');
            const ts = now();
            return save({ document_id: id, delivery_id: deliveryId, revision_id: revision.id, content_hash: revision.content_hash,
                envelope_hash: envelopeHash, envelope: input.envelope, provenance: input.provenance,
                status: 'draft', grant: null, invalidated_at: null, invalidation_reason: null, claimed_at: null, receipt: null,
                created_at: existing?.created_at || ts, updated_at: ts }, 'prepared');
        }),
        decideOutgoing: db.transaction((id, input, actor) => {
            if (!operators.has(actor?.authority)) fail('operator_required', 'Only the operator may authorize sending');
            const row = getOutgoing(id);
            exact(row, input);
            if (terminal.has(row.status)) fail('delivery_locked', 'Delivery has already been claimed; it cannot be cancelled or approved again');
            if (input.decision === 'cancel') {
                if (row.status === 'cancelled') return row;
                return save({ ...row, status: 'cancelled', grant: null, updated_at: now() }, 'cancelled', actor);
            }
            if (row.status === 'cancelled') fail('outgoing_cancelled', 'Cancellation is permanent for this document');
            fresh(row);
            if (!row.envelope.cc.length) fail('operator_copy_missing', 'The operator copy address must be configured and included in the reviewed message before sending');
            if (row.status === 'approved') return row;
            const ts = now();
            return save({ ...row, status: 'approved', updated_at: ts, grant: {
                decision: 'approve_send', actor_id: actor.id, authority: actor.authority, approved_at: ts,
                document_id: id, revision_id: row.revision_id, content_hash: row.content_hash,
                envelope_hash: row.envelope_hash, envelope: row.envelope, provenance: row.provenance, delivery_id: row.delivery_id,
            } }, 'approved', actor);
        }),
        claimOutgoing: db.transaction((id, input) => {
            const row = getOutgoing(id);
            exact(row, input);
            if (row.delivery_id !== input.delivery_id) fail('delivery_mismatch', 'Delivery identifier does not match this message');
            if (terminal.has(row.status)) return { claimed: false, outgoing: row };
            fresh(row);
            if (row.status !== 'approved' || !operators.has(row.grant?.authority)
                || row.grant?.envelope_hash !== row.envelope_hash) fail('send_not_approved', 'An explicit operator Approve and send decision is required');
            const ts = now();
            return { claimed: true, outgoing: save({ ...row, status: 'delivering', claimed_at: ts, updated_at: ts }, 'claimed') };
        }),
        receiptOutgoing: db.transaction((id, input) => {
            const row = getOutgoing(id);
            if (!row || row.delivery_id !== input.delivery_id) fail('delivery_mismatch', 'Delivery identifier does not match this message');
            const receipt = { delivery_id: input.delivery_id, status: input.status, ...(input.message_id ? { message_id: input.message_id } : {}) };
            if (row.receipt) {
                if (JSON.stringify(row.receipt) === JSON.stringify(receipt)) return row;
                fail('receipt_conflict', 'A delivery receipt is already recorded; no reset or retry is allowed');
            }
            if (row.status !== 'delivering') fail('delivery_not_claimed', 'The runtime must claim this approved message before recording its receipt');
            return save({ ...row, status: input.status, receipt, updated_at: now() }, 'receipt');
        }),
    };
}
module.exports = { initializeDocumentOutgoing, createDocumentOutgoingStore };
