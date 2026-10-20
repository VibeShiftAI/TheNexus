# Nexus travel displays: Windows and shared presentation views

Task `9cae1b0e-cba3-4580-a83a-1c3222404dbe` · 20 October 2026 · implementation and verification walkthrough.

The shared foundation, Windows adapter, controller UI and isolated TV-browser receiver are implemented. Robert has explicitly deferred the native Windows observations in criteria 1 and 2 **until he gets home**. The task can proceed to normal independent QA under that amended acceptance scope; physical Windows behavior remains unverified. All four presentation families have local fixture evidence, including the original real-Chromium run. No installed Windows binary, production casting, deployment, Access-policy change or document approval is claimed.

## Operator ruling and amended acceptance scope

Robert answered the criterion-1/2 deferral question at **2026-10-20T22:46:13.870Z**, inbox answer `task-question-9cae1b0e-1792536333178`:

> you can defer that requirement until I get home

The live task's `antigravity_payload.operator_rulings` was read again in this continuation; the exact question, answer and source identity are retained in `docs/reviews/travel-displays-evidence/completion-ruling.log:2`, `:3`, `:4`, `:5`. This resolves the earlier disputes. **Only the native Windows observations are deferred.** Four read-only view families, existing controller authentication, exact document/revision identity, native-source discovery implementation, bounded contracts, receiver isolation, expiry, stop/revoke, truthful limitations and Documents delivery remain part of this handoff.

The deferral is not a Windows test result. `browser.log:1` still records `windowsRuntime:false` and `physicalDevices:false`; host tests and cross-compilation remain distinct from native runtime evidence. Windows authentication reuse, chosen-monitor rendering, actual laptop-origin enumeration, mixed DPI, one-display handling and unplug/reconnect must be observed when Robert is home and an authorized Windows execution/control environment is available. The physical checklist under “Hardware blockers and remaining execution” is retained for that work. Android/Living Room TV availability blockers remain explicit under criteria 4 and 6; their models/protocols are not inferred.

The earlier access checks and dispute sections below are dated history, superseded for acceptance by this ruling. This continuation did not repeat device probes or ask the answered questions again. The current implementation has fresh 28/19/4 passing focused tests. The final handoff records exact-revision registration and the normal QA boundary.

## What changed and why

The Windows travel shell is the launcher. `PresentDocumentButton` passes the displayed document ID, revision ID and SHA-256, including an older pinned revision, at `dashboard/src/components/presentation/presentation-controller.tsx:15`; the global launcher is native-gated at line 24. The separate renderer has no cockpit root providers, inbox, chat or approval UI. The automated browser observed zero review controls and links in each of eight view/media variants (`docs/reviews/travel-displays-evidence/browser.log:2`, `:10`, `:14`, `:16`).

The native adapter enumerates the Windows host with Tauri monitor geometry and Windows monitor-device interface identity (`desktop/src-tauri/src/presentation.rs:381`). It scopes stable target IDs to the installation, displays friendly names plus exact IDs, bounds reports to 32 targets and 30 seconds, re-enumerates before selection, and uses physical coordinates for mixed DPI. Start creates one dedicated fullscreen output using the existing WebView2 profile (`desktop/src-tauri/src/presentation.rs:250`). Stop, expiry, unplug, geometry changes and rejected navigation close output; reconnect needs explicit selection (`desktop/src-tauri/src/presentation.rs:161`). Single/duplicated desktops and ambiguous identities are unavailable, with Extend-mode guidance. The origin/frame bridge is restricted to the configured HTTPS BRIDGE tab (`desktop/src-tauri/src/presentation.rs:86`); no remote Tauri commands or feedback widget are installed on output. The shared capability wildcard was narrowed to the existing main window.

Every controller request goes through the existing verified operator authenticator, independently of the legacy local-user stub (`server/routes/presentations.js:62`). Sessions preserve immutable selected views. Registered Markdown is checked against exact bytes; binary media is copied and hashed into private per-session captures, capped at 128 MiB per primary asset and 512 MiB total (`server/services/presentation-data.js:42`). A newer registry revision produces a notice without replacing selected bytes (`server/services/presentation-data.js:141`).

