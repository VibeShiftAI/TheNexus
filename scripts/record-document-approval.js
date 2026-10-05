#!/usr/bin/env node
/**
 * Record an executor-recorded document approval: the supported pathway for
 * Robert's recurring "Approve with changes" review (contract section 6 in
 * docs/contracts/document-review-deliverables.md; operations and handoff in
 * docs/reviews/2026-10-04-executor-recorded-document-approvals.md).
 *
 * Robert reviews a revision and finishes the review with "make this change,
 * then mark the document approved" and the approve-after-changes grant, from
 * his verified session or operator credential (an unsigned review, or one
 * without the grant, is feedback the server refuses as a source). The executor
 * applies the change, registers the resulting revision on the same document,
 * then runs:
 *
 *   node scripts/record-document-approval.js \
 *     --document <document id> --source-submission <review submission id> \
 *     --executor <executor identity> [--task <nexus task id>] [--execution <praxis execution id>] \
 *     [--expect-hash <sha256 of the bytes you wrote>] [--note "<short note>"] [--dry-run]
 *
 * Before posting, the script re-reads the document's current revision, fetches
 * its exact bytes from the raw route and checks their SHA-256 against the
 * revision, against the file on disk and against --expect-hash when given, so
 * the approval names the verified resulting bytes and nothing else. The
 * decision is sent with a deterministic client_decision_id, so a retry is an
 * idempotent replay. It prints the decision receipt, the consumer check and
 * the document's decision history as JSON.
 *
 * Credential: NEXUS_DOCUMENT_APPROVAL_KEY, the document-scoped executor
 * credential, from this process's environment or, failing that, read from the
 * fleet env file (/Volumes/Projects/.fleet-env, FLEET_ENV_PATH to override)
 * inside this process only. It is never printed, never written to the task
 * log and never placed in a prompt. It records only executor-recorded
 * approvals that cite Robert's delegating review: the server refuses it for a
 * direct decision and the stakeholder endpoints refuse it outright, and
 * Robert's operator credential (NEXUS_OPERATOR_APPROVAL_KEY) is never read
 * here. Praxis strips both keys from the environment it hands executors; this
 * script is how an executor uses the document credential.
 *
 * Exit codes: 0 recorded (or an identical replay) and confirmed in force by the
 * consumer check; 1 the API refused and the refusal JSON was printed; 2 the
 * credential is unavailable; 3 revision or hash drift (nothing was recorded);
 * 4 usage error; 5 recorded but not confirmed (the readback failed or reports
 * the approval no longer in force), so the caller reads it back before relying
 * on it.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { fleetEnvPath } = require('../server/utils/fleet-env');

/** Robert's standing authorization for this pathway (questionnaire answered 2026-10-04). */
const STANDING_AUTHORIZATION = 'ask-robert-81299292-0878-4db1-a108-a14cc332f5dc';
const DEFAULT_API = process.env.NEXUS_API_URL || 'http://127.0.0.1:4000';
const EXIT = { ok: 0, refused: 1, credential: 2, drift: 3, usage: 4, unconfirmed: 5 };

function usage(message) {
    if (message) console.error(`record-document-approval: ${message}`);
    console.error(`usage: node scripts/record-document-approval.js --document <id> (--source-submission <id> | --source-review <id>) --executor <identity>
       [--task <task id>] [--execution <execution id>] [--authorization <ref>] [--note <text>]
       [--client-id <id>] [--expect-hash <sha256>] [--api <base url>] [--dry-run]`);
    process.exit(EXIT.usage);
}

