# Live transport — Phase 2 design

Ticket P3-30. Phase 1 shipped (see the end of this doc for what is already in
place). This document is the **design only** for Phase 2: retiring the SSE
route, moving the remaining hooks onto the shared context, and having Praxis
publish ops-events directly to the Nexus socket instead of through SSE.

Nothing in Phase 2 has been implemented. Each section names the change, the
order it has to happen in, and what can go wrong.

---

## Where Phase 1 left the system

Today a Praxis operational event travels:

```
Praxis src/ops-events.ts
  → ops-events-routing.ts
  → Praxis src/routes/stream.ts   (GET /stream, SSE + ring buffer + /presence)
  → TheNexus server/services/praxis-client.js  praxisStream()   (one upstream SSE)
  → TheNexus server/routes/praxis-stream.js    broadcast()
        ├── downstream SSE  → GET /api/praxis/stream  → dashboard usePraxisStream()
        └── io.emit('praxis:event', frame)            → dashboard LiveBoardStateProvider
```

So there is **one upstream connection** (Praxis → Nexus) and **two downstream
transports** (Nexus → browser). The dashboard's `LiveBoardStateProvider`
consumes both and dedupes by `eventId`, which is what makes each phase
independently shippable: either downstream transport can die without freezing
the migrated surfaces.

Phase 2 removes the SSE downstream, then removes the SSE upstream.

---

## Step 1 — Move the remaining hooks onto `useLiveBoardState()`

Must happen first: the SSE route cannot be removed while anything still opens
an `EventSource`.

### Still on the SSE store (`usePraxisStream` / `useStreamRefetch`)

| Consumer | What it uses the stream for | Target |
| --- | --- | --- |
| `hooks/use-praxis-stream.ts` | owns the EventSource | delete last |
| `hooks/use-stream-refetch.ts` | debounced refetch on event types | delete; `useLiveRefetch` supersedes it |
| `hooks/use-crew-activity.ts` | executor progress frames | `useLiveBoardState().recentEvents` + `system` domain |
| `hooks/use-active-work.ts` | task lifecycle + its own poll | `useLiveRefetch(["task"])` |
| `hooks/use-core-state.ts` | council/presence + council poll | `useLiveRefetch(["system","activity"])` |
| `hooks/use-hitl-inbox.ts` | `hitl.created` / `hitl.resolved` | new `hitl` domain (see below) |
| `components/bridge/event-ticker.tsx` | the raw event feed | `useLiveBoardState().recentEvents` |
| `components/bridge/praxis-core.tsx` | presence | `useLiveBoardState().presence` |
| `components/bridge/ambient-mode.tsx` | presence + events | same |
| `components/bridge/status-strip.tsx` | presence badges | same — **owned by another session, coordinate** |
| `components/bridge/taskboard-station.tsx` | board refetch | `useLiveRefetch(["board","task"])` |
| `components/bridge/dispatch-station.tsx` | dispatch state | new `dispatch` domain — **owned by another session** |
| `components/bridge/voice-command-bar.tsx` | presence/thinking | `useLiveBoardState()` |
| `components/praxis-status-panel.tsx` | presence | `useLiveBoardState().presence` |
| `components/presence-indicator.tsx` | presence | `useLiveBoardState().presence` |
| `app/inbox/page.tsx` | hitl events | `hitl` domain |

### Still on plain `setInterval`, no stream at all

These are a second, larger tranche — they poll the Nexus API for state that has
no Praxis stream frame behind it. **Shipped as ticket D-1; see
§ "Second tranche" below for what each one actually became.** They should move to `useLiveRefetch` with the
right domain **and keep their fallback poll**, since for several of them the
fallback poll is the only correctness guarantee:

