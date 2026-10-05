# Nexus connection recovery after expiry, sleep or network loss

Task `60c8716a-c6d6-4058-90dd-75fa54a96904`, project TheNexus, 2026-10-03.
Trigger: Robert, 2026-10-03: "I refreshed the Nexus and now I see the Ops panel
looks correct. I do went to set up some kind of auto-renewal of the access
token, I find I am often having to refresh or even close and re-open The Nexus
in order to Connect properly."

Repositories changed: `/Volumes/Projects/TheNexus` only. Round 1 (2026-10-03,
morning) changed `dashboard/` and this document. The QA repair round
(2026-10-03, afternoon, execution 38721b58) added the supported automatic
renewal path and the document-preserving sign-in, which also touches the
Windows travel shell source that lives in this same repository
(`desktop/src-tauri/src/main.rs`; section 5 says how it is built).
`/Volumes/Projects/Praxis` was not modified. The bounded Codex repair
(execution `612e5d13`) corrects the renewal/cooldown boundary and replaces
the destructive travel-shell fallback; see section 8 for current evidence.

## 1. What was actually failing (facts, with evidence)

Every item below was reproduced or read from logs on 2026-10-03. No credential
values appear anywhere in this document, the code, or the tests.

**F1. A backend restart killed the live stream permanently until a reload.**
The dashboard's Praxis event stream is a browser `EventSource` on
`/api/praxis/stream`. On the Mac shell (localhost:3000) that path is proxied by
`next dev` to :4000. While :4000 is down the proxy answers `500 Internal Server
Error` with a `text/plain` body. Per the WHATWG EventSource spec a non-200 or
non-`text/event-stream` answer is a *final* failure: `readyState` goes to
`CLOSED` (2) and the browser never retries. Reproduced with a standalone Node
EventSource against the proxy with :4000 stopped (`/tmp/es-repro.mjs`, outside
the repo): `readyState=2`, no further requests. The old store
(`hooks/use-praxis-stream.ts`) only flipped `connected: false` on error and
never reopened the source. Consequence: the PRAXIS presence chip read
"Offline" and presence stopped updating after every backend restart even
though the Socket.IO half had already reconnected. Both :4000 and the :3000
`next dev` child were restarted together at 2026-10-02 17:52 (Praxis
supervisor log), which is the most recent such event before the report.

**F2. Nothing reacted to foreground return, network return or a sleep gap.**
Neither transport nor any poller listened for `visibilitychange`, `focus`,
`online` or `pageshow`. socket.io-client's engine closes itself on the
browser's `offline` event but listens for nothing on `online`, so after a
network return it waited out its 3s to 15s reconnection backoff. Ops data
waited for the next 20s (`use-dispatch-state`) or 60s (`useLiveRefetch`
fallback poll) timer.

**F3. Event-derived "active" lanes never expired.** `hooks/use-crew-activity`
folds the live event ring into one lane per executor and treated an `active`
lane as live forever; only a newer frame could move it. When the closing
`task.completed` frame was missed (restart, sleep, a gap the relay could not
replay) the crew strip and the Ops "Executor runs" list kept a run the
registry had closed, and the Ops page synthesized a phantom active row for it.
`stream.reset` frames (the relay saying "I could not replay the gap") were
appended to the ring without clearing the stale frames before them.

**F4. Ops could not tell "no runs" from "telemetry unavailable".** When the
dispatch-state fetch failed, the Ops page showed a red error line and the list
fell back to "No dispatch or agent runs on record yet.", which is false while
the backend is unreachable. Nothing on the page dated the rows it showed.

**F5. An expired Cloudflare Access session was indistinguishable from a bug.**
Remote clients (`nexus.vibeshiftai.com`, Access session duration 24h) get a
`302` to the team domain on every request once the session is gone. A
followed `fetch` turns that into an HTML login page and a JSON parse error in
whichever hook ran first. Nothing in the dashboard recognized this state or
offered a way out other than a manual reload. Tunnel ingress for this host
routes `/socket.io.*` and `/api/.*` straight to :4000 and everything else to
:3000, so the stream, the socket and the pollers all sit behind the same
Access cookie.

**F6. Which clients were in use.** On 2026-10-03 the Mac "The Nexus.app"
(WKWebView to localhost:3000, no Access in the path) was relaunched at 11:13,
and the Windows travel shell also reached the API that day (Access analytics,
read-only token). The Mac shell has been respawned 24 times and the dashboard
child 3 times since 2026-09-04. No macOS sleep events were found in the window
around the report.

## 2. Hypotheses (not confirmed)

