/**
 * Canonical task-status unification (2026-07-05). The board had drifted to
 * three completion synonyms (complete/done/completed); every write now
 * funnels through normalizeTaskBoardStatus. These tests lock the contract.
 */
const {
    TaskBoardStatusSchema,
    LEGACY_TASK_STATUS_MAP,
    normalizeTaskBoardStatus,
} = require('@praxis/contract');

describe('canonical task-status normalization', () => {
    test('legacy completion synonyms collapse to completed', () => {
        expect(normalizeTaskBoardStatus('complete')).toBe('completed');
        expect(normalizeTaskBoardStatus('done')).toBe('completed');
        expect(normalizeTaskBoardStatus('completed')).toBe('completed');
    });

    test('case and whitespace are forgiven', () => {
        expect(normalizeTaskBoardStatus('  Done ')).toBe('completed');
        expect(normalizeTaskBoardStatus('In-Progress')).toBe('in_progress');
    });

    test('canonical values pass through unchanged', () => {
        for (const status of TaskBoardStatusSchema.options) {
            expect(normalizeTaskBoardStatus(status)).toBe(status);
        }
    });

    test('unknown values are rejected (null), not guessed', () => {
        expect(normalizeTaskBoardStatus('bananas')).toBeNull();
        expect(normalizeTaskBoardStatus('')).toBeNull();
        expect(normalizeTaskBoardStatus(42)).toBeNull();
        expect(normalizeTaskBoardStatus(undefined)).toBeNull();
    });

    // P0-10 (2026-09-03): HITL suspension was 400ing at the API because the
    // enum lacked the status the resume route already required.
    test('suspended is canonical (HITL hold, resumed via POST /:id/resume)', () => {
        expect(TaskBoardStatusSchema.options).toContain('suspended');
        expect(normalizeTaskBoardStatus('suspended')).toBe('suspended');
        expect(normalizeTaskBoardStatus(' Suspended ')).toBe('suspended');
    });

    test('queued (dispatch-gate vocabulary) normalizes to todo, not scheduled', () => {
        expect(normalizeTaskBoardStatus('queued')).toBe('todo');
        expect(LEGACY_TASK_STATUS_MAP.queued).toBe('todo');
    });

    test('awaiting_approval is still not a board status (no writer exists)', () => {
        expect(normalizeTaskBoardStatus('awaiting_approval')).toBeNull();
    });

    test('every legacy mapping lands on a canonical value', () => {
        const valid = new Set(TaskBoardStatusSchema.options);
        for (const canonical of Object.values(LEGACY_TASK_STATUS_MAP)) {
            expect(valid.has(canonical)).toBe(true);
        }
    });
});
