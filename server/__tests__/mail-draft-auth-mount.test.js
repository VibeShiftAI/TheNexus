const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const access = require('./helpers/operator-access');
const createRouter = require('../routes/mail-draft-review');

const nativeFetch = global.fetch;
let server, base, restore, relay;
beforeEach(async () => {
    restore = access.configure({ deviceIds: access.deviceId });
    global.fetch = jest.fn(async (url, options) => String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks } : nativeFetch(url, options));
    const app = express();
    app.use(express.json());
    // Exercise the actual production middleware registration, not a fixture
    // that pre-populates req.user and conceals missing route registrations.
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('function authenticate(req, res, next)');
    const end = source.indexOf("app.use('/api/write-leases'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    vm.runInNewContext(source.slice(start, end), { app });
    relay = jest.fn(async () => ({ status: 200, json: async () => ({ status: 'fixture-only' }) }));
    app.use('/api/praxis/mailbox/drafts-review', createRouter({ relay, sign: () => ({ 'X-Proof': 'fixture-only' }) }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/praxis/mailbox/drafts-review/md_fixture`;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    restore();
});
async function approve(token) {
    return nativeFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(token ? { 'cf-access-jwt-assertion': token } : {}) },
    body: JSON.stringify({ action: 'approve_send', version: 'fixture' }) });
}
test.each(['device', 'user'])('production Mail mount accepts verified operator %s', async kind => {
    const token = kind === 'device' ? access.serviceToken({ aud: access.audience }) : access.token();
    expect((await approve(token)).status).toBe(200);
    expect(relay).toHaveBeenCalledTimes(1);
});
test.each(['unsigned', 'untrusted-device', 'forged'])('production Mail mount refuses %s', async kind => {
    const token = kind === 'unsigned' ? undefined : kind === 'untrusted-device'
        ? access.serviceToken({ common_name: 'untrusted-device.access' }) : `${access.token()}broken`;
    expect((await approve(token)).status).toBe(403);
    expect(relay).not.toHaveBeenCalled();
});