- **H1. "Access token expiry" as the cause.** For the Mac shell there is no
  Access in the path at all, so expiry cannot explain the Mac symptom; F1 and
  F2 do. For the Windows travel shell a 24h session expiry is plausible and
  the new `reauth` state is built for it, but no expired-session event was
  captured in logs during this task. Treat it as a supported scenario, not a
  confirmed root cause.
- **H2. Which client Robert meant.** The relaunch evidence favors the Mac
  shell; the clarification question was still pending when this task ran.
- **H3. Exact timing of the Ops staleness Robert saw.** Consistent with F1
  plus F3 after the 2026-10-02 17:52 restart, but not pinned to a timestamp.

## 3. Design

One shared recovery coordinator, `dashboard/src/lib/connection-lifecycle.ts`,
owned by `LiveBoardStateProvider` (mounted once in the root layout):

- **Signals in:** `visibilitychange` (to visible), `focus`, `online`,
  `pageshow` (bfcache restore), a 15s interval that arrives more than 45s late
  (sleep or suspension), transport failure and up reports from the socket, the
  SSE store and the dispatch-state fetchers, and an explicit `manual` signal
  from the Retry buttons.
- **One bounded run at a time:** signals within 500ms coalesce; a run in
  flight queues at most one follow-up; while live, a wake signal within 10s of
  a passing probe is dropped; transport failure reports probe at most every
  10s and only out of the `live` phase.
- **The probe:** `GET /api/health` with `redirect: "manual"`, same-origin
  credentials, a 6s timeout. An `opaqueredirect`, 401 or 403 reads `reauth`;
  a thrown fetch or a non-2xx reads `unreachable`; 2xx reads `ok`. The route
  exists on the API and answers JSON through the proxy (verified live).
- **Phases:** `live`, `recovering` (probe in flight), `renewing` (the session
  expired and a native shell was asked to renew it; bounded, see below),
  `offline` (retry with 3s backoff doubling to 30s, only while the page is
  visible; a hidden page waits for the next `visible`), `reauth` (no shell can
  renew, or renewal did not take: no automatic retry; wake signals re-probe at
  most every 30s; the operator gets one explicit "Sign in again" action). The
  browser's `offline` event moves to `offline` at once without burning probes.
- **Recovery broadcast:** a passing probe after a non-live phase, or after a
  wake signal, tells subscribers "we are back". The provider then bumps every
  live-domain revision so each surface re-fetches authoritative data; the
  socket reconnects at once instead of waiting out its backoff; the SSE store
  reopens a closed source, or replaces an "open" source silent through three
  relay heartbeats (45s) after sleep. A transport failing while the API probes
  healthy does **not** broadcast, so one surface's failing fetch cannot become
  a deck-wide refetch loop.
- **Automatic renewal, the supported path (QA repair round).** Cloudflare
  documents two ways an Access session comes back, and page JavaScript can do
  neither on its own:
  1. *Service-token exchange.* A request carrying the `CF-Access-Client-Id` and
     `CF-Access-Client-Secret` headers is answered with a fresh
     `CF_Authorization` cookie ("Service tokens expire according to the token
     duration you selected when you created the token",
     developers.cloudflare.com/cloudflare-one/identity/service-tokens/). The
     Windows travel shell already did this at launch (`exchange_and_inject`).
     It now also does it on request and on a schedule. The dashboard
     (`lib/session-renewal.ts`) recognizes the shell by the roster it injects
     as `window.__NEXUS_SHELL__` and asks with
     `location.assign("nexus-shell://renew-session")`; the shell's existing
     navigation interceptor cancels that "navigation" (so the document never
     changes) and runs the exchange on its own thread (`renew_session`), then
     fires `nexus:session-renewed` in every content webview. The lifecycle
     moves to `renewing` and awaits a correlated native completion event.
     A `deferred` result carries the native cooldown or busy wait and does not
     consume an exchange attempt. Native admission remains single-flight even
     when an exchange outlasts 30s; its cooldown starts at completion. Failed
     exchanges get 2s/4s/8s page backoff plus any remaining native cooldown,
     bounded to three exchanges. Native completion waits time out after 60s;
     a continuous deferral streak has a 120s elapsed budget. Explicit manual
     recovery or a real offline-to-online episode can begin another bounded
     run. Ordinary wake/focus probes cannot reset the budget. Its 8h schedule
     is unchanged. Travel shells must advertise `renew-session`; older builds
     do not silently consume attempts. Android still requires its capability.
     No credential reaches the page: it asks, the shell exchanges, the page
     re-probes.
  2. *The login redirect flow (user sessions in a browser).* "When the
     application token expires, Cloudflare will automatically issue a new
     application token if the global token is still valid (and the user's
     identity still passes your Access policies)"
     (developers.cloudflare.com/cloudflare-one/identity/users/session-management/),
     but only on a top-level navigation through the team domain. There is no
     refresh token and no fetch-based renewal: the team-domain cookie is not
     sent on cross-site subrequests, and WebKit blocks third-party cookies in
     frames. The sign-in action below drives exactly this flow, from a
     separate window.
