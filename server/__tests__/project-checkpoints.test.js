/**
 * Ordered endpoint checkpoints (Nexus 143abc00, docs/project-checkpoints.md):
 * persistence, plan editing, and the single guarded advancement transition,
 * exercised through the real projects router against a temp SQLite database.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVED = '2026-09-15T10:00:00Z';
const passObservation = { status: 'pass', observed_at: OBSERVED, evidence_ref: 'vault:acceptance-note' };
const manual = (id, observation = passObservation) => ({ id, kind: 'manual', description: `Acceptance ${id}`, enabled: true, ...(observation ? { observation } : {}) });
const checkpoint = (id, title, criteria, extra = {}) => ({ id, title, goal: `${title} is observably reached`, criteria, ...extra });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const knowledge = (blocking = true, criterionIds = []) => ({ question: 'Which rollout strategy meets the budget?', tags: ['rollouts'], satisfaction_test: 'A measured trial supports the answer.', criterion_ids: criterionIds, task_ids: [], blocking, evidence: [] });

describe('project checkpoints: persistence, editing and guarded advancement', () => {
    let db, raw, dir, server, url, oldDbPath;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-project-checkpoints-'));
        oldDbPath = process.env.NEXUS_DB_PATH;
        process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
        jest.resetModules();
        db = require('../../db');
        raw = new Database(process.env.NEXUS_DB_PATH);
        raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
        const app = express();
        app.use(express.json());
        app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: (_, id) => db.getProject(id), getAllProjects: () => db.getProjects(), scanProjects: jest.fn(), callAI: jest.fn(), contextSync: {} }));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/api/projects/${PROJECT_ID}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        raw.close();
        if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = oldDbPath;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
        raw.prepare('DELETE FROM projects').run();
        await db.upsertProject({ id: PROJECT_ID, name: 'Project', path: '/tmp/project', end_state: 'Long-term goal: reliable releases', end_state_criteria: [manual('final')] });
    });
    async function req(suffix, body, method = 'PATCH') {
        if (body && suffix === '' && ['end_state', 'endpoint', 'end_state_criteria'].some(k => Object.hasOwn(body, k))) body.expected_updated_at ??= (await db.getProject(PROJECT_ID)).updated_at;
        if (body && suffix === '' && Object.hasOwn(body, 'checkpoints') && !Object.hasOwn(body, 'expected_checkpoints_revision')) body.expected_checkpoints_revision = (await db.getProject(PROJECT_ID)).checkpoints?.revision ?? null;
        const response = await fetch(url + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    }
    async function savePlan(items, extra = {}) {
        const result = await req('', { checkpoints: items, ...extra });
        expect(result.status).toBe(200);
        return result.body;
    }
    async function assessment(checkpointId, criteriaIds, status = 'pass', overrides = {}) {
        await sleep(5); // evidence must postdate the definition revision written a moment ago
        const checked_at = new Date().toISOString();
        return {
            evaluated_at: checked_at,
            results: criteriaIds.map(id => ({ id, pass: status === 'pass', status, checked_at, detail: `recorded ${status}` })),
            knowledge: { required: 0, satisfied: 0, unresolved: 0 },
            ...overrides,
        };
    }
    async function transition(project, checkpointId, body) {
        const target = project.checkpoints.items.find(c => c.id === checkpointId);
        return req('/checkpoints/transition', { checkpoint_id: checkpointId, definition_revision: target.definition_revision, expected_checkpoints_revision: project.checkpoints.revision, source: 'test', ...body }, 'POST');
    }
    async function advance(project, checkpointId) {
        let target = project.checkpoints.items.find(c => c.id === checkpointId);
        if (target.criteria.some(c => c.kind === 'manual' && !c.observation)) {
            project = await savePlan(project.checkpoints.items.map(cp => cp.id === checkpointId ? { id: cp.id, criteria: cp.criteria.map(c => c.kind === 'manual' ? { ...c, observation: { ...passObservation, observed_at: new Date().toISOString() } } : c) } : { id: cp.id }));
            target = project.checkpoints.items.find(c => c.id === checkpointId);
        }
        const result = await transition(project, checkpointId, { assessment: await assessment(checkpointId, target.criteria.map(c => c.id)) });
        expect(result.status).toBe(200);
        expect(result.body.transition).toMatchObject({ outcome: 'advanced' });
        return result.body.project;
    }

    test('projects without a plan read null and legacy writes never touch an existing plan', async () => {
        const before = await req('', undefined, 'GET');
        expect(before.body.checkpoints).toBeNull();
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1', passObservation)]), checkpoint('b', 'Rollout', [manual('b1')])]);
        expect(saved.checkpoints.items.map(c => c.id)).toEqual(['a', 'b']);
        expect(saved.checkpoints.items.every(c => c.status === 'pending')).toBe(true);
        expect(saved.end_state).toBe('Long-term goal: reliable releases');
        const revision = saved.checkpoints.revision;
        const legacy = await req('', { description: 'An older client saving only the description' });
        expect(legacy.status).toBe(200);
        const criteriaEdit = await req('', { end_state_criteria: [manual('final'), manual('final-2')] });
        expect(criteriaEdit.status).toBe(200);
        expect(criteriaEdit.body.checkpoints.items.map(c => c.id)).toEqual(['a', 'b']);
        expect(criteriaEdit.body.checkpoints.revision).toBe(revision);
        // The long-term goal revision is independent of plan edits.
        expect(criteriaEdit.body.end_state_updated_at).not.toBe(saved.end_state_updated_at);
        const clear = await req('', { checkpoints: null });
        expect(clear.status).toBe(400);
    });

    test('plan edits keep ids stable, assign ids to new items, archive removals, reorder under the revision guard, and ignore no-op saves', async () => {
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1')]), checkpoint('b', 'Rollout', [manual('b1')])]);
        const r1 = saved.checkpoints.revision;
        const stale = await req('', { checkpoints: [checkpoint('b', 'Rollout', [manual('b1')]), checkpoint('a', 'Foundation', [manual('a1')])], expected_checkpoints_revision: 'not-the-revision' });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('CHECKPOINT_REVISION_STALE');
        const reordered = await savePlan([checkpoint('b', 'Rollout', [manual('b1')]), checkpoint('a', 'Foundation', [manual('a1')])], { expected_checkpoints_revision: r1 });
        expect(reordered.checkpoints.items.map(c => c.id)).toEqual(['b', 'a']);
        expect(reordered.checkpoints.revision).not.toBe(r1);
        expect(reordered.checkpoints.items.map(c => c.definition_revision)).toEqual(saved.checkpoints.items.map(c => c.definition_revision).reverse());
        const removed = await savePlan([checkpoint('b', 'Rollout', [manual('b1')]), { title: 'Adoption', goal: 'Users rely on it', criteria: [manual('c1')] }]);
        expect(removed.checkpoints.items.map(c => c.title)).toEqual(['Rollout', 'Adoption']);
        expect(removed.checkpoints.items[1].id).toMatch(/^[0-9a-f]{8}$/);
        expect(removed.checkpoints.archived.map(c => c.id)).toEqual(['a']);
        expect(removed.checkpoints.archived[0].status).toBe('archived');
        expect(removed.checkpoints.archived[0].history.at(-1).kind).toBe('archived');
        const noop = await savePlan(removed.checkpoints.items.map(({ id, title, goal, criteria, need_ids }) => ({ id, title, goal, criteria, need_ids })));
        expect(noop.checkpoints.revision).toBe(removed.checkpoints.revision);
        const restored = await savePlan([...removed.checkpoints.items.map(({ id }) => ({ id })), { id: 'a' }]);
        expect(restored.checkpoints.items.map(c => c.id)).toEqual([...removed.checkpoints.items.map(c => c.id), 'a']);
        expect(restored.checkpoints.archived).toEqual([]);
        expect(restored.checkpoints.items.at(-1).history.at(-1).kind).toBe('restored');
        const unknownNeed = await req('', { checkpoints: [checkpoint('b', 'Rollout', [manual('b1')], { need_ids: ['nope'] })] });
        expect(unknownNeed.status).toBe(400);
        expect(unknownNeed.body.error).toMatch(/unknown need link/);
    });

    test('fresh passing evidence advances exactly once; replays, stale guards and non-current targets cannot move the sequence', async () => {
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1', passObservation)]), checkpoint('b', 'Rollout', [manual('b1')]), checkpoint('c', 'Adoption', [manual('c1')])]);
        const evidence = await assessment('a', ['a1']);
        const first = await transition(saved, 'a', { assessment: evidence });
        expect(first.status).toBe(200);
        expect(first.body.transition).toMatchObject({ outcome: 'advanced', verified: true, completed_checkpoint_id: 'a', current_checkpoint_id: 'b', sequence_completed_at: null });
        const after = first.body.project;
        expect(after.checkpoints.revision).not.toBe(saved.checkpoints.revision);
        expect(after.checkpoints.items[0]).toMatchObject({ status: 'completed', completion: { definition_revision: saved.checkpoints.items[0].definition_revision, source: 'test' } });
        expect(after.checkpoints.items[0].completion.assessment.results[0].status).toBe('pass');
        expect(after.checkpoints.items[0].history.at(-1).kind).toBe('completed');
        expect(after.end_state).toBe('Long-term goal: reliable releases');
        expect(after.end_state_updated_at).toBe(saved.end_state_updated_at);

        // A restarted evaluator replaying the same evidence with its old plan revision hits the guard.
        const replayStale = await transition(saved, 'a', { assessment: evidence });
        expect(replayStale.status).toBe(409);
        expect(replayStale.body.code).toBe('CHECKPOINT_REVISION_STALE');
        // With the fresh revision the same evidence is a duplicate: nothing changes.
        const replay = await transition(after, 'a', { assessment: evidence });
        expect(replay.status).toBe(200);
        expect(replay.body.transition.outcome).toBe('duplicate');
        expect(replay.body.project.checkpoints.revision).toBe(after.checkpoints.revision);
        // Newer evidence for an already completed checkpoint is refused rather than double-counted.
        const again = await transition(after, 'a', { assessment: await assessment('a', ['a1']) });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('CHECKPOINT_NOT_CURRENT');
        // Skipping ahead is impossible: only the current checkpoint accepts evidence.
        const skip = await transition(after, 'c', { assessment: await assessment('c', ['c1']) });
        expect(skip.status).toBe(409);
        expect(skip.body.code).toBe('CHECKPOINT_NOT_CURRENT');
        expect((await req('', undefined, 'GET')).body.checkpoints.items.filter(c => c.status === 'completed')).toHaveLength(1);
        // Evidence gathered against another definition of the current checkpoint is stale.
        const staleDefinition = await transition(after, 'b', { definition_revision: '2020-01-01T00:00:00.000Z', assessment: await assessment('b', ['b1']) });
        expect(staleDefinition.status).toBe(409);
        expect(staleDefinition.body.code).toBe('CHECKPOINT_DEFINITION_STALE');
        const old = await transition(after, 'b', { assessment: { ...(await assessment('b', ['b1'])), evaluated_at: '2020-01-01T00:00:00.000Z' } });
        expect(old.status).toBe(409);
        expect(old.body.code).toBe('ASSESSMENT_NOT_FRESH');
        const missingGuard = await req('/checkpoints/transition', { checkpoint_id: 'b', definition_revision: after.checkpoints.items[1].definition_revision, assessment: await assessment('b', ['b1']) }, 'POST');
        expect(missingGuard.status).toBe(428);
    });

    test('failed, unknown, unverifiable, skipped or missing evidence and empty criteria keep the checkpoint current', async () => {
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1'), manual('a2')]), checkpoint('z', 'No criteria yet', []), checkpoint('d', 'Disabled only', [{ ...manual('d1'), enabled: false }])]);
        for (const status of ['fail', 'unknown', 'unverifiable']) {
            const project = (await req('', undefined, 'GET')).body;
            const result = await transition(project, 'a', { assessment: await assessment('a', ['a1', 'a2'], status) });
            expect(result.status).toBe(200);
            expect(result.body.transition).toMatchObject({ outcome: 'recorded', verified: false, current_checkpoint_id: 'a' });
            expect(result.body.project.checkpoints.items[0].status).toBe('pending');
            expect(result.body.project.checkpoints.items[0].assessment.results[0].status).toBe(status);
            expect(result.body.project.checkpoints.revision).toBe(saved.checkpoints.revision);
        }
        // A skipped task is reported by the evaluator as a failed task_set result: same outcome.
        const skipped = await transition((await req('', undefined, 'GET')).body, 'a', { assessment: await assessment('a', ['a1', 'a2'], 'fail', { results: [{ id: 'a1', pass: true, status: 'pass', checked_at: new Date().toISOString() }, { id: 'a2', pass: false, status: 'fail', checked_at: new Date().toISOString(), detail: '1 task(s) skipped (closed without delivery)' }] }) });
        expect(skipped.body.transition.outcome).toBe('recorded');
        // One passing result out of two criteria is not verification.
        const partial = await transition((await req('', undefined, 'GET')).body, 'a', { assessment: await assessment('a', ['a1']) });
        expect(partial.body.transition.outcome).toBe('recorded');
        // The client's own achieved flag carries no authority.
        const claimed = await transition((await req('', undefined, 'GET')).body, 'a', { assessment: { ...(await assessment('a', ['a1'], 'fail')), achieved: true } });
        expect(claimed.body.transition.outcome).toBe('recorded');
        expect(claimed.body.project.checkpoints.items[0].assessment.achieved).toBe(false);
        // Advance a for real, then prove empty and all-disabled criteria sets can never complete.
        const advanced = await advance((await req('', undefined, 'GET')).body, 'a');
        expect(advanced.checkpoints.items.map(c => c.status)).toEqual(['completed', 'pending', 'pending']);
        const empty = await transition(advanced, 'z', { assessment: await assessment('z', []) });
        expect(empty.body.transition.outcome).toBe('recorded');
        const fabricated = await transition(advanced, 'z', { assessment: await assessment('z', ['ghost']) });
        expect(fabricated.body.transition.outcome).toBe('recorded');
        expect(fabricated.body.project.checkpoints.items[1].status).toBe('pending');
        const withCriteria = await savePlan([{ id: 'a' }, checkpoint('z', 'No criteria yet', [manual('z1')]), { id: 'd' }]);
        const zDone = await advance(withCriteria, 'z');
        const disabled = await transition(zDone, 'd', { assessment: await assessment('d', ['d1']) });
        expect(disabled.body.transition.outcome).toBe('recorded');
        expect(disabled.body.project.checkpoints.sequence_completed_at).toBeNull();
    });

    test('required knowledge is scoped: a linked blocking need gates its checkpoint, an unlinked one stays project-wide, and the server recomputes the counts', async () => {
        const added = await req('/needs', { kind: 'information', description: 'Rollout knowledge', source: 'operator', knowledge: knowledge(true) }, 'POST');
        expect(added.status).toBe(201);
        const linked = added.body.need;
        const global = (await req('/needs', { kind: 'information', description: 'Long-term question', source: 'operator', knowledge: knowledge(true) }, 'POST')).body.need;
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1')], { need_ids: [linked.id] }), checkpoint('b', 'Rollout', [manual('b1')])]);
        const blocked = await transition(saved, 'a', { assessment: await assessment('a', ['a1']) });
        expect(blocked.status).toBe(200);
        expect(blocked.body.transition).toMatchObject({ outcome: 'recorded', knowledge: { required: 1, satisfied: 0, unresolved: 1, open_ids: [linked.id] } });
        expect(blocked.body.project.checkpoints.items[0].assessment.knowledge).toEqual({ required: 1, satisfied: 0, unresolved: 1 });
        const met = await req(`/needs/${linked.id}`, { status: 'met', knowledge: { answer: 'Use a canary.', evidence: [{ ref: 'vault:trial', checked_at: OBSERVED }] }, source: 'executor' });
        expect(met.status).toBe(200);
        const project = (await req('', undefined, 'GET')).body;
        // Satisfying knowledge cleared the pending evaluation; a fresh one is required and now verifies.
        expect(project.checkpoints.items[0].assessment).toBeNull();
        const verified = await transition(project, 'a', { assessment: await assessment('a', ['a1']) });
        expect(verified.body.transition).toMatchObject({ outcome: 'advanced', knowledge: { required: 1, satisfied: 1, unresolved: 0 } });
        // The unlinked blocking need does not gate checkpoint b.
        const unlinked = await transition(verified.body.project, 'b', { assessment: await assessment('b', ['b1']) });
        expect(unlinked.body.transition.outcome).toBe('advanced');
        expect(unlinked.body.transition.knowledge.required).toBe(0);
        expect((await req('', undefined, 'GET')).body.needs.find(n => n.id === global.id).status).toBe('open');
    });

    test('a definition edit returns a completed checkpoint to pending with its evidence kept as history, reopens linked knowledge, and an inserted checkpoint becomes current', async () => {
        const need = (await req('/needs', { kind: 'information', description: 'Rollout knowledge', source: 'operator', knowledge: knowledge(true) }, 'POST')).body.need;
        await req(`/needs/${need.id}`, { status: 'met', knowledge: { answer: 'Use a canary.', evidence: [{ ref: 'vault:trial' }] }, source: 'executor' });
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1')], { need_ids: [need.id] }), checkpoint('b', 'Rollout', [manual('b1')])]);
        const advanced = await advance(saved, 'a');
        const untouched = await savePlan([{ id: 'a' }, { id: 'b', title: 'Rollout renamed' }]);
        expect(untouched.checkpoints.items[0].status).toBe('completed');
        // Renaming is a label change: the plan revision moves, the definition (and its evidence) does not.
        expect(untouched.checkpoints.items[1].definition_revision).toBe(advanced.checkpoints.items[1].definition_revision);
        expect(untouched.checkpoints.revision).not.toBe(advanced.checkpoints.revision);
        const edited = await savePlan([checkpoint('a', 'Foundation', [manual('a1'), manual('a2')], { need_ids: [need.id] }), { id: 'b' }]);
        const a = edited.checkpoints.items[0];
        expect(a.status).toBe('pending');
        expect(a.completion).toBeNull();
        expect(a.definition_revision).not.toBe(advanced.checkpoints.items[0].definition_revision);
        expect(a.history.map(h => h.kind)).toEqual(['completed', 'reopened', 'definition_changed']);
        expect(a.history[1].assessment.results[0].id).toBe('a1');
        expect(a.history[1].definition_revision).toBe(advanced.checkpoints.items[0].definition_revision);
        expect(edited.needs.find(n => n.id === need.id)).toMatchObject({ status: 'open', knowledge: { research_status: 'stale' } });
        expect(edited.needs.find(n => n.id === need.id).knowledge.answer).toBe('Use a canary.');
        // Old evidence cannot be resubmitted against the new definition.
        const stale = await req('/checkpoints/transition', { checkpoint_id: 'a', definition_revision: advanced.checkpoints.items[0].definition_revision, expected_checkpoints_revision: edited.checkpoints.revision, assessment: await assessment('a', ['a1', 'a2']) }, 'POST');
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('CHECKPOINT_DEFINITION_STALE');
        // Inserting a checkpoint ahead of completed work makes it current: the operator asked for a new gate.
        const withB = await advance(await advance(await savePlan([checkpoint('a', 'Foundation', [manual('a1')], { need_ids: [] }), { id: 'b' }]), 'a'), 'b');
        expect(withB.checkpoints.sequence_completed_at).not.toBeNull();
        const inserted = await savePlan([{ title: 'Prerequisite', goal: 'Something first', criteria: [manual('p1')] }, { id: 'a' }, { id: 'b' }]);
        expect(inserted.checkpoints.items.map(c => c.status)).toEqual(['pending', 'completed', 'completed']);
        expect(inserted.checkpoints.sequence_completed_at).toBeNull();
        const current = (await transition(inserted, inserted.checkpoints.items[0].id, { assessment: await assessment('p', ['p1'], 'fail') })).body.transition;
        expect(current.current_checkpoint_id).toBe(inserted.checkpoints.items[0].id);
    });

    test('the final checkpoint records sequence completion without touching the long-term goal; assessments carry the gate; reopen is explicit', async () => {
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1')]), checkpoint('b', 'Rollout', [manual('b1')])]);
        const one = await advance(saved, 'a');
        expect(one.checkpoints.sequence_completed_at).toBeNull();
        const two = await advance(one, 'b');
        expect(two.checkpoints.sequence_completed_at).not.toBeNull();
        expect(two.checkpoints.items.every(c => c.status === 'completed')).toBe(true);
        expect(two.end_state).toBe('Long-term goal: reliable releases');
        expect(two.end_state_updated_at).toBe(saved.end_state_updated_at);
        expect(two.endpoint).toEqual(saved.endpoint);
        expect(two.status).toBe('active');
        const noCurrent = await transition(two, 'b', { assessment: await assessment('b', ['b1']) });
        expect(noCurrent.status).toBe(409);
        // The final-goal assessment records the sequence gate alongside its results.
        const final = await req('', { end_state_assessment: { evaluated_at: new Date().toISOString(), endpoint_revision: two.end_state_updated_at, results: [{ id: 'final', pass: true, status: 'pass', checked_at: new Date().toISOString() }], knowledge: { required: 0, satisfied: 0, unresolved: 0 }, checkpoints: { current_id: null, completed: 2, total: 2, sequence_complete: true }, achieved: true }, expected_updated_at: two.updated_at });
        expect(final.status).toBe(200);
        expect(final.body.end_state_assessment.checkpoints.sequence_complete).toBe(true);
        expect(final.body.checkpoints.sequence_completed_at).toBe(two.checkpoints.sequence_completed_at);
        const reopened = await req('/checkpoints/b/reopen', { reason: 'Rollout regressed in production', source: 'operator', expected_checkpoints_revision: two.checkpoints.revision }, 'POST');
        expect(reopened.status).toBe(200);
        expect(reopened.body.current_checkpoint_id).toBe('b');
        expect(reopened.body.project.end_state_assessment).toBeNull();
        expect(reopened.body.checkpoints.sequence_completed_at).toBeNull();
        expect(reopened.body.checkpoints.items[1]).toMatchObject({ status: 'pending', completion: null });
        expect(reopened.body.checkpoints.items[1].history.at(-1)).toMatchObject({ kind: 'reopened', reason: 'Rollout regressed in production' });
        expect(reopened.body.checkpoints.items[1].history.at(-1).assessment.results[0].id).toBe('b1');
        const twice = await req('/checkpoints/b/reopen', { reason: 'again', expected_checkpoints_revision: reopened.body.checkpoints.revision }, 'POST');
        expect(twice.status).toBe(409);
        expect(twice.body.code).toBe('CHECKPOINT_NOT_COMPLETED');
        const staleReopen = await req('/checkpoints/a/reopen', { expected_checkpoints_revision: two.checkpoints.revision }, 'POST');
        expect(staleReopen.status).toBe(409);
    });

    test('concurrent evaluators submitting the same evidence advance the sequence once', async () => {
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1')]), checkpoint('b', 'Rollout', [manual('b1')])]);
        const evidence = await assessment('a', ['a1']);
        const results = await Promise.all([1, 2, 3].map(() => transition(saved, 'a', { assessment: evidence })));
        const outcomes = results.map(r => r.status === 200 ? r.body.transition.outcome : r.body.code);
        expect(outcomes.filter(o => o === 'advanced')).toHaveLength(1);
        expect(outcomes.every(o => ['advanced', 'CHECKPOINT_REVISION_STALE', 'duplicate'].includes(o))).toBe(true);
        const project = (await req('', undefined, 'GET')).body;
        expect(project.checkpoints.items.filter(c => c.status === 'completed')).toHaveLength(1);
        expect(project.checkpoints.items[0].history.filter(h => h.kind === 'completed')).toHaveLength(1);
    });

    test('unrelated needs retain pending evaluations while completed evidence stays attached', async () => {
        const saved = await savePlan([checkpoint('a', 'Foundation', [manual('a1')]), checkpoint('b', 'Rollout', [manual('b1')])]);
        const advanced = await advance(saved, 'a');
        const waiting = await transition(advanced, 'b', { assessment: await assessment('b', ['b1'], 'fail') });
        expect(waiting.body.project.checkpoints.items[1].assessment).not.toBeNull();
        const added = await req('/needs', { kind: 'decision', description: 'Which region first?', source: 'operator' }, 'POST');
        expect(added.status).toBe(201);
        const project = (await req('', undefined, 'GET')).body;
        expect(project.checkpoints.items[1].assessment).toEqual(waiting.body.project.checkpoints.items[1].assessment);
        expect(project.checkpoints.items[0].completion.assessment.results[0].status).toBe('pass');
        expect(project.checkpoints.revision).not.toBe(advanced.checkpoints.revision);
    });
});
