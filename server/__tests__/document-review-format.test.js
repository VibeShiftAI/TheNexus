const fmt = require('../services/document-review-format');

const content = ['# Title', '', 'First paragraph.', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Last line.'].join('\n');

test('passage anchors must quote the exact pinned lines; the hash is derived server-side', () => {
    const ok = fmt.verifyPassageAnchor({ start_line: 5, end_line: 7, quote: '| a | b |\n|---|---|\n| 1 | 2 |' }, content);
    expect(ok.ok).toBe(true);
    expect(ok.block_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fmt.verifyPassageAnchor({ start_line: 5, end_line: 7, quote: 'tampered' }, content)).toMatchObject({ ok: false, code: 'anchor_mismatch' });
    expect(fmt.verifyPassageAnchor({ start_line: 0, end_line: 1, quote: '# Title' }, content)).toMatchObject({ ok: false, code: 'invalid_anchor' });
    expect(fmt.verifyPassageAnchor({ start_line: 3, end_line: 99, quote: 'x' }, content)).toMatchObject({ ok: false, code: 'invalid_anchor' });
    expect(fmt.verifyPassageAnchor({ start_line: '3', end_line: '3', quote: 'First paragraph.' }, content).ok).toBe(true);
});

test('anchor state distinguishes intact, moved and orphaned passages without relocating them', () => {
    const comment = { kind: 'passage', start_line: 3, end_line: 3, quote: 'First paragraph.' };
    expect(fmt.anchorState(comment, content, 'h1', 'h1')).toEqual({ state: 'intact', current_start_line: 3 });
    const moved = `Intro added.\n\n${content}`;
    expect(fmt.anchorState(comment, moved, 'h1', 'h2')).toEqual({ state: 'moved', current_start_line: 5 });
    const rewritten = content.replace('First paragraph.', 'First paragraph, edited.');
    expect(fmt.anchorState(comment, rewritten, 'h1', 'h3')).toEqual({ state: 'orphaned', current_start_line: null });
    expect(fmt.anchorState({ kind: 'document', body: 'note' }, rewritten, 'h1', 'h3')).toEqual({ state: 'document' });
});

test('the delivered turn reproduces every comment verbatim with its quote, anchor, link and revision', () => {
    const payload = fmt.buildSubmissionPayload({
        submissionId: 'sub-1',
        review: { id: 'rev-1', reviewer_id: 'local_user', summary: 'Overall: solid, two fixes.' },
        comments: [
            { id: 'c1', kind: 'passage', start_line: 5, end_line: 7, block_hash: 'h', quote: '| a | b |\n|---|---|\n| 1 | 2 |', selection: 'b', body: 'Column b needs units.', created_at: 't1', updated_at: 't1' },
            { id: 'c2', kind: 'document', body: 'Whole doc: add a date header.', created_at: 't2', updated_at: 't2' },
        ],
        document: { id: 'doc-1', title: 'Readiness', path: '/Volumes/Projects/P/docs/r.md', kind: 'report', project_id: 'p1', task_id: 't1' },
        revision: { id: 'r1', content_hash: 'abcdef0123456789', captured_at: '2026-09-10T10:00:00.000Z', line_count: 9 },
        source: { task: { id: 't1', title: 'Verify repairs', status: 'completed' }, project: { id: 'p1', name: 'Praxis' } },
        submittedAt: '2026-09-10T11:00:00.000Z',
    });
    expect(payload.review_url).toBe('https://nexus.vibeshiftai.com/documents/doc-1');
    expect(payload.comments).toHaveLength(2);
    const message = fmt.formatSubmissionMessage(payload);
    expect(message).toContain('[DOCUMENT REVIEW] Robert finished reviewing "Readiness".');
    expect(message).toContain('Reviewed revision: abcdef012345');
    expect(message).toContain('Source task: "Verify repairs" (t1)');
    expect(message).toContain('Review link: https://nexus.vibeshiftai.com/documents/doc-1');
    expect(message).toContain('Overall: solid, two fixes.');
    expect(message).toContain('On lines 5-7 (highlighted: "b"):');
    expect(message).toContain('> | a | b |\n> |---|---|\n> | 1 | 2 |');
    expect(message).toContain('Robert: Column b needs units.');
    expect(message).toContain('1. Whole doc: add a date header.');
    expect(message).not.toContain('without adding comments');
});

test('a zero-comment finish is still a complete, honest turn', () => {
    const payload = fmt.buildSubmissionPayload({
        submissionId: 's', review: { id: 'r', reviewer_id: 'u', summary: '' }, comments: [],
        document: { id: 'd', title: 'T', path: '/p/d.md', kind: 'document' }, revision: { id: 'x', content_hash: 'ff', captured_at: 'c', line_count: 1 },
        source: {}, submittedAt: 's',
    });
    const message = fmt.formatSubmissionMessage(payload);
    expect(message).toContain('(no summary given)');
    expect(message).toContain('Robert finished the review without adding comments.');
});

test('the dashboard base URL is overridable and never carries a trailing slash', () => {
    const before = process.env.NEXUS_DASHBOARD_URL;
    process.env.NEXUS_DASHBOARD_URL = 'http://localhost:3000/';
    try { expect(fmt.reviewUrlFor('a b')).toBe('http://localhost:3000/documents/a%20b'); }
    finally { if (before === undefined) delete process.env.NEXUS_DASHBOARD_URL; else process.env.NEXUS_DASHBOARD_URL = before; }
});