TV pairing uses a separate opt-in listener that mounts only presentation assets and scoped receiver routes (`server/presentation-receiver.js:31`). A short-lived code plus an independent poll secret grants one receiver capability for one chosen view. Operator cookies, Access service tokens and general API authority are not copied to the receiver. Stop/revoke closes reads and open media streams. A controller heartbeat cannot activate a TV before it redeems its pairing; independent 45-second controller and receiver leases revoke disconnected sessions (`server/services/presentations.js:56`, `:156`). Pairing lasts two minutes and a session has a hard 30-minute limit. Process restart forgets all authority.

Review found and fixed a start/heartbeat race, PDF new-tab escape, Mermaid image/link bypass, premature TV-active reporting and incorrect JSON error media headers. Lifecycle operations now serialize; presentation Mermaid stays literal; PDF has no Open-full link and its frame is inert while external page controls remain usable. Those boundaries have passing regressions (`docs/reviews/travel-displays-evidence/dashboard-tests.log:14`, `:16`, `:19`; `docs/reviews/travel-displays-evidence/server-presentations-tests.log:25`). Review of the attributable source patch found no remaining debug hooks, placeholder production code or unrelated source changes. The fixture-only native bridge and synthetic JWT are confined to the QA script.

## Compatibility matrix

| Method / surface | Built | Verification evidence (dated logs) | Conditional / unsupported boundary |
|---|---|---|---|
| Windows attached HDMI / USB-C / dock display | Native enumeration, exact target selection, fullscreen start/status/stop | 9 host policy/protocol tests, 7 bridge-origin/frame cases, Windows-target Tauri adapter check | Native observations are deferred until Robert gets home by ruling task-question-9cae1b0e-1792536333178; actual execution, install, auth reuse, mixed DPI and unplug/reconnect remain unverified; cross-check is not Windows proof |
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

## Hardware blockers and remaining execution (Windows observations deferred by operator)

The host was Darwin arm64/macOS 26.5.2 (`docs/reviews/travel-displays-evidence/hardware-inventory.log:3`). `adb devices -l` returned an empty attached-device list at line 7. The local SSH config had no Windows/laptop/travel host alias at line 12. No authorized Windows execution route or desktop session was exposed to this run. This establishes an access blocker, not that the laptop is physically off or absent.

Five-second Mac-side mDNS browsing and bounded TXT resolution observed nine Cast speaker/group records, including a Nest Audio named “Living Room speaker” (`hardware-inventory.log:54`), and only Mac Studio AirPlay announcements (`hardware-inventory.log:35`). No “Living Room TV” was identified. A speaker is not the selected TV; no Chromecast/AirPlay/browser support, TV model or OS version was inferred. This was inventory only, never Windows/Android-origin discovery, connectivity proof or a cast.

Robert's temporary selected-view pairing approval and named test devices remain accepted; no new pairing/account decision is needed. After Robert gets home, complete the deferred Windows observations using an existing authorized Windows session on his laptop, record its model/OS and the exact locally built/installed binary, run native discovery there, then select an actual external display. Exercise all four views, exact old/new document revisions, two displays with different scale factors/negative coordinates where available, one-display refusal, disconnect/unplug/reconnect and controller-auth expiry. OS picker/consent remains a human/device prerequisite. On the Android successor, record the actual phone model/OS and native-origin inventory. On Living Room TV, first observe model/protocol and reachable browser or supported route, then exercise scoped pairing, stop, disconnect, expiry and another-document denial. Do not infer protocol from the name or replace Windows evidence with these Mac fixtures.

## Historical laptop-session check (20 October, 21:57 UTC)

Robert answered the Windows-session question at 21:19:44.736 UTC: “I'm on the laptop now, can you use this session?” (inbox answer `task-question-9cae1b0e-1792531151681`). This accepts use of his current laptop session; it does not establish that the executor has a connection to it. The pairing approval and all three selected devices remain unchanged.

