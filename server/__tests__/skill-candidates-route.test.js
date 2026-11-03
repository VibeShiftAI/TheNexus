const express = require('express');
const createRouter = require('../routes/skill-candidates');

const fetchFixture = global.fetch;
let server;
let base;
let upstream;
let authorize;
let sign;

beforeEach(async () => {
    upstream = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    authorize = jest.fn().mockResolvedValue({ ok: true, actor: { authority: 'access_user' } });
    sign = jest.fn().mockReturnValue({ 'X-Praxis-Operator-Provenance': 'fixture-signature' });
    const app = express();
    app.use(express.json());
    app.use('/api/skill-candidates', createRouter({ authorize, sign }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port + '/api/skill-candidates';
});

afterEach(async () => {
    upstream.mockRestore();
    await new Promise(resolve => server.close(resolve));
});

function decide(body, headers = {}) {
    return fetchFixture(base + '/example/decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
}

test('review forwards the requested candidate as one segment and preserves upstream errors', async () => {
    const body = { state: 'stale', error: 'Skill changed. Re-evaluate the amendment.' };
    upstream.mockResolvedValueOnce(Response.json(body, { status: 409 }));
    const res = await fetchFixture(base + '/name%20%26%20more/review');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(body);
    expect(upstream).toHaveBeenCalledWith(expect.stringMatching(/\/skill-candidates\/name%20%26%20more\/review$/), expect.objectContaining({ method: 'GET' }));
});

test('apply forwards the URL id and the exact review id without client-supplied diff or target', async () => {
    const res = await decide({ decision: 'apply-amendment', reviewId: 'review-2', id: 'spoofed', diff: 'spoofed', targetSkill: 'spoofed' });
    expect(res.status).toBe(200);
    expect(sign).toHaveBeenCalledWith(JSON.stringify({ purpose: 'skill-amendment-apply', id: 'example', reviewId: 'review-2' }), { surface: 'nexus-skill-amendment' });
    expect(upstream.mock.calls[0][1].headers['X-Praxis-Operator-Provenance']).toBe('fixture-signature');
    expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({ id: 'example', decision: 'apply-amendment', reviewId: 'review-2' });
});

test.each(['approve', 'archive', 'reject'])('legacy %s keeps its original decision payload', async decision => {
    await decide({ decision, reviewId: 'irrelevant' });
    expect(authorize).not.toHaveBeenCalled();
    expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({ id: 'example', decision });
});

test.each([
    { ok: false, status: 401 },
    { ok: true, actor: { authority: 'document_executor_credential' } },
])('apply refuses callers without operator authority', async verdict => {
    authorize.mockResolvedValueOnce(verdict);
    const res = await decide({ decision: 'apply-amendment', reviewId: 'review-2' });
    expect([401, 403]).toContain(res.status);
    expect(sign).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
});

test('cross-site requests cannot apply an amendment', async () => {
    expect((await decide({ decision: 'apply-amendment', reviewId: 'review-2' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
});

test('a missing review id or unavailable signing key cannot authorize apply', async () => {
    expect((await decide({ decision: 'apply-amendment' })).status).toBe(400);
    sign.mockReturnValueOnce({});
    expect((await decide({ decision: 'apply-amendment', reviewId: 'review-2' })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
});