- **Sign-in action (`reauthenticate`), preserving the document:** only acts in
  `reauth`, never automatically. It opens `/session/renewed` (a new page beside
  the existing `/session` check page) in a separate window named
  `nexus-sign-in`, one at a time (a second click focuses the open one). Access
  takes that window through its flow and brings it back to `/session/renewed`,
  which announces the renewed session (a `BroadcastChannel` message plus a
  direct event on the opener) and closes itself. The lifecycle hears the
  announcement, or sees the window close, and probes; a passing probe closes a
  window still open, clears the attempt flag and broadcasts recovery. This
  document, and every unsaved edit in it, is never replaced. A blocked popup
  offers another window attempt after popups are allowed, never navigation.
  Travel shells advertising `sign-in-window` open a dedicated native WebView2
  window at the fixed roster origin's `/session/renewed`, sharing the content
  views' default app cookie profile. Repeated clicks focus the existing window.
  Native completion/close events cause a probe, whose answer alone restores
  `live`. Older travel shells cannot use the system browser's separate
  profile: their action fails closed with an update hint, retaining all edits.
  The compatibility method `signInHere()` now retries the separate window;
  neither UI offers same-document sign-in or a relaunch that would lose work.
  The attempt flag remains in sessionStorage for two minutes. No credential
  is stored in page state or draft storage.
- **SSE store** (`lib/praxis-stream-store.ts`, factory behind
  `hooks/use-praxis-stream.ts`): reopens a `CLOSED` source with 3s to 30s
  backoff carrying `?lastEventId=` so the relay replays the gap or sends
  `stream.reset`; leaves a `CONNECTING` source to the browser; holds while the
  lifecycle says `reauth`. Public hook surface unchanged.
- **Lane reconciliation** (`lib/crew-lanes.ts`): the registry snapshot wins
  over an event-derived active lane when it marks the run non-active at or
  after the lane's frame (15s grace for unordered writes); an active lane the
  registry has never heard of is kept for 10 minutes of silence, then dropped;
  a registry that never loaded leaves the stream's word standing.
  `stream.reset` now clears the ring to the reset frame alone.