The fresh check found a `Win32` Nexus activity report at 21:41:33.942 UTC (`docs/reviews/travel-displays-evidence/resume-session-check.log:4`). Its label comes from `navigator.platform` (`dashboard/src/lib/active-client.ts:51`). The presence router only stores and returns the last activity report (`server/routes/presence.js:23`, `:36`); it has no command or display-control transport. The report is consistent with Robert using Windows, but proves neither the installed shell version nor authenticated Windows OS identity.

The executor terminal still reported `Darwin 25.5.0 arm64` and macOS 26.5.2 (`resume-session-check.log:2`). Computer Use returned `target:mac`, Mac application IDs and an empty connected-browser list (`resume-session-check.log:3`). The SSH configuration exposes only the local OrbStack Linux endpoint, and the current Praxis bridge has no Windows execution tool (`resume-session-check.log:6`, `:7`). This is an observed missing connection, not a claim that the laptop is off or lacks SSH.

Two deployment facts also prevent treating the dashboard session as the new native feature: the live update feed reports shell 1.4.0 with publication date 17 July 2026 (`resume-session-check.log:8`), while `GET http://127.0.0.1:4000/api/presentations/config` returns **404** (`resume-session-check.log:9`). The feed is not evidence of the version installed on the laptop. The retained task commits were not published, and this resume did not restart production, install a binary or start a cast. A fresh `adb devices -l` again listed no attached phone (`resume-session-check.log:10`). The TV inventory above remains historical; this resume did not repeat TV discovery or infer a protocol.

**Historical request, answered below at 22:07 UTC:** Robert was asked to open PowerShell on the laptop, without elevation, and paste the output of this read-only command:

```powershell
whoami; Get-Service sshd; Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress
```

This checks the current account, whether an existing SSH service is present/running, and its local IPv4 interfaces. It installs nothing, starts no service, changes no firewall and requests no password or private key. Microsoft documents `sshd` as the Windows OpenSSH service: [OpenSSH on Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse). A missing-service error is useful evidence, not an instruction to install or enable it. The request is retained at `resume-session-check.log:18`; the subsequent operator answer is retained below. Do not repeat this request.

If an existing authorized SSH route is available, verify its connection using the existing authentication and record the actual Windows model/OS and build prerequisites. SSH availability alone does not prove access to the interactive desktop: physical display selection, OS consent and visual verification still require Robert's interactive session or a connected Windows computer-control surface. If no existing route is available, keep criteria 1 and 2 blocked; opening the signed-in dashboard again cannot supply that capability. Establishing a new remote-access service would require a separate concrete setup decision, not copying Nexus credentials or injecting general command execution into the presentation bridge. Preserve the existing task and successor chain.

The retained implementation was not rewritten. Fresh focused verification passed **28 server tests**, **19 dashboard/renderer/bridge tests**, and **4 shared-contract tests**:

- From TheNexus: `npx jest server/__tests__/presentations.test.js --runInBand --verbose`; `resume-server-tests.log:32` records 28 passed. Lines 2–29 exercise authentication, immutable views, provenance/ambiguity, selected-view pairing, stream revocation and both leases.
- From `dashboard`: `node --import ./test/register.mjs --test src/components/__tests__/presentation-*.test.mjs src/components/__tests__/document-markdown.test.mjs src/components/__tests__/document-media-viewers.test.mjs src/lib/__tests__/presentation-*.test.ts`; `resume-dashboard-tests.log:22` records 19 passed. Lines 10–19 cover native gating, exact revision, all four families, failed-refresh blanking and serialized lifecycle behavior.
- From `/Volumes/Projects/nexus-shared`: `node --test test/presentations.test.cjs`; `resume-contract-tests.log:7` records 4 passed. This command only rechecked the retained contract; no shared-repository files were edited in this resume.

All evidence filenames in this subsection are under `docs/reviews/travel-displays-evidence/`. The earlier full build, native cross-check and real Chromium results remain separately dated evidence; they were not rerun or relabeled as Windows runtime proof. Self-review of this resume found no application-source change, and the new evidence/documents passed strict UTF-8 and mojibake checks. Normal independent QA remains outstanding. Existing source and evidence commits `4bc6710`, `4e71421`, `23e56de`, `59855bd`, `33fde73`, and shared commit `367c543` are retained. All three predecessors still read completed and the foreign `.env.example` hash is unchanged (`resume-session-check.log:12`, `:13`, `:14`, `:17`).

