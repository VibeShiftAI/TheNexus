const { buildApprovedPlanFollowupScope } = require('../services/approved-plan-followups');
const now = new Date('2026-10-09T15:00:00Z');
const slate = { available: true, date: '2026-10-09', stages: [{ stage: 'approved', reached: true }], slots: [{ taskId: 'today', withdrawn: false }] };
const event = (task_id, start_time = '2026-10-09T13:00:00Z', status = 'completed') => ({ task_id, start_time, status });
const row = (id, deps = [], extra = {}) => ({ id, name: id, status: 'planning', dependencies: JSON.stringify(deps), ...extra });
const rows = [row('today', [], { status: 'completed' }), row('next', ['today']), row('later', ['next']), row('old', [], { status: 'completed' }), row('random', ['old'])];
const scope = (s = slate, e = [event('today')], r = rows, n = now) => buildApprovedPlanFollowupScope(s, e, r, n);
test('only direct unscheduled follow-ups of approved calendar work, with root lineage', () => {
    expect([...scope().keys()]).toEqual(['next']);
    expect(scope().get('next')).toEqual([{ taskId: 'today', title: 'today' }]);
});
test.each([null, { available: false }, { ...slate, date: '2026-10-08' }, { ...slate, date: '2026-10-10' }, { ...slate, stages: [] }, { ...slate, stages: [{ stage: 'approved', reached: false }] }])('no scope without today’s explicit approval: %j', s => expect(scope(s).size).toBe(0));
test('calendar evidence and non-withdrawn approved slot are required', () => {
    expect(scope(slate, []).size).toBe(0);
    expect(scope(slate, [event('today', '2026-10-08T13:00:00Z')]).size).toBe(0);
    expect(scope(slate, [event('today', undefined, 'cancelled')]).size).toBe(0);
    expect(scope({ ...slate, slots: [{ taskId: 'today', withdrawn: true }] }).size).toBe(0);
});
test('calendar tasks, including future scheduled work, are not offered again', () => {
    const result = scope(slate, [event('today'), event('next', '2026-10-10T13:00:00Z', 'scheduled')]);
    expect([...result.keys()]).toEqual([]);
});
test('completed intermediate tasks do not pull later milestones into today’s follow-ups', () => {
    expect([...scope(slate, [event('today')], rows.map(r => r.id === 'next' ? { ...r, status: 'completed' } : r)).keys()]).toEqual([]);
    for (const change of [{ status: 'cancelled' }, { archived_at: '2026-10-08' }]) {
        expect(scope(slate, [event('today')], rows.map(r => r.id === 'next' ? { ...r, ...change } : r)).size).toBe(0);
    }
});
test('successor links, multiple roots, cycles and cross-project dependencies are resolved once', () => {
    const s = { ...slate, slots: [...slate.slots, { taskId: 'second', withdrawn: false }] };
    const r = [row('today', [], { successor_id: 'next' }), row('second'), row('next', ['second', 'later']), row('later', ['next'])];
    const result = scope(s, [event('today'), event('second')], r);
    expect([...result.keys()]).toEqual(['next']);
    expect(result.get('next').map(r => r.taskId).sort()).toEqual(['second', 'today']);
});
test('day boundary uses New York, not UTC or server timezone', () => {
    expect(scope(slate, [event('today', '2026-10-10T02:00:00Z')], rows, new Date('2026-10-10T03:00:00Z')).size).toBe(1);
    expect(scope(slate, [event('today')], rows, new Date('2026-10-10T04:00:00Z')).size).toBe(0);
});

test('a later milestone appears only when its own direct predecessor is in today’s approved plan', () => {
    const s = { ...slate, slots: [...slate.slots, { taskId: 'next', withdrawn: false }] };
    const result = scope(s, [event('today'), event('next')]);
    expect([...result.keys()]).toEqual(['later']);
    expect(result.get('later')).toEqual([{ taskId: 'next', title: 'next' }]);
});
test('direct QA improvement tasks stay visible alongside direct successors', () => {
    const r = [...rows, row('qa-fix', ['today'], { name: 'QA improvements' })];
    expect([...scope(slate, [event('today')], r).keys()]).toEqual(['next', 'qa-fix']);
});
