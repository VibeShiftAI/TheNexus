const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');

const PROFILE_FIELDS = ['name', 'email', 'phone', 'relationship', 'birthday', 'notes',
    'preferences', 'expertise', 'interests', 'claims', 'status', 'kind', 'seat_id', 'source'];

function nonempty(value) {
    if (value === null || value === undefined || value === '') return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

/**
 * Capture deserialized canonical rows. The caller owns the contact transaction;
 * every nested ledger append must succeed before that transaction can commit.
 * This is evidence of a directory write, never verification of its claims.
 */
function captureMemberDirectoryChange(ledger, before, after) {
    const changes = {};
    for (const field of PROFILE_FIELDS) {
        if (!before) {
            if (nonempty(after[field])) changes[field] = { after: after[field] };
        } else if (!isDeepStrictEqual(before[field], after[field])) {
            changes[field] = { before: before[field], after: after[field] };
        }
    }
    if (Object.keys(changes).length === 0) return;

    const action = before ? 'updated' : 'created';
    // A unique change reference permits A → B → A → B to retain all changes.
    // Identical retries are suppressed by the canonical comparison above.
    const sourceRef = `member-directory:${after.id}:${randomUUID()}`;
    const json = JSON.stringify({ action, member_id: after.id, changes });
    const parts = [];
    for (let start = 0; start < json.length;) {
        // Reserve room for provenance/part numbering under the 20k text limit.
        let end = Math.min(start + 19000, json.length);
        // SQLite encodes strings as UTF-8: never split a surrogate pair.
        if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
        parts.push(json.slice(start, end));
        start = end;
    }
    parts.forEach((part, index) => ledger.append(after.id, {
        project_id: null,
        kind: 'observation', evidence: 'observed', source: 'member_directory',
        source_ref: sourceRef, idempotency_key: `${sourceRef}:part:${index + 1}`,
        text: `Observed member directory ${action} (part ${index + 1}/${parts.length}). `
            + 'Directory values are not independently verified member claims.\n\n' + part,
    }));
}

module.exports = { captureMemberDirectoryChange };