`app/core-lab/page.tsx`, `app/council/page.tsx`, `app/knowledge-ingestion/page.tsx`,
`app/llm-activity/page.tsx`, `app/local-queue/page.tsx`, `app/ops/page.tsx`,
`app/system-monitor/page.tsx`, `app/task-board/page.tsx`*, `app/task/[id]/page.tsx`*,
`components/bridge/academy-station.tsx`, `components/bridge/knowledge-station.tsx`,
`components/bridge/power-station.tsx`, `components/llm-activity-widget.tsx`,
`components/local-queue-list.tsx`, `components/model-status-panel.tsx`,
`components/task-manager.tsx`, `components/usage-routing-panel.tsx`,
`hooks/use-autonomy.ts`*, `hooks/use-board-state.ts`, `hooks/use-comms.ts`,
`hooks/use-dispatch-state.ts`, `hooks/use-executor-models.ts`, `hooks/use-qa-holds.ts`*,
`hooks/use-token-usage.ts`, `hooks/use-voice-status.ts`

`*` = currently uncommitted work owned by another session; migrate only after
that work lands.

**Clock ticks are not pollers.** Several of the intervals above only advance a
"now" cursor (`setNow(Date.now())` in `council`, `schedule-timeline`,
`usage-routing-panel`, `event-ticker`, `use-core-state`). Those stay as they
are — they touch no network and no transport change affects them.

### New domains needed

`LiveDomain` currently covers `board | task | schedule | system | activity`.
Phase 2 adds at least `hitl` (inbox badge correctness) and `dispatch` (the
dispatch station and CLI-lane panels). Adding a domain is additive: the switch
in `domainsForEvent()` gains cases, and existing consumers are unaffected
because the counters are independent.

### Risks

- **Missed invalidation.** `domainsForEvent()` is a hand-written map from event
  type to affected domains. If Praxis adds an event type and nobody updates the
  map, it falls into `default → ["activity"]` and a board surface silently stops
  refreshing except on the fallback poll. *Mitigation:* keep the fallback poll
  on every migrated surface (Phase 1 already does), and add a contract test that
  every `StreamEvent["type"]` in `@praxis/contract` has an explicit case.
- **Losing the "poll is the only source" cases.** Commits in the activity feed,
  git status, token usage, and disk/port stats produce no Praxis event at all.
  Removing their poll in favour of events would freeze them. *Mitigation:* the
  fallback poll is mandatory, not optional, for those surfaces.
- **Write-then-read races.** Components that mutate (dispatch station, task
  page) currently refetch immediately after their own POST. Event-driven
  refetch is *additional*, never a replacement — the local refetch must stay or
  the UI lags one round-trip behind the user's own action.

---

## Second tranche — the remaining `setInterval` pollers (ticket D-1, SHIPPED)

Step 1's second tranche is done. Every network poller in the dashboard now runs
through `useLiveRefetch`, so there is exactly **one** polling mechanism on the
deck and `grep -rn "setInterval" src` returns only clock ticks, the shared
module-level stores, and `useLiveRefetch`'s own fallback timer.

The finding that shaped the tranche: **of the eighteen surfaces, only the
council chamber had a Praxis event behind its data.** Everything else polls
Nexus- or host-side state that `publishOperationalEvent()` never sees. Those
did not get a fake domain; they were routed through `useLiveRefetch` with **no
domains and `fallbackPollMs` = their old interval**, which changes no timing
but puts every poller in one place — and makes the "what event would Praxis
need to publish" column below the actual backlog for making them live.

### Migrated to an event + fallback

| Surface | Old interval | Event type | Domain | New fallback |
| --- | --- | --- | --- | --- |
| `app/council/page.tsx` (archive list) | 5s live / 30s idle | `council.update` | `council` (new) | 5s live / 30s idle |
| `app/council/page.tsx` (transcript) | 5s while live | `council.update` | `council` (new) | 5s live / none once complete |

