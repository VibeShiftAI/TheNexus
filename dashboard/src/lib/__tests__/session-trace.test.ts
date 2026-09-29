import test from "node:test";
import assert from "node:assert/strict";

import { TRACE_WINDOW_MS, clientFamily, createTraceState, describeRequestSession, pinsFromEnv, traceRequest } from "../session-trace.ts";

// Synthetic fixtures only, never a real token.
const CLIENT_ID = "0123456789abcdef0123456789abcdef.access";
const EMAIL = "operator@vibeshiftai.test";
const ISSUER = "https://team.cloudflareaccess.test";
const AUD = "aud-fixture-0123456789abcdef";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims)}.c2ln`;
const now = Math.floor(Date.now() / 1000);
const serviceToken = token({ iss: ISSUER, aud: [AUD], type: "app", iat: now - 60, exp: now + 3600, sub: "", common_name: CLIENT_ID });
const userToken = (email: string) => token({ iss: ISSUER, aud: [AUD], type: "app", iat: now - 60, exp: now + 3600, sub: "subject-uuid-1234", email });
const pins = pinsFromEnv({ NEXUS_OPERATOR_EMAIL: EMAIL, NEXUS_OPERATOR_ACCESS_AUD: AUD, NEXUS_OPERATOR_ACCESS_ISSUER: ISSUER });
const SHELL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const headers = (entries: Record<string, string>) => new Headers(entries);

test("the travel shell's page load traces as a Windows service-token session with fixed words only", () => {
  const line = describeRequestSession(headers({ "cf-access-jwt-assertion": serviceToken, "user-agent": SHELL_UA }), pins);
  assert.equal(line, "[SessionCheck] via=proxy client=windows assertion=present kind=service-token email=absent expired=no emailPin=n/a audience=match audShape=array issuer=match type=app sub=empty nbf=absent");
  const singleString = token({ iss: ISSUER, aud: AUD, type: "app", iat: now - 60, exp: now + 3600, sub: "", common_name: CLIENT_ID });
  assert.equal(describeRequestSession(headers({ "cf-access-jwt-assertion": singleString, "user-agent": SHELL_UA }), pins), "[SessionCheck] via=proxy client=windows assertion=present kind=service-token email=absent expired=no emailPin=n/a audience=match audShape=string issuer=match type=app sub=empty nbf=absent");
  const otherApp = token({ iss: ISSUER, aud: ["other-application"], type: "app", iat: now - 60, exp: now + 3600, sub: "", common_name: CLIENT_ID });
  assert.match(describeRequestSession(headers({ "cf-access-jwt-assertion": otherApp, "user-agent": SHELL_UA }), pins), / audience=mismatch audShape=array issuer=match /);
  for (const value of [CLIENT_ID, EMAIL, ISSUER, AUD, serviceToken.split(".")[1]]) assert.ok(!line.includes(value), `${value} never appears in the trace`);
});

test("a person's session traces its pin comparison without the address", () => {
  const matching = describeRequestSession(headers({ "cf-access-jwt-assertion": userToken(EMAIL), "user-agent": SHELL_UA }), pins);
  assert.equal(matching, "[SessionCheck] via=proxy client=windows assertion=present kind=user email=present expired=no emailPin=match audience=match audShape=array issuer=match type=app sub=present nbf=absent");
  const other = describeRequestSession(headers({ "cf-access-jwt-assertion": userToken("someone.else@vibeshiftai.test"), "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36" }), pins);
  assert.equal(other, "[SessionCheck] via=proxy client=android assertion=present kind=user email=present expired=no emailPin=mismatch audience=match audShape=array issuer=match type=app sub=present nbf=absent");
  assert.ok(!other.includes("someone"));
  const unpinned = describeRequestSession(headers({ "cf-access-jwt-assertion": userToken(EMAIL) }), pinsFromEnv({}));
  assert.match(unpinned, /client=other .*emailPin=unpinned audience=unpinned audShape=array issuer=unpinned type=app sub=present nbf=absent$/);
});

test("without an assertion the trace says only that, and garbage reads as unknown", () => {
  assert.equal(describeRequestSession(headers({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/605.1.15" }), pins), "[SessionCheck] via=proxy client=mac assertion=absent kind=none");
  assert.equal(describeRequestSession(headers({ "user-agent": "curl/8.7.1" }), pins), "[SessionCheck] via=proxy client=other assertion=absent kind=none");
  assert.equal(describeRequestSession(headers({ "cf-access-jwt-assertion": "a.b", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), pins), "[SessionCheck] via=proxy client=ios assertion=present kind=unknown email=absent expired=unknown emailPin=n/a audience=n/a audShape=absent issuer=n/a type=absent sub=absent nbf=absent");
  assert.equal(clientFamily(undefined), "other");
});

test("an identical reading is written once per window; a different reading is written at once", () => {
  const state = createTraceState();
  const shell = headers({ "cf-access-jwt-assertion": serviceToken, "user-agent": SHELL_UA });
  const start = 1_000_000;
  const first = traceRequest(shell, pins, state, start);
  assert.match(first ?? "", /kind=service-token/);
  assert.equal(traceRequest(shell, pins, state, start + 1_000), null, "same reading inside the window");
  assert.equal(traceRequest(shell, pins, state, start + TRACE_WINDOW_MS - 1), null);
  assert.match(traceRequest(shell, pins, state, start + TRACE_WINDOW_MS) ?? "", /kind=service-token/, "written again once the window has passed");
  const person = headers({ "cf-access-jwt-assertion": userToken(EMAIL), "user-agent": SHELL_UA });
  assert.match(traceRequest(person, pins, state, start + 2_000) ?? "", /kind=user/, "a different reading does not wait for the window");
  assert.equal(traceRequest(headers({ "user-agent": "curl/8.7.1" }), pins, state, start + 3_000), "[SessionCheck] via=proxy client=other assertion=absent kind=none");
  assert.equal(traceRequest(headers({ "user-agent": "curl/8.7.1" }), pins, state, start + 4_000), null);
});

test("the trace state stays bounded", () => {
  const state = createTraceState();
  const start = 5_000_000;
  for (let i = 0; i < 200; i += 1) {
    traceRequest(headers({ "user-agent": `agent-${i}` }), pins, state, start + i);
  }
  assert.ok(state.lastLogged.size <= 200);
  for (let i = 0; i < 200; i += 1) {
    traceRequest(headers({ "user-agent": `agent-${i} (Windows NT 10.0)` }), pins, state, start + TRACE_WINDOW_MS + 1_000 + i);
  }
  assert.ok(state.lastLogged.size <= 65, `stale readings are dropped once the map grows (size ${state.lastLogged.size})`);
});