function parseArgs(argv) {
    const flags = {
        document: 'document', 'source-submission': 'sourceSubmission', 'source-review': 'sourceReview', executor: 'executor',
        task: 'task', execution: 'execution', authorization: 'authorization', note: 'note', 'client-id': 'clientId',
        'expect-hash': 'expectHash', api: 'api',
    };
    const out = { dryRun: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') usage();
        if (arg === '--dry-run') { out.dryRun = true; continue; }
        if (!arg.startsWith('--')) usage(`unexpected argument ${arg}`);
        const name = flags[arg.slice(2)];
        if (!name) usage(`unknown option ${arg}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
        out[name] = value;
        i += 1;
    }
    if (!out.document) usage('--document is required');
    if (!out.sourceSubmission && !out.sourceReview) usage('--source-submission or --source-review is required');
    if (!out.executor) usage('--executor is required (the identity recorded on the decision)');
    if (out.expectHash !== undefined && !/^[0-9a-f]{64}$/.test(out.expectHash)) usage('--expect-hash must be a lowercase hex SHA-256');
    return out;
}

const CREDENTIAL_ENV = 'NEXUS_DOCUMENT_APPROVAL_KEY';

/** The document executor credential, from the environment or the fleet env file; only this key is read, nothing is printed. */
function loadCredential() {
    let key = (process.env[CREDENTIAL_ENV] || '').trim();
    if (!key) {
        const file = fleetEnvPath();
        if (fs.existsSync(file)) {
            const parsed = require('dotenv').parse(fs.readFileSync(file));
            key = (parsed[CREDENTIAL_ENV] || '').trim();
        }
    }
    return key.length >= 32 ? key : null;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

async function call(base, method, route, { body, bearer } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
        const type = response.headers.get('content-type') || '';
        const payload = type.includes('application/json') ? await response.json() : await response.text();
        return { status: response.status, json: payload, headers: response.headers };
    } finally {
        clearTimeout(timer);
    }
}

function decisionSummary(decision) {
    if (!decision) return null;
    return {
        id: decision.id, decision: decision.decision, revision_id: decision.revision_id, content_hash: decision.content_hash,
        authority: decision.authority, recorded_by: decision.recorded_by || 'operator', created_at: decision.created_at,
        executor: decision.provenance?.executor?.id || null, source_submission_id: decision.provenance?.source?.submission_id || null,
        source_review_id: decision.provenance?.source?.review_id || null,
    };
}

async function historyReadback(base, documentId) {
    const history = await call(base, 'GET', `/api/documents/${encodeURIComponent(documentId)}/history`);
    if (history.status !== 200) return { status: history.status };
    return {
        review_status: history.json.review_status,
        current_revision_id: history.json.current_revision_id,
        decisions: (history.json.decisions || []).map(decisionSummary),
    };
}

function finish(code, result) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(code);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const base = (args.api || DEFAULT_API).replace(/\/+$/, '');
    const documentId = args.document;
    const route = `/api/documents/${encodeURIComponent(documentId)}`;

    const credential = loadCredential();
    if (!credential && !args.dryRun) {
        finish(EXIT.credential, {
            outcome: 'credential_unavailable',
            error: `${CREDENTIAL_ENV} is not available to this process: it was not in the environment and the fleet env file does not provide it`,
            fleet_env_path: fleetEnvPath(),
        });
    }

    const read = await call(base, 'GET', route);
    if (read.status !== 200) finish(EXIT.refused, { outcome: 'document_unavailable', status: read.status, response: read.json });
    const { document, revision, file_state: fileState } = read.json;
    if (!revision || fileState !== 'ok') {
        finish(EXIT.drift, { outcome: 'file_unavailable', file_state: fileState, document: { id: document.id, path: document.path } });
    }

    // The exact bytes the approval will name, fetched back from the registry as bytes (a text decoder could drop a BOM)
    // and compared with the file on disk and the producer's own hash. The raw route's X-Document-Revision header is the content hash.
    const rawResponse = await fetch(`${base}${route}/raw?revision=${encodeURIComponent(revision.id)}`);
    if (rawResponse.status !== 200) finish(EXIT.drift, { outcome: 'raw_unavailable', status: rawResponse.status });
    const exactBytes = Buffer.from(await rawResponse.arrayBuffer());
    const verified = {
        revision_id: revision.id,
        content_hash: revision.content_hash,
        raw_route_hash: rawResponse.headers.get('x-document-revision'),
        raw_hash_matches: sha256(exactBytes) === revision.content_hash,
        disk_hash_matches: null,
        expected_hash_matches: args.expectHash ? args.expectHash === revision.content_hash : null,
    };
    if (document.deliverable_key && document.path) {
        try {
            verified.disk_hash_matches = sha256(fs.readFileSync(document.path)) === revision.content_hash;
        } catch (err) {
            verified.disk_hash_matches = false;
            verified.disk_error = err.code || String(err.message || err);
        }
    }
    const drift = !verified.raw_hash_matches || verified.disk_hash_matches === false || verified.expected_hash_matches === false
        || verified.raw_route_hash !== revision.content_hash;
    if (drift) {
        finish(EXIT.drift, {
            outcome: 'revision_drift',
            error: 'The current revision does not match the verified bytes; register the bytes you wrote (or re-read the document) before approving',
            verified, expected_hash: args.expectHash || null,
            history: await historyReadback(base, documentId),
        });
    }

    const sourceRef = args.sourceSubmission || args.sourceReview;
    const executor = { id: args.executor };
    if (args.task) executor.task_id = args.task;
    if (args.execution) executor.execution_id = args.execution;
    if (args.sourceSubmission) executor.source_submission_id = args.sourceSubmission;
    if (args.sourceReview) executor.source_review_id = args.sourceReview;
    executor.authorization_ref = args.authorization || STANDING_AUTHORIZATION;
    const body = {
        decision: 'approve',
        revision_id: revision.id,
        content_hash: revision.content_hash,
        note: args.note || '',
        client_decision_id: args.clientId || `executor-approval:${sourceRef}:${revision.id}`.slice(0, 120),
        executor,
    };
    if (args.dryRun) {
        finish(EXIT.ok, { outcome: 'dry_run', credential_available: Boolean(credential), api: base, document: { id: document.id, path: document.path }, verified, body });
    }

    const posted = await call(base, 'POST', `${route}/decisions`, { body, bearer: credential });
    if (posted.status === 201 || posted.status === 200) {
        const decision = posted.json.decision;
        // Recording and confirming are two different facts: the consumer check must read the decision back as an
        // approval still in force. When it cannot (readback failed, or the bytes moved on already) the row exists,
        // but the caller must not treat the approval as confirmed, so the exit code says so.
        let check;
        try {
            const read = await call(base, 'GET', `${route}/decisions/${encodeURIComponent(decision.id)}`);
            check = read.status === 200
                ? { status: 200, in_force: read.json.in_force, approved: read.json.approved, reason: read.json.reason, file_state: read.json.file_state }
                : { status: read.status };
        } catch (err) {
            check = { status: null, error: err?.message || String(err) };
        }
        const confirmed = check.status === 200 && check.in_force === true && check.approved === true;
        finish(confirmed ? EXIT.ok : EXIT.unconfirmed, {
            outcome: posted.json.duplicate ? 'already_recorded' : 'recorded',
            confirmed,
            duplicate: Boolean(posted.json.duplicate),
            review_status: posted.json.review_status,
            decision,
            check,
            ...(confirmed ? {} : { error: 'The decision was recorded but could not be confirmed as an approval in force; read it back before relying on it' }),
            history: await historyReadback(base, documentId),
        });
    }
    finish(EXIT.refused, {
        outcome: 'refused',
        status: posted.status,
        response: posted.json,
        verified,
        history: await historyReadback(base, documentId),
    });
}

main().catch(err => {
    console.error(`record-document-approval: ${err?.message || err}`);
    process.exit(EXIT.refused);
});
