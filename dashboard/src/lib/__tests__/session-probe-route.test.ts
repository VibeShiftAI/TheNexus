import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../app/session/probe/route.ts";

const CLIENT_ID = "0123456789abcdef0123456789abcdef.access";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const ISSUER = "https://team.cloudflareaccess.test";
const AUD = "aud-fixture-0123456789abcdef";
const claims = (aud: unknown) => ({ iss: ISSUER, aud, type: "app", iat: now - 60, exp: now + 3600, sub: "", common_name: CLIENT_ID });
const serviceToken = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims([AUD]))}.c2ln`;
const singleStringToken = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims(AUD))}.c2ln`;
const comparison = { emailPin: "n/a", audience: "match", audienceShape: "array", issuer: "match", tokenType: "app", subject: "empty", nbf: "absent" };

function pinned<T>(run: () => Promise<T>): Promise<T> {
  const previous = { aud: process.env.NEXUS_OPERATOR_ACCESS_AUD, iss: process.env.NEXUS_OPERATOR_ACCESS_ISSUER, email: process.env.NEXUS_OPERATOR_EMAIL };
  process.env.NEXUS_OPERATOR_ACCESS_AUD = AUD;
  process.env.NEXUS_OPERATOR_ACCESS_ISSUER = ISSUER;
  process.env.NEXUS_OPERATOR_EMAIL = "operator@vibeshiftai.test";
  return run().finally(() => {
    for (const [name, value] of [["NEXUS_OPERATOR_ACCESS_AUD", previous.aud], ["NEXUS_OPERATOR_ACCESS_ISSUER", previous.iss], ["NEXUS_OPERATOR_EMAIL", previous.email]] as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

function capture() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore() { console.log = original; } };
}

test("the probe names the session kind and the pin comparison from the forwarded assertion and logs fixed strings only", async () => {
  const log = capture();
  try {
    await pinned(async () => {
      const response = await GET(new Request("http://localhost/session/probe", { headers: { "cf-access-jwt-assertion": serviceToken, "sec-fetch-site": "same-origin" } }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.deepEqual(body, { assertionPresent: true, kind: "service-token", emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false, ...comparison });
      const single = await (await GET(new Request("http://localhost/session/probe", { headers: { "cf-access-jwt-assertion": singleStringToken } }))).json();
      assert.deepEqual(single, { assertionPresent: true, kind: "service-token", emailPresent: false, commonNamePresent: true, clientId: CLIENT_ID, expired: false, ...comparison, audienceShape: "string" });
      for (const value of [AUD, ISSUER, serviceToken.split(".")[1]]) assert.ok(!JSON.stringify([body, single, log.lines]).includes(value), `${value} never leaves the probe`);
    });
    assert.deepEqual(log.lines, [
      "[SessionCheck] assertion=present kind=service-token audience=match audShape=array issuer=match type=app sub=empty nbf=absent",
      "[SessionCheck] assertion=present kind=service-token audience=match audShape=string issuer=match type=app sub=empty nbf=absent",
    ]);
  } finally {
    log.restore();
  }
});

test("without pins in the dashboard process the probe says unpinned rather than guessing", async () => {
  const log = capture();
  try {
    const previous = { aud: process.env.NEXUS_OPERATOR_ACCESS_AUD, iss: process.env.NEXUS_OPERATOR_ACCESS_ISSUER };
    delete process.env.NEXUS_OPERATOR_ACCESS_AUD;
    delete process.env.NEXUS_OPERATOR_ACCESS_ISSUER;
    try {
      const body = await (await GET(new Request("http://localhost/session/probe", { headers: { "cf-access-jwt-assertion": serviceToken } }))).json();
      assert.deepEqual([body.audience, body.audienceShape, body.issuer], ["unpinned", "array", "unpinned"]);
    } finally {
      if (previous.aud !== undefined) process.env.NEXUS_OPERATOR_ACCESS_AUD = previous.aud;
      if (previous.iss !== undefined) process.env.NEXUS_OPERATOR_ACCESS_ISSUER = previous.iss;
    }
    assert.deepEqual(log.lines, ["[SessionCheck] assertion=present kind=service-token audience=unpinned audShape=array issuer=unpinned type=app sub=empty nbf=absent"]);
  } finally {
    log.restore();
  }
});

test("without a session the probe says so, and a cross-site request is refused", async () => {
  const log = capture();
  try {
    const anonymous = await GET(new Request("http://localhost/session/probe"));
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), { assertionPresent: false, kind: "none", emailPresent: false, commonNamePresent: false, clientId: null, expired: null, emailPin: "n/a", audience: "n/a", audienceShape: "absent", issuer: "n/a", tokenType: "absent", subject: "absent", nbf: "absent" });
    const crossSite = await GET(new Request("http://localhost/session/probe", { headers: { "cf-access-jwt-assertion": serviceToken, "sec-fetch-site": "cross-site" } }));
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers.get("cache-control"), "no-store");
    assert.deepEqual(log.lines, ["[SessionCheck] assertion=absent kind=none"], "a refused request logs nothing");
  } finally {
    log.restore();
  }
});
