import test from 'node:test';
import assert from 'node:assert/strict';
import { addComment, DocumentApiError, finishReview, recordDecision } from '../document-review';

/**
 * The documents API is session-authenticated: the browser's cookies carry the
 * Cloudflare Access session and the server stamps the local user. The shared
 * nexus fetch helper attaches a placeholder `Authorization: Bearer
 * local-dev-token` to every call, and on 2026-10-04 the decision authority
 * read that placeholder as an operator-credential attempt and refused
 * Robert's Request changes with 503 operator_credential_unconfigured before
 * looking at his session (task a1cc8616). Document review requests must not
 * carry a bearer.
 */

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown) {
    const calls: Call[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return { ok: status < 400, status, json: async () => body } as unknown as Response;
    }) as typeof fetch;
    return { calls, restore() { globalThis.fetch = original; } };
}

function headerNames(init: RequestInit): string[] {
    return Object.keys((init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
}

const NOTE = 'Change the "identity" column in the table below to be a summary of the documents instead of just listing what documents are available.';

test('decision, comment and finish requests carry the session (cookies) and no bearer header', async () => {
    const decision = { id: 'd-1', document_id: 'doc-1', revision_id: 'rev-2', content_hash: 'b'.repeat(64), decision: 'request_changes', actor_id: 'local_user', authority: 'access_user', note: NOTE, client_decision_id: 'cd-1', intended_action: 'send', created_at: '2026-10-04T17:00:00Z' };
    const stub = stubFetch(201, { decision, review_status: 'changes_requested', comment: { id: 'c-1' }, review: { id: 'review-1' }, submission: { id: 's-1' } });
    try {
        const recorded = await recordDecision('doc-1', { decision: 'request_changes', revision_id: 'rev-2', content_hash: 'b'.repeat(64), note: NOTE, client_decision_id: 'cd-1' });
        assert.equal(recorded.decision.revision_id, 'rev-2');
        await addComment('review-1', { client_id: 'c-1', kind: 'document', body: 'Summarise the documents.' });
        await finishReview('review-1', 'See the comment.');

        assert.equal(stub.calls.length, 3);
        for (const call of stub.calls) {
            assert.ok(!headerNames(call.init).includes('authorization'), `${call.url} must not carry a bearer (headers: ${headerNames(call.init).join(', ')})`);
            assert.equal(call.init.credentials, 'include', `${call.url} must send the session cookies`);
            assert.equal((call.init.headers as Record<string, string>)['Content-Type'], 'application/json');
            assert.equal(call.init.method, 'POST');
        }
        const [decide, comment, finish] = stub.calls;
        assert.match(decide.url, /^\/api\/documents\/doc-1\/decisions(\?|$)/);
        assert.deepEqual(JSON.parse(String(decide.init.body)), { decision: 'request_changes', revision_id: 'rev-2', content_hash: 'b'.repeat(64), note: NOTE, client_decision_id: 'cd-1' });
        assert.match(comment.url, /^\/api\/documents\/reviews\/review-1\/comments(\?|$)/);
        assert.match(finish.url, /^\/api\/documents\/reviews\/review-1\/finish(\?|$)/);
    } finally {
        stub.restore();
    }
});

test('a refusal keeps the server status, code and reason so the card can say what the session lacked', async () => {
    const stub = stubFetch(503, { error: 'The operator credential is not configured; no decision can be recorded with it', code: 'operator_credential_unconfigured', reason: 'assertion-missing' });
    try {
        await assert.rejects(
            recordDecision('doc-1', { decision: 'approve', revision_id: 'rev-1', client_decision_id: 'cd-2' }),
            (err: unknown) => {
                assert.ok(err instanceof DocumentApiError);
                assert.equal(err.status, 503);
                assert.equal(err.code, 'operator_credential_unconfigured');
                assert.equal(err.reason, 'assertion-missing');
                assert.match(err.message, /operator credential is not configured/);
                return true;
            },
        );
    } finally {
        stub.restore();
    }
});
