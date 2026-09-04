# The Nexus — MCP Boundary Threat Model & Requirements

**Status:** drafted 2026-08-12 (Nexus task `17c118c3` — "Threat-model the MCP boundary";
knowledge-routing 2026-08-04, `shared-mind/memories/note_knowledge_council_2026-08-04.md`).
**Scope:** the trust boundary where a coding-agent (Claude / Codex / Antigravity) session, or a
remote dashboard viewer, reaches Nexus/Praxis state through an MCP or MCP-adjacent surface.
**Source findings (why now):** four items surfaced together in overnight ingestion and were routed
to this project — (1) the **MCP 2026-07-28 specification** (stateless redesign, Streamable HTTP,
removal of `Mcp-Session-Id`, RFC 9207); (2) **Enterprise-Managed Authorization** (centralized authz
that *secures* MCP, adopted by Microsoft); (3) the **official MCP authorization / audit / migration
spec** (the council explicitly wanted primary specs, "not secondary security summaries"); and
(4) **NIST post-quantum cryptography** standardization, which MCP guidance now treats as a
requirement for AI-infrastructure security. These are the lenses; the requirements below are what
they imply for *this* codebase.
**Prior decisions this respects:** the single-server topology decision
(`shared-mind/memories/project_mcp_topology_decision_2026-07-11.md` — keep praxis-mind as the one
agent-facing MCP server; split only on trust/credential/lifecycle boundaries, never per domain) and
the authority-laundering trust boundaries already shipped
(`services/praxis-mind-mcp/lib/provenance.js`).

This document is a **threat model and a requirements register**, not an implementation. Per
`docs/verification-protocol.md`, every conceptual/security goal is written as a **verifiable
acceptance assertion** so each requirement is dispatchable as its own task.

---

## 1. The boundary as it exists today

There are three MCP-or-MCP-adjacent surfaces on this machine. Only the first is what "the
praxis-mind MCP surface every session rides" refers to.

### Surface A — `praxis-mind` MCP server (primary, agent-facing)
`services/praxis-mind-mcp/` · stdio transport · ephemeral spawn per MCP client.

- **Transport:** stdio only. The process is spawned by the client (Claude Code / Codex) from
  `~/.claude.json` `mcpServers.praxis-mind`; JSON-RPC rides stdin/stdout, diagnostics to stderr
  (`stdio.js`). No network listener — the boundary is a local pipe.
- **Identity:** a single static bearer secret, `PRAXIS_MIND_KEY`, passed as an env var by the
  client config and resolved against `~/.praxis-mind/keys.json` (chmod 600) in `lib/auth.js`.
  The key *is* the identity: it maps to `{ identity, namespace, privileges,
  rate_limits_per_hour, daily_cap_usd }`. Three identities exist today — `claude`, `codex`,
  `antigravity` — and **all three currently hold an identical privilege set**, including every
  write tool.
- **Authorization:** per-tool privilege check (`checkPrivilege`) plus per-caller/per-tool/per-hour
  rate limits (`lib/ratelimit.js`, counter in WAL sqlite). `nexus_project_update` falls back from
  `nexus.project_update` to the `nexus.task_update` privilege when the dedicated one is absent.
- **Read trust:** retrieved content is rendered through `lib/provenance.js`, which stamps an
  authority ceiling and quotes untrusted/external bodies (monotonic-downgrade, never upgrade).
- **Write integrity & audit:** the five write tools (`vault_write`, `memory_write`,
  `nexus_task_create`, `nexus_task_update`, `nexus_project_update`) run inside
  `lib/transactions.js` (`executeTransaction`: capture -> precondition -> apply -> read-back ->
  verify) and always append one terminal record to an append-only JSONL transition log
  (`lib/transition-log.js`, dir 0700 / file 0600, `fsync`ed). A separate cost ledger
  (`lib/ledger.js`) records every call (caller, tool, tokens, cost, latency, success).

### Surface B — Nexus HTTP API + tunnel (remote-reachable)
`server/server.js` · Express on `:4000` · exposed at `nexus.vibeshiftai.com` via cloudflared.

- Not an MCP server, but it is the **same board state** the MCP write tools mutate, reachable over
  the network. Binds the default interface (`server.listen(PORT)` with no host arg) and is fronted
  by a Cloudflare tunnel (`~/.cloudflared/config.yml`) for `/api/*`, `/socket.io`, `/graph`.