- **Honest Ops state** (`components/ops-connection-status.tsx`, `app/ops/page.tsx`):
  one line always states live / stale / offline / reauth with "data as of
  HH:MM:SS", the rows dim when stale, and the empty list has four readings
  (`data-ops-runs-empty`): `loading`, `unavailable` (nothing ever loaded and
  telemetry failed), `none` ("No dispatch or agent runs on record yet.",
  confirmed by current telemetry) and, since the QA repair round,
  `stale-none` ("No runs in the last telemetry received (as of HH:MM:SS);
  current telemetry is unavailable, so a run started since then cannot be
  shown yet.") whenever the last answer was empty but the connection is not
  live or the latest fetch failed. A JSON `502` from the API (Praxis down
  behind a healthy Nexus) is shown as telemetry unavailable and does not wake
  the lifecycle; only a thrown fetch, an opaque redirect or a non-JSON body
  does. **Request sequencing (QA repair round):** every `load()` takes a
  sequence number and only the newest call's answer (or error) is applied, so
  a request from before an outage that lands after the reconnect refetch
  cannot overwrite the recovered rows; QA's reproduction had exactly that
  older empty answer erase the active run the recovery had fetched. The
  shared `use-dispatch-state` hook coalesces concurrent refreshes into one
  request, so it has no such ordering gap.
- **Deck-wide banner** (`components/connection-banner.tsx`): hidden while
  live and for the first 4s of `recovering` and `renewing`; otherwise one pill
  for reconnecting / renewing / unreachable since / session expired. The
  expired pill says what is true about the sign-in: the window is open
  ("Finish signing in in the window that opened; this page and anything you
  typed stay as they are."), or it was blocked (allow popups, or update an old
  travel shell, then retry the separate window; no document replacement).
- **Unsent input** (`lib/chat-draft.ts`): the chat composer mirrors its text to
  `sessionStorage` on every edit, restores it on mount, and clears it only
  when a send is accepted. The sign-in round trip and a reload both bring the
  draft back. Rejected sends keep the text; one click is one send.
- **PRAXIS chip** (`bridge/status-strip.tsx`) now reads the folded live state
  (socket or SSE), so a dead EventSource alone no longer shows "Offline".

Preserved unchanged: `server/services/operator-access.js` (expiry, issuer,
audience, device/user and the task 5fbeff4a aud string-or-array handling),
every server auth route, the `/api/*` proxy seam, and the three foreign dirty
files that were already in the workspace at dispatch (`.env.example`,
`db/client-access.js`, `server/__tests__/client-access.test.js`).

## 4. Tests

Historical tests from the first QA repair: 744/744 (726 after round 1,
678 before this task). The current repair's commands and totals are in
section 8. Earlier coverage, with fallback behavior updated below:

| File | Covers |
| --- | --- |
| `lib/__tests__/connection-lifecycle.test.ts` (18) | coalescing, backend restart backoff, throttle without broadcast, wake gap, expired session in a browser (no auto retry, no auto navigation, no auto popup, 30s re-probe gate), shell renewal bounded to three attempts with 2s/4s/8s waits then `reauth` (and a refusing shell goes straight to `reauth`), shell renewal that works (`renewed` event cuts the wait, deck refetch, counters reset), the explicit action opens one window and leaves the document (second click focuses, announcement probes, passing probe closes the window), a window closed without announcing gets one probe, blocked window retries without navigation, attempt flag clears on recovery, no-ops outside `reauth`, single flight, browser offline/online, hidden page, clock jump, refcounted start/stop, probe verdict matrix incl. no token in the probe, transport-vs-API error classification |
| `lib/__tests__/session-renewal.test.ts` (5, new) | bridge detection (browser none, travel shell via injected roster, Android only with the capability), the renew request goes through the intercepted navigation or the shell message with no credential, subscribe/announce over the window event and `BroadcastChannel` (and without a channel), `openSignInWindow` wraps a popup and reports null when blocked, throwing or absent, never navigating |
| `lib/__tests__/praxis-stream-store.test.ts` (6) | reopen with backoff and `?lastEventId=`, CONNECTING left to the browser, recovery reopen / stale replace / re-bootstrap, reauth hold, teardown stops retries, frames |
| `components/__tests__/live-board-state-recovery.test.mjs` (5) | backend restart with three concurrent consumers (one probe, one refetch each, one socket reconnect, listener counts unchanged), foreground return, expired session end to end (the action opens the sign-in window, no navigation, `signIn` state reflected), `connected` follows the socket while SSE is dead, unmount releases everything |
| `components/__tests__/ops-page-recovery.test.mjs` (3, new) | the real Ops page through the provider with held dispatch-state requests answered out of order: the obsolete pre-outage answer landing after the reconnect refetch does not remove the recovered active run (QA's missing-active-run sequence); a JSON 502 with a cached empty list reads `stale-none` and says current telemetry is unavailable; the API unreachable with a cached empty list reads offline and `stale-none`, then `none` again once current telemetry confirms it |
| `components/__tests__/reauth-preserves-document.test.mjs` (2, new) | `ConnectionBanner` plus a mounted `TaskEditModal`: an unsent description edit survives the expiry, the "Sign in again" click (separate window, no navigation), the renewed announcement and the recovery; with the window blocked the edit is still intact, the separate-window retry completes after popups are allowed; the travel-shell native window also completes without replacing the textarea |
| `components/__tests__/connection-banner.test.mjs` (5) | offline pill with manual retry, browser reauth (one action, window opened, document kept, no relaunch hint), blocked window (retry keeps document), travel shell (`renewing` after the grace, three requests, then a separate native sign-in window), recovering grace |
| `components/__tests__/ops-connection-status.test.mjs` (6) | copy and actions for every tone including `renewing`, the four reauth variants (plain, attempted, window open, blocked) and the travel-shell variant, the component wiring each offered button to its handler |
| `lib/__tests__/crew-lanes.test.ts` (6) | registry supersession, grace, orphan TTL, never-loaded registry |
| `lib/__tests__/chat-draft.test.ts` (3), `components/__tests__/chat-composer-draft.test.mjs` (3) | draft survives remount, rejected send keeps, accepted send clears, seed is a draft |
| `lib/__tests__/live-socket.test.ts` (+2), `components/__tests__/live-board-state.test.ts` (+2) | forced reconnect, lifecycle binding/unbinding, reset clears ring, invalidateAll |

QA's own reproduction script (`/tmp/qa-60c8716a-ops-repro.mjs`, outside the
repo), re-run after the repair with
`cd dashboard && node --import ./test/register.mjs /tmp/qa-60c8716a-ops-repro.mjs`,
now prints `after older response {"active":true,"tone":"live"}` (it printed
`{"active":false,...}` before) and `unavailable with cached empty {"tone":"stale"}`
with the recovered run still on screen.

Server, exact command from the repo root:

```
npx jest --runInBand server/__tests__/praxis-operator-provenance.test.js server/__tests__/praxis-stream-reconnect.test.js server/__tests__/ai-chat-praxis-stream.test.js server/__tests__/mcp-boundary-security.test.js
```

Result: `Test Suites: 4 passed, 4 total`, `Tests: 157 passed, 157 total`
(re-run in the QA repair round). Round 1 reported 174 because it also included
`server/__tests__/praxis-stream.test.js`, which adds 17 passing tests and one
pre-existing failure, unrelated and not touched: "ignores X-Forwarded-For and
judges loopback by the socket peer" (fails on this machine since 2026-09-18
independent of any dashboard change). `server/services/operator-access.js` is
byte-for-byte unchanged (`git diff --quiet -- server/services/operator-access.js`).

