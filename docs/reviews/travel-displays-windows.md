# Nexus travel displays: Windows and shared presentation views

Task `9cae1b0e-cba3-4580-a83a-1c3222404dbe` · 20 October 2026 · implementation and verification walkthrough.

The shared foundation, Windows adapter, controller UI and isolated TV-browser receiver are implemented. All four presentation families rendered in real Chromium using isolated signed-authentication and registry fixtures. Windows runtime behavior remains **blocked**, not proven: this run had no Windows execution session or attached Android device, and its bounded Mac network inventory did not identify Living Room TV. No installed Windows binary, production casting, deployment, Access-policy change or human approval is claimed. Browser evidence explicitly records `windowsRuntime:false` and `physicalDevices:false` at `docs/reviews/travel-displays-evidence/browser.log:1`.

## What changed and why

The Windows travel shell is the launcher. `PresentDocumentButton` passes the displayed document ID, revision ID and SHA-256, including an older pinned revision, at `dashboard/src/components/presentation/presentation-controller.tsx:15`; the global launcher is native-gated at line 24. The separate renderer has no cockpit root providers, inbox, chat or approval UI. The automated browser observed zero review controls and links in each of eight view/media variants (`docs/reviews/travel-displays-evidence/browser.log:2`, `:10`, `:14`, `:16`).

The native adapter enumerates the Windows host with Tauri monitor geometry and Windows monitor-device interface identity (`desktop/src-tauri/src/presentation.rs:381`). It scopes stable target IDs to the installation, displays friendly names plus exact IDs, bounds reports to 32 targets and 30 seconds, re-enumerates before selection, and uses physical coordinates for mixed DPI. Start creates one dedicated fullscreen output using the existing WebView2 profile (`desktop/src-tauri/src/presentation.rs:250`). Stop, expiry, unplug, geometry changes and rejected navigation close output; reconnect needs explicit selection (`desktop/src-tauri/src/presentation.rs:161`). Single/duplicated desktops and ambiguous identities are unavailable, with Extend-mode guidance. The origin/frame bridge is restricted to the configured HTTPS BRIDGE tab (`desktop/src-tauri/src/presentation.rs:86`); no remote Tauri commands or feedback widget are installed on output. The shared capability wildcard was narrowed to the existing main window.

Every controller request goes through the existing verified operator authenticator, independently of the legacy local-user stub (`server/routes/presentations.js:62`). Sessions preserve immutable selected views. Registered Markdown is checked against exact bytes; binary media is copied and hashed into private per-session captures, capped at 128 MiB per primary asset and 512 MiB total (`server/services/presentation-data.js:42`). A newer registry revision produces a notice without replacing selected bytes (`server/services/presentation-data.js:141`).

TV pairing uses a separate opt-in listener that mounts only presentation assets and scoped receiver routes (`server/presentation-receiver.js:31`). A short-lived code plus an independent poll secret grants one receiver capability for one chosen view. Operator cookies, Access service tokens and general API authority are not copied to the receiver. Stop/revoke closes reads and open media streams. A controller heartbeat cannot activate a TV before it redeems its pairing; independent 45-second controller and receiver leases revoke disconnected sessions (`server/services/presentations.js:56`, `:156`). Pairing lasts two minutes and a session has a hard 30-minute limit. Process restart forgets all authority.

Review found and fixed a start/heartbeat race, PDF new-tab escape, Mermaid image/link bypass, premature TV-active reporting and incorrect JSON error media headers. Lifecycle operations now serialize; presentation Mermaid stays literal; PDF has no Open-full link and its frame is inert while external page controls remain usable. Those boundaries have passing regressions (`docs/reviews/travel-displays-evidence/dashboard-tests.log:14`, `:16`, `:19`; `docs/reviews/travel-displays-evidence/server-presentations-tests.log:25`). Review of the attributable source patch found no remaining debug hooks, placeholder production code or unrelated source changes. The fixture-only native bridge and synthetic JWT are confined to the QA script.

## Compatibility matrix

