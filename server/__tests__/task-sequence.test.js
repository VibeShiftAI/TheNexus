/**
 * Task sequencing — predecessor gate + successor auto-start
 * (server/lib/task-sequence.js; semantics from @praxis/contract
 * TaskSequenceSchema).
 */

const {
    getIncompletePredecessors,
    checkPredecessorGate,
    findSuccessorCandidates,
    triggerSuccessors,
} = require('../lib/task-sequence');

/** Minimal db facade stub over an in-memory task map. */
function makeDb(tasks) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    return {
        getTask: async (id) => byId.get(id) || null,
        getTasks: async (projectId) => tasks.filter(t => t.project_id === projectId),
    };
}

const P = 'proj-1';

describe('getIncompletePredecessors', () => {
    test('reports incomplete predecessors and ignores (but flags) missing ones', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed' },
            { id: 'b', project_id: P, name: 'B', status: 'todo' },
            { id: 't', project_id: P, name: 'T', status: 'todo', dependencies: ['a', 'b', 'ghost'] },
        ]);
        const { incomplete, missing } = await getIncompletePredecessors(db, await db.getTask('t'));
        expect(incomplete.map(p => p.id)).toEqual(['b']);
        expect(missing).toEqual(['ghost']);
    });

    test('legacy done-synonym statuses count as complete', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'done' },
            { id: 'b', project_id: P, name: 'B', status: 'complete' },
            { id: 't', project_id: P, name: 'T', status: 'todo', dependencies: ['a', 'b'] },
        ]);
        const { incomplete } = await getIncompletePredecessors(db, await db.getTask('t'));
        expect(incomplete).toEqual([]);
    });
});

describe('checkPredecessorGate', () => {
    const tasks = [
        { id: 'dep', project_id: P, name: 'Dep', status: 'in_progress' },
        { id: 't', project_id: P, name: 'T', status: 'todo', dependencies: ['dep'] },
        { id: 'free', project_id: P, name: 'Free', status: 'todo', dependencies: [] },
        { id: 'running', project_id: P, name: 'Running', status: 'in_progress', dependencies: ['dep'] },
    ];
    const db = makeDb(tasks);

    test('blocks a start transition while a predecessor is incomplete', async () => {
        const err = await checkPredecessorGate(db, tasks[1], 'in_progress');
        expect(err).toMatch(/predecessor/);
        expect(err).toContain('dep');
        expect(await checkPredecessorGate(db, tasks[1], 'dispatched')).toMatch(/predecessor/);
    });

    test('non-start transitions are never gated', async () => {
        expect(await checkPredecessorGate(db, tasks[1], 'review')).toBeNull();
        expect(await checkPredecessorGate(db, tasks[1], 'completed')).toBeNull();
        expect(await checkPredecessorGate(db, tasks[1], 'blocked')).toBeNull();
    });

    test('tasks without predecessors start freely', async () => {
        expect(await checkPredecessorGate(db, tasks[2], 'in_progress')).toBeNull();
    });

    test('an already-started task is not re-gated (progression, not a start)', async () => {
        expect(await checkPredecessorGate(db, tasks[3], 'dispatched')).toBeNull();
    });

    test('force bypasses the gate', async () => {
        expect(await checkPredecessorGate(db, tasks[1], 'in_progress', { force: true })).toBeNull();
    });
});

describe('findSuccessorCandidates', () => {
    test('finds the direct successor', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'b' },
            { id: 'b', project_id: P, name: 'B', status: 'todo' },
        ]);
        const candidates = await findSuccessorCandidates(db, await db.getTask('a'));
        expect(candidates.map(c => c.id)).toEqual(['b']);
    });

    test('fan-in: completing the LAST predecessor surfaces a successor designated by an earlier-completed task', async () => {
        // a (completed, successor: c) ─┐
        //                              ├─→ c (deps: a, b)
        // b (just completed) ──────────┘
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'c' },
            { id: 'b', project_id: P, name: 'B', status: 'completed' },
            { id: 'c', project_id: P, name: 'C', status: 'todo', dependencies: ['a', 'b'] },
        ]);
        const candidates = await findSuccessorCandidates(db, await db.getTask('b'));
        expect(candidates.map(c => c.id)).toEqual(['c']);
    });

    test('no candidates when nothing links to the completed task', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed' },
            { id: 'b', project_id: P, name: 'B', status: 'todo' },
        ]);
        expect(await findSuccessorCandidates(db, await db.getTask('a'))).toEqual([]);
    });
});