Typecheck: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` exit 0.
Production build: `NEXT_DIST_DIR=.next-verify npm run build` exit 0, with
`/session/renewed` in the route list (the `tsconfig.json` rewrite Next performs
was discarded; `dashboard/tsconfig.json` is identical to HEAD). Encoding:
every changed or new file decodes as strict UTF-8 with no BOM, CRLF or
mojibake; no em dash was added to any line.

The earlier repair did not compile Rust. This execution found installed
Rust tooling, passed Windows ARM64 `cargo check --locked`, and executed the
standalone Rust gate test on macOS (section 8). No Windows binary was run.

## 5. Activation

The supervised :3000 is `next dev` under `PRAXIS_DASHBOARD_DEV=1` (verified
in the running process list on 2026-10-03), so it serves the working tree
live: no restart, build or commit was needed, and no Praxis process was
touched. Verified at 12:50 EDT by fetching `http://localhost:3000/ops` from
the running server: HTTP 200, the server-rendered HTML already carries the new
`data-ops-connection="live"` status line and the `data-ops-runs-empty`
marker, and neither `/ops` nor `/` contains a compile error. The Mac shell
picks the change up on its next page load; remote clients on the next load of
`nexus.vibeshiftai.com`. If the supervisor is ever run with the flag unset
(`next start`), rebuild with `npm run build` and let the supervisor restart
the child.

Re-verified in the QA repair round against the running :3000: `/ops` answers
200 with `data-ops-connection="live"` and the `data-ops-runs-empty` marker,
and the new `/session/renewed` answers 200 with its "Session renewed." body.

**The Windows travel shell is not live on save.** This source now requires
both the correlated renewal protocol and the same-profile sign-in window.
Windows ARM64 `cargo check` passes, but no release binary was built, signed,
installed or run on a Windows device in this repair. The existing workflow
`.github/workflows/desktop-windows-arm.yml` builds/signs on an authorized push
that touches `desktop/**`; the laptop installs through its existing updater.
No commit or push was authorized or performed here. Older installed shells
advertise neither capability, so the updated dashboard sends them no renewal
requests and never replaces the editor to work around missing sign-in
support. Install a reviewed shell build before relying on these native paths.
Android remains outside this native repair and requires its advertised bridge.

Nothing here is a flag or a migration. Rolling back is reverting the
`dashboard/` and `desktop/` diff.

## 6. Observed live recovery (separate from code and test completion)

Not observed on a real device during this task. What was observed live:

- The running :3000 `next dev` compiled the change and serves the new Ops
  status line (above).
- `/api/health` answers `200 application/json` both directly on :4000 and
  through the :3000 proxy, so the probe target is valid on the Mac path.

What was **not** done: no backend restart, sleep, network pull or Access
expiry was induced against a live client, because restarting :4000 or the
dashboard child would interrupt the active client-portal executor task
96eaa517 and other operator work. The recovery paths are proven by the unit
and provider tests above, not by a live device. Suggested first live check,
at a quiet moment: open Ops on the Mac shell, restart only the Nexus API
(:4000), and watch the banner go "Reconnecting" then disappear, the Ops line
return to "Live · data as of", the PRAXIS chip stay on the socket, and the
run list re-fetch without a reload.

## 7. Follow-ups outside this task