## Historical operator answer and access verification (20 October, 22:07–22:12 UTC)

Robert supplied the requested output in inbox answer `task-question-9cae1b0e-1792533759050` at 22:07:08.828 UTC. It reports account `nova\rober`, Wi-Fi address `192.168.4.34`, CloudflareWARP address `172.16.0.2`, and **“Cannot find any service with service name 'sshd'.”** The original output is retained in `docs/reviews/travel-displays-evidence/nova-operator-output.log:1`; the missing-service result is at line 5 and Wi-Fi address at line 18. This is operator-provided device evidence, not a remotely executed command. It confirms that the proposed existing `sshd` service is unavailable; it does not establish the laptop's hardware model, Windows version or display topology.

A bounded check from this executor attempted only the four named remote-access ports on the supplied Wi-Fi address: SSH 22, RDP 3389, WinRM HTTP 5985 and WinRM HTTPS 5986, with a three-second timeout per connection. All four timed out (`nova-access-check.log:3`, `:4`, `:5`, `:6`, `:7`). No authentication or remote command was attempted. `/sbin/route -n get 192.168.4.34` routed through gateway `192.168.86.1` on `en1` (`nova-access-check.log:8`, `:11`, `:12`). This proves no connection from this executor at that time; it does not identify whether routing, firewall, service state or some other cause prevented the connections. The WARP interface entry alone is not a usable remote-execution route.

Computer Use still reported `target:mac`, no connected browsers and no matching remote-desktop application in its app inventory (`nova-access-check.log:14`). The previously observed Nexus activity heartbeat and signed-in dashboard remain insufficient for native execution/control. The implementation has no general command-execution relay, and none is added here.

**Disposition at that time, superseded by the 22:46 deferral ruling:** the answer closes the SSH availability question. Keep the implementation and Documents handoff intact, retain native criteria 1 and 2 as blocked, and report the task incomplete. No further diagnostic question is pending. The remaining prerequisite is a supported execution/control session attached to the laptop, including access to the interactive desktop for display selection and OS consent. Resume this same task from that environment with the retained commits, the required Projects storage/preflight workflow, and the existing Windows verification checklist. If such a session cannot be supplied, a concrete access/setup change needs separate authorization before installing/enabling remote access, changing routing or firewall policy, or expanding device credentials. This task does not silently waive native proof or install a new access service. No duplicate task or successor chain was created.

This continuation changes only the walkthrough and access evidence. It adds no runtime surface to exercise. The prior 28/19/4 test results were read again, and source-equality checks confirmed that the implementation still matches its tested commits (`nova-review.log:2`, `:3`). Tests/builds were not rerun just to relabel historical results. The fresh verification is the bounded connection attempt and route lookup above, plus strict UTF-8/mojibake, diff review and exact-revision Documents checks. The Android/TV blockers remain as previously observed; no new phone or TV test is claimed. Commit `3fed7bc64062b0be0dd2026d5c37ce8a81c4d5bc` from the preceding resume is retained, along with all earlier implementation/evidence commits.

## Historical bounded repair attempt 1 (20 October, 22:37–22:39 UTC)

Execution `47067bb1-4323-40d9-9d62-842177abc733` reproduced the reported blocker before editing. `uname -srm` returned `Darwin 25.5.0 arm64`; Computer Use returned `target:mac`, no connected browsers and no matching remote-desktop app (`docs/reviews/travel-displays-evidence/repair-1-access.log:3`, `:4`). Four three-second TCP attempts to Robert's supplied `192.168.4.34` timed out on ports 22, 3389, 5985 and 5986 (`repair-1-access.log:7`). The route remained gateway `192.168.86.1`, interface `en1` (`repair-1-access.log:12`). No authentication or remote command was attempted. These checks reproduce unavailable access from this executor; they do not identify the network cause or prove the laptop is off. The missing-`sshd` answer remains operator-reported evidence (`nova-operator-output.log:5`), not a fresh Windows command.

Fresh focused verification passed with exit code zero for each command:

