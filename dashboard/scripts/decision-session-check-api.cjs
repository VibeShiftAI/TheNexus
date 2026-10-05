#!/usr/bin/env node
/**
 * Isolated Nexus API for scripts/decision-session-browser-check.mjs (task
 * a1cc8616, 2026-10-04): the real server (server/server.js, so the same
 * mounting, the same req.user stamping, the same documents router, decision
 * authority and Access verifier) on a temporary SQLite database, with:
 *
 *   - a synthetic Cloudflare Access issuer: the verifier's only outbound call,
 *     the signing-key fetch for the pinned issuer, is answered in-process from
 *     a throwaway RSA key pair (server/__tests__/helpers/operator-access.js).
 *     The pins are the fixture's, never the host's, and the two session
 *     tokens are written to files in the temp dir, not printed;
 *   - the operator credential unset, as on the host where the refusal happened;
 *   - a synthetic Praxis receiver on the next port that accepts the review
 *     relay and answers it, so Finish review reaches "delivered" without
 *     Praxis, mail or a real conversation (it lists what it received at
 *     GET /__relays);
 *   - one synthetic brief registered as a declared deliverable under a temp
 *     project root.
 *
 * Nothing here touches the live nexus.db, :4000, :3000 or Praxis. The fleet
 * env is still loaded by server.js (process env wins), so model discovery at
 * boot may list providers as the live server does; no other outbound call is
 * made by the checked flow.
 *
 *   node scripts/decision-session-check-api.cjs            # prints CHECK_* lines, keeps serving
 *
 * Env: CHECK_API_PORT (4299), CHECK_PRAXIS_PORT (CHECK_API_PORT + 1),
 * CHECK_API_DIR (a fresh directory under os.tmpdir() unless given).
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.CHECK_API_PORT || 4299);
const PRAXIS_PORT = Number(process.env.CHECK_PRAXIS_PORT || PORT + 1);
// realpath: the documents router checks a project root lexically before resolving it,
// and macOS /tmp is a symlink to /private/tmp.
const dir = fs.realpathSync.native(process.env.CHECK_API_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "nexus-decision-check-")));
fs.mkdirSync(path.join(dir, "docs"), { recursive: true });

// Fixture issuer, audience, operator email and one trusted device; set before
// server.js loads the env files, which never override a value already present.
const access = require(path.join(REPO, "server", "__tests__", "helpers", "operator-access"));
access.configure({ deviceIds: access.deviceId });
process.env.NEXUS_OPERATOR_APPROVAL_KEY = "";
process.env.PORT = String(PORT);
process.env.NEXUS_DB_PATH = path.join(dir, "nexus.db");
process.env.PRAXIS_URL = `http://127.0.0.1:${PRAXIS_PORT}`;
process.env.PROJECT_ROOT = dir;

// The verifier fetches `${issuer}/cdn-cgi/access/certs`; answer that one URL from the fixture keys.
const certsUrl = `${access.issuer}/cdn-cgi/access/certs`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url) === certsUrl
    ? Promise.resolve(new Response(JSON.stringify(access.jwks), { status: 200, headers: { "content-type": "application/json" } }))
    : nativeFetch(url, init));

// Synthetic Praxis: accepts the keyed review relay (POST /api/chat) and nothing else.
const relays = [];
const praxis = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/chat") {
            relays.push({ at: new Date().toISOString(), idempotencyKey: req.headers["idempotency-key"] || null, bytes: body.length });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ response: "Synthetic receiver: review received; nothing was done with it.", duplicate: false }));
            return;
        }
        if (req.method === "GET" && req.url === "/__relays") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(relays));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "synthetic praxis receiver: not here" }));
    });
});
praxis.listen(PRAXIS_PORT, "127.0.0.1");

const now = Math.floor(Date.now() / 1000);
fs.writeFileSync(path.join(dir, "operator-session.jwt"), access.token({ exp: now + 3600 }), { mode: 0o600 });
fs.writeFileSync(path.join(dir, "device-session.jwt"), access.serviceToken({ exp: now + 3600 }), { mode: 0o600 });

const BRIEF = [
    "# Synthetic client brief (verification fixture)",
    "",
    "This file exists only for scripts/decision-session-browser-check.mjs. It is not a client document.",
    "",
    "## Documents on file",
    "",
    "| Identity | Status |",
    "| --- | --- |",
    "| Intake form | received |",
    "| Prior-year statement | received |",
    "| Engagement letter | pending |",
    "",
    "## Next step",
    "",
    "Summarise what each document establishes rather than listing which documents exist.",
    "",
].join("\n");
const briefPath = path.join(dir, "docs", "synthetic-client-brief.md");
fs.writeFileSync(briefPath, BRIEF);

require(path.join(REPO, "server", "server.js"));
const db = require(path.join(REPO, "db"));

async function waitForApi() {
    for (let i = 0; i < 100; i++) {
        try {
            const res = await nativeFetch(`http://127.0.0.1:${PORT}/api/health`);
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the API did not come up on :${PORT}`);
}

(async () => {
    await waitForApi();
    const project = await db.upsertProject({ name: "decision-session-check", description: "throwaway project for scripts/decision-session-browser-check.mjs", type: "tool", path: dir, tasks_list: [] });
    if (!project?.id) throw new Error("could not create the throwaway project");
    let taskId = null;
    try {
        const task = await db.createTask({ project_id: project.id, name: "Draft the synthetic client brief", description: "verification fixture", status: "completed", priority: 2 });
        taskId = task?.id || null;
    } catch (err) {
        console.error(`(no source task: ${err?.message || err})`);
    }
    const res = await nativeFetch(`http://127.0.0.1:${PORT}/api/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            path: briefPath, title: "Synthetic client brief", project_id: project.id, ...(taskId ? { task_id: taskId } : {}), kind: "document",
            deliverable: { requires_review: true, purpose: "Decide whether the synthetic brief can go to the (fictional) client", intended_action: "send" },
        }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`register failed: ${res.status} ${JSON.stringify(body)}`);
    console.log(`CHECK_DIR=${dir}`);
    console.log(`CHECK_DOC=${body.document.id}`);
    console.log(`CHECK_FILE=${briefPath}`);
    console.log(`CHECK_API=http://127.0.0.1:${PORT}`);
    console.log(`CHECK_PRAXIS=http://127.0.0.1:${PRAXIS_PORT}`);
    console.log("CHECK_READY=1 (Ctrl-C to stop; the temp dir holds the database, the fixture and the two session tokens)");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