- **Application-layer auth is a stub:** `authenticate()` assigns *every* request
  `{ id: 'local_user', role: 'admin' }` — there is no token, session, or user check in the app.
  All confidentiality/authorization for the remote path is delegated to **Cloudflare Access at the
  edge** (the config comments state the site is deliberately not launched publicly and each
  hostname requires an Access app + Service Auth policy before its DNS route). `/api/ai/usage` and
  `/api/system/status` are explicitly public.
- The `/api/mcp/*` routes (`routes/mcp-inline.js`, `routes/mcp-scopes.js`) are **MCP-server
  *management* endpoints** (register servers, define OAuth-style scope templates) that store to an
  in-memory `Map` and sit behind the same stub `authenticate`.

### Surface C — Praxis agent-tool bridge (loopback, this run uses it)
`Praxis/src/webhook.ts` `/agent-tool` + `/agent-tools` · HTTP on `:54322` · loopback-only.

- Hands an HTTP caller Praxis's real toolset, but is **scoped** (`Praxis/src/agent-bridge-policy.ts`):
  no token -> `readonly` allowlist with action-level narrowing; correct `X-Praxis-Bridge-Token`
  -> `full` minus a self-management denylist. Loopback enforced (`isLoopbackRequest`). This is the
  read-only subset a dispatched executor (like this task run) is served.

### Retired surface — `server/mcp.js` ("Local Nexus" stdio MCP)
**Retired 2026-09-04 (ticket M-1).** The 11-tool stdio server never had a configured client
(re-checked 2026-09-04: not in `~/.claude.json`, `~/.codex/config.toml`, Claude Desktop,
`~/.antigravity`, any `.mcp.json`, or Praxis `mcp-servers.json`; not mounted by
`server/server.js`). Rather than keep a gated-but-dead surface, the file, its `npm run mcp`
script, and the three tests that only exercised it (`mcp-stateless-conformance`,
`mcp-board-governance`, `mcp-tool-gating`) were moved to `/Volumes/Projects/Backup/TheNexus-server-mcp-2026-09-04/`. The four privileges it alone
consumed (`nexus.scaffold`, `nexus.git_write`, `nexus.git_read`, `nexus.system_read`) were
dropped from `lib/auth.js` `PRIVILEGES`; no key ever held them. The governed board
implementation it delegated to (`lib/board-ops.js`, P1-15) stays — praxis-mind is its only
caller now. Coverage that those suites carried for the live surface was ported to
`server/__tests__/praxis-mind-board-governance.test.js` and
`server/__tests__/praxis-mind-stateless-conformance.test.js`.

---

## 2. Assets, actors, trust zones

**Assets:** the Nexus board (projects, tasks, dispatch payloads = executable instructions to the
fleet); the shared-mind vault (operator-authored SOUL/USER/CONTEXT, agent memory); Cortex memory;
the Praxis LLM cascade (spend); the audit/transition logs and cost ledger; the secrets themselves
(`PRAXIS_MIND_KEY`, `CORTEX_GATEWAY_KEY`, bridge token, Cloudflare service tokens).

**Actors, by trust zone:**
1. **Operator (Robert)** — full authority; the only source of `operator`-tier content.
2. **Praxis himself** on a CLI — full bridge scope; schedules and advances the board.
3. **Dispatched coding-agent session** — holds `bypassPermissions` locally *and* a praxis-mind
   key. This is the primary in-scope adversary model: **not malicious by intent, but drivable by
   untrusted content** (a planted vault doc, a task description, tool output) into taking actions
   its identity is authorized for. Prompt-injection turns a trusted identity into a confused deputy.
4. **Remote dashboard viewer** — reaches Surface B; gated only by Cloudflare Access.
5. **Local non-root process / other user** — can read any file the login user can, including the
   plaintext keys, if filesystem permissions slip.
6. **Network / future quantum adversary** — can capture tunnel traffic now to decrypt later
   (harvest-now-decrypt-later), the PQC-relevant actor.

---

## 3. Threats (STRIDE over the boundary)

