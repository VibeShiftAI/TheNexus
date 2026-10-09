/**
 * The adapter from committed answers to the Groundrules scorer's documents.
 *
 * Targets are the paths the packet's own filling instructions name, relative
 * to the gold-set directory (Groundrules.club/data/ledger/gold-set):
 *   labels/robert.json           Part A, kind gold, blind true
 *   judgments/robert.json        Part B, kind control-judgments
 *   judgments/robert-vpu.json    Part C, kind vpu-annotations
 *   post-exposure/robert-revisions.json   changes to a committed Stage A
 *                                reading made after Stage B or C was shown;
 *                                NOT a scorer input, blind false, kept
 *                                outside labels/ because the scorer loads
 *                                every *.json there.
 *
 * Documents are built only from a commit snapshot, so an export is
 * byte-for-byte reproducible from the same commit and carries the commit
 * time as the collection date. A file on disk that this session did not
 * write (its sha256 matches none of the session's recorded exports) is never
 * overwritten: the caller gets 409 export_conflict and the human decides.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const TARGETS = {
    A: 'labels/robert.json',
    B: 'judgments/robert.json',
    C: 'judgments/robert-vpu.json',
    revisions: 'post-exposure/robert-revisions.json',
};
const KINDS = Object.keys(TARGETS);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const fail = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

function provenance({ session, commit, taskId }) {
    return {
        collectedWith: 'nexus-groundrules-labeling',
        nexusTaskId: taskId || session.task_id,
        sessionId: session.id,
        packetSha256: session.packet_sha256,
        commitSha256: commit ? commit.snapshot_sha256 : null,
        committedAt: commit ? commit.committed_at : null,
        committedAuthority: commit ? commit.committed_authority : null,
    };
}

/** One scorer `{quote[, sourceUnit][, within]}` from a stored quote field. */
function quoteRef(row, quote, source, within) {
    const ref = { quote };
    if (source !== 'row' && source !== undefined && source !== null && source !== '') {
        const index = typeof source === 'number' ? source : Number.parseInt(String(source).replace(/^context:/, ''), 10);
        const context = row.contexts[index];
        if (!context || !context.quotable) throw fail(422, `${row.id}: context ${index} is not on the roster`, 'context_not_quotable');
        // A context in another unit names it; a context in the row's own unit
        // is resolved by the scorer inside the row's unit through `within`.
        if (context.sourceUnit) ref.sourceUnit = context.sourceUnit;
        ref.within = within && within.trim() ? within : context.quote;
    } else if (within && within.trim()) {
        ref.within = within;
    } else if (row.anchorWithin) {
        // The row text repeats inside its unit; the roster's own span is the
        // only `within` the scorer can resolve for it.
        ref.within = row.anchorWithin;
    }
    return ref;
}

function labelRow(packet, rowId, answer) {
    const row = packet.rowsById.get(rowId);
    if (!row) throw fail(422, `unknown rowId ${rowId}`, 'unknown_row');
    const entry = {
        rowId,
        modality: answer.modality,
        actor: quoteRef(row, answer.actor.quote, answer.actor.source, answer.actor.within),
        propositions: (answer.propositions || []).map(prop => {
            const out = { category: prop.category, ...quoteRef(row, prop.quote, prop.source, prop.within) };
            if (prop.numeric) out.numeric = { value: prop.numeric.value, unit: prop.numeric.unit, operator: prop.numeric.operator };
            if (prop.note && prop.note.trim()) out.note = prop.note;
            return out;
        }),
    };
    if (answer.notes && answer.notes.trim()) entry.note = answer.notes;
    return entry;
}

function exposureBeforeA(session, commit) {
    const out = {};
    for (const stage of ['B', 'C']) {
        const at = session.stages?.[stage]?.revealed_at || null;
        out[stage] = at && at <= commit.committed_at ? at : null;
    }
    return out;
}

function buildLabelsDocument({ packet, session, commit }) {
    if (!commit || commit.stage !== 'A') throw fail(412, 'Stage A is not committed', 'stage_not_committed');
    const rows = [];
    for (const provision of packet.stageA.provisions) {
        for (const row of provision.rows) {
            const record = commit.snapshot[row.id];
            if (!record) throw fail(422, `${row.id} is missing from the Stage A commit`, 'commit_incomplete');
            rows.push(labelRow(packet, row.id, record.answer));
        }
    }
    // A session rebound after Part B or C was shown inherits that exposure;
    // its Stage A record is still Robert's, but it is not blind and says so.
    const exposure = exposureBeforeA(session, commit);
    const blind = !exposure.B && !exposure.C;
    return {
        annotator: session.annotator,
        kind: 'gold',
        blind,
        rosterSha256: session.digests.rosterSha256,
        guidelineSha256: session.digests.guidelineSha256,
        labeledAt: commit.committed_at,
        rows,
        provenance: { ...provenance({ session, commit }), ...(blind ? {} : { notBlind: 'Part B or Part C had been shown before this Stage A commit (session rebound after exposure).', exposureBeforeCommit: exposure, carriedFrom: session.carried_from }) },
    };
}

