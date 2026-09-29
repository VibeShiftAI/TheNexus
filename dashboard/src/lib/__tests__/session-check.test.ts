import test from "node:test";
import assert from "node:assert/strict";

import {
  compareAssertion,
  describeAssertion,
  describeAudience,
  nextStep,
  summarizeAccessIdentity,
  summarizeOperatorIdentity,
  summarizeProbe,
  type AccessIdentitySummary,
  type AssertionSummary,
  type OperatorSummary,
  type ProbeSummary,
} from "../session-check.ts";

// Synthetic fixtures only: the same Client ID shape the server helper uses
// (server/__tests__/helpers/operator-access.js), never a real token.
const CLIENT_ID = "0123456789abcdef0123456789abcdef.access";
const EMAIL = "operator@vibeshiftai.test";
const SUBJECT = "subject-uuid-1234";
const ISSUER = "https://team.cloudflareaccess.test";
const AUD = "aud-fixture-0123456789abcdef";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims)}.c2ln`;
const now = Math.floor(Date.now() / 1000);
const serviceClaims = { iss: ISSUER, aud: [AUD], type: "app", iat: now - 60, exp: now + 3600, sub: "", common_name: CLIENT_ID };
const userClaims = { iss: ISSUER, aud: [AUD], type: "app", iat: now - 60, nbf: now - 60, exp: now + 3600, sub: SUBJECT, email: EMAIL };
const pins = { operatorEmail: EMAIL, audience: AUD, issuer: ISSUER };

test("an absent assertion is reported as no session", () => {
  const expected: AssertionSummary = { assertionPresent: false, kind: "none", emailPresent: false, commonNamePresent: false, clientId: null, expired: null };
  assert.deepEqual(describeAssertion(undefined), expected);
  assert.deepEqual(describeAssertion(null), expected);
  assert.deepEqual(describeAssertion(""), expected);
});

test("the travel shell's service-token session reads as service-token with its Client ID and nothing else", () => {
  const raw = token(serviceClaims);
  const summary = describeAssertion(raw);
  assert.deepEqual(summary, { assertionPresent: true, kind: "service-token", emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false });
  const printed = JSON.stringify(summary);
  assert.ok(!printed.includes(raw.split(".")[1]), "the claim segment never leaves the helper");
  assert.ok(!printed.includes("cloudflareaccess"), "issuer is not copied out");
});

test("a person's session reads as user, with no Client ID and no address or subject copied out", () => {
  const raw = token(userClaims);
  const summary = describeAssertion(raw);
  assert.deepEqual(summary, { assertionPresent: true, kind: "user", emailPresent: true, commonNamePresent: false, clientId: null, expired: false });
  const printed = JSON.stringify(summary);
  assert.ok(!printed.includes(EMAIL) && !printed.includes(SUBJECT), "no claim value in the summary");
});

test("an aged-out token is flagged, a malformed Client ID is withheld, garbage is unknown", () => {
  assert.equal(describeAssertion(token({ ...userClaims, exp: now - 5 })).expired, true);
  assert.equal(describeAssertion(token({ ...userClaims, exp: "soon" })).expired, null);
  const odd = describeAssertion(token({ ...serviceClaims, common_name: "x" }));
  assert.equal(odd.kind, "service-token");
  assert.equal(odd.clientId, null);
  for (const raw of ["abc", "a.b", "a.b.c.d", `${b64({})}.!!.c2ln`, `${b64({})}.${b64([1])}.c2ln`, `${b64({})}.${b64("s")}.c2ln`, "x".repeat(17_000)]) {
    const summary = describeAssertion(raw);
    assert.equal(summary.assertionPresent, true, raw.slice(0, 12));
    assert.equal(summary.kind, "unknown", raw.slice(0, 12));
    assert.equal(summary.clientId, null);
  }
  assert.equal(describeAssertion(token({ iat: now, exp: now + 10, sub: SUBJECT })).kind, "unknown", "neither email nor common_name");
});

test("the pin comparison says which server check an unverified token would fail, in fixed words only", () => {
  const device = compareAssertion(token(serviceClaims), pins);
  assert.deepEqual(device, { assertionPresent: true, kind: "service-token", emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false, emailPin: "n/a", audience: "match", audienceShape: "array", issuer: "match", tokenType: "app", subject: "empty", nbf: "absent" });

  const person = compareAssertion(token(userClaims), pins);
  assert.equal(person.emailPin, "match");
  assert.equal(compareAssertion(token({ ...userClaims, email: EMAIL.toUpperCase() }), pins).emailPin, "match", "the server lower-cases the address");
  assert.equal(compareAssertion(token({ ...userClaims, email: "someone.else@vibeshiftai.test" }), pins).emailPin, "mismatch");
  assert.equal(compareAssertion(token(userClaims), { ...pins, operatorEmail: "  " }).emailPin, "unpinned");

  assert.equal(compareAssertion(token({ ...serviceClaims, aud: ["other-application"] }), pins).audience, "mismatch");
  // 2026-09-26: the server accepts the pinned audience in RFC 7519 single-string form too; the form is reported beside the comparison.
  const single = compareAssertion(token({ ...serviceClaims, aud: AUD }), pins);
  assert.deepEqual([single.audience, single.audienceShape], ["match", "string"], "the pinned audience as a single string matches, and the form is named");
  assert.deepEqual((({ audience, audienceShape }) => [audience, audienceShape])(compareAssertion(token({ ...serviceClaims, aud: "other-application" }), pins)), ["mismatch", "string"]);
  assert.equal(compareAssertion(token({ ...serviceClaims, aud: [AUD, "second"] }), pins).audience, "match");
  assert.deepEqual((({ audience, audienceShape }) => [audience, audienceShape])(compareAssertion(token({ ...serviceClaims, aud: [] }), pins)), ["mismatch", "array"]);
  assert.deepEqual((({ audience, audienceShape }) => [audience, audienceShape])(compareAssertion(token({ ...serviceClaims, aud: 7 }), pins)), ["mismatch", "other"]);
  assert.deepEqual((({ audience, audienceShape }) => [audience, audienceShape])(compareAssertion(token({ ...serviceClaims, aud: undefined }), pins)), ["absent", "absent"]);
  assert.equal(compareAssertion(token(serviceClaims), { ...pins, audience: null }).audience, "unpinned");
  assert.equal(compareAssertion(token({ ...serviceClaims, aud: AUD }), { ...pins, audience: null }).audience, "unpinned");

  const profile = compareAssertion(token(userClaims), pins);
  assert.deepEqual([profile.tokenType, profile.subject, profile.nbf], ["app", "present", "present"]);
  assert.deepEqual((({ tokenType, subject, nbf }) => [tokenType, subject, nbf])(compareAssertion(token({ ...userClaims, type: "org", sub: 5, nbf: undefined }), pins)), ["other", "absent", "absent"]);
  assert.equal(compareAssertion(token({ ...userClaims, type: undefined }), pins).tokenType, "absent");

  assert.equal(compareAssertion(token({ ...serviceClaims, iss: "https://other.cloudflareaccess.test" }), pins).issuer, "mismatch");
  assert.equal(compareAssertion(token({ ...serviceClaims, iss: undefined }), pins).issuer, "absent");
  assert.equal(compareAssertion(token(serviceClaims), { ...pins, issuer: undefined }).issuer, "unpinned");

  const none = compareAssertion(null, pins);
  assert.deepEqual([none.assertionPresent, none.emailPin, none.audience, none.audienceShape, none.issuer, none.tokenType, none.subject, none.nbf], [false, "n/a", "n/a", "absent", "n/a", "absent", "absent", "absent"]);
  const garbage = compareAssertion("a.b", pins);
  assert.deepEqual([garbage.kind, garbage.emailPin, garbage.audience, garbage.issuer], ["unknown", "n/a", "n/a", "n/a"]);

  const printed = JSON.stringify([device, person]);
  for (const value of [EMAIL, "someone.else", SUBJECT, ISSUER, AUD]) assert.ok(!printed.includes(value), `${value} never leaves the comparison`);
});

test("the probe answer is read through a whitelist", () => {
  const good = { assertionPresent: true, kind: "service-token", emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false, extra: "dropped" };
  assert.deepEqual(summarizeProbe(200, good), { assertionPresent: true, kind: "service-token", emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false, available: true, status: 200, note: "", emailPin: null, audience: null, audienceShape: null, issuer: null, tokenType: null, subject: null, nbf: null });
  const compared = summarizeProbe(200, { ...good, emailPin: "n/a", audience: "match", audienceShape: "string", issuer: "match", tokenType: "app", subject: "empty", nbf: "absent" });
  assert.deepEqual([compared.emailPin, compared.audience, compared.audienceShape, compared.issuer, compared.tokenType, compared.subject, compared.nbf], ["n/a", "match", "string", "match", "app", "empty", "absent"]);
  const odd = summarizeProbe(200, { ...good, audience: "MATCH", audienceShape: ["array"], issuer: 1, tokenType: "<b>", subject: "root", nbf: true });
  assert.deepEqual([odd.audience, odd.audienceShape, odd.issuer, odd.tokenType, odd.subject, odd.nbf], [null, null, null, null, null, null], "only the fixed words pass");
  assert.equal(summarizeProbe(200, { ...good, kind: "operator" }).kind, "none");
  assert.equal(summarizeProbe(200, { ...good, kind: "user" }).clientId, null, "a Client ID only rides with a service-token kind");
  assert.equal(summarizeProbe(200, { ...good, clientId: "<script>" }).clientId, null);
});

test("a probe that did not answer is undetermined, never an observed absent session", () => {
  for (const [status, body] of [[0, null], [404, good404()], [500, { error: "boom" }], [200, "nope"], [200, { kind: "none" }]] as Array<[number, unknown]>) {
    const summary = summarizeProbe(status, body);
    assert.equal(summary.available, false, `status ${status}`);
    assert.equal(summary.status, status);
    assert.equal(summary.kind, "unknown", `status ${status} does not read as none`);
    assert.equal(summary.clientId, null);
    assert.match(summary.note, /cannot tell whether an Access session is present/);
  }
  assert.match(summarizeProbe(0, null).note, /could not be reached/);
  assert.match(summarizeProbe(502, null).note, /answered 502/);
  assert.equal(summarizeProbe(0, null).audienceShape, null);
  function good404() { return "<html>not found</html>"; }
});

test("the audience row says the form of the claim and its relation to the pin, in fixed words", () => {
  assert.equal(describeAudience("string", "match"), "single-string form (RFC 7519); equals the pinned audience");
  assert.equal(describeAudience("array", "mismatch"), "array form (as Cloudflare documents); is not the pinned audience");
  assert.equal(describeAudience("array", "match"), "array form (as Cloudflare documents); equals the pinned audience");
  assert.equal(describeAudience("string", "unpinned"), "single-string form (RFC 7519); no audience is pinned in the dashboard process");
  assert.equal(describeAudience("absent", "absent"), "absent from the token");
  assert.equal(describeAudience("other", "mismatch"), "of an unexpected type");
  assert.equal(describeAudience(null, null), "not reported by the probe");
});

test("Cloudflare's get-identity answers reduce to a session kind", () => {
  const noCookie = summarizeAccessIdentity(401, { err: "no app token set" });
  assert.equal(noCookie.kind, "none");
  assert.match(noCookie.note, /no Access session cookie/);
  assert.equal(summarizeAccessIdentity(200, { err: "other" }).kind, "none");
  const mac = summarizeAccessIdentity(404, null);
  assert.equal(mac.kind, "none");
  assert.match(mac.note, /localhost:3000/);
  assert.match(summarizeAccessIdentity(0, null).note, /could not be reached/);
  assert.match(summarizeAccessIdentity(502, null).note, /502/);

  const person = summarizeAccessIdentity(200, { email: EMAIL, name: "Robert", idp: { type: "onetimepin" }, user_uuid: SUBJECT });
  assert.equal(person.kind, "user");
  assert.equal(person.email, EMAIL);
  assert.equal(person.clientId, null);
  assert.ok(!JSON.stringify(person).includes(SUBJECT));

  const device = summarizeAccessIdentity(200, { common_name: CLIENT_ID, service_token_status: true, service_token_id: "uuid", email: "" });
  assert.equal(device.kind, "service-token");
  assert.equal(device.clientId, CLIENT_ID);
  assert.equal(device.email, null);
  assert.equal(summarizeAccessIdentity(200, { service_token_id: "uuid" }).kind, "service-token");
  assert.equal(summarizeAccessIdentity(200, { service_token_id: "uuid" }).clientId, null);
  assert.equal(summarizeAccessIdentity(200, {}).kind, "unknown");
  assert.equal(summarizeAccessIdentity(200, [1]).kind, "none");
});

test("the Nexus self-check answer is read through a whitelist of fixed names", () => {
  assert.equal(summarizeOperatorIdentity(404, "<html>").state, "route-missing");
  assert.match(summarizeOperatorIdentity(404, null).note, /before this check existed/);
  assert.equal(summarizeOperatorIdentity(403, { error: "x" }).state, "cross-site");
  assert.equal(summarizeOperatorIdentity(503, { error: "x" }).state, "unavailable");
  assert.equal(summarizeOperatorIdentity(0, null).state, "unreachable");
  assert.equal(summarizeOperatorIdentity(500, { operator: true }).state, "unexpected");
  assert.equal(summarizeOperatorIdentity(200, null).state, "unexpected");

  const ok = summarizeOperatorIdentity(200, {
    operator: true, identity: "device", reason: "ok", assertionPresent: true,
    configured: { issuer: true, audience: true, operatorEmail: true, trustedDevices: 1 },
  });
  assert.equal(ok.state, "ok");
  assert.equal(ok.identity, "device");
  assert.equal(ok.reason, "ok");
  assert.equal(ok.check, null);
  assert.equal(ok.trustedDevices, 1);
  assert.equal(ok.configured, true);

  const refused = summarizeOperatorIdentity(200, {
    operator: false, identity: null, reason: "claim-rejected", check: "service-identity", assertionPresent: true,
    configured: { issuer: true, audience: true, operatorEmail: false, trustedDevices: 0 },
  });
  assert.equal(refused.state, "refused");
  assert.equal(refused.check, "service-identity");
  assert.equal(refused.configured, false);
  assert.equal(refused.operator, false);

  const odd = summarizeOperatorIdentity(200, { operator: "yes", identity: "root", reason: "Claim Rejected!", check: "<b>", configured: "all" });
  assert.equal(odd.operator, false);
  assert.equal(odd.identity, null);
  assert.equal(odd.reason, null);
  assert.equal(odd.check, null);
  assert.equal(odd.configured, null);
  assert.equal(odd.trustedDevices, null);
});

const probeOf = (over: Partial<ProbeSummary> = {}): ProbeSummary => ({ assertionPresent: false, kind: "none", emailPresent: false, commonNamePresent: false, clientId: null, expired: null, available: true, status: 200, note: "", emailPin: null, audience: null, audienceShape: null, issuer: null, tokenType: null, subject: null, nbf: null, ...over });
const noProbe = (): ProbeSummary => summarizeProbe(0, null);
const accessOf = (over: Partial<AccessIdentitySummary> = {}): AccessIdentitySummary => ({ status: 200, kind: "none", email: null, clientId: null, note: "", ...over });
const operatorOf = (over: Partial<OperatorSummary> = {}): OperatorSummary => ({ status: 200, state: "refused", operator: false, identity: null, reason: "claim-rejected", check: null, assertionPresent: true, trustedDevices: 0, configured: true, note: "", ...over });

test("the next step names the one setting to change, with the session's own Client ID or address", () => {
  assert.match(nextStep(probeOf(), accessOf(), operatorOf({ state: "ok", operator: true, identity: "device", reason: "ok" })), /^Nothing to do/);

  const service = probeOf({ assertionPresent: true, kind: "service-token", commonNamePresent: true, clientId: CLIENT_ID, expired: false });
  const unpinned = nextStep(service, accessOf(), operatorOf({ check: "service-identity" }));
  assert.match(unpinned, /service-identity/);
  assert.ok(unpinned.includes(`Add ${CLIENT_ID} to NEXUS_OPERATOR_DEVICE_IDS`));
  assert.match(unpinned, /reload the Nexus child once/);
  assert.match(nextStep(service, accessOf(), operatorOf({ check: "service-identity", trustedDevices: 1 })), /a different Client ID is pinned/);
  assert.match(nextStep(probeOf({ assertionPresent: true, kind: "service-token", commonNamePresent: true }), accessOf(), operatorOf({ check: "service-identity" })), /access-token\.json/);

  const person = nextStep(probeOf({ assertionPresent: true, kind: "user", emailPresent: true }), accessOf({ kind: "user", email: EMAIL }), operatorOf({ check: "identity-email" }));
  assert.match(person, /identity-email/);
  assert.ok(person.includes(`(${EMAIL})`));
  assert.match(person, /NEXUS_OPERATOR_EMAIL/);

  assert.match(nextStep(probeOf(), accessOf(), operatorOf({ reason: "assertion-missing" })), /Mac app \(localhost\) that is expected/);
  assert.match(nextStep(probeOf(), accessOf(), operatorOf({ reason: "config-missing" })), /operator pins/);
  assert.match(nextStep(probeOf(), accessOf(), operatorOf({ reason: "key-fetch-failed" })), /30 seconds/);
  assert.match(nextStep(service, accessOf(), operatorOf({ reason: "claim-rejected", check: "executor-headers" })), /machine credentials/);
  assert.match(nextStep(service, accessOf(), operatorOf({ check: "audience" })), /Refused at check audience: the session token failed a profile check/);
  assert.match(nextStep(service, accessOf(), operatorOf({ check: null })), /does not recognize/);
});

test("an audience refusal is explained from the form of the claim: a reload for the single-string form, a pin for another application", () => {
  const audience = operatorOf({ check: "audience", trustedDevices: 1 });
  const singleString = nextStep(probeOf({ assertionPresent: true, kind: "service-token", commonNamePresent: true, clientId: CLIENT_ID, expired: false, audience: "match", audienceShape: "string", issuer: "match" }), accessOf(), audience);
  assert.match(singleString, /^Refused at check audience: this session's token carries the pinned audience as a single string/);
  assert.match(singleString, /No pin needs changing: reload the Nexus child once/);
  assert.doesNotMatch(singleString, /NEXUS_OPERATOR_ACCESS_AUD|Zero Trust/);
  const otherApp = nextStep(probeOf({ assertionPresent: true, kind: "service-token", commonNamePresent: true, clientId: CLIENT_ID, expired: false, audience: "mismatch", audienceShape: "array", issuer: "match" }), accessOf(), audience);
  assert.match(otherApp, /^Refused at check audience: this token was issued for an Access application/);
  assert.match(otherApp, /NEXUS_OPERATOR_ACCESS_AUD/);
  assert.match(otherApp, /Zero Trust/);
  assert.match(nextStep(probeOf({ assertionPresent: true, kind: "service-token", commonNamePresent: true, clientId: CLIENT_ID, expired: false, audience: "match", audienceShape: "array", issuer: "match" }), accessOf(), audience), /failed a profile check/, "array and match is the old child's rule already met; the generic text stands");
  assert.match(nextStep(noProbe(), accessOf({ kind: "service-token", clientId: CLIENT_ID }), audience), /failed a profile check/, "no probe reading, no explanation");
  for (const text of [singleString, otherApp]) for (const value of [CLIENT_ID, AUD, ISSUER]) assert.ok(!text.includes(value), `${value} never appears`);
});

test("before the Nexus reload, the edge reading alone still names the step", () => {
  const missing = operatorOf({ status: 404, state: "route-missing", reason: null, assertionPresent: null, trustedDevices: null, configured: null });
  const fromEdge = nextStep(probeOf(), accessOf({ kind: "service-token", clientId: CLIENT_ID }), missing);
  assert.match(fromEdge, /travel shell's service-token session/);
  assert.ok(fromEdge.includes(CLIENT_ID));
  assert.match(nextStep(probeOf(), accessOf({ kind: "user", email: EMAIL }), missing), /person's Access session/);
  assert.match(nextStep(probeOf(), accessOf({ kind: "none" }), missing), /No Access session on this origin/);
  assert.match(nextStep(probeOf(), accessOf({ kind: "unknown" }), missing), /Reload the Nexus child once/);
  assert.equal(nextStep(probeOf(), accessOf(), operatorOf({ state: "unreachable", note: "The Nexus API did not answer." })), "The Nexus API did not answer.");
});

test("an unanswered probe never turns into 'no Access session' in the next step", () => {
  const missing = operatorOf({ status: 404, state: "route-missing", reason: null, assertionPresent: null, trustedDevices: null, configured: null, note: "The Nexus API is still running code from before this check existed." });
  const undetermined = nextStep(noProbe(), accessOf({ kind: "none" }), missing);
  assert.match(undetermined, /could not be reached/);
  assert.match(undetermined, /Check again/);
  assert.doesNotMatch(undetermined, /No Access session/);
  assert.match(nextStep(noProbe(), accessOf({ kind: "service-token", clientId: CLIENT_ID }), missing), /travel shell's service-token session/, "the edge reading still speaks when the probe cannot");
  assert.match(nextStep(noProbe(), accessOf({ kind: "user", email: EMAIL }), missing), /person's Access session/);
  const unexpected = nextStep(noProbe(), accessOf({ kind: "none" }), operatorOf({ status: 500, state: "unexpected", note: "The Nexus API answered 500 without a verdict." }));
  assert.match(unexpected, /could not be reached/);
  assert.match(unexpected, /answered 500/);
  assert.match(nextStep(noProbe(), accessOf({ kind: "service-token", clientId: CLIENT_ID }), operatorOf({ check: "service-identity" })), /service-identity/, "a verdict outranks a silent probe");
});