`council.update` carries a **complete snapshot** on every persisted council
mutation — convene, each thesis landing, the synthesis handoff, the verdict —
so a seat reporting repaints the chamber at once instead of up to 5s later. The
poll stays underneath at the old cadence: the transcript is a surface an
operator watches live, and a session ageing out of the 3h live window changes
the archive with no frame behind it.

### Poll-only, routed through `useLiveRefetch([], …)`

No stream event describes this data today. The last column is what Praxis would
have to publish for the surface to become event-driven.

| Surface | Old interval | New fallback | Event Praxis would need |
| --- | --- | --- | --- |
| `app/llm-activity/page.tsx` | 5s | 5s | `llm.call` (caller, provider, model, tokens, latency) |
| `components/llm-activity-widget.tsx` | 10s | 10s | `llm.call` |
| `components/bridge/power-station.tsx` | 15s | 15s | `llm.call` |
| `app/local-queue/page.tsx` | 5s | 5s | `localllm.job` (queued/started/finished + job id) |
| `components/local-queue-list.tsx` | 5s | 5s | `localllm.job` |
| `app/system-monitor/page.tsx` | 5s | 5s | none — host CPU/disk/port sampling is Nexus-side, not a Praxis concern; the poll IS the source |
| `app/knowledge-ingestion/page.tsx` | 30s | 30s | `ingestion.run` (run started/finished, per-source counts) |
| `components/bridge/knowledge-station.tsx` (stats) | 60s | 60s | `ingestion.run` |
| `components/bridge/knowledge-station.tsx` (topic map) | 5m | 5m | `ingestion.run` (map recompute is expensive — a coalesced "map rebuilt" frame) |
| `components/bridge/academy-station.tsx` | 60s | 60s | `skill.acquired` (name, category) — the station already animates on a total delta it has to detect by polling |
| `components/model-status-panel.tsx` | 30s | 30s | `usage.hold` (model/family held or released, reason, until) |
| `components/usage-routing-panel.tsx` | 60s | 60s | `usage.hold` + a routing-decision frame |
| `hooks/use-token-usage.ts` | 60s | 60s | none — spend is accumulated by the Nexus counter; the poll IS the source |
| `hooks/use-executor-models.ts` | 60s | 60s | `credential.changed` (executor lane, provider key valid/expired) |
| `hooks/use-comms.ts` | 60s | 60s | `comms.received` (channel, sender, at) |
| `hooks/use-voice-status.ts` | 5m | 5m | `voice.status` (green/yellow/red + reason) — this hook exists *because* the ElevenLabs quota running dry was silent for ~36h |

`usage.hold`, `llm.call` and `voice.status` are the three worth having: each is
a correctness surface where the operator is being told "dispatch is fine" by a
number that can be up to a full interval stale.

### Deliberately NOT migrated

| Surface | Interval | Why it stays |
| --- | --- | --- |
| `app/core-lab/page.tsx` | 7s touring / 30s | Tour cursor + a `now` tick over **synthetic** scenarios. Touches no network. |
| `app/council/page.tsx` `LiveSessionPanel` | 1s | Clock tick (elapsed-time label). |
| `components/schedule-timeline.tsx`, `bridge/event-ticker.tsx`, `bridge/dispatch-station.tsx` (:351), `hooks/use-core-state.ts`, `hooks/use-crew-activity.ts`, `components/usage-routing-panel.tsx` | 1s–30s | Clock ticks — `setNow(Date.now())` / re-render cursors, no fetch. |
| `app/task-board/page.tsx`, `app/task/[id]/page.tsx`, `bridge/ambient-mode.tsx`, `bridge/dispatch-station.tsx` (:324) | 5s–30s | Out of D-1's scope — first-tranche surfaces owned by other sessions. Still on plain intervals; fold in when that work lands. |
| `components/task-manager.tsx` | 10s ×2 | Not a steady-state poller: a **bounded completion poll** started by an auto-research run and cleared the moment the run leaves `researching` (with a 5-minute cap). `useLiveRefetch` has no start-on-action / stop-on-condition semantics, and wrapping it would turn a self-terminating loop into a permanent subscription. Revisit if a `research.completed` frame ever exists. |
| `components/bridge/voice-command-bar.tsx`, `hooks/use-voice-recorder.ts` | sub-second | Audio silence detection and a recording timer. |
| `hooks/use-board-state.ts`, `use-dispatch-state.ts`, `use-autonomy.ts`, `use-qa-holds.ts` | 20s–60s | Module-level shared stores, already migrated in the first tranche: the store's own timer IS the fallback, so their `useLiveRefetch` passes `fallbackPollMs: 0`. |