| # | Threat (STRIDE) | Surface | Current mitigation | Residual gap |
|---|---|---|---|---|
| T1 | **Spoofing** identity: static bearer key is the only proof; whoever reads `keys.json` / `.claude.json` *is* that agent | A | file perms 0600; key-per-agent | No expiry, no rotation, no per-session binding, symmetric secret; a leaked key is a permanent forgeable identity (**G1, G2**) |
| T2 | **Elevation**: all three agents share one privilege set incl. writes; least-privilege is nominal | A | privilege list exists in `keys.json` | Read-only reviewers can create/mutate board work and rewrite the vault; no read-only identity exists (**G3**) |
| T3 | **Confused deputy / tampering**: injected content steers a trusted session into an authorized write | A/B | provenance ceiling on *reads*; transaction verify on *writes* | Provenance labels the input but does not *gate the write* — an authorized identity may still act on advisory content; no dangerous-action confirmation (**G4**) |
| T4 | **Repudiation / audit gaps**: an action lands with no attributable record | A | transition log + cost ledger, both caller-stamped | Reads are not audited; Surface B mutations bypass the transition log entirely (direct HTTP, no envelope) and all attribute to `local_user` (**G5, G6**) |
| T5 | **DoS / resource exhaustion**: runaway loop or cost blowout | A | rate limits on brain/memory/vault-write; `daily_cap_usd` field | Board-write tools have **no effective rate limit** (no `rate_limits_per_hour` entry -> `checkAndIncrement` no-ops); `daily_cap_usd` is **computed but never enforced** (**G7, G8**) |
| T6 | **Info disclosure / spoofing at the edge**: remote board access with a stub app-auth | B | Cloudflare Access + loopback intent | Entire remote authz is one edge control with no app-layer defense in depth; a tunnel/Access misconfig exposes an admin-everything API (**G9**) |
| T7 | **Harvest-now-decrypt-later**: classical TLS on the tunnel; long-lived secrets in transit/at rest | B/A | TLS 1.3 at edge | No PQC/hybrid KEX posture; long-lived static secrets maximize the value of a later decrypt (**G10**) |
| T8 | **Latent surface**: `server/mcp.js` scaffolds projects and mutates the board | C(retired) | **Retired 2026-09-04 (M-1)** — file removed from the tree, archived at `/Volumes/Projects/Backup/TheNexus-server-mcp-2026-09-04/` | None; the surface no longer exists (**G11** closed) |

---

## 4. Requirements