- From TheNexus, `npx --no-install jest server/__tests__/presentations.test.js --runInBand --verbose`: **28 passed**, `repair-1-server-tests.log:35`. Lines 5–32 cover authentication, all projections, exact revision, source provenance, ambiguity, selected-view pairing, stop/revoke, expiry and independent controller/receiver leases.
- From `dashboard`, `node --import ./test/register.mjs --test src/components/__tests__/presentation-controller.test.mjs src/components/__tests__/presentation-view.test.mjs src/components/__tests__/document-markdown.test.mjs src/components/__tests__/document-media-viewers.test.mjs src/lib/__tests__/presentation-native.test.ts src/lib/__tests__/presentation-operations.test.ts`: **19 passed**, `repair-1-dashboard-tests.log:25`. Lines 13–22 exercise shell gating, exact-review selection, four read-only families, media, failed-refresh blanking and lifecycle serialization.
- From `/Volumes/Projects/nexus-shared`, `node --test test/presentations.test.cjs`: **4 passed**, `repair-1-contract-tests.log:10`. Lines 4–7 check exact identity, the four families, source provenance and ambiguity. No file in that repository was edited by this repair.

All abbreviated evidence filenames in this subsection are under `docs/reviews/travel-displays-evidence/`. The suites use local fixtures; they are not Windows runtime or physical-TV evidence. The earlier full Windows cross-build failure remains `NotAttempted("llvm-rc")` at `presentation-windows-check.log:315`; no new native build, installation or physical-display test was run. The original Chromium evidence identifies `windowsRuntime:false` and `physicalDevices:false` at `browser.log:1`. Android/TV inventory remains the historical observation at `hardware-inventory.log:1`: no attached Android at line 8 and a Nest Audio named Living Room speaker at line 54, which is not the selected TV. No current model, OS or receiver protocol is inferred.

**Historical ruling request, resolved by Robert at 22:46:** the implementation is retained and the native evidence gap is real. Criterion 4 expressly allows an “explicitly retained hardware blocker,” but criteria 1 and 2 remain unconditional native-observation gates. This repair was dispatched to the same Mac-only environment without the Windows execution/control prerequisite named in the failure. Repeating this dispatch cannot produce those observations. The dispute concerns whether the stated hardware fallback can defer that physical verification, not whether Mac fixtures count as Windows proof. Pending an explicit ruling, criteria 1 and 2 stay blocked and the task stays incomplete. If native observations remain mandatory before acceptance, the prerequisite is a Windows-connected execution/control environment with the retained source, required storage preflight and interactive display/consent access. Establishing new remote access remains a separately scoped setup decision; the answered SSH, pairing and device-selection questions are not repeated.

Historical dispute 1 (resolved by the operator ruling above) — Unmeetable as an immediate repair obligation in this unchanged Mac-only dispatch: repair-1-access.log:3–10 records Darwin, Mac Computer Use and four connection timeouts. Criterion 4 permits a retained hardware blocker while criterion 1 requires a chosen Windows display. Please rule whether that fallback defers only the physical verification or keep criterion 1 blocking pending a Windows-connected execution environment. The four-family and exact-revision requirements are preserved.
Historical dispute 2 (resolved by the operator ruling above) — Fresh laptop-origin discovery and physical start/stop/disconnect observations cannot be produced by the available Mac tools; repair-1-access.log:4–15 reproduces the missing connection. Please rule on the same criterion-4 fallback or require the Windows-connected environment before another implementation repair. No Mac inventory, mocked bridge or cross-compilation is offered as native proof.

This repair edits only documentation and evidence. Source-equality commands against retained Nexus commit `33fde73` and shared contract commit `367c543` returned exit zero (`repair-1-review.log:2`, `:3`). The new diff was read end to end; no runtime fix was invented for an access blocker. Strict UTF-8/mojibake validation and `git diff --check` passed. Existing local commit `fb64a2ad43128a79bb569be54dee77b6d4fa1494` and all earlier task commits are retained. This repair's local commit SHA is recorded in the final task walkthrough. No extra repository was edited; `/Volumes/Projects/nexus-shared` was read/tested for the shared contract only. The foreign `.env.example` remains unchanged by this run (`repair-1-review.log:4`). No installation, remote-access configuration, deployment, production casting, push or task-status mutation was performed. At that point independent QA and criterion rulings were outstanding. Robert subsequently resolved the deferral question; independent QA remains the normal next gate.