- **Windows travel shell release**: source type-checks for Windows ARM64;
  release build, signing and installation still use CI (section 5). First live check once that build is
  installed: let a session expire (or wait for the 8h schedule) and watch the
  shell's stdout for `renewing Access session (page-request)` or
  `(scheduled)` followed by `Access session planted for <host>`; the lines
  carry no secret. The dashboard should show `renewing` briefly, then return
  to live without a reload.
- **Android shell**: implement `{ type: "renew-session" }` (re-prime the Access
  cookie natively, then dispatch `nexus:session-renewed` in the WebView) and
  add `renew-session` to the advertised capabilities. Until then an expired
  session on the phone takes the interactive path.
- **Cloudflare Access session length**: the TheNexus app's 24h session is
  policy, not code; longer sessions or a service-token path for the shells
  would reduce how often `reauth` appears at all.
- **Praxis runtime** was deliberately not modified (operator exclusion).

## 8. Bounded Codex repair: the two remaining failures

Scope: only criteria 2 and 5 were repaired; accepted Ops sequencing, identity
validation, and the other settled criteria were preserved. The workspace
preflight confirmed `/Volumes/Projects/TheNexus` contains both dashboard and
native sources. All edited existing task files were already dirty at dispatch.
Foreign `.env.example`, `db/client-access.js`, and its test were left alone.
No additional repository was modified; no commit, push, board status change,
Praxis change or supervised-service restart was performed.

### Reproduction before edits

- `cd dashboard && node --import ./test/register.mjs /tmp/qa-60c8716a-travel-unsent.test.mjs`
  printed `before sign-in {"phase":"reauth","description":"Unsent operator edit","actions":["Sign in in this tab"]}`
  and `after replacement document mounts {"description":"Original description"}`.
  The reviewer's script exits 0 because it asserts the broken outcome; the
  printed loss is the reproduced failure, not a passing acceptance check.
- The renewal script was absent, so a reproduction using the actual lifecycle
  and the native 30s gate described by QA was written under `/tmp`.
  `cd dashboard && node --import ./test/register.mjs /tmp/qa-60c8716a-renewal-boundary.test.mjs`
  exited 1 and printed `{"phase":"reauth","requests":3,"actualExchanges":1}`
  after transient failure, network recovery and manual recovery.

### Repair and review

`session-renewal.ts` now gates native features by explicit capabilities and
correlates each request with a credential-free completion/deferral event.
`connection-lifecycle.ts` waits for completion, honors the native cooldown
without spending exchange attempts, bounds deferral by elapsed time, and
cleans up pending native listeners on timeout/disposal. `main.rs` and the
new `renewal_gate.rs` implement matching completion/cooldown behavior.