### The contract test the risk section asked for

`src/components/__tests__/live-board-state-contract.test.ts`. The `switch` with
a `default` in `domainsForEvent()` was replaced by an exported
`EVENT_DOMAINS: Record<StreamEventType, LiveDomain[]>`, so a new Praxis event
type is a **type error** at build time. The test re-checks the same thing at
runtime against `StreamEventSchema`'s zod union — the shape actually on the
wire — because the vendored `@praxis/contract` types can be stale while the
stream is not. It also asserts the reverse (no entry the contract dropped),
that every mapped domain is a real `LiveDomain`, and that a genuinely unknown
type still falls back to `["activity"]` so a newer Praxis cannot freeze feeds.

Writing it surfaced three event types that had been silently landing in the old
`default` branch: `trade.signal`, `trade.filled`, `trade.blocked`. They are now
explicit (`["activity"]` — this deck has no trading surface), which is the same
behaviour, but stated rather than inherited.

---

## Step 2 — Retire the downstream SSE route

Only after step 1 leaves `usePraxisStream` with zero callers.

1. Delete `dashboard/src/hooks/use-praxis-stream.ts` and
   `dashboard/src/hooks/use-stream-refetch.ts`.
2. In `LiveBoardStateProvider`, drop the SSE half: the `usePraxisStream()` call,
   the SSE drain effect, and the `sse.*` fallbacks in the memo. The dedupe set
   stays — the socket itself can redeliver on reconnect.
3. Replace the SSE bootstrap with a socket-side snapshot. Presence currently
   arrives from `GET /api/praxis/stream/snapshot` on EventSource open. On the
   socket, the server should push a `praxis:snapshot` on `connection` (and the
   client should re-request one on `reconnect`), so there is no blank-UI window.
4. Keep `GET /api/praxis/stream` alive for one release with a deprecation log
   line, then delete the `router.get('/stream', …)` handler, the `subscribers`
   set, and the downstream heartbeat in `server/routes/praxis-stream.js`.
   **Keep the ring buffer** — it becomes the socket's replay source (step 3).

### Risks

- **Mobile.** The relay comment says the socket fan-out exists *because* mobile
  cannot easily consume SSE — but check `TheNexus` mobile and any other client
  before deleting the route. An unknown SSE consumer outside this repo would
  break silently; the deprecation-log release is what surfaces it.
- **Gap replay.** SSE gives `Last-Event-ID` replay for free; Socket.IO does not.
  Without an explicit `{ since: lastEventId }` handshake, a reconnecting tab
  silently misses everything that happened while it was away. This is the single
  most likely source of "the board is stale and nobody noticed" — the ring-miss
  path must emit `stream.reset`, which `domainsForEvent()` already treats as
  invalidate-everything.
- **Proxy differences.** Socket.IO needs websocket upgrade through the
  Cloudflare tunnel and the Next `/api` proxy. SSE works over plain HTTP where
  websockets are blocked. Confirm the tunnel's `/socket.io/*` ingress rule holds
  for every access path (LAN, tunnel, mobile) before removing the HTTP fallback.
  Socket.IO's own long-polling fallback covers most of this, but only if
  `transports` is left at its default — do not pin it to `["websocket"]`.

---

## Step 3 — Praxis publishes to the Nexus socket directly