function buildJudgmentsDocument({ packet, session, commit }) {
    if (!commit || commit.stage !== 'B') throw fail(412, 'Stage B is not committed', 'stage_not_committed');
    const judgments = packet.stageB.items.map(item => {
        const record = commit.snapshot[item.id];
        if (!record) throw fail(422, `${item.id} is missing from the Stage B commit`, 'commit_incomplete');
        return { fixtureId: item.id, verdict: record.answer.verdict, note: record.answer.note || '' };
    });
    return {
        annotator: session.annotator,
        kind: 'control-judgments',
        rosterSha256: session.digests.rosterSha256,
        controlsSha256: session.digests.controlsSha256,
        judgedAt: commit.committed_at,
        judgments,
        provenance: provenance({ session, commit }),
    };
}

function buildVpuDocument({ packet, session, commit }) {
    if (!commit || commit.stage !== 'C') throw fail(412, 'Stage C is not committed', 'stage_not_committed');
    const annotations = packet.stageC.items.map(item => {
        const record = commit.snapshot[item.id];
        if (!record) throw fail(422, `${item.id} is missing from the Stage C commit`, 'commit_incomplete');
        const a = record.answer;
        return { pairId: item.id, exampleOutcomeSame: a.exampleOutcomeSame, meaning: a.meaning, divergingCase: a.divergingCase || '', note: a.note || '' };
    });
    return {
        annotator: session.annotator,
        kind: 'vpu-annotations',
        vpuSha256: session.digests.vpuSha256,
        annotatedAt: commit.committed_at,
        annotations,
        provenance: provenance({ session, commit }),
    };
}

function buildRevisionsDocument({ packet, session, commit, revisions }) {
    if (!commit || commit.stage !== 'A') throw fail(412, 'Stage A is not committed', 'stage_not_committed');
    return {
        annotator: session.annotator,
        kind: 'post-exposure-revisions',
        blind: false,
        notScorerInput: 'Changes to committed Stage A readings made after Part B or Part C was shown. The blind baseline is labels/robert.json; this file never replaces it.',
        rosterSha256: session.digests.rosterSha256,
        guidelineSha256: session.digests.guidelineSha256,
        baseline: { commitSha256: commit.snapshot_sha256, committedAt: commit.committed_at },
        revisions: revisions.map(rev => ({
            rowId: rev.item_id,
            recordedAt: rev.created_at,
            afterExposureTo: rev.exposure.after_exposure_to || [],
            revealed: rev.exposure.revealed || {},
            note: rev.note || '',
            incomplete: (rev.errors || []).length > 0 ? rev.errors : undefined,
            reading: rev.errors && rev.errors.length ? rev.answer : labelRow(packet, rev.item_id, rev.answer),
        })),
        provenance: provenance({ session, commit }),
    };
}

function buildDocument(kind, context) {
    if (kind === 'A') return buildLabelsDocument(context);
    if (kind === 'B') return buildJudgmentsDocument(context);
    if (kind === 'C') return buildVpuDocument(context);
    if (kind === 'revisions') return buildRevisionsDocument(context);
    throw fail(400, `Unknown export kind ${kind}`, 'unknown_export');
}

function serialize(document) {
    return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/**
 * Write a document at its fixed target. Returns { path, sha256, written,
 * identical }. Refuses (409) to replace a file this session did not write.
 */
function writeExport({ goldDir, kind, document, priorExports }) {
    if (!KINDS.includes(kind)) throw fail(400, `Unknown export kind ${kind}`, 'unknown_export');
    const target = path.join(goldDir, TARGETS[kind]);
    const bytes = serialize(document);
    const digest = sha256(bytes);
    let existing = null;
    if (fs.existsSync(target)) {
        existing = sha256(fs.readFileSync(target));
        if (existing === digest) return { path: target, sha256: digest, written: false, identical: true };
        const ours = priorExports.some(e => e.kind === kind && e.path === target && e.sha256 === existing);
        if (!ours) {
            throw fail(409, `${TARGETS[kind]} already exists and was not written by this session; it was left untouched`, 'export_conflict', { path: target, existing_sha256: existing, document_sha256: digest });
        }
        // Our own earlier file: keep a copy beside the post-exposure history
        // before replacing it, never inside labels/ (the scorer globs there).
        const history = path.join(goldDir, 'post-exposure', 'history');
        fs.mkdirSync(history, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(target, path.join(history, `${path.basename(TARGETS[kind], '.json')}.${stamp}.${existing.slice(0, 8)}.json`));
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
    return { path: target, sha256: digest, written: true, identical: false, replaced_sha256: existing };
}

module.exports = { TARGETS, KINDS, buildDocument, buildLabelsDocument, buildJudgmentsDocument, buildVpuDocument, buildRevisionsDocument, writeExport, serialize };
