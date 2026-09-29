import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import SessionPage from '../../app/session/page.tsx';

const CLIENT_ID = '0123456789abcdef0123456789abcdef.access';
const EMAIL = 'operator@vibeshiftai.test';
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const html = (status = 404) => ({ ok: false, status, json: async () => { throw new SyntaxError('not json'); } });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

function mount(answers) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    calls.push({ path, credentials: options.credentials, cache: options.cache });
    const answer = answers[path];
    if (!answer) throw new TypeError(`unexpected fetch ${path}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(SessionPage)));
  return { container, calls, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const probe = (over = {}) => json({ assertionPresent: true, kind: 'service-token', emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false, ...over });
const compared = { emailPin: 'n/a', audience: 'match', audienceShape: 'string', issuer: 'match', tokenType: 'app', subject: 'empty', nbf: 'absent' };

test('inside the travel shell before the Nexus reload, the page names the service-token session and the pin to add', async () => {
  const t = mount({
    '/session/probe': probe(),
    '/cdn-cgi/access/get-identity': json({ common_name: CLIENT_ID, service_token_status: true, service_token_id: 'uuid' }),
    '/api/ai/chat/operator-identity': html(404),
  });
  try {
    await settle();
    assert.deepEqual(t.calls.map(c => c.path).sort(), ['/api/ai/chat/operator-identity', '/cdn-cgi/access/get-identity', '/session/probe']);
    assert.ok(t.calls.every(c => c.credentials === 'same-origin' && c.cache === 'no-store'));
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-kind'), 'service-token');
    assert.equal(page.getAttribute('data-session-operator'), 'route-missing');
    const step = page.querySelector('[data-session-step]').textContent;
    assert.match(step, /travel shell's service-token session/);
    assert.ok(step.includes(`Add ${CLIENT_ID} to NEXUS_OPERATOR_DEVICE_IDS`));
    assert.match(page.textContent, /Client ID \(not a secret; the value to pin\)/);
    assert.match(page.textContent, /before this check existed/);
    assert.ok(!page.textContent.includes('Verified address'), 'a service-token session has no address to show');
  } finally {
    t.cleanup();
  }
});

test('after the reload with the laptop pinned, the page reports the device identity and nothing to do', async () => {
  const t = mount({
    '/session/probe': probe(),
    '/cdn-cgi/access/get-identity': json({ common_name: CLIENT_ID, service_token_status: true }),
    '/api/ai/chat/operator-identity': json({ operator: true, identity: 'device', reason: 'ok', assertionPresent: true, configured: { issuer: true, audience: true, operatorEmail: true, trustedDevices: 1 } }),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-operator'), 'ok');
    assert.match(page.querySelector('[data-session-step]').textContent, /^Nothing to do/);
    assert.match(page.textContent, /Identity\s*device/);
    assert.match(page.textContent, /Trusted devices pinned\s*1/);
    assert.ok(!page.textContent.includes('Audience claim'), 'a probe answer without the comparison words shows no audience row');
  } finally {
    t.cleanup();
  }
});

test('on the Mac app (localhost) the page explains the missing Access session instead of asking for a login', async () => {
  const t = mount({
    '/session/probe': json({ assertionPresent: false, kind: 'none', emailPresent: false, commonNamePresent: false, clientId: null, expired: null }),
    '/cdn-cgi/access/get-identity': html(404),
    '/api/ai/chat/operator-identity': json({ operator: false, identity: null, reason: 'assertion-missing', assertionPresent: false, configured: { issuer: true, audience: true, operatorEmail: true, trustedDevices: 0 } }),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-kind'), 'none');
    assert.match(page.querySelector('[data-session-step]').textContent, /Mac app \(localhost\) that is expected/);
    assert.match(page.textContent, /localhost:3000 directly/);
    assert.doesNotMatch(page.textContent, /log in|sign in again/i);
  } finally {
    t.cleanup();
  }
});

test('a person signed in under another address is told which pin to correct, and the address shown is the session\'s own', async () => {
  const t = mount({
    '/session/probe': json({ assertionPresent: true, kind: 'user', emailPresent: true, commonNamePresent: false, clientId: null, expired: false }),
    '/cdn-cgi/access/get-identity': json({ email: EMAIL, idp: { type: 'onetimepin' } }),
    '/api/ai/chat/operator-identity': json({ operator: false, identity: null, reason: 'claim-rejected', check: 'identity-email', assertionPresent: true, configured: { issuer: true, audience: true, operatorEmail: true, trustedDevices: 0 } }),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-kind'), 'user');
    const step = page.querySelector('[data-session-step]').textContent;
    assert.match(step, /identity-email/);
    assert.ok(step.includes(EMAIL));
    assert.match(page.textContent, /Verified address/);
    assert.ok(!page.textContent.includes('Client ID'));
  } finally {
    t.cleanup();
  }
});

test('when the dashboard probe cannot be reached, the page says the kind is undetermined rather than "no Access session"', async () => {
  const t = mount({
    '/session/probe': new TypeError('network down'),
    '/cdn-cgi/access/get-identity': json({ err: 'no app token set' }, 401),
    '/api/ai/chat/operator-identity': html(404),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-kind'), 'undetermined');
    assert.match(page.textContent, /Not determined: the dashboard probe gave no reading/);
    assert.match(page.textContent, /Dashboard probe\s*The dashboard probe could not be reached/);
    const step = page.querySelector('[data-session-step]').textContent;
    assert.match(step, /could not be reached/);
    assert.match(step, /Check again/);
    assert.doesNotMatch(step, /No Access session/);
    assert.doesNotMatch(page.textContent, /Kind\s*No Access session/);
  } finally {
    t.cleanup();
  }
});

test('with the laptop pinned but the running child refusing at audience, the page reads the form of the claim and names the reload, not a pin', async () => {
  const t = mount({
    '/session/probe': probe(compared),
    '/cdn-cgi/access/get-identity': json({ err: 'unauthorized' }, 400),
    '/api/ai/chat/operator-identity': json({ operator: false, identity: null, reason: 'claim-rejected', check: 'audience', assertionPresent: true, configured: { issuer: true, audience: true, operatorEmail: true, trustedDevices: 1 } }),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-kind'), 'service-token');
    assert.equal(page.getAttribute('data-session-operator'), 'refused');
    const step = page.querySelector('[data-session-step]').textContent;
    assert.match(step, /^Refused at check audience: this session's token carries the pinned audience as a single string/);
    assert.match(step, /reload the Nexus child once/);
    assert.doesNotMatch(step, /NEXUS_OPERATOR_DEVICE_IDS|NEXUS_OPERATOR_ACCESS_AUD/);
    assert.match(page.textContent, /Audience claim\s*single-string form \(RFC 7519\); equals the pinned audience/);
    assert.match(page.textContent, /Token profile\s*type app, subject empty, nbf absent, issuer match/);
    assert.match(page.textContent, /Check\s*audience/);
    assert.match(page.textContent, /Trusted devices pinned\s*1/);
    assert.match(page.textContent, /Client ID \(not a secret; the value to pin\)/);
  } finally {
    t.cleanup();
  }
});

test('a token issued for another application is told which pin to correct, from the array form of the claim', async () => {
  const t = mount({
    '/session/probe': probe({ ...compared, audience: 'mismatch', audienceShape: 'array' }),
    '/cdn-cgi/access/get-identity': json({ err: 'unauthorized' }, 400),
    '/api/ai/chat/operator-identity': json({ operator: false, identity: null, reason: 'claim-rejected', check: 'audience', assertionPresent: true, configured: { issuer: true, audience: true, operatorEmail: true, trustedDevices: 1 } }),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    const step = page.querySelector('[data-session-step]').textContent;
    assert.match(step, /issued for an Access application whose audience tag is not NEXUS_OPERATOR_ACCESS_AUD/);
    assert.match(page.textContent, /Audience claim\s*array form \(as Cloudflare documents\); is not the pinned audience/);
  } finally {
    t.cleanup();
  }
});

test('when the probe is silent but the edge names the session, the edge reading is shown', async () => {
  const t = mount({
    '/session/probe': html(500),
    '/cdn-cgi/access/get-identity': json({ common_name: CLIENT_ID, service_token_status: true }),
    '/api/ai/chat/operator-identity': html(404),
  });
  try {
    await settle();
    const page = t.container.querySelector('[data-session-check]');
    assert.equal(page.getAttribute('data-session-kind'), 'service-token');
    assert.match(page.textContent, /Dashboard probe\s*The dashboard probe answered 500/);
    const step = page.querySelector('[data-session-step]').textContent;
    assert.match(step, /travel shell's service-token session/);
    assert.ok(step.includes(`Add ${CLIENT_ID} to NEXUS_OPERATOR_DEVICE_IDS`));
  } finally {
    t.cleanup();
  }
});