| Method / surface | Built | Verified in this run | Conditional / unsupported boundary |
|---|---|---|---|
| Windows attached HDMI / USB-C / dock display | Native enumeration, exact target selection, fullscreen start/status/stop | 9 host policy/protocol tests, 7 bridge-origin/frame cases, Windows-target Tauri adapter check | Actual Windows execution, install, auth reuse, mixed DPI and unplug/reconnect are blocked by unavailable laptop access; cross-check is not Windows proof |
| Windows wireless display / Miracast | Manual Win+K selection and Win+P Extend guidance, then normal native discovery | Official Windows documentation and code inspection | Requires compatible laptop/receiver and OS consent; no programmatic Miracast connection claimed |
| TV-browser receiver | Separate listener, selected-view pairing, expiry, disconnect, revoke | Real Chromium pairing and eight revocations; strict signed-HTTP isolation tests | Dedicated reachable receiver origin and compatible TV browser required; disabled by default; Living Room TV protocol/model/reachability unknown |
| Chromecast from Windows WebView2 | Shared view contract only | No native Cast sender implemented or claimed | Unsupported in this Windows shell; use an attached/Miracast display or a TV browser capable of the paired receiver |
| Apple TV / AirPlay from Windows or Android | None | No compatible sender path observed | Unsupported here; no generic TV or AirPlay discovery claim; a compatible independent browser/attached display is a separate practical route |
| Android display/Cast implementation | Versioned source/session/receiver contract and Android inventory acceptance | Contract tests and server Android-provenance test | Native Android work belongs to the existing successor; phone model/OS and connectivity unobserved |
| Ordinary browser dashboard, Mac, iPad, iPhone | No display launcher added for these products | Browser-native gating test passes | Out of scope |

