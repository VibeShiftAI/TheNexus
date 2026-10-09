/**
 * Guided blind-labelling API (server/routes/groundrules-labeling.js) over a
 * synthetic packet in a temp gold-set directory and a temp SQLite board:
 * entry linkage, operator-only writes, stage gating at the server, answer
 * states (draft / unsure / complete / UNKNOWN / explicit none), optimistic
 * concurrency, hash binding, commit refusal of incomplete records, frozen
 * blind baseline with post-exposure revisions, export files and conflicts,
 * and the deliberate rebind after a packet change. Nothing here reads or
 * writes /Volumes/Projects/Groundrules.club or the live nexus.db.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const createRouter = require('../routes/groundrules-labeling');
const { createPacketSource } = require('../services/groundrules-labeling/packet');
const { createLabelingWriteAuthority } = require('../services/groundrules-labeling/authority');
const { closeRaw } = require('../../db/raw');
const { writePacketFixture, CONTEXT_3, WITHIN_2, UNIT_REPEAT } = require('./helpers/groundrules-packet-fixture');

const TASK = 'task-synthetic-labeling-0001';
const OPERATOR_KEY = 'synthetic-operator-key-0123456789abcdef';
const DOCUMENT_KEY = 'synthetic-document-key-0123456789abcdef';

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}
function close(handle) {
    for (const s of handle.sockets) s.destroy();
    return new Promise(resolve => handle.server.close(resolve));
}

describe('groundrules labeling route', () => {
    let handle;
    let tmpDir;
    let fixture;
    let dbPath;
    const env = {};

    const api = async (method, route, { body, headers = {}, auth = 'operator' } = {}) => {
        const authHeaders = auth === 'operator' ? { Authorization: `Bearer ${OPERATOR_KEY}` }
            : auth === 'document' ? { Authorization: `Bearer ${DOCUMENT_KEY}` }
                : auth === 'access' ? { Authorization: 'Bearer local-dev-token', 'x-test-access': 'yes' }
                    : auth === 'placeholder' ? { Authorization: 'Bearer local-dev-token' }
                        : {};
        const res = await fetch(`${handle.baseUrl}/api/groundrules-labeling${route}`, {
            method, headers: { 'Content-Type': 'application/json', ...authHeaders, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    // Like the dashboard, the helper names the last revision the server
    // acknowledged for an item (null before the first save); tests pass an
    // explicit base_revision when they mean to be stale or deliberate.
    const known = new Map();
    const learn = (sessionId, read) => { for (const stage of ['A', 'B', 'C']) for (const a of read.answers?.[stage] ?? []) known.set(`${sessionId}:${stage}:${a.item_id}`, a.revision); };
    const put = async (sessionId, stage, itemId, answer, extra = {}) => {
        const key = `${sessionId}:${stage}:${itemId}`;
        const res = await api('PUT', `/sessions/${sessionId}/answers/${stage}/${itemId}`, { body: { packet_sha256: fixture.sha, base_revision: known.get(key) ?? null, state: 'draft', answer, ...extra } });
        if (res.status === 200 && res.body.answer) known.set(key, res.body.answer.revision);
        return res;
    };

    beforeAll(() => {
        for (const [key, value] of Object.entries({ NEXUS_OPERATOR_APPROVAL_KEY: OPERATOR_KEY, NEXUS_DOCUMENT_APPROVAL_KEY: DOCUMENT_KEY, GROUNDRULES_LABELING_TASK_IDS: TASK })) {
            env[key] = process.env[key];
            process.env[key] = value;
        }
    });
    afterAll(() => {
        for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    });

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-groundrules-route-'));
        dbPath = path.join(tmpDir, 'board.db');
        const written = writePacketFixture();
        fixture = { ...written, sha: createPacketSource({ packetDir: written.packetDir, goldDir: written.goldDir }).load().sha256 };
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
        const authorizeWrite = createLabelingWriteAuthority({ authenticateOperator: { inspect: async req => (req.get('x-test-access') === 'yes' ? { operator: true, identity: 'user', reason: 'ok' } : { operator: false, identity: null, reason: 'assertion-missing' }) } });
        app.use('/api/groundrules-labeling', createRouter({ dbPath, packetSource: createPacketSource({ packetDir: written.packetDir, goldDir: written.goldDir }), authorizeWrite, operatorInspect: async () => ({ operator: false, identity: null, reason: 'assertion-missing' }) }));
        handle = await listen(app);
    });
    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
        closeRaw(dbPath);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(fixture.ledgerDir, { recursive: true, force: true });
    });

    const completeRow1 = {
        modality: 'may',
        actor: { quote: 'A card holder', source: 'row' },
        propositionsDeclared: 'some',
        propositions: [
            { id: 'p1', category: 'condition', quote: 'up to five items at one time', numeric: { value: 5, unit: 'item', operator: '<=' } },
            { id: 'p2', category: 'exception', quote: 'unless the holder has an overdue item' },
            { id: 'p3', category: 'negation', quote: 'no further loan shall be made' },
        ],
        notes: '',
    };
    const completeRow2 = { modality: 'shall', actor: { quote: 'The library shall' }, propositionsDeclared: 'some', propositions: [{ category: 'condition', quote: 'within ten days after an item becomes overdue', numeric: { value: 10, unit: 'day', operator: '<=' } }] };
    const completeRow3 = { modality: 'is', actor: { quote: 'an unreasonable refusal', source: 0 }, propositionsDeclared: 'some', propositions: [{ category: 'condition', quote: 'who has paid every fine within thirty days of notice', numeric: { value: 30, unit: 'day', operator: '<=' } }] };

    const read_anchor = read => read.body.stageA.provisions[0].rows[1].anchorWithin;
    async function startSession() {
        const res = await api('POST', `/tasks/${TASK}/session`);
        expect(res.status).toBe(201);
        return res.body.session;
    }
    async function completeStageA(session) {
        for (const [row, answer] of [['lib-loans.limit', completeRow1], ['lib-loans.notice', completeRow2], ['lib-renewal.rule', completeRow3]]) {
            const res = await put(session.id, 'A', row, answer);
            expect(res.status).toBe(200);
            expect(res.body.answer.state).toBe('complete');
            // A save returns the same session summary a read does, so the client can replace its copy.
            expect(Object.keys(res.body.session.progress)).toEqual(['A', 'B', 'C']);
            expect(res.body.session.stages.A).toEqual({ committed_at: null, revealed_at: expect.any(String) });
            expect(res.body.session.progress.A.complete).toBeGreaterThan(0);
        }
        const latest = await api('GET', `/sessions/${session.id}`);
        const commit = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha, expected_revision: latest.body.session.revision } });
        expect(commit.status).toBe(201);
        return commit.body;
    }

    test('task linkage: only linked tasks get an entry, with packet counts and no session yet', async () => {
        const other = await api('GET', '/tasks/task-unrelated-0002');
        expect(other.body).toEqual({ linked: false, task_id: 'task-unrelated-0002' });
        const linked = await api('GET', `/tasks/${TASK}`);
        expect(linked.status).toBe(200);
        expect(linked.body.linked).toBe(true);
        expect(linked.body.route).toBe(`/task/${TASK}/labeling`);
        expect(linked.body.packet.counts).toEqual({ provisions: 2, rows: 3, controls: 2, pairs: 1 });
        expect(linked.body.packet.sha256).toBe(fixture.sha);
        expect(linked.body.session).toBeNull();
        expect(linked.body.related_tasks.map(t => t.role)).toEqual(['packet preparation', 'blind protocol', 'later scoring']);
    });

    test('writes need an operator proof: placeholder bearer, no bearer and the document executor key are refused; operator key and Access session pass', async () => {
        expect((await api('POST', `/tasks/${TASK}/session`, { auth: 'none' })).body.code).toBe('operator_required');
        expect((await api('POST', `/tasks/${TASK}/session`, { auth: 'placeholder' })).body.code).toBe('operator_required');
        const document = await api('POST', `/tasks/${TASK}/session`, { auth: 'document' });
        expect(document.status).toBe(403);
        expect(document.body.code).toBe('operator_required');
        const bridge = await api('POST', `/tasks/${TASK}/session`, { headers: { 'x-praxis-bridge-token': 'bridge' } });
        expect(bridge.status).toBe(403);
        expect((await api('GET', `/tasks/${TASK}`)).body.session).toBeNull();
        const created = await api('POST', `/tasks/${TASK}/session`, { auth: 'access' });
        expect(created.status).toBe(201);
        expect(created.body.session.created_authority).toBe('access_user');
        const again = await api('POST', `/tasks/${TASK}/session`);
        expect(again.status).toBe(200);
        expect(again.body.session.id).toBe(created.body.session.id);
        expect(again.body.created).toBe(false);
        const whoami = await api('GET', '/whoami', { auth: 'none' });
        expect(whoami.body).toMatchObject({ operator_session: false, operator_credential_configured: true, user_id: 'local_user' });
    });

    test('the session read and the Stage A read never carry Part B or Part C content; later stages are locked at the API', async () => {
        const session = await startSession();
        const read = await api('GET', `/sessions/${session.id}`);
        expect(read.status).toBe(200);
        const json = JSON.stringify(read.body);
        expect(read.body.stageA.provisions.map(p => p.rows.length)).toEqual([2, 1]);
        expect(read.body.stageA.provisions[1].rows[0].contexts).toEqual([{ quote: CONTEXT_3, sourceUnit: '/syn/lib/s2', quotable: true }]);
        for (const leak of ['ctl-s1', 'ctl-p1', 'accept or reject', 'equivalent or different', 'vpu-s1', 'exception-removed', 'unless the fine is waived', 'NEVER SHOWN', 'nested-exception']) {
            expect(json.includes(leak)).toBe(false);
        }
        expect(read.body.answers).toEqual({ A: [] });
        expect(read.body.session.progress.B).toMatchObject({ unlocked: false, reason: 'stage_A_not_committed', total: 2 });
        expect(read.body.session.progress.C).toMatchObject({ unlocked: false, reason: 'stage_B_not_committed', total: 1 });
        const stageA = await api('GET', `/sessions/${session.id}/stages/A`);
        expect(stageA.status).toBe(200);
        expect(JSON.stringify(stageA.body).includes('ctl-s1')).toBe(false);
        for (const stage of ['B', 'C']) {
            const locked = await api('GET', `/sessions/${session.id}/stages/${stage}`);
            expect(locked.status).toBe(403);
            expect(locked.body.code).toBe('stage_locked');
            expect(JSON.stringify(locked.body).includes('ctl-')).toBe(false);
            const write = await put(session.id, stage, stage === 'B' ? 'ctl-s1' : 'vpu-s1', { verdict: 'accept' });
            expect(write.status).toBe(403);
            expect(write.body.code).toBe('stage_locked');
        }
        const commitB = await api('POST', `/sessions/${session.id}/commit/B`, { body: { packet_sha256: fixture.sha } });
        expect(commitB.status).toBe(403);
    });

    test('answer states: malformed is refused, untouched vs draft vs unsure vs complete vs UNKNOWN vs explicit none are distinct, quotes resolve by the anchor rule', async () => {
        const session = await startSession();
        expect((await put(session.id, 'A', 'lib-loans.limit', 'nope')).status).toBe(400);
        const badCategory = await put(session.id, 'A', 'lib-loans.limit', { modality: 'may', actor: { quote: 'A card holder' }, propositionsDeclared: 'some', propositions: [{ category: 'carveout', quote: 'unless' }] });
        expect(badCategory.status).toBe(400);
        expect(badCategory.body.code).toBe('malformed_answer');
        expect((await put(session.id, 'A', 'lib-loans.limit', { modality: 'maybe' })).status).toBe(400);
        expect((await put(session.id, 'A', 'lib-loans.limit', completeRow1, { state: 'complete' })).status).toBe(400);
        expect((await put(session.id, 'A', 'no-such-row', completeRow1)).status).toBe(404);

        const draft = await put(session.id, 'A', 'lib-loans.limit', { modality: '', actor: { quote: '' }, propositionsDeclared: '', propositions: [] });
        expect(draft.status).toBe(200);
        expect(draft.body.answer.state).toBe('draft');
        expect(draft.body.validation.errors.map(e => e.path)).toEqual(['modality', 'actor.quote', 'propositionsDeclared']);
        expect(draft.body.saved_at).toBe(draft.body.answer.updated_at);

        const unknown = await put(session.id, 'A', 'lib-loans.limit', { modality: 'UNKNOWN', actor: { quote: 'A card holder' }, propositionsDeclared: 'none', propositions: [] }, { base_revision: draft.body.answer.revision });
        expect(unknown.body.answer.state).toBe('draft');
        expect(unknown.body.answer.answer.modality).toBe('UNKNOWN');
        expect(unknown.body.validation.errors).toEqual([expect.objectContaining({ path: 'modality', unknown: true })]);

        const none = await put(session.id, 'A', 'lib-loans.notice', { modality: 'shall', actor: { quote: 'The library shall' }, propositionsDeclared: 'none', propositions: [] });
        expect(none.body.answer.state).toBe('complete');
        expect(none.body.answer.answer.propositionsDeclared).toBe('none');
        // ROW_2 repeats inside its unit (the roster carries a `within` for it):
        // a quote unique in the passage but repeated in that span is refused,
        // and a narrower user "within" cannot pin it for the scorer.
        const sectionRepeat = await put(session.id, 'A', 'lib-loans.notice', { modality: 'shall', actor: { quote: 'The library' }, propositionsDeclared: 'none', propositions: [] }, { base_revision: 1 });
        expect(sectionRepeat.body.answer.state).toBe('draft');
        expect(sectionRepeat.body.validation.errors[0]).toMatchObject({ path: 'actor.quote', reason: 'not_unique_in_section', count: 2 });
        const narrowed = await put(session.id, 'A', 'lib-loans.notice', { modality: 'shall', actor: { quote: 'The library', within: 'The library shall notify' }, propositionsDeclared: 'none', propositions: [] }, { base_revision: 2 });
        expect(narrowed.body.validation.errors[0]).toMatchObject({ path: 'actor.within', reason: 'within_not_allowed' });
        expect(read_anchor(await api('GET', `/sessions/${session.id}`))).toBe(WITHIN_2);
        await put(session.id, 'A', 'lib-loans.notice', { modality: 'shall', actor: { quote: 'The library shall' }, propositionsDeclared: 'none', propositions: [] }, { base_revision: 3 });

        const unsure = await put(session.id, 'A', 'lib-renewal.rule', completeRow3, { state: 'unsure' });
        expect(unsure.body.answer.state).toBe('unsure');
        expect(unsure.body.validation.complete).toBe(true);

        const notFound = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'The card holder' } }, { base_revision: unknown.body.answer.revision });
        expect(notFound.body.answer.state).toBe('draft');
        expect(notFound.body.validation.errors[0]).toMatchObject({ path: 'actor.quote', reason: 'not_found' });
        const midWord = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'A card hold' } }, { base_revision: notFound.body.answer.revision });
        expect(midWord.body.validation.errors[0]).toMatchObject({ path: 'actor.quote', reason: 'not_found' });
        const repeated = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder' } }, { base_revision: midWord.body.answer.revision });
        expect(repeated.body.validation.errors[0]).toMatchObject({ path: 'actor.quote', reason: 'not_unique', count: 2 });
        const pinned = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder', within: 'the holder has' } }, { base_revision: repeated.body.answer.revision });
        expect(pinned.body.answer.state).toBe('complete');
        expect(pinned.body.answer.answer.actorResolved.slice).toBe('holder');
        const spacing = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: '  A   card\nholder ' } }, { base_revision: pinned.body.answer.revision });
        expect(spacing.body.answer.state).toBe('complete');
        expect(spacing.body.answer.answer.actorResolved.slice).toBe('A card holder');

        const contextRow = await put(session.id, 'A', 'lib-renewal.rule', { ...completeRow3, actor: { quote: 'refusal includes', source: 0 } }, { base_revision: unsure.body.answer.revision });
        expect(contextRow.body.answer.state).toBe('complete');
        expect(contextRow.body.answer.answer.actorResolved).toMatchObject({ source: 'context', index: 0 });
        const progress = (await api('GET', `/sessions/${session.id}`)).body.session.progress.A;
        expect(progress).toMatchObject({ total: 3, complete: 3, draft: 0, unsure: 0, untouched: 0 });
    });

    test('numeric values are a number or a plain decimal string; anything else is malformed, never coerced', async () => {
        const session = await startSession();
        const withNumeric = value => ({ ...completeRow2, propositions: [{ ...completeRow2.propositions[0], numeric: { ...completeRow2.propositions[0].numeric, value } }] });
        for (const value of ['0x10', '1e3', ' 10 days', [], {}, true]) {
            const res = await put(session.id, 'A', 'lib-loans.notice', withNumeric(value));
            expect([value, res.status, res.body.code]).toEqual([value, 400, 'malformed_answer']);
        }
        const string = await put(session.id, 'A', 'lib-loans.notice', withNumeric('10'));
        expect(string.status).toBe(200);
        expect(string.body.answer.answer.propositions[0].numeric.value).toBe(10);
        const empty = await put(session.id, 'A', 'lib-loans.notice', withNumeric(''));
        expect(empty.body.answer.answer.propositions[0].numeric.value).toBeNull();
    });

    test('hash binding and optimistic concurrency: missing/foreign packet hash and stale revisions are refused with the current record', async () => {
        const session = await startSession();
        const noHash = await api('PUT', `/sessions/${session.id}/answers/A/lib-loans.limit`, { body: { answer: completeRow1 } });
        expect(noHash.status).toBe(400);
        expect(noHash.body.code).toBe('packet_sha256_required');
        const wrongHash = await api('PUT', `/sessions/${session.id}/answers/A/lib-loans.limit`, { body: { packet_sha256: 'f'.repeat(64), answer: completeRow1 } });
        expect(wrongHash.status).toBe(409);
        expect(wrongHash.body.code).toBe('packet_mismatch');
        const first = await put(session.id, 'A', 'lib-loans.limit', completeRow1);
        expect(first.body.answer.revision).toBe(1);
        // A "first save" (null) from a client that never loaded the record cannot replace one that exists.
        const blindRetry = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, notes: 'device that never loaded' }, { base_revision: null });
        expect(blindRetry.status).toBe(409);
        expect(blindRetry.body.code).toBe('stale_write');
        expect(blindRetry.body.current.revision).toBe(1);
        const second = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, notes: 'device two' }, { base_revision: 1 });
        expect(second.body.answer.revision).toBe(2);
        const stale = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, notes: 'device one, stale' }, { base_revision: 1 });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('stale_write');
        expect(stale.body.current.revision).toBe(2);
        expect(stale.body.current.answer.notes).toBe('device two');
        const overwrite = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, notes: 'device one, deliberate' }, { base_revision: 2 });
        expect(overwrite.status).toBe(200);
        expect(overwrite.body.answer.revision).toBe(3);
        expect(overwrite.body.session.revision).toBeGreaterThan(session.revision);
        const staleCommit = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha, expected_revision: 1 } });
        expect(staleCommit.status).toBe(422); // incomplete rows are reported before the revision is compared
        await put(session.id, 'A', 'lib-loans.notice', completeRow2);
        await put(session.id, 'A', 'lib-renewal.rule', completeRow3);
        const staleFull = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha, expected_revision: 1 } });
        expect(staleFull.status).toBe(409);
        expect(staleFull.body.code).toBe('stale_session');
    });

    test('a rebind after Part B was shown carries the exposure: the successor and its labels export say they are not blind, the old session stays blind', async () => {
        const session = await startSession();
        await completeStageA(session);
        const reveal = await api('POST', `/sessions/${session.id}/reveal/B`, { body: { packet_sha256: fixture.sha } });
        expect(reveal.status).toBe(201);
        fixture.write('moved');
        const movedSha = createPacketSource({ packetDir: fixture.packetDir, goldDir: fixture.goldDir }).load().sha256;
        const rebound = await api('POST', `/sessions/${session.id}/rebind`, { body: { from_packet_sha256: fixture.sha, to_packet_sha256: movedSha, confirm: true } });
        expect(rebound.status).toBe(201);
        const successor = rebound.body.session;
        expect(successor.stages.A.committed_at).toBeNull();
        expect(successor.stages.B.revealed_at).toBe(reveal.body.revealed_at);
        expect(successor.blind).toBe(false);
        expect(successor.exposure_before_a).toEqual({ B: reveal.body.revealed_at, C: null });
        const old = (await api('GET', `/sessions/${session.id}`)).body.session;
        expect([old.blind, old.exposure_before_a]).toEqual([true, { B: null, C: null }]);
        expect((await api('GET', `/tasks/${TASK}`)).body.session.blind).toBe(false);
        // The successor's Stage A is open again, so Part B is locked until it is re-committed; the reveal time stays recorded meanwhile.
        expect((await api('GET', `/sessions/${successor.id}/stages/B`)).body.code).toBe('stage_locked');
        fixture.sha = movedSha;
        learn(successor.id, (await api('GET', `/sessions/${successor.id}`)).body);
        const committed = await completeStageA(successor);
        expect(committed.session.blind).toBe(false);
        const exported = await api('POST', `/sessions/${successor.id}/exports/A`, { body: { packet_sha256: movedSha } });
        expect(exported.status).toBe(201);
        const doc = JSON.parse(fs.readFileSync(exported.body.export.path, 'utf8'));
        expect(doc.blind).toBe(false);
        expect(doc.provenance.notBlind).toEqual(expect.any(String));
        expect(doc.provenance.exposureBeforeCommit).toEqual({ B: reveal.body.revealed_at, C: null });
        expect(doc.provenance.carriedFrom).toBe(session.id);
    });

    test('commit refuses incomplete, unsure, missing and invalid records and keeps the drafts; a commit freezes the blind baseline', async () => {
        const session = await startSession();
        await put(session.id, 'A', 'lib-loans.limit', completeRow1);
        await put(session.id, 'A', 'lib-loans.notice', completeRow2, { state: 'unsure' });
        const refused = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha } });
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ code: 'incomplete', missing: ['lib-renewal.rule'], unsure: ['lib-loans.notice'], invalid: [] });
        await put(session.id, 'A', 'lib-renewal.rule', { ...completeRow3, modality: 'UNKNOWN' });
        const refusedAgain = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha } });
        expect(refusedAgain.body.invalid).toEqual([{ item_id: 'lib-renewal.rule', errors: [expect.objectContaining({ path: 'modality', unknown: true })] }]);
        const kept = (await api('GET', `/sessions/${session.id}`)).body;
        expect(kept.session.stages.A.committed_at).toBeNull();
        expect(kept.answers.A.map(a => [a.item_id, a.state])).toEqual([['lib-loans.limit', 'complete'], ['lib-loans.notice', 'unsure'], ['lib-renewal.rule', 'draft']]);

        const committed = await completeStageA(session);
        expect(committed.commit.item_count).toBe(3);
        expect(committed.session.stages.A.committed_at).toBe(committed.commit.committed_at);
        const frozen = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, notes: 'after commit' }, { base_revision: null });
        expect(frozen.status).toBe(409);
        expect(frozen.body.code).toBe('stage_committed');
        const twice = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha } });
        expect(twice.status).toBe(409);
        expect(twice.body.code).toBe('already_committed');
    });

    test('after Stage A commits, Stage B opens only through the operator\'s own reveal, which is the recorded exposure; Stage C waits for B; post-exposure revisions never touch the baseline', async () => {
        const session = await startSession();
        const committed = await completeStageA(session);
        expect(committed.session.stages.B.revealed_at).toBeNull();
        expect(committed.session.blind).toBe(true);
        // A read never reveals, whoever makes it; nothing of Part B leaks before the reveal.
        const unrevealed = await api('GET', `/sessions/${session.id}/stages/B`);
        expect(unrevealed.status).toBe(403);
        expect(unrevealed.body.code).toBe('stage_not_revealed');
        expect(JSON.stringify(unrevealed.body).includes('ctl-')).toBe(false);
        expect((await api('GET', `/sessions/${session.id}`)).body.session.stages.B.revealed_at).toBeNull();
        // The reveal is a write: the placeholder token and the document executor key cannot stamp Robert's exposure.
        for (const auth of ['placeholder', 'document', 'none']) {
            const denied = await api('POST', `/sessions/${session.id}/reveal/B`, { body: { packet_sha256: fixture.sha }, auth });
            expect([auth, denied.status]).toEqual([auth, 403]);
        }
        expect((await api('POST', `/sessions/${session.id}/reveal/B`, { body: {} })).body.code).toBe('packet_sha256_required');
        expect((await api('POST', `/sessions/${session.id}/reveal/C`, { body: { packet_sha256: fixture.sha } })).body.code).toBe('stage_locked');
        expect((await api('POST', `/sessions/${session.id}/reveal/A`, { body: { packet_sha256: fixture.sha } })).status).toBe(400);
        const reveal = await api('POST', `/sessions/${session.id}/reveal/B`, { body: { packet_sha256: fixture.sha } });
        expect(reveal.status).toBe(201);
        expect(reveal.body).toMatchObject({ stage: 'B', first: true, revealed_at: expect.any(String) });
        expect(reveal.body.session.stages.B.revealed_at).toBe(reveal.body.revealed_at);
        const stageB = await api('GET', `/sessions/${session.id}/stages/B`);
        expect(stageB.status).toBe(200);
        expect(stageB.body.content.items.map(i => i.id)).toEqual(['ctl-s1', 'ctl-p1']);
        expect(stageB.body.committed_rows['lib-loans.notice'].answer.modality).toBe('shall');
        expect(stageB.body.revealed_at).toBe(reveal.body.revealed_at);
        const revealAgain = await api('POST', `/sessions/${session.id}/reveal/B`, { body: { packet_sha256: fixture.sha } });
        expect([revealAgain.status, revealAgain.body.first, revealAgain.body.revealed_at]).toEqual([200, false, reveal.body.revealed_at]);
        const again = await api('GET', `/sessions/${session.id}/stages/B`);
        expect(again.body.revealed_at).toBe(stageB.body.revealed_at);
        expect((await api('GET', `/sessions/${session.id}/stages/C`)).body.code).toBe('stage_locked');

        const wrongVerdict = await put(session.id, 'B', 'ctl-p1', { verdict: 'accept' });
        expect(wrongVerdict.status).toBe(400);
        await put(session.id, 'B', 'ctl-s1', { verdict: 'reject', note: 'synthetic' });
        const incomplete = await api('POST', `/sessions/${session.id}/commit/B`, { body: { packet_sha256: fixture.sha } });
        expect(incomplete.status).toBe(422);
        expect(incomplete.body.missing).toEqual(['ctl-p1']);
        await put(session.id, 'B', 'ctl-p1', { verdict: 'UNKNOWN' });
        expect((await api('POST', `/sessions/${session.id}/commit/B`, { body: { packet_sha256: fixture.sha } })).body.invalid[0].item_id).toBe('ctl-p1');
        await put(session.id, 'B', 'ctl-p1', { verdict: 'different' }, { base_revision: 1 });
        const commitB = await api('POST', `/sessions/${session.id}/commit/B`, { body: { packet_sha256: fixture.sha } });
        expect(commitB.status).toBe(201);

        expect((await api('GET', `/sessions/${session.id}/stages/C`)).body.code).toBe('stage_not_revealed');
        expect((await api('POST', `/sessions/${session.id}/reveal/C`, { body: { packet_sha256: fixture.sha } })).status).toBe(201);
        const stageC = await api('GET', `/sessions/${session.id}/stages/C`);
        expect(stageC.status).toBe(200);
        expect(stageC.body.content.items[0].id).toBe('vpu-s1');
        const needsCase = await put(session.id, 'C', 'vpu-s1', { exampleOutcomeSame: 'yes', meaning: 'different', divergingCase: '' });
        expect(needsCase.body.answer.state).toBe('draft');
        expect(needsCase.body.validation.errors[0].path).toBe('divergingCase');
        await put(session.id, 'C', 'vpu-s1', { exampleOutcomeSame: 'yes', meaning: 'different', divergingCase: 'The fine is waived: the original requires nothing, the mutant still requires payment.' }, { base_revision: 1 });
        const commitC = await api('POST', `/sessions/${session.id}/commit/C`, { body: { packet_sha256: fixture.sha } });
        expect(commitC.status).toBe(201);

        const revision = await api('POST', `/sessions/${session.id}/revisions/lib-loans.limit`, { body: { packet_sha256: fixture.sha, answer: { ...completeRow1, modality: 'shall' }, note: 'changed my mind after seeing Part B' } });
        expect(revision.status).toBe(201);
        expect(revision.body.revision.exposure).toMatchObject({ blind: false, after_exposure_to: ['B', 'C'] });
        expect(revision.body.revision.exposure.revealed.B).toBe(stageB.body.revealed_at);
        const read = (await api('GET', `/sessions/${session.id}`)).body;
        expect(read.commits.A.snapshot_sha256).toBe(committed.commit.snapshot_sha256);
        expect(read.answers.A.find(a => a.item_id === 'lib-loans.limit').answer.modality).toBe('may');
        expect(read.revisions).toHaveLength(1);
        expect(read.revisions[0].answer.modality).toBe('shall');
        const unknownRow = await api('POST', `/sessions/${session.id}/revisions/no-row`, { body: { packet_sha256: fixture.sha, answer: completeRow1 } });
        expect(unknownRow.status).toBe(404);
    });

    test('exports write scorer-shaped documents at fixed paths, are idempotent, and never overwrite a file this session did not write', async () => {
        const session = await startSession();
        const early = await api('POST', `/sessions/${session.id}/exports/A`, { body: { packet_sha256: fixture.sha } });
        expect(early.status).toBe(412);
        const committed = await completeStageA(session);
        const exported = await api('POST', `/sessions/${session.id}/exports/A`, { body: { packet_sha256: fixture.sha } });
        expect(exported.status).toBe(201);
        expect(exported.body.written).toBe(true);
        expect(exported.body.target).toBe('labels/robert.json');
        const file = path.join(fixture.goldDir, 'labels', 'robert.json');
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(doc).toMatchObject({ annotator: 'robert', kind: 'gold', blind: true, rosterSha256: fixture.packet.rosterSha256, guidelineSha256: fixture.packet.guideline.sha256, labeledAt: committed.commit.committed_at });
        expect(doc.rows.map(r => r.rowId)).toEqual(['lib-loans.limit', 'lib-loans.notice', 'lib-renewal.rule']);
        expect(doc.rows[0].actor).toEqual({ quote: 'A card holder' });
        expect(doc.rows[1].actor).toEqual({ quote: 'The library shall', within: WITHIN_2 });
        expect(doc.rows[1].propositions[0]).toEqual({ category: 'condition', quote: 'within ten days after an item becomes overdue', within: WITHIN_2, numeric: { value: 10, unit: 'day', operator: '<=' } });
        expect(doc.rows[0].propositions[0]).toEqual({ category: 'condition', quote: 'up to five items at one time', numeric: { value: 5, unit: 'item', operator: '<=' } });
        expect(doc.rows[2].actor).toEqual({ quote: 'an unreasonable refusal', sourceUnit: '/syn/lib/s2', within: CONTEXT_3 });
        expect(doc.provenance).toMatchObject({ collectedWith: 'nexus-groundrules-labeling', nexusTaskId: TASK, sessionId: session.id, commitSha256: committed.commit.snapshot_sha256 });
        expect(Object.keys(doc)).toEqual(['annotator', 'kind', 'blind', 'rosterSha256', 'guidelineSha256', 'labeledAt', 'rows', 'provenance']);
        const repeat = await api('POST', `/sessions/${session.id}/exports/A`, { body: { packet_sha256: fixture.sha } });
        expect(repeat.status).toBe(200);
        expect(repeat.body.identical).toBe(true);
        fs.writeFileSync(file, '{"annotator":"someone-else","kind":"gold","rows":[]}\n');
        const conflict = await api('POST', `/sessions/${session.id}/exports/A`, { body: { packet_sha256: fixture.sha } });
        expect(conflict.status).toBe(409);
        expect(conflict.body.code).toBe('export_conflict');
        expect(fs.readFileSync(file, 'utf8')).toContain('someone-else');
        expect((await api('POST', `/sessions/${session.id}/exports/B`, { body: { packet_sha256: fixture.sha } })).status).toBe(412);
        expect((await api('POST', `/sessions/${session.id}/exports/nope`, { body: { packet_sha256: fixture.sha } })).status).toBe(400);
        const exports = (await api('GET', `/sessions/${session.id}`)).body.exports;
        expect(exports.map(e => e.kind)).toEqual(['A', 'A']);
        expect(fs.existsSync(path.join(fixture.goldDir, 'judgments'))).toBe(false);
    });

    test('a regenerated packet is a visible conflict: writes refuse, a new session is not started silently, and a deliberate rebind carries answers as drafts', async () => {
        const session = await startSession();
        await put(session.id, 'A', 'lib-loans.limit', completeRow1);
        await put(session.id, 'A', 'lib-loans.notice', completeRow2, { state: 'unsure' });
        const moved = fixture.write('moved');
        const movedSha = createPacketSource({ packetDir: fixture.packetDir, goldDir: fixture.goldDir }).load().sha256;
        expect(movedSha).not.toBe(fixture.sha);
        expect(moved.rosterSha256).not.toBe(fixture.packet.rosterSha256);
        const entry = await api('GET', `/tasks/${TASK}`);
        expect(entry.body.packet.sha256).toBe(movedSha);
        expect(entry.body.session.packet_conflict).toMatchObject({ session_packet_sha256: fixture.sha, current_packet_sha256: movedSha });
        const write = await put(session.id, 'A', 'lib-renewal.rule', completeRow3);
        expect(write.status).toBe(409);
        expect(write.body.code).toBe('packet_changed');
        const start = await api('POST', `/tasks/${TASK}/session`);
        expect(start.status).toBe(409);
        expect(start.body.code).toBe('packet_changed');
        const unconfirmed = await api('POST', `/sessions/${session.id}/rebind`, { body: { from_packet_sha256: fixture.sha, to_packet_sha256: movedSha } });
        expect(unconfirmed.status).toBe(400);
        const wrong = await api('POST', `/sessions/${session.id}/rebind`, { body: { from_packet_sha256: fixture.sha, to_packet_sha256: 'a'.repeat(64), confirm: true } });
        expect(wrong.status).toBe(409);
        const rebound = await api('POST', `/sessions/${session.id}/rebind`, { body: { from_packet_sha256: fixture.sha, to_packet_sha256: movedSha, confirm: true } });
        expect(rebound.status).toBe(201);
        expect(rebound.body.carried).toBe(2);
        expect(rebound.body.session.packet_sha256).toBe(movedSha);
        expect(rebound.body.session.carried_from).toBe(session.id);
        expect(rebound.body.superseded.superseded_by).toBe(rebound.body.session.id);
        const successor = (await api('GET', `/sessions/${rebound.body.session.id}`)).body;
        expect(successor.answers.A.map(a => [a.item_id, a.state])).toEqual([['lib-loans.limit', 'draft'], ['lib-loans.notice', 'unsure']]);
        expect(successor.answers.A[0].answer.carried_from).toMatchObject({ session_id: session.id, packet_sha256: fixture.sha, state: 'complete' });
        expect(successor.answers.A[0].errors[0].path).toBe('packet');
        const old = (await api('GET', `/sessions/${session.id}`)).body;
        expect(old.answers.A).toHaveLength(2);
        expect(old.answers.A[0].state).toBe('complete');
        const oldWrite = await api('PUT', `/sessions/${session.id}/answers/A/lib-loans.limit`, { body: { packet_sha256: fixture.sha, answer: completeRow1 } });
        expect(oldWrite.status).toBe(409);
        expect(['session_superseded', 'packet_changed']).toContain(oldWrite.body.code);
        expect((await api('GET', `/tasks/${TASK}`)).body.session.id).toBe(rebound.body.session.id);
        expect((await api('POST', `/sessions/${rebound.body.session.id}/rebind`, { body: { from_packet_sha256: movedSha, to_packet_sha256: movedSha, confirm: true } })).body.code).toBe('packet_unchanged');
    });
    test('a "within" is checked where the scorer resolves it, the whole source unit: a span unique in the passage but repeated in the section keeps the row a draft, the commit refuses it, and a corpus that cannot be verified refuses to guess', async () => {
        const session = await startSession();
        // UNIT_REPEAT ("the holder") occurs once in ROW_1 but three times in
        // /syn/lib/s1, because ROW_2 carries it and repeats there.
        const ambiguous = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder', within: UNIT_REPEAT } });
        expect(ambiguous.status).toBe(200);
        expect(ambiguous.body.answer.state).toBe('draft');
        expect(ambiguous.body.validation.errors).toEqual([expect.objectContaining({ path: 'actor.within', reason: 'within_not_unique_in_unit', count: 3 })]);
        const propAmbiguous = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, propositions: [{ category: 'exception', quote: 'holder', within: UNIT_REPEAT }] });
        expect(propAmbiguous.body.answer.state).toBe('draft');
        expect(propAmbiguous.body.validation.errors).toEqual([expect.objectContaining({ path: 'propositions[0].within', reason: 'within_not_unique_in_unit', count: 3 })]);
        // A context quote's "within" is resolved in the context's own unit.
        const contextAmbiguous = await put(session.id, 'A', 'lib-renewal.rule', { ...completeRow3, actor: { quote: 'refusal', source: 0, within: 'refusal' } });
        expect(contextAmbiguous.body.validation.errors).toEqual([expect.objectContaining({ path: 'actor.within', reason: 'within_not_unique_in_unit', count: 3 })]);
        const contextPinned = await put(session.id, 'A', 'lib-renewal.rule', { ...completeRow3, actor: { quote: 'refusal', source: 0, within: 'an unreasonable refusal' } });
        expect(contextPinned.body.answer.state).toBe('complete');

        // The stage cannot be committed around the ambiguous anchor.
        await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder', within: UNIT_REPEAT } });
        expect((await put(session.id, 'A', 'lib-loans.notice', completeRow2)).body.answer.state).toBe('complete');
        const refused = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha } });
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('incomplete');
        expect(refused.body.missing).toEqual([]);
        expect(refused.body.invalid).toEqual([{ item_id: 'lib-loans.limit', errors: [expect.objectContaining({ path: 'actor.within', reason: 'within_not_unique_in_unit' })] }]);
        expect((await api('GET', `/sessions/${session.id}`)).body.answers.A.find(a => a.item_id === 'lib-loans.limit').state).toBe('draft');

        // A corpus file that is not the one the packet pins is never trusted:
        // the answer stays a draft instead of reaching the scorer unchecked.
        const sourceFile = path.join(fixture.sourcesDir, 'lib.xml');
        const sourceBytes = fs.readFileSync(sourceFile);
        fs.writeFileSync(sourceFile, Buffer.concat([sourceBytes, Buffer.from('\n<!-- tampered -->\n')]));
        const tampered = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder', within: 'the holder has' } });
        expect(tampered.body.answer.state).toBe('draft');
        expect(tampered.body.validation.errors).toEqual([expect.objectContaining({ path: 'actor.within', reason: 'within_unverifiable', detail: 'source_digest_mismatch' })]);
        fs.renameSync(path.join(fixture.sourcesDir, 'manifest.json'), path.join(fixture.sourcesDir, 'manifest.json.away'));
        const noManifest = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder', within: 'the holder has' } });
        expect(noManifest.body.validation.errors[0]).toMatchObject({ path: 'actor.within', reason: 'within_unverifiable', detail: 'manifest_unreadable' });
        fs.renameSync(path.join(fixture.sourcesDir, 'manifest.json.away'), path.join(fixture.sourcesDir, 'manifest.json'));
        fs.writeFileSync(sourceFile, sourceBytes);
        // No "within" at all needs no corpus: the scorer resolves the quote in the row's own span.
        const plain = await put(session.id, 'A', 'lib-loans.limit', completeRow1);
        expect(plain.body.answer.state).toBe('complete');

        const pinned = await put(session.id, 'A', 'lib-loans.limit', { ...completeRow1, actor: { quote: 'holder', within: 'the holder has' } });
        expect(pinned.body.answer.state).toBe('complete');
        const latest = await api('GET', `/sessions/${session.id}`);
        const commit = await api('POST', `/sessions/${session.id}/commit/A`, { body: { packet_sha256: fixture.sha, expected_revision: latest.body.session.revision } });
        expect(commit.status).toBe(201);
        const exported = await api('POST', `/sessions/${session.id}/exports/A`, { body: { packet_sha256: fixture.sha } });
        expect(exported.status).toBe(201);
        const doc = JSON.parse(fs.readFileSync(path.join(fixture.goldDir, 'labels', 'robert.json'), 'utf8'));
        expect(doc.rows[0].actor).toEqual({ quote: 'holder', within: 'the holder has' });
        expect(doc.rows[2].actor).toEqual({ quote: 'refusal', sourceUnit: '/syn/lib/s2', within: 'an unreasonable refusal' });
    });
});