describe('triggerSuccessors', () => {
    function fetchMock(responses = {}) {
        const calls = [];
        const impl = async (url, opts) => {
            const body = JSON.parse(opts.body);
            calls.push({ url, body });
            const r = responses[body.taskId] || { ok: true, status: 200, json: { ok: true, reply: 'dispatched' } };
            return { ok: r.ok, status: r.status, json: async () => r.json };
        };
        return { impl, calls };
    }

    test('dispatches an eligible successor through the Praxis dispatch endpoint', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'b' },
            { id: 'b', project_id: P, name: 'B', status: 'todo' },
        ]);
        const { impl, calls } = fetchMock();
        const results = await triggerSuccessors(db, await db.getTask('a'), { fetchImpl: impl, praxisUrl: 'http://praxis.test' });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://praxis.test/api/dispatch/task');
        expect(calls[0].body).toEqual({ taskId: 'b' });
        expect(results).toEqual([{ taskId: 'b', action: 'dispatched', detail: 'dispatched' }]);
    });

    test('holds a successor whose other predecessors are still incomplete', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'c' },
            { id: 'b', project_id: P, name: 'B', status: 'in_progress' },
            { id: 'c', project_id: P, name: 'C', status: 'todo', dependencies: ['a', 'b'] },
        ]);
        const { impl, calls } = fetchMock();
        const results = await triggerSuccessors(db, await db.getTask('a'), { fetchImpl: impl });
        expect(calls).toHaveLength(0);
        expect(results[0]).toMatchObject({ taskId: 'c', action: 'held' });
    });

    test('skips successors that are already running or terminal', async () => {
        for (const status of ['in_progress', 'dispatched', 'completed', 'cancelled', 'scheduled']) {
            const db = makeDb([
                { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'b' },
                { id: 'b', project_id: P, name: 'B', status },
            ]);
            const { impl, calls } = fetchMock();
            const results = await triggerSuccessors(db, await db.getTask('a'), { fetchImpl: impl });
            expect(calls).toHaveLength(0);
            expect(results[0]).toMatchObject({ taskId: 'b', action: 'skipped' });
        }
    });

    test('a refused dispatch (409) is reported, not thrown', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'b' },
            { id: 'b', project_id: P, name: 'B', status: 'todo' },
        ]);
        const { impl } = fetchMock({ b: { ok: false, status: 409, json: { ok: false, reply: '❌ duplicate' } } });
        const results = await triggerSuccessors(db, await db.getTask('a'), { fetchImpl: impl });
        expect(results[0]).toMatchObject({ taskId: 'b', action: 'refused', detail: '❌ duplicate' });
    });

    test('Praxis being unreachable is reported, not thrown', async () => {
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'b' },
            { id: 'b', project_id: P, name: 'B', status: 'todo' },
        ]);
        const failFetch = async () => { throw new Error('ECONNREFUSED'); };
        const results = await triggerSuccessors(db, await db.getTask('a'), { fetchImpl: failFetch });
        expect(results[0]).toMatchObject({ taskId: 'b', action: 'failed' });
    });

    test('a blocked-status successor is still eligible once its predecessors are done', async () => {
        // Predecessor-blocked tasks commonly sit at `blocked`; completing the
        // last predecessor must release them.
        const db = makeDb([
            { id: 'a', project_id: P, name: 'A', status: 'completed', successor_id: 'b' },
            { id: 'b', project_id: P, name: 'B', status: 'blocked', dependencies: ['a'] },
        ]);
        const { impl, calls } = fetchMock();
        const results = await triggerSuccessors(db, await db.getTask('a'), { fetchImpl: impl });
        expect(calls).toHaveLength(1);
        expect(results[0]).toMatchObject({ taskId: 'b', action: 'dispatched' });
    });
});
