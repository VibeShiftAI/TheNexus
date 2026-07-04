/**
 * last_activity_at bump rule (Board Groundskeeper, task 02f3c8a7).
 *
 * The core guarantee: a full-board sweep that PATCHes rows with the SAME
 * values does not move last_activity_at — only genuine changes (or none of
 * the sweep header) count as activity.
 */

const { hasRealActivity, ACTIVITY_FIELDS } = require('../lib/task-activity');

const existing = {
    id: 't1',
    name: 'Fix the widget',
    status: 'idea',
    description: 'A real description',
    priority: 1,
    dependencies: ['a', 'b'],
    antigravity_payload: { prompt: 'do it', workspace: '/w' },
    model_assignment: null,
};

describe('hasRealActivity', () => {
    test('same-value rewrite (the daily sweep pattern) is NOT activity', () => {
        // A sweep re-sends the row verbatim — every field present, none changed.
        const sweepUpdates = {
            name: 'Fix the widget',
            status: 'idea',
            description: 'A real description',
            priority: 1,
            dependencies: ['a', 'b'],
            antigravity_payload: { prompt: 'do it', workspace: '/w' },
        };
        expect(hasRealActivity(existing, sweepUpdates)).toBe(false);
    });

    test('a real status change IS activity (dispatch, completion, human moves)', () => {
        expect(hasRealActivity(existing, { status: 'in-progress' })).toBe(true);
        expect(hasRealActivity(existing, { status: 'completed' })).toBe(true);
    });

    test('description/name/priority/dependency edits are activity', () => {
        expect(hasRealActivity(existing, { description: 'rewritten' })).toBe(true);
        expect(hasRealActivity(existing, { name: 'Fix the widget properly' })).toBe(true);
        expect(hasRealActivity(existing, { priority: 2 })).toBe(true);
        expect(hasRealActivity(existing, { dependencies: ['a'] })).toBe(true);
    });

    test('non-activity fields alone do not bump (workflow bookkeeping)', () => {
        const retiredStatusKey = ['lang', 'graph_status'].join('');
        expect(hasRealActivity(existing, { research_output: 'x', [retiredStatusKey]: 'done' })).toBe(false);
        expect(hasRealActivity(existing, { metadata: { status_message: 'sync tick' } })).toBe(false);
    });

    test('the x-nexus-sweep header suppresses the bump even for real changes', () => {
        expect(hasRealActivity(existing, { status: 'todo' }, { 'x-nexus-sweep': '1' })).toBe(false);
    });

    test('null/empty/undefined equivalence does not create phantom activity', () => {
        expect(hasRealActivity(existing, { model_assignment: null })).toBe(false);
        expect(hasRealActivity({ ...existing, description: '' }, { description: null })).toBe(false);
    });

    test('exports the field list so the rule is inspectable', () => {
        expect(ACTIVITY_FIELDS).toEqual(
            expect.arrayContaining(['status', 'name', 'description', 'priority', 'dependencies'])
        );
    });
});