## Current verification after the ruling (20 October, 23:38 UTC)

All three predecessors again returned `completed` (`completion-ruling.log:9`, `:10`, `:11`). This continuation preserves the application source and updates documentation/evidence only. A fresh comparison of the 37 task-owned source paths against `a6bb71e` found no changes. The shared contract paths also still match `367c543`. Unrelated newer workspace-addition changes are excluded from task ownership; the foreign `.env.example` and shared-repository edits remain intact.

Fresh commands, each exit zero:

- TheNexus: `npx --no-install jest server/__tests__/presentations.test.js --runInBand --verbose` — **28 passed**, `completion-server-tests.log:35`.
- Dashboard: `node --import ./test/register.mjs --test src/components/__tests__/presentation-controller.test.mjs src/components/__tests__/presentation-view.test.mjs src/components/__tests__/document-markdown.test.mjs src/components/__tests__/document-media-viewers.test.mjs src/lib/__tests__/presentation-native.test.ts src/lib/__tests__/presentation-operations.test.ts` — **19 passed**, `completion-dashboard-tests.log:25`.
- `/Volumes/Projects/nexus-shared`: `node --test test/presentations.test.cjs` — **4 passed**, `completion-contract-tests.log:10`.

Evidence filenames in this and the following section are under `docs/reviews/travel-displays-evidence/`. These are fresh fixture-based checks, not physical hardware verification. The earlier production-build, browser and host-native logs remain dated history. No native build, binary installation, production restart or cast was performed in this continuation. The completion source reviewer found no Critical, Important or Minor issues; the review covers the three Nexus implementation commits and shared contract, excluding foreign work. Its result, source-equality checks and the parent's documentation diff/encoding checks are retained in `completion-review.log`. This is a completion review, not the normal independent Praxis QA verdict.

## Criterion-by-criterion evidence (operator ruling applied)

1. **Met as amended; native observation deferred until Robert gets home.** The ruling is explicit at `completion-ruling.log:4`. Fresh tests exercise all four read-only view families, exact displayed revision selection and media (`completion-dashboard-tests.log:14`, `:15`, `:16`, `:17`), existing controller authentication (`completion-server-tests.log:5`) and immutable revision/hash pinning (`completion-server-tests.log:9`, `:10`). The Windows native implementation is retained; no chosen Windows physical-display observation is claimed.
2. **Met as amended; native observation deferred until Robert gets home.** `completion-ruling.log:3`–`:6` records the exact scope. Fresh provenance, bounded inventory, stable identity, ambiguity, freshness and lifecycle tests pass (`completion-server-tests.log:6`, `:7`, `:12`; `completion-contract-tests.log:6`, `:7`). The Windows-only enumeration/selection adapter remains implemented. Fresh laptop-origin enumeration, physical placement, mixed DPI and unplug/reconnect observations remain on the deferred checklist.
3. **Met for the shared foundation.** Exact-view schemas and provenance pass (`completion-contract-tests.log:4`–`:7`); strict controller authentication, receiver API/credential isolation, expiry and Android inventory checks pass (`completion-server-tests.log:5`, `:14`, `:16`, `:19`, `:27`). Receiver reads and media omit controller cookies (`dashboard/src/lib/presentation-transport.ts:13`, `:37`). Unsupported methods remain explicit in the compatibility matrix; Android/Praxis native/runtime consumers remain their separate tasks.
4. **Met via the explicit hardware-blocker route and operator deferral.** Fresh focused suites pass 28/19/4 as cited above. The exact historical Windows cross-build failure is retained at `presentation-windows-check.log:315`, and browser fixtures explicitly record their Mac environment at `browser.log:1`. Native build/installation/runtime proof remains absent and clearly distinguished from passing local checks.
5. **Registered walkthrough with compatibility matrix, exact evidence and amended scope.** Stable document `470c263f-c519-49b8-8f5a-4c2e965dc787` was read at revision `cae74488-fc13-4257-8417-4f6d34fc64df` before editing. The completion handoff preserves that document identity and stable key. Its returned receipt and exact-revision raw/readiness checks establish delivery, not file existence or this sentence.
6. **Met via automated evidence and the explicitly allowed device blockers.** Fresh tests exercise scoped pairing, controller stop/revoke, expiry, stream revocation and exact-revision isolation (`completion-server-tests.log:12`–`:16`, `:22`, `:25`, `:29`–`:32`). Existing login and receiver credential omission remain covered by criterion 3. Windows observations are deferred; Android/Living Room TV availability remains explicitly historical inventory (`hardware-inventory.log:7`, `:54`) with models/protocols unknown. Physical pairing is not claimed.

