# Nexus API traffic, November 20, 2026

Nexus received **2,800 requests in 15 minutes** during an executor run with an active dashboard and mobile client. The largest repeatable costs were Praxis leasing tasks whose schedule and board status already agreed, and several dashboard components polling for the same data. The sample did not exhaust the old allowance. The November 19 logs establish the refusal and restart sequence but cannot identify the exact mix of the 6,000 earlier arrivals.

## Who called Nexus

One complete window, **19:22:53.042 to 19:37:53.042 UTC** (14:22 EST). Counts include 68 exact health reads, which already had their own allowance. The other 2,732 would enter the general limiter before this patch.

| Caller | Requests | Main routes and cadence |
|---|---:|---|
| Dashboard browser | 1,661 | Active dispatches 351, 10 s per mounted hook plus task/dispatch events. Chat activity and knowledge activity 180 each, 5 s each. Council sessions 166. The orb refreshed on activity and system frames plus a 30 s timer, and Ops polled separately every 5 or 30 s. Pending inbox 136, live events, 60 s fallback and activity-feed evidence reads. Dispatch state 73, 20 s plus events. LLM log 62, 15 s. Token usage 60, typically 60 s per widget. |
| Praxis runtime | 1,042 | 180 lease acquisitions, 180 releases, 220 task reads, 128 event posts, 34 chat-config reads, 32 board reads, 29 calendar reads and 29 health probes. Two calendar loops tick every 60 s. Supervisor health normally runs every 30 s. Event posts follow incoming frames. |
| Mobile client/relay | 68 | Fleet health, service health and Studio channels 18 each, board 14. This route mix matches the iPad hub's 60 s fast and 300 s full refresh, plus view and manual refreshes. |
| Nexus internal | 18 | One GET of its own health route for each incoming fleet-health check. |
| Executor/CLI directly identified | 0 | No command-line or headless user agent. Executor work can also cause calls through Praxis. |
| Unresolved Node | 11 | Four task GETs, two model resolves, one each for projects, workspace delta, activity publish, stream publish and calendar. |
| **Total** | **2,800** | 60 distinct caller/method/route combinations including separately labelled inferred Praxis rows. |

At the Nexus capture baseline (`fddc44b5bfbe`), the dashboard intervals are in `dashboard/src/hooks/use-active-work.ts:58`, `use-chat-activity.ts:36`, `use-core-state.ts:65`, `use-dispatch-state.ts:22`, `use-hitl-inbox.ts:86`, `use-token-usage.ts:11`, and `dashboard/src/components/bridge/{activity-provider.tsx:60,dispatch-station.tsx:268,power-station.tsx:160}`. The runtime paths are `Praxis/src/scheduler/calendar-sync.ts:446`, `Praxis/src/calendar-dispatch.ts:516`, `Praxis/src/supervisor/heartbeat.ts:58` and `Praxis/src/ops-events-routing.ts:845`. The mobile implementation is in `Praxis iPad Home Hub/PraxisHub/Views/ContentView.swift:52` and `FleetDashboardManager.swift:104`. The resulting internal probe is in `server/routes/fleet.js:22`.

The November 19 log shows dropped events, calendar and lease refusals, a 429 on health, and the restart between 15:56:56 and 15:57:54 UTC. It lacks successful-request attribution. A temporary HTTP diagnostics subscriber therefore counted arrivals on November 20 and unsubscribed at the window boundary. Agents identified browser and mobile families. Socket samples within five seconds matched 712 requests to the Praxis PID. Another 330 fell within contiguous acquire/read/release triples with a matching peer and under one second elapsed. Tab count is unknown. `requests.tsv` contains normalized, timestamped arrivals. `traffic.tsv` contains their totals. Both omit headers, queries, ports and task identifiers.

## What changed and how much it saved

The before and after columns below use the same input, with temporary services or counted fetches. None of the after figures is a post-deployment traffic estimate.

| Scenario | Before | After |
|---|---:|---:|
| Three active-work panels, one 60 s refusal, first 50 s | 18 active GETs | 1 GET, followed by one successful read at 60 s |
| Three token-usage panels over the same first 50 s | 3 GETs | 1 GET |
| Orb and Ops over 67 s, including three executor frames, a council convening and 30 s hidden | 12 council-session GETs | 5 GETs, including one at foreground return. Executor frames and hidden time caused zero. |
| Closed ambient overlay and three inbox readers on mount | 7 reads (4 telemetry, 3 inbox) | 1 inbox read |
| Activity batch without an actionable human request | 1 pending-inbox read | 0 |
| Four already-settled schedule slots, one sweep | 12 requests | 1 status projection, 0 leases |
| Four stream events arriving during a 60 s refusal | 4 refused posts, 4 events discarded | 1 refused post, 1 successful batch after reset, queue empty |
| Three simultaneous model-setting notifications | 27 Nexus reads, including 6 chat-config | 8 Nexus reads, including 1 chat-config |
| Model-control and calendar test suites pointed at a counting Praxis endpoint | 16 outbound refresh notifications | 0 |
| Three ordinary reads through the browser verification harness | 3 sent to its shared-API destination (intercepted) | 0 shared, 3 isolated. Chrome's direct connection also reached the isolated peer. |

The live schedule had 11 completed slots matching SQLite plus one separate recovery intent. Each minute produced 12 acquire/read/release triples. Praxis now reads all slot statuses in one query. Mismatches and recovery intents still use the authoritative lease and task version. A 404 uses the old sweep during rolling upgrades. Model changes share the existing debounced state-document refresh. The event publisher retains refused events until reset.

Active work and usage share a timer and an in-flight read per page. Hidden tabs skip those reads. The root inbox provider owns one subscription, and the ambient overlay loads telemetry only while open. Browser reads honor both Retry-After formats, keep health independent and scope upstream refusals to their route. Writes are never automatically replayed. The two 5 s feeds serve different data and each fired once per interval.

The orb and Ops now share the twelve-session response. The orb uses the latest five. Council updates trigger a shared refresh, and the timer runs every 30 seconds when idle or every five seconds while Ops follows a sitting council. During the hidden portion of the test, arbiter and bench reads also fell from three each to zero.

The original server tests triggered 16 real state collections in the sample. Live Praxis logged a generated `/Volumes/Projects/shared-mind/STATE.md` rewrite at 19:23:51.905Z. The matched test above used a counting receiver and verified zero notifications after the fix. The historical browser QA report records port 4000 as its upstream (`docs/reviews/2026-11-19-retired-backend-calls/after/report.json:8`). Its 401 desktop requests include assets and postdate the restart.

## Allowance decision

`git show af28370d1224 -- server/server.js` traces 6,000 to a July change from 1,000 after two viewers had encountered refusals. The author recorded about 25 requests per minute per tab, without a resource calculation for 6,000.

Authenticated loopback Praxis traffic has **no request-count quota**. Its proof derives from the existing independent runtime credential and grants no route permission. The client sends it only to the configured local API and refuses redirects. Other callers retain a per-IP allowance. GET health keeps its own store. A refusal logs caller, method, route, lane and reason and returns Retry-After.

Each bounded store defaults to **5,758 requests per IP per 15 minutes**. One core provides 900,000 ms in the window. On a private SQLite backup, 11 full-board reads each serialized 28,087,299 bytes with median process CPU of 156.3 ms. A repeat measured 160.5 ms. The 5,758 figure uses a full-board read as a common cost unit. Per-IP counters cannot enforce aggregate CPU consumption across addresses.

Production after-counts await integration and restart. The task evidence folder contains the matched scenarios, commands and baseline failures in `verification.txt`.