Each requirement has an ID, the finding(s) it answers, and a **verifiable acceptance assertion**
(the condition a task's QA can hold a diff against). Priority: **P0** = close a live gap now,
**P1** = required before the remote/enterprise surface widens, **P2** = migration-horizon.

### 4.1 Identity (ID)

- **ID-1 (P0) — Least-privilege identities.** The three agent keys must stop sharing one privilege
  set; introduce at minimum a `readonly` identity (no `*.write`, no `nexus.task_*`/`project_update`)
  for QA/review dispatches.
  *Accept:* a test loads a `readonly` caller and asserts every write tool returns `isError` with a
  privilege-denied message, while read tools succeed. Findings: enterprise-authz, MCP-2026.
- **ID-2 (P1) — Key expiry & rotation.** Keys in `keys.json` must carry an `expires_at` and a
  `key_id`; `resolveCaller` must reject an expired key and log the `key_id` (never the secret).
  *Accept:* a test with a key whose `expires_at` is in the past resolves to unauthenticated; a valid
  key resolves and the transition/ledger records show `key_id`, not the raw secret. Findings: MCP-2026, PQC.
- **ID-3 (P1) — No plaintext long-lived secrets as the sole factor.** Document and, where the client
  supports it, move `PRAXIS_MIND_KEY` out of plaintext `.claude.json` into an OS keychain / file
  with verified 0600, and treat the key as *one* factor bound to the local caller (stdio already
  binds to a local spawn — record that binding).
  *Accept:* a startup self-check refuses to run if `keys.json` is group/world-readable, and a doc
  note states the client-config storage decision. Findings: enterprise-authz, PQC.
- **ID-4 (P2) — Externalizable identity.** When the enterprise-managed-authorization path lands, an
  identity must be resolvable from a verifiable token (OIDC/JWT with RFC 9207 issuer identification)
  rather than only a local static secret, without changing tool code.
  *Accept:* `resolveCaller` accepts a pluggable resolver; a JWT-backed resolver test yields the same
  caller shape. Findings: enterprise-authz, MCP-2026.

### 4.2 Authorization (AZ)

- **AZ-1 (P0) — Privilege is enforced per tool (regression-locked).** Keep every tool's
  `checkPrivilege(...)` gate; add a test matrix asserting each tool refuses a caller lacking its
  exact privilege string.
  *Accept:* a parametric test over all registered tools × a privilege-stripped caller asserts
  `isError` for each. Findings: enterprise-authz.
- **AZ-2 (P0) — Effective rate limits on board writes.** `nexus.task_create`, `nexus.task_update`,
  `nexus.project_update` must have real per-hour limits (today the lookup is `undefined`, so
  `checkAndIncrement` no-ops and the calls are unthrottled).
  *Accept:* a test drives N+1 `nexus_task_create` calls for a caller whose limit is N and asserts
  the N+1th returns a rate-limit `isError`. Findings: MCP-2026 (DoS hardening).
- **AZ-3 (P1) — Daily cost cap enforced, not just reported.** Before any billable tool
  (`brain_*`), compare `ledger.costSince(caller,24)` to `caller.daily_cap_usd` and refuse when
  exceeded.
  *Accept:* with a ledger pre-seeded past the cap, `brain_chat` returns a cap-exceeded `isError`
  and records the refusal. Findings: enterprise-authz, MCP-2026.
- **AZ-4 (P1) — Dangerous-action policy is centralized and auditable.** Mirror the bridge's
  denylist/allowlist model (`Praxis/src/agent-bridge-policy.ts`) for praxis-mind: a single policy
  module classifies each tool as read / write / dangerous, so widening access is a one-line,
  reviewable edit next to the promise it enforces.
  *Accept:* a policy table test asserts the classification of every registered tool and that no tool
  is unclassified. Findings: enterprise-authz, audit.
- **AZ-5 (P1) — Provenance gates writes, not just reads.** A write whose *justifying content* was
  classified `external`/advisory (per `lib/provenance.js`) must not silently proceed for a
  high-impact tool; require an explicit operator-tier signal or downgrade to a proposal.
  *Accept:* a test feeds advisory-tier context into a guarded write path and asserts it is refused
  or routed to `status:"idea"` rather than executed. Findings: audit, enterprise-authz.

### 4.3 Audit (AU)

- **AU-1 (P0) — Every write is attributable and immutable.** Preserve the transition-log invariant:
  one terminal JSONL record per write, before/after images, caller identity + namespace, verdict;
  file 0600 / dir 0700.
  *Accept:* a test asserts a write produces exactly one transition record carrying caller identity
  and a verdict, and that the file mode is 0600. Findings: audit, MCP-2026 (Logging capability).
- **AU-2 (P1) — Reads are audited (attribution surface).** The cost ledger already rows every call;
  add caller-attributed read logging sufficient to answer "which identity read which vault
  path / task / memory, when" — the Evidence surface the project's end state demands.
  *Accept:* after a `vault_read` / `nexus_task_status`, a ledger/read-audit query returns a row with
  caller, tool, target ref, and timestamp. Findings: audit.
- **AU-3 (P1) — Remote (Surface B) mutations are attributable.** Board writes over `/api/*` must not
  all collapse to `local_user`; carry the authenticated principal (from Access headers / a real
  session) into the audit trail so a tunnel action is distinguishable from a local one.
  *Accept:* a request bearing an Access-authenticated principal produces an audit row naming that
  principal, not `local_user`. Findings: enterprise-authz, audit.
- **AU-4 (P2) — Tamper-evident log.** Chain transition records (hash of prior record) or periodically
  seal them, so deletion/edit of history is detectable.
  *Accept:* a test that alters one historical record makes a `verify` pass over the chain fail.
  Findings: audit, PQC (integrity under a stronger adversary).
- **AU-5 (P1) — Secrets never logged.** Assert no log path (transition, ledger, stderr) can emit a
  raw key; identities are referenced by `identity`/`key_id` only.
  *Accept:* a test greps a run's logs for known-secret material and asserts absence. Findings: audit, PQC.

### 4.4 Migration (MG)

- **MG-1 (P1) — Stateless-transport readiness.** The MCP 2026 redesign is stateless and removes
  `Mcp-Session-Id`; praxis-mind is already stateless per-spawn (shared state in WAL sqlite, no
  session id), so the migration requirement is to **keep it that way** and document that any HTTP
  transport added later must use **Streamable HTTP** (not HTTP+SSE) and carry no server-side session
  affinity.
  *Accept:* a design note records the constraint; a check asserts no `Mcp-Session-Id` dependency
  exists in the server. Findings: MCP-2026.
- **MG-2 (P1) — Hold the single-server topology; split only on trust boundary.** Re-affirm
  `project_mcp_topology_decision_2026-07-11`: new cognitive tools go into praxis-mind; a second
  server is justified only by a credential/lifecycle boundary (e.g. credentialed adapters), never
  per domain. The enterprise-authz finding does **not** by itself justify a split — it justifies an
  external policy layer in front of the one server.
  *Accept:* this doc + the memory are cross-linked; any proposal to split cites this decision.
  Findings: MCP-2026, enterprise-authz.
- **MG-3 (P2) — Enterprise-Managed Authorization adoption path.** Define the seam where an external
  authorization server (OAuth2 + RFC 9207 issuer identification) can front praxis-mind: token in ->
  caller resolved (ID-4) -> existing `checkPrivilege` unchanged. Authorization *decisions* may move
  out; *enforcement points* stay at each tool.
  *Accept:* an interface note plus a stub resolver test proves tool code is unchanged when the
  identity source swaps. Findings: enterprise-authz, MCP-2026.
- **MG-4 (P2) — Post-quantum posture.** Two moves: (a) shorten secret lifetime and enable rotation
  now (ID-2) to shrink the harvest-now-decrypt-later window; (b) when an HTTP/remote MCP transport
  or the tunnel is next touched, require a **hybrid/PQC key exchange** (NIST ML-KEM per the PQC
  finding) at the TLS terminator, and prefer PQC-ready signature schemes for any token signing.
  *Accept:* a migration checklist item exists and is referenced by the tunnel/transport config;
  rotation (ID-2) is shipped as the near-term deliverable. Findings: PQC, MCP-2026.
- **MG-5 (P1) — Gate the latent surface.** `server/mcp.js` must not be wired to any client until it
  meets ID-1/AZ-1/AU-1, or it must be explicitly retired.
  *Status 2026-09-04 (M-1):* **closed by retirement.** `server/mcp.js` and its tests moved to
  `/Volumes/Projects/Backup/TheNexus-server-mcp-2026-09-04/`; `npm run mcp` removed; the four latent-only privileges dropped from `PRIVILEGES`. The
  H-1 note below is kept as history.
  *Accept:* a note marks it latent; if activated, its diff carries identity + privilege + audit
  tests. Findings: enterprise-authz, audit.
  *Status 2026-09-03 (H-1):* **met for the tool surface.** Board tools: identity + privilege +
  transition-log audit via `board-ops` (P1-15, `mcp-board-governance.test.js`). Non-board tools:
  identity + privilege via the same `resolveCaller`/`checkPrivilege` (`mcp-tool-gating.test.js`);
  the four new privileges (`nexus.scaffold`, `nexus.git_write`, `nexus.git_read`,
  `nexus.system_read`) are listed in `lib/auth.js` `PRIVILEGES` and granted to no key. Remaining:
  the `projects://list` resource is unauthenticated (read-only), and the non-board tools have no
  audit record beyond the process log — close both before any client is configured.

---

## 5. Gap register (concrete, ranked)

Ranked by exploitability × blast radius. IDs referenced by §3.

| Gap | Where | Sev | Requirement that closes it |
|---|---|---|---|
| **G7** board-write tools unthrottled (`rate_limits_per_hour` has no entry, so `checkAndIncrement` no-ops) | `tools/nexus.js` + `keys.json` | High | AZ-2 |
| **G8** `daily_cap_usd` computed (`ledger.costSince`) but never enforced | `tools/brain.js`, `lib/ledger.js` | High | AZ-3 |
| **G3** all three agents share one write-capable privilege set; no read-only identity | `~/.praxis-mind/keys.json` | High | ID-1 |
| **G9** remote board authz is a single edge control; app-layer `authenticate` is a stub granting `admin` | `server/server.js` | High | AU-3, ID-4 |
| **G1/G2** static bearer key, no expiry/rotation, plaintext in `.claude.json` | `lib/auth.js`, client config | High | ID-2, ID-3, AU-5 |
| **G6** Surface B mutations bypass the transition-log envelope and attribute to `local_user` | `server/routes/*` | Med | AU-3 |
| **G4** provenance labels reads but does not gate high-impact writes; no dangerous-action confirm | `lib/provenance.js`, write tools | Med | AZ-4, AZ-5 |
| **G5** reads are unaudited beyond the cost ledger | `tools/*` | Med | AU-2 |
| **G11** `server/mcp.js` latent board+filesystem MCP — **retired 2026-09-04 (M-1)**, archived at `/Volumes/Projects/Backup/TheNexus-server-mcp-2026-09-04/` | — | Closed | MG-5 |
| **G10** no PQC/hybrid posture; long-lived secrets amplify harvest-now-decrypt-later | tunnel + secrets | Low-now | MG-4 |

---

## 6. Migration roadmap (sequenced)

1. **Now (P0, closes G7/G8/G3):** ship AZ-2 (board-write limits), AZ-3 (enforce daily cap), ID-1
   (readonly identity). These are small, local, test-backed edits inside `praxis-mind-mcp` and
   `keys.json` — no protocol change, no topology change.
2. **Next (P1):** ID-2/ID-3 (key expiry, rotation, keychain + perms self-check), AZ-4/AZ-5 (central
   policy + write-side provenance gate), AU-2/AU-3/AU-5 (read audit, remote attribution, secret
   scrubbing), MG-1/MG-2/MG-5 (transport constraint doc, topology re-affirmation, latent-surface gate).
3. **Horizon (P2):** ID-4 + MG-3 (pluggable identity resolver -> Enterprise-Managed Authorization
   seam), AU-4 (tamper-evident log), MG-4(b) (PQC/hybrid KEX at the terminator when the transport is
   next touched).

Each numbered item is a candidate Nexus task; each already carries its acceptance assertion above,
so it is dispatchable without a second spec pass.

### Status update — 2026-08-15 (Nexus task `e608e40f`, "Harden stateless MCP boundaries")

The P0 slice of the roadmap shipped, with its acceptance assertions enforced by
`server/__tests__/mcp-boundary-security.test.js` (scoped credentials, mutation
rejection, request isolation — the July-revision + unauthorized-action-evaluation lenses):

- **ID-1 (closes G3):** a `readonly` identity now exists in `~/.praxis-mind/keys.json`
  (8 read privileges, no writes, no `brain.*`, `daily_cap_usd: 0`). Verified end-to-end
  against the live stdio server: reads succeed, every write/billable tool refuses.
  Not yet wired to any dispatch lane — QA/review dispatches still ride agent keys (follow-up).
- **AZ-2 (closes G7):** board-write limits provisioned for all three agent identities
  (`nexus.task_create`: 30/h, `nexus.task_update`: 60/h, `nexus.project_update`: 20/h).
  The N+1 rejection path is regression-locked by the suite.
- **ID-3 (partial):** `lib/auth.js` now refuses a group/world-accessible keys file as a
  credential source (the live file had drifted to 0644; restored to 0600). Note the
  deliberate failure mode: if permissions drift again, every praxis-mind caller resolves
  unauthenticated until `chmod 600` — loud, safe, and logged with the exact fix.
- **MG-1:** no session-id dependency and no ambient `process.env` reads in tool handlers,
  both asserted by the suite. AZ-1's tool × privilege matrix is a ratchet: an unclassified
  new tool fails the suite.
- **Runtime evidence (reproducible):** `node scripts/mcp-boundary-probe.js` spawns the real
  stdio server twice against a throwaway HOME, flipping only the keys-file mode between
  phases; every invocation/rejection claim names its log or trace source — server stderr
  captures, JSON-RPC transcripts, attributed cost-ledger rows, and a probe-HOME file listing
  for absence claims (11 checks). All raw evidence persists to
  `logs/mcp-boundary-probe/<run>/` (`latest` symlink; machine-readable `report.json`).

Still open from the P0/P1 set: AZ-3 (daily cost cap enforcement), key expiry/rotation
(ID-2), read audit (AU-2), remote attribution (AU-3), and the readonly dispatch-lane wiring.

---

## 7. How this document was verified

This is a documentation/requirements deliverable — its "runtime surface" is the accuracy of every
code claim it makes. Verification was **claim-by-claim against the source** (file + behavior),
recorded in the walkthrough: the stub `authenticate`, the unthrottled board writes, the unenforced
`daily_cap_usd`, the shared privilege set, the transition-log/ledger invariants, the loopback bridge
scope, and the plaintext key in client config were each read in the code, not assumed. When any
requirement here is implemented, its **Accept** clause is the test that closes the loop.

**Cross-links:** `docs/verification-protocol.md` (brief standard),
`services/praxis-mind-mcp/lib/provenance.js` (authority laundering),
`shared-mind/memories/project_mcp_topology_decision_2026-07-11.md` (topology),
`Praxis/src/agent-bridge-policy.ts` (the scoped-bridge model AZ-4 mirrors).
