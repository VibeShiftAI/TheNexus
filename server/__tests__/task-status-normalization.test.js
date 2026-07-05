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

    test('every legacy mapping lands on a canonical value', () => {
        const valid = new Set(TaskBoardStatusSchema.options);
        for (const canonical of Object.values(LEGACY_TASK_STATUS_MAP)) {
            expect(valid.has(canonical)).toBe(true);
        }
    });
});