Microsoft documents choosing wireless receivers with Win+K and display modes with Win+P: [Windows display guidance](https://support.microsoft.com/en-us/windows/hardware/display-graphics/screen-mirroring-and-projecting-to-your-pc-or-wireless-display). Google's supported sender platforms do not establish WebView2 as a Cast sender: [Cast overview](https://developers.google.com/cast/docs/overview). Apple's documented AirPlay instructions describe Apple senders; they do not prove a Windows/Android API: [AirPlay guidance](https://support.apple.com/en-us/102661). These vendor limits are the reason for the conditional/unsupported entries, not an inference from a TV's friendly name.

## Four views and media boundaries

| Family | Selected output | Evidence |
|---|---|---|
| Ambient bridge | Clock and recorded board active/queued/completed counts, explicitly distinguished from live execution | `browser.log:2`; real `ambient.png` export |
| Current focus / task board | Sanitized task titles/projects/statuses; live task IDs are marked only when the existing Praxis activity feed confirms them | `server-presentations-tests.log:8`; `browser.log:4` and `:6` |
| Exact document review | Markdown/PDF/image/video bound to ID, revision and hash; newer-revision notice stays read-only | `server-presentations-tests.log:6`; `browser.log:10`, `:12`, `:14`, `:16` |
| Calendar / day plan | Selected server-calendar date, event times shown in the display timezone | `browser.log:8` |

Evidence filenames in this section are under `docs/reviews/travel-displays-evidence/`. Markdown embedded resources are omitted, links are plain text and Mermaid fences are literal source so an exact selected revision cannot load unrelated authenticated resources. PDF requires a browser with an inline PDF renderer. PDF interactions stay in the revocable parent; image zoom and video playback controls are read-only. Unsupported codecs, media larger than the bound, HTML/SVG/design packages and missing or mismatched registered primaries fail or remain unsupported. These are presentation limits, not changes to the normal document-review product.

## Shared interface for Android and Praxis

The additional repository is **`/Volumes/Projects/nexus-shared`**, registered with the workspace endpoint before editing. Its task-owned `src/presentations.ts:1` exports version 1 schemas and TypeScript wire types; `src/index.ts:17` exports the module. Contract tests pass four behavioral cases (`docs/reviews/travel-displays-evidence/contract-tests.log:5`). The dashboard's copied dependency was refreshed after rebuilding the contract. No Praxis runtime source was changed; conversational dispatch remains a Praxis responsibility.

| Endpoint | Authority and operation |
|---|---|
| `PUT /api/presentations/inventory` | Existing verified operator; strict source-device report, max 32 targets, 30-second freshness |
| `GET /api/presentations/config`, `/inventory`, `/sessions` | Existing verified operator; receiver configuration and bounded device/session state |
| `POST /api/presentations/sessions` | `{sourceDeviceId,targetId,view}`; choose an exact ID, never guess an ambiguous friendly name |
| `GET /api/presentations/sessions/:id` | Session state; starting/active/stopped/expired/disconnected/failed |
| `POST /api/presentations/sessions/:id/heartbeat` | Existing verified controller renews its lease with `{state:'active'}` or reports disconnected/failed |
| `DELETE /api/presentations/sessions/:id` | Controller stop/revoke |
| `GET /api/presentations/sessions/:id/view` or `/asset` | Only that selected projection or primary media, still operator-authenticated |
| `POST /receiver/pairings` | Isolated receiver enrolls `{name}` and retains its poll secret in memory |
| `POST /api/presentations/pairings/:code/claim` | Controller binds `{sourceDevice,view}`; no receiver secret is returned to controller |
| `GET /receiver/pairings/:code` | Bearer poll secret; one-time receiver capability redemption |
| `GET /receiver/view` or `/receiver/asset` | Bearer selected-view capability; no general API routes, no query scope overrides |

A native command is correlated by `requestId`, with `discover`, `status`, `stop`, `wireless-picker`, or `start` carrying exact target/session/expiry. The Windows adapter intercepts the narrow `nexus-shell://presentation?request=...` navigation and replies with `nexus:display-result`. This wire payload carries no credentials. Receiver capabilities live in memory, not query strings or localStorage. The controller polls every ten seconds; the external renderer refreshes every three seconds, blanks on failed authorization/data refresh, and enforces hard expiry locally. Receiver liveness means recent scoped reads, not proof that a human is watching.

The optional listener is configured with `NEXUS_PRESENTATION_RECEIVER_PORT`, `NEXUS_PRESENTATION_RECEIVER_HOST` (loopback default) and `NEXUS_PRESENTATION_RECEIVER_ORIGIN`. Remote origins must be HTTPS; use a dedicated receiver hostname/TLS termination exposing only this listener. The listener itself is HTTP behind that termination. No environment or Access policy was changed here. Do not point a TV at the full dashboard or forward operator credentials. Build the static renderer with `cd dashboard && npm run build:presentation`; normal predev/prebuild also runs it. API restart, receiver hosting and Windows packaging/installation remain normal deployment steps, not actions performed by this task.

## Verification commands and observations

- `npx jest server/__tests__/presentations.test.js --runInBand --verbose` — **28 passed**, including all four projections, missing/expired/forged authority, exact revision/hash, ambiguity/provenance, stop/expiry, pairing isolation, independent leases and stream revocation. Exact names/results: `docs/reviews/travel-displays-evidence/server-presentations-tests.log:2`; total at line 32.
- `npx jest server/__tests__/presentations.test.js server/__tests__/mcp-boundary-security.test.js server/__tests__/praxis-mind-stateless-conformance.test.js server/__tests__/praxis-operator-provenance.test.js --runInBand` — **4 suites, 188 passed**; `docs/reviews/travel-displays-evidence/server-jest.log:4125`.
- In `dashboard`: `node --import ./test/register.mjs --test src/components/__tests__/presentation-*.test.mjs src/components/__tests__/document-markdown.test.mjs src/components/__tests__/document-media-viewers.test.mjs src/lib/__tests__/presentation-*.test.ts` — **19 passed**; `docs/reviews/travel-displays-evidence/dashboard-tests.log:20`.
- In `dashboard`: `NEXT_DIST_DIR=.next-travel-displays-verify npm run build` — optimized build, TypeScript and **29 pages succeeded**; `docs/reviews/travel-displays-evidence/dashboard-build.log:28` and `:42`. Only this build's generated tsconfig include entries were removed afterward. The existing multiple-lockfile warning is retained; no suite failure is described as a pass.
- In `/Volumes/Projects/nexus-shared`: `npm run build && node --test test/presentations.test.cjs` — build and **4 passed**; retained test output at `docs/reviews/travel-displays-evidence/contract-tests.log:5`.
- `node scripts/travel-displays-qa/verify-browser.cjs` — **real Chrome 155 on macOS**, eight receiver view/media cases and eight revocations; controller select/start/stop exercised through the real React/HTTP code with an explicitly simulated native bridge. `docs/reviews/travel-displays-evidence/browser.log:18` records that distinction; line 19 records 78 receiver requests, no operator credentials or unselected-resource requests, API 404 and no JS exceptions. The script awaited and closed its isolated servers/browser and removed its own scratch files.
- `python3 /Volumes/Projects/StorageManagement/storage.py run --project nexus-travel-displays-windows -- sh desktop/scripts/test-presentation-policy.sh` — policy checks passed. The later `test-presentation-wire.sh` command under the same runner includes all policy tests plus protocol tests: **9 passed**, and **7 origin/frame cases** plus navigation-race/capability checks; `docs/reviews/travel-displays-evidence/presentation-wire-tests.log:16` and `presentation-bridge-tests.log:1`.
- `python3 /Volumes/Projects/StorageManagement/storage.py run --project nexus-travel-displays-windows -- sh desktop/scripts/check-presentation-adapter.sh` — actual Windows-target adapter/Tauri API typecheck passed; `docs/reviews/travel-displays-evidence/presentation-adapter-check.log:2`. It excludes the app resource build and is not a full shell build or Windows execution.
- `python3 /Volumes/Projects/StorageManagement/storage.py run --project nexus-travel-displays-windows -- sh desktop/scripts/check-presentation-windows.sh` — full shell cross-check **blocked**, `tauri-winres` cannot find `llvm-rc` on this Mac; `docs/reviews/travel-displays-evidence/presentation-windows-check.log:315`. No compiler/resource tools were installed to bypass the constraint.

All automated native builds used helper-managed scratch/results/archive variables on Projects. Original native logs remain under `/Volumes/Projects/BuildArtifacts/nexus-travel-displays-windows/Results/`; exact copies are retained beside this walkthrough. Screenshots are real exports from the isolated browser run: `ambient.png`, `focus.png`, `board.png`, `day-plan.png`, `markdown.png`, `image.png`, `pdf.png`, `video.png`, `stopped.png`, `controller-fixture.png`. The controller screenshot visibly labels its native source as simulated. These exports are submitted with the walkthrough through Documents; registration/readiness is separate from QA or approval.

## Hardware blockers and remaining execution

The host was Darwin arm64/macOS 26.5.2 (`docs/reviews/travel-displays-evidence/hardware-inventory.log:3`). `adb devices -l` returned an empty attached-device list at line 7. The local SSH config had no Windows/laptop/travel host alias at line 12. No authorized Windows execution route or desktop session was exposed to this run. This establishes an access blocker, not that the laptop is physically off or absent.

Five-second Mac-side mDNS browsing and bounded TXT resolution observed nine Cast speaker/group records, including a Nest Audio named “Living Room speaker” (`hardware-inventory.log:54`), and only Mac Studio AirPlay announcements (`hardware-inventory.log:35`). No “Living Room TV” was identified. A speaker is not the selected TV; no Chromecast/AirPlay/browser support, TV model or OS version was inferred. This was inventory only, never Windows/Android-origin discovery, connectivity proof or a cast.

Robert's temporary selected-view pairing approval and named test devices remain accepted; no new pairing/account decision is needed. To close Windows-native criteria, use an existing authorized Windows session on his laptop, record its model/OS and the exact locally built/installed binary, run native discovery there, then select an actual external display. Exercise all four views, exact old/new document revisions, two displays with different scale factors/negative coordinates where available, one-display refusal, disconnect/unplug/reconnect and controller-auth expiry. OS picker/consent remains a human/device prerequisite. On the Android successor, record the actual phone model/OS and native-origin inventory. On Living Room TV, first observe model/protocol and reachable browser or supported route, then exercise scoped pairing, stop, disconnect, expiry and another-document denial. Do not infer protocol from the name or replace Windows evidence with these Mac fixtures.

## Criterion-by-criterion evidence

1. **Blocked for full native attestation.** The four read-only views and exact revision behavior passed HTTP/browser tests, but this run did not observe them on a chosen Windows physical display. `browser.log:1` states `windowsRuntime:false`; the native implementation is at `desktop/src-tauri/src/presentation.rs:250`.
2. **Blocked for full native attestation.** Native source, identity/topology policy tests and adapter check are present; fresh laptop-origin discovery, placement and unplug/reconnect require the unavailable Windows session. `hardware-inventory.log:12` records the access finding; `presentation-wire-tests.log:16` is explicitly host testing.
3. **Met for the shared foundation.** `contract-tests.log:5`, `server-presentations-tests.log:10`, `:11`, `:16`, `:24` and `browser.log:19` prove schema/provenance, strict authority denial, selected-view isolation and credential omission. Android/Praxis native/runtime consumers remain their separate tasks.
4. **Met via the explicitly allowed hardware-blocker route.** Focused automated results and the real-browser flow are above. Full-shell resource build, Windows runtime and installation are distinguished from passing adapter/host checks; hardware blockers are retained without claiming native success.
5. **Matrix and exact test evidence prepared for Documents.** The handoff receipt and exact revision links in the task response are the registration authority; file existence alone is not a delivery claim.
6. **Met via automated evidence and the explicitly allowed device blockers.** `server-presentations-tests.log:10`, `:13`, `:19`, `:26`, `:27`, `:28`, `:29` and `browser.log:19` cover one-view pairing, revocation, expiry, isolation and truthful receiver liveness. The laptop/phone/TV availability findings are recorded above; their models/protocols remain unknown. Physical pairing is not claimed.

## Commits and preservation

Primary workspace: `/Volumes/Projects/TheNexus`, dispatch branch `main`, QA baseline `423d8f8a25744c91d2dfc9e3b3da829a8ad94c3e`. Source commits: `4bc6710` (server), `4e71421` (Windows adapter), `23e56de` (renderer/controller/browser harness). The attributable source diff against the QA baseline contains **37 files, 3,036 insertions and 11 deletions**, as observed by `git diff 423d8f8a2574 --stat` after those commits. Documentation/evidence are additional; their commit SHA is recorded in the final task response to avoid embedding a file's own commit identity in its bytes.

Additional declared repository `/Volumes/Projects/nexus-shared`: source contract commit `367c54329d6faeca76f125a41c83e33663654e19`, three task-owned files. Its pre-existing changes to `src/endpoints.ts`, `src/entities/project.ts`, `test/project.test.cjs` and untracked `test/endpoints.test.cjs` were left untouched. No other source repository was edited. No commits were pushed.

All three predecessor IDs still read `completed` (`docs/reviews/travel-displays-evidence/preflight.log:2`). The research document remained approved at revision `32ed69cf-96a6-41fd-9fe6-21d458b921f5`, hash `68b1637becd15029714286cad870d1fe346ab022992cb144d3fe4eb84c192e5f` (`preflight.log:6`). Its current registry/history and original submission comments were read; its file and comments were not edited. The foreign `.env.example` is byte-identical to the dispatch snapshot, SHA-256 `e87f409424c736d95b28120b31ffb7411ee39198e7199c581b57a81ff1a093ab` (`preflight.log:7`). The prior menu work was preserved.

## Files touched

- .gitignore
- dashboard/.gitignore
- dashboard/package.json
- dashboard/scripts/build-presentation.mjs
- dashboard/src/app/layout.tsx
- dashboard/src/components/__tests__/presentation-controller.test.mjs
- dashboard/src/components/__tests__/presentation-view.test.mjs
- dashboard/src/components/document-review/document-markdown.tsx
- dashboard/src/components/document-review/document-review.tsx
- dashboard/src/components/document-review/viewers/pdf-viewer.tsx
- dashboard/src/components/presentation/presentation-controller.tsx
- dashboard/src/components/presentation/presentation-screen.tsx
- dashboard/src/components/presentation/presentation-view.tsx
- dashboard/src/lib/__tests__/presentation-native.test.ts
- dashboard/src/lib/__tests__/presentation-operations.test.ts
- dashboard/src/lib/presentation-native.ts
- dashboard/src/lib/presentation-operations.ts
- dashboard/src/lib/presentation-transport.ts
- dashboard/src/presentation/entry.tsx
- dashboard/src/presentation/styles.css
- desktop/scripts/check-presentation-adapter.sh
- desktop/scripts/check-presentation-windows.sh
- desktop/scripts/test-presentation-bridge.cjs
- desktop/scripts/test-presentation-policy.sh
- desktop/scripts/test-presentation-wire.sh
- desktop/src-tauri/capabilities/default.json
- desktop/src-tauri/src/main.rs
- desktop/src-tauri/src/presentation.rs
- desktop/src-tauri/src/presentation_policy.rs
- desktop/src-tauri/src/presentation_wire.rs
- scripts/travel-displays-qa/verify-browser.cjs
- server/__tests__/presentations.test.js
- server/presentation-receiver.js
- server/routes/presentations.js
- server/server.js
- server/services/presentation-data.js
- server/services/presentations.js
- docs/superpowers/plans/2026-10-20-travel-displays.md
- docs/reviews/travel-displays-windows.md
- docs/reviews/travel-displays-evidence/
- /Volumes/Projects/nexus-shared/src/presentations.ts
- /Volumes/Projects/nexus-shared/src/index.ts
- /Volumes/Projects/nexus-shared/test/presentations.test.cjs

## Binding constraints (verbatim)

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/9cae1b0e-cba3-4580-a83a-1c3222404dbe/workspace with the new path and a reason. Robert, if the re-point is refused.
- **Fallback (do this instead):** If the WHOLE task belongs elsewhere, re-point the task first and then do ALL the work in the new directory; if you only realise at the end, still call the endpoint with "baseline":"head". If the task merely also needs another repo, work there and declare it in your report. If neither is possible, report needs_input.
- **Consequence (if you proceed anyway):** QA builds the authoritative diff from this workspace and the dispatch-time snapshot, plus the diff of every additional repo the run touched and declared. Work done in an undeclared repo that Praxis could not record is invisible to review, and a round with no work in any visible repo fails as an empty diff no matter how correct the change is.

#### BC-DEPENDENCIES — Do not treat this task as unblocked until its declared dependencies are resolved: 6d6e2638-8fc1-46fa-8545-3ad4d5876dc0, be441473-ebd1-4c93-b3a1-9f3e3d3decf4, 91f1f758-4b40-464b-a2a0-29f29de0bf98.
- **Prerequisite (resolve first):** Each of 6d6e2638-8fc1-46fa-8545-3ad4d5876dc0, be441473-ebd1-4c93-b3a1-9f3e3d3decf4, 91f1f758-4b40-464b-a2a0-29f29de0bf98 must be complete (or explicitly waived) before the work this task depends on them for is valid.
- **Authority (who may waive it):** Robert. Praxis's scheduler files dependencies; it does not drop them, and neither does an executor.
- **Fallback (do this instead):** Deliver only the parts that genuinely do not depend on the unresolved item, say in the walkthrough exactly what you left out and why, and report needs_input if nothing is deliverable.
- **Consequence (if you proceed anyway):** Work built on an unmet dependency is rejected at review and re-filed, spending a correction attempt on a rebuild rather than a fix.

#### BC-CRITERIA — Satisfy every acceptance criterion above and cite the command or observation that proves each one.
- **Prerequisite (resolve first):** Each criterion has to be verified against real behavior before you report complete — a criterion you did not run is a criterion you did not meet.
- **Authority (who may waive it):** The QA reviewer rules on a criterion you can show is defective — contest it with "PRAXIS_CRITERION_DISPUTE: <number> — <why, with evidence>", and twice contested without resolution goes to Robert. Robert's operator rulings override both. Neither happens silently — you have to raise it.
- **Fallback (do this instead):** If a criterion cannot be met as written, say so explicitly with evidence and deliver everything else in full. Narrowing the scope quietly is not the fallback.
- **Consequence (if you proceed anyway):** QA scores each criterion mechanically against your diff. An unproven criterion is a fail verdict and a correction round, not a note.

#### BC-FOREIGN-WORK — The workspace is SHARED and may hold unrelated uncommitted work from other agents or Robert's own sessions. Never revert, stash, `git checkout`/`git restore`, or delete anything you did not change in this run.
- **Prerequisite (resolve first):** Know what was already dirty before you touch the tree: the brief's workspace pre-flight lists it, and `git status` shows the rest. Anything on that list is somebody else's in-flight work.
- **Authority (who may waive it):** Robert alone. No task brief, no reviewer finding, and no cleanup instinct authorizes discarding another session's changes.
- **Fallback (do this instead):** Work additively. Re-read a contended file immediately before each edit, keep your change narrow, and say in your walkthrough that the file was already dirty. Never `git add -A` or `git commit -a`.
- **Consequence (if you proceed anyway):** Git keeps no reflog for working-tree reverts, so the other session's work is gone unrecoverably — that happened on 2026-07-09 and cost a verified-but-uncommitted change.

#### BC-TASK-COMMITS — Commit your OWN verified work as you go, in small, task-scoped, LOCAL commits on the dispatch branch, each ending with the trailer `Task: 9cae1b0e-cba3-4580-a83a-1c3222404dbe`. Never `git push`, and never stage or commit anything you did not change in this run.
- **Prerequisite (resolve first):** Before each commit: the change is verified (its test, typecheck or hand-run passed); `git branch --show-current` is still the dispatch branch and HEAD is not detached; you stage explicit paths only (`git add -- <path>`, never `-A`, `-u` or `commit -a`); and `git diff --cached --stat` lists nothing but files you changed in this run. A file that was already dirty at dispatch, or that a sibling is editing, needs your hunks separated from theirs before it can be in your commit.
- **Authority (who may waive it):** An explicit commit hold (a task brief or operator note that says not to commit, or dispatch metadata `commitPolicy: hold`) prevails over this default, and then the work stays uncommitted. Pushing is Robert's alone: the QA-pass commit and the end-of-day commit-approval workflow are the only publishers, and no sentence in a task brief authorizes `git push`.
- **Fallback (do this instead):** Cannot separate your hunks from foreign ones in a shared dirty file? Leave that file uncommitted, commit the rest, and name it in your walkthrough; QA still reviews it from the working tree. Under a hold, leave everything uncommitted and `git add` only the NEW files you created. Either way, record every commit SHA you made in your walkthrough.
- **Consequence (if you proceed anyway):** QA diffs the dispatch snapshot against the WORKING TREE, so committed and uncommitted work both stay in view. A commit carrying your trailer whose files start from their dispatch-time version is attributed to you; a commit without the trailer, or one whose files first moved under someone else's commit or dirty edit, reaches the reviewer only as an unattributed candidate. A commit that sweeps foreign work misattributes it under your task's name (a defect in its own right), and a push without Robert's approval publishes unreviewed work.

#### BC-LIFECYCLE — Do NOT change this task's status in The Nexus yourself.
- **Prerequisite (resolve first):** The completion protocol markers at the end of this brief are the only status channel available to you; use them instead of the board.
- **Authority (who may waive it):** Praxis's completion handler owns the lifecycle. Robert can override it from the board.
- **Fallback (do this instead):** End with the exact completion / failure / needs-input protocol, and put anything the status cannot express into the walkthrough.
- **Consequence (if you proceed anyway):** A hand-edited status desynchronizes the schedule from the run, and the executor callback that would have carried your result is discarded.

#### BC-QUALITY-GATES — Run BOTH quality gates — verify and code-review — and declare them on the marker line before reporting complete.
- **Prerequisite (resolve first):** The verify pass needs the change actually exercised (run the flow, command, or test — a typecheck is not a verify), and the code-review pass needs your own task diff, every commit you made this run plus the edits still uncommitted, re-read end to end.
- **Authority (who may waive it):** Nobody. Neither an executor nor a reviewer may waive a gate; the only sanctioned exception is a change with no runtime surface, and you must say that explicitly on the marker line.
- **Fallback (do this instead):** If there is genuinely nothing to drive, declare that in place of a command rather than omitting the gate or inventing a command you did not run.
- **Consequence (if you proceed anyway):** A completion reported without the marker line is treated as unverified work and flagged for the human reviewer, whatever the walkthrough claims.

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/TheNexus`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.