The last hop. Today Praxis exposes `/stream` and Nexus pulls; afterwards Praxis
pushes into the Nexus socket server and `/stream` exists only for debugging.

Two shapes, in preference order:

**A. Praxis posts to a Nexus ingest endpoint** (`POST /api/praxis/events`,
bridge-token authenticated), and the Nexus route does `io.emit('praxis:event')`
plus the ring push. `publishOperationalEvent()` in `src/ops-events.ts` already
funnels every event through one function, so the change is one new sink
alongside the existing SSE sink in `ops-events-routing.ts`. Simple, testable,
no new long-lived connection, survives either process restarting independently.

**B. Praxis holds a socket.io-client connection to Nexus** and emits on it.
Lower latency and no per-event HTTP overhead, but adds a client library and a
reconnect state machine to the Praxis runtime, and inverts the current
dependency direction (Praxis becomes a client of the cockpit).

Recommend **A**: the event rate is low (operational events, not telemetry), and
per-event HTTP into a local process is not the bottleneck. Reserve B for if
event volume ever grows to per-token streaming.

Either way, `/stream` and `/presence` on Praxis stay: they are the debugging
surface and the snapshot bootstrap, and the ring buffer behind them is what
makes replay possible.

### Risks

- **Ordering and loss.** SSE over one TCP connection is ordered; N independent
  POSTs are not, and a failed POST is a lost event with no retry. The ingest
  path needs a monotonic sequence number and a bounded retry queue on the Praxis
  side, or the ring buffer stops being a truthful replay source.
- **Startup order.** Today Nexus reconnects to Praxis with backoff, so either
  can boot first. With Praxis pushing, Praxis must buffer while Nexus is down
  (launchd restarts, `self_upgrade`) instead of dropping. Bound that buffer — an
  unbounded one turns a Nexus outage into a Praxis memory leak.
- **Auth surface.** A new inbound write endpoint on Nexus that fans out to every
  connected browser is worth treating as security-sensitive: bridge-token
  required, loopback-only, and covered the way
  `server/__tests__/mcp-boundary-security.test.js` covers the MCP seam.
- **Losing the single choke point.** The relay's `broadcast()` is currently the
  one place HITL push notifications are triggered (`notifyHitlCreated`). Any
  new ingest path must run through the same function, or HITL pushes stop
  firing while the UI still looks correct.

---

## Suggested order

1. New `LiveDomain` values (`hitl`, `dispatch`) — additive, ships alone.
2. Migrate the remaining stream hooks (step 1, first table).
3. Migrate the remaining pure pollers (step 1, second table) — several files
   need another session's work to land first.
4. Socket snapshot + `{ since }` replay handshake. **Prerequisite for step 5.**
5. Delete the SSE route and hooks (step 2).
6. Praxis → Nexus ingest endpoint (step 3, option A).

Steps 1–3 are independently shippable and reversible. Step 5 is the first
one-way door; do not take it before step 4 is proven against a real reconnect.

---

## Appendix — what Phase 1 actually shipped

- `dashboard/src/lib/live-socket.ts` — refcounted single Socket.IO connection
  for the whole tab, shared by `CortexProvider` (chat) and the live context.
- `dashboard/src/components/live-board-state.tsx` — `LiveBoardStateProvider`,
  `useLiveBoardState()`, `useLiveRefetch(domains, cb)`; per-domain revision
  counters, cross-transport dedupe by `eventId`, mandatory 60s fallback poll.
- `dashboard/src/app/layout.tsx` — provider mounted inside `CortexProvider`.
- `server/routes/praxis-stream.js` — the `io.emit('praxis:event', frame)`
  fan-out alongside the SSE relay (it predates this ticket; Phase 1 added the
  regression test that pins both paths).
- Migrated: `activity-feed`, `resource-monitor`, `schedule-timeline`,
  `compact-task-board`.