`main.rs` opens sign-in at the hosted tab's fixed roster origin in a separate
WebView2 window. No arbitrary page-supplied destination or native IPC access
is added. The existing content views remain mounted. Tauri's installed
`tauri-2.11.5/src/manager/webview.rs:534–543` assigns all Windows webviews
without a custom data directory to the same `LocalData/config.identifier`
profile; both the content and sign-in builders use that default. This matches
[Tauri's upstream implementation](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/manager/webview.rs)
and [window builder documentation](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html).
The banner and Ops sign-in actions retain this document even when blocked.
The old `signInHere` callback name is retained for existing consumers, but
it only retries the separate window.

Independent read-only subagent review found two defects during implementation:
a too-short count-based busy budget and a callback relying on bound `this`.
Both were fixed. Final re-review ran the six focused suites: 46/46 passed, with no
callback exceptions; the reviewer found no remaining blocker. This includes
bounded-deferral, timeout cleanup and offline-to-online regressions. This is independent local review, not the later Praxis
cross-executor verdict.

### Verification in this execution

- `cd dashboard && npm test`: 754 passed, 0 failed, exit 0.
- Six focused suites (exact command):
  `cd dashboard && node --import ./test/register.mjs --test src/lib/__tests__/session-renewal.test.ts src/lib/__tests__/connection-lifecycle.test.ts src/lib/__tests__/native-renewal-boundary.test.ts src/components/__tests__/reauth-preserves-document.test.mjs src/components/__tests__/connection-banner.test.mjs src/components/__tests__/ops-connection-status.test.mjs`.
  The boundary test uses the real page adapter/lifecycle with a modeled native
  gate: first transient exchange fails, second succeeds automatically,
  `{"scheduled":false,"phase":"live","requests":3,"actualExchanges":2}`.
  A concurrent scheduled exchange takes 45s and fails; after its cooldown,
  page renewal succeeds: `{"scheduled":true,"phase":"live","requests":11,"actualExchanges":1}`.
  Tests also cover an indefinitely deferred native gate, explicit recovery,
  timeout/disposal listener removal, and a new network episode after exhaustion.
- `reauth-preserves-document.test.mjs` completes browser popup, native shell
  window and blocked-then-allowed popup flows. Each retains the original
  textarea node and exact unsent text, performs no document navigation, and
  reaches `live` only after the health probe passes. No send is replayed.
- `cd desktop/src-tauri && cargo check --target aarch64-pc-windows-msvc --locked`:
  exit 0. This type-checks the Windows code and its actual Tauri APIs.
- `rustc --test desktop/src-tauri/src/renewal_gate.rs -o /tmp/nexus-renewal-gate-test && /tmp/nexus-renewal-gate-test`:
  1 passed. The actual native gate prevents overlap even after 45s and admits
  the next exchange only after completion plus cooldown.
- The four-suite Jest command in section 4: 157/157, 4/4 suites passed.
- `cd dashboard && node --import ./test/register.mjs /tmp/qa-60c8716a-ops-repro.mjs`:
  `after older response {"active":true,"tone":"live"}` and unavailable cached
  empty telemetry `{"tone":"stale"}`.
- `cd dashboard && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`: exit 0.
- `cd dashboard && NEXT_DIST_DIR=.next-verify npm run build`: exit 0, 29 static
  pages generated. Next's added verification-directory include entries were
  removed while preserving the exact prior tsconfig bytes. No live dist was
  replaced. The existing multiple-lockfile warning remains informational.
- `curl --max-time 30 -s -o /tmp/nexus-repair-ops.html -w 'ops HTTP %{http_code}\n' http://localhost:3000/ops`:
  `ops HTTP 200`; the corresponding `/session/renewed` call: `renewed HTTP 200`.
  `/api/health`: `health HTTP 200 application/json; charset=utf-8`.
- `git diff --check`: exit 0. Own changed source, tests and uncommitted native
  diff were re-read. No leftover debug code, credential handling, server auth
  edits, task status mutation or unrelated source changes were introduced.
- Strict UTF-8 decoding and a mojibake scan across the 13 edited text files:
  passed. `git diff --quiet -- server/services/operator-access.js dashboard/tsconfig.json`:
  exit 0. `git diff e932bb02c9a4 --stat` is non-empty and includes the native
  change; the new/untracked task files remain visible in `git status` and are
  named below, not attributed via the shared range alone.

Observed recovery is test-harness behavior, not a Windows-device experiment.
Do not infer a released shell, Access policy change, actual sleep/network
interruption, or live-device renewal from compilation or HTTP availability.

Files edited in this bounded repair (13):

- `dashboard/src/lib/connection-lifecycle.ts`
- `dashboard/src/lib/session-renewal.ts`
- `dashboard/src/components/connection-banner.tsx`
- `dashboard/src/components/ops-connection-status.tsx` (sign-in actions only)
- `dashboard/src/lib/__tests__/connection-lifecycle.test.ts`
- `dashboard/src/lib/__tests__/session-renewal.test.ts`
- `dashboard/src/lib/__tests__/native-renewal-boundary.test.ts` (new)
- `dashboard/src/components/__tests__/connection-banner.test.mjs`
- `dashboard/src/components/__tests__/ops-connection-status.test.mjs`
- `dashboard/src/components/__tests__/reauth-preserves-document.test.mjs`
- `desktop/src-tauri/src/main.rs`
- `desktop/src-tauri/src/renewal_gate.rs` (new)
- `docs/reviews/2026-10-03-connection-recovery.md`

## Binding constraints carried forward verbatim

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/60c8716a-c6d6-4058-90dd-75fa54a96904/workspace with the new path and a reason. Robert, if the re-point is refused.
- **Fallback (do this instead):** If the WHOLE task belongs elsewhere, re-point the task first and then do ALL the work in the new directory; if you only realise at the end, still call the endpoint with "baseline":"head". If the task merely also needs another repo, work there and declare it in your report. If neither is possible, report needs_input.
- **Consequence (if you proceed anyway):** QA builds the authoritative diff from this workspace and the dispatch-time snapshot, plus the diff of every additional repo the run touched and declared. Work done in an undeclared repo that Praxis could not record is invisible to review, and a round with no work in any visible repo fails as an empty diff no matter how correct the change is.

#### BC-CRITERIA — Satisfy every acceptance criterion above and cite the command or observation that proves each one.
- **Prerequisite (resolve first):** Each criterion has to be verified against real behavior before you report complete — a criterion you did not run is a criterion you did not meet.
- **Authority (who may waive it):** The QA reviewer rules on a criterion you can show is defective — contest it with "PRAXIS_CRITERION_DISPUTE: <number> — <why, with evidence>", and twice contested without resolution goes to Robert. Robert's operator rulings override both. Neither happens silently — you have to raise it.
- **Fallback (do this instead):** If a criterion cannot be met as written, say so explicitly with evidence and deliver everything else in full. Narrowing the scope quietly is not the fallback.
- **Consequence (if you proceed anyway):** QA scores each criterion mechanically against your diff. An unproven criterion is a fail verdict and a correction round, not a note.

#### BC-REPAIR — Resolve every reviewer finding listed for this repair round (attempt 1 of 2).
- **Prerequisite (resolve first):** Reproduce the reviewer's failing check yourself before changing anything. A finding you cannot reproduce is one to report, not one to guess at.
- **Authority (who may waive it):** The QA reviewer, via a ruling on a contested finding ("PRAXIS_CRITERION_DISPUTE: <number> — <why, with evidence>"). Robert, once a finding has been contested twice without resolution.
- **Fallback (do this instead):** Fix only the listed findings and preserve every criterion not amended by one; if a finding is defective, contest it with evidence instead of complying blindly or ignoring it.
- **Consequence (if you proceed anyway):** Attempts are bounded at 2. Exhausting them stops the task and escalates it to Robert, and a finding that recurs across rounds is read as an unfixed root cause, not a fresh note.

#### BC-FOREIGN-WORK — The workspace is SHARED and may hold unrelated uncommitted work from other agents or Robert's own sessions. Never revert, stash, `git checkout`/`git restore`, or delete anything you did not change in this run.
- **Prerequisite (resolve first):** Know what was already dirty before you touch the tree: the brief's workspace pre-flight lists it, and `git status` shows the rest. Anything on that list is somebody else's in-flight work.
- **Authority (who may waive it):** Robert alone. No task brief, no reviewer finding, and no cleanup instinct authorizes discarding another session's changes.
- **Fallback (do this instead):** Work additively. Re-read a contended file immediately before each edit, keep your change narrow, and say in your walkthrough that the file was already dirty. Never `git add -A` or `git commit -a`.
- **Consequence (if you proceed anyway):** Git keeps no reflog for working-tree reverts, so the other session's work is gone unrecoverably — that happened on 2026-07-09 and cost a verified-but-uncommitted change.

#### BC-NO-COMMIT — Do NOT commit or push unless the task explicitly says to.
- **Prerequisite (resolve first):** A commit needs explicit authorization in this task's own brief. Absent that sentence, the work stays uncommitted.
- **Authority (who may waive it):** Robert, through the end-of-day commit-approval workflow. The task brief itself, when it explicitly instructs you to commit.
- **Fallback (do this instead):** Leave the change in the working tree; `git add` only the NEW files you created if the task needs them visible to review.
- **Consequence (if you proceed anyway):** QA reviews your UNCOMMITTED diff against a dispatch-time snapshot. Committing moves the work out of that view, and the round can read as an empty diff — a mandatory fail — even though the code is right.

#### BC-LIFECYCLE — Do NOT change this task's status in The Nexus yourself.
- **Prerequisite (resolve first):** The completion protocol markers at the end of this brief are the only status channel available to you; use them instead of the board.
- **Authority (who may waive it):** Praxis's completion handler owns the lifecycle. Robert can override it from the board.
- **Fallback (do this instead):** End with the exact completion / failure / needs-input protocol, and put anything the status cannot express into the walkthrough.
- **Consequence (if you proceed anyway):** A hand-edited status desynchronizes the schedule from the run, and the executor callback that would have carried your result is discarded.

#### BC-QUALITY-GATES — Run BOTH quality gates — verify and code-review — and declare them on the marker line before reporting complete.
- **Prerequisite (resolve first):** The verify pass needs the change actually exercised (run the flow, command, or test — a typecheck is not a verify), and the code-review pass needs your own uncommitted diff re-read end to end.
- **Authority (who may waive it):** Nobody. Neither an executor nor a reviewer may waive a gate; the only sanctioned exception is a change with no runtime surface, and you must say that explicitly on the marker line.
- **Fallback (do this instead):** If there is genuinely nothing to drive, declare that in place of a command rather than omitting the gate or inventing a command you did not run.
- **Consequence (if you proceed anyway):** A completion reported without the marker line is treated as unverified work and flagged for the human reviewer, whatever the walkthrough claims.

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/TheNexus`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.