## Commits and preservation

Primary workspace: `/Volumes/Projects/TheNexus`, dispatch branch `main`, QA baseline `423d8f8a25744c91d2dfc9e3b3da829a8ad94c3e`. Source commits: `4bc6710` (server), `4e71421` (Windows adapter), `23e56de` (renderer/controller/browser harness). The attributable source diff against the QA baseline contains **37 files, 3,036 insertions and 11 deletions**, as observed by `git diff 423d8f8a2574 --shortstat -- <37 task-owned source paths>` in this continuation (`completion-review.log:6`). Documentation/evidence are additional. Retained local task commits are `59855bd371adcc399d62409dbc9c95d1073fc3b9`, `33fde73fe929f65277e078aebd2d3fdd2595eaa5`, `3fed7bc64062b0be0dd2026d5c37ce8a81c4d5bc`, `fb64a2ad43128a79bb569be54dee77b6d4fa1494` and `a6bb71e6415d0d683aa86af6c6e4c3853336a1dd`. `git show --no-patch a6bb71e6415d0d683aa86af6c6e4c3853336a1dd` confirms the latter exists; the dispatch lookup used text search, which is not a Git object lookup. This continuation's local commit SHA is recorded in the final task response to avoid embedding a file's own commit identity in its bytes.

Additional declared repository `/Volumes/Projects/nexus-shared`: source contract commit `367c54329d6faeca76f125a41c83e33663654e19`, three task-owned files. Its pre-existing changes to `src/endpoints.ts`, `src/entities/project.ts`, `test/project.test.cjs` and untracked `test/endpoints.test.cjs` were left untouched. No other source repository was edited. No commits were pushed.

All three predecessor IDs still read `completed` (`docs/reviews/travel-displays-evidence/preflight.log:2`). The research document remained approved at revision `32ed69cf-96a6-41fd-9fe6-21d458b921f5`, hash `68b1637becd15029714286cad870d1fe346ab022992cb144d3fe4eb84c192e5f` (`preflight.log:6`). Its current registry/history and original submission comments were read; its file and comments were not edited. The foreign `.env.example` is byte-identical to the dispatch snapshot, SHA-256 `e87f409424c736d95b28120b31ffb7411ee39198e7199c581b57a81ff1a093ab` (`preflight.log:7`). The prior menu work was preserved.

## Files touched

This operator-ruling continuation changes only the walkthrough, internal plan and completion evidence:

- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-windows.md
- /Volumes/Projects/TheNexus/docs/superpowers/plans/2026-10-20-travel-displays.md
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-ruling.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-server-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-dashboard-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-contract-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-review.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-handoff.json
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/completion-handoff-verification.json

Bounded repair attempt 1 changes the walkthrough and the following evidence/receipt files only:

- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-windows.md
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-access.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-server-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-dashboard-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-contract-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-review.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-handoff.json
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/repair-1-handoff-verification.json

The 22:07-answer continuation changes the walkthrough and `nova-*` evidence/receipt files. The preceding resume changed the `resume-*` files. All implementation files remain at the retained commits.

- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/nova-operator-output.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/nova-access-check.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/nova-review.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/nova-handoff.json
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/nova-handoff-verification.json

- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-session-check.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-server-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-dashboard-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-contract-tests.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-review.log
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-handoff.json
- /Volumes/Projects/TheNexus/docs/reviews/travel-displays-evidence/resume-handoff-verification.json

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

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/TheNexus` and `/Volumes/Projects/nexus-shared`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.
