# Activity evidence in Current Focus: contract v1

The Current Focus panel attributes live work to projects from several Praxis
feeds (run registry, CLI queue, continuation ledger, open input requests,
saved CLI sessions, and the live event buffer). This document fixes how those
feeds are combined so the panel never reports more certainty than the feeds
carry. Implementation: `dashboard/src/lib/current-focus.ts`
(`deriveCurrentFocus`, `phaseEvidence`) and the row renderer in
`dashboard/src/components/bridge/current-focus.tsx`.

## Rules

1. **Durable lifecycle is kept separately from fresh activity.** Every row
   carries `lifecycle`: the board status and its timestamp, and the newest
   run-registry record for the task (status, last recorded phase, time),
   superseded only by a confirmed terminal event that is newer. Freshness
   rules may withhold a live sub-phase, but they never erase this record;
   the panel prints it on every row as "Last recorded".
2. **Unavailable telemetry is null plus a reason, never guessed.** Model and
   phase are `FocusTelemetry` values: `{ value, reason, source, at }`. When
   `value` is null, `reason` says why (feed unavailable, no run, no session
   model, phase report too old, start default). The panel renders the reason
   in place of the value instead of a bare "not reported".
3. **Conflicting feeds are reconciled by freshness and the losing claim is
   kept.** Queue entries, saved waits, blocked board statuses
   and active runs are timestamped claims on a task. The newest claim decides
   the row's status. A displaced claim is appended to `conflicts` with both
   timestamps, and the panel lists it as "Feeds disagree". A live run against
   a task the board no longer lists as active is also recorded as a
   disagreement. A terminal event newer than a run supersedes it, and the run's
   outcome moves into `lifecycle`.
4. **A cached phase implies neither provider health nor a tool sub-phase.**
   The Praxis run registry keeps one `phase` per run. It is set to `thinking`
   when the executor process is spawned (a start default, not a report) and
   afterwards changes only when a tool report arrives, so its timestamp marks
   the last change rather than the last activity. Therefore:
   - Praxis lifecycle steps (`dispatching`, `loading`, `committing`,
     `completing`, ...) are shown as recorded; they are not model claims.
   - A tool phase (`thinking`, `writing`, `testing`) is shown only while its
     report is within `FRESH_MS` (5 minutes, the existing stale window).
   - `thinking` additionally needs a report message (the tool or trace that
     carried it). A bare spawn-time `thinking`, or a registry-only `thinking`
     with nothing in the live event buffer, is not evidence.
   - Without evidence the row shows **Running** with the reason underneath,
     not Thinking, Building or Testing.
   - A saved CLI session names the model the session was opened with. Its
     `lastUsedAt` is touched when the session is opened or resumed, not per
     turn, so the model is attributed with the source "saved session" (shown
     inline beside the model, not only in a tooltip) and a reason stating that
     it proves neither provider health nor a live turn. A run's own `model`
     field takes precedence when present.
5. **Freshness is a function of elapsed time and feed availability, not of a
   new snapshot arriving.** The shared board and dispatch stores keep their
   last good snapshot by reference while their pollers fail, so a derivation
   memoized on snapshot references alone would freeze: a "Testing" row stayed
   fresh for the whole outage (QA finding, 2026-09-20). Therefore:
   - `useCurrentFocus` re-derives on a 30 second tick (`FOCUS_TICK_MS`) with
     the current clock, so a phase report ages out of the window even when no
     new snapshot arrives.
   - The hook passes `feed: { available, snapshotAt }` from the dispatch
     store. While the feed is failing, every tool-phase claim from the frozen
     snapshot is withheld with the reason "Run feed has not refreshed since
     HH:MM UTC", queued, waiting and board-only rows carry the same feed
     reason instead of asserting that no run exists, and a running row is
     marked stale once the snapshot itself is older than the window unless an
     independent live progress report supplies its own activity timestamp. Live
     progress is evaluated against its own freshness window even during a
     polling outage; the hook reports the polling outage separately. The
     recorded lifecycle is kept throughout.
6. **An open question is not evidence about execution.** `ask_robert`
   proceeds without suspending the run (Praxis `src/tools/core-tools.ts`
   around line 1691) and the contract's `HITLRequest` carries no blocking
   flag. Execution claims from the board, queue, saved waits and active runs are
   reconciled first, independently of requests. The newest open request is
   then attached through its approval link, without changing the selected
   status, evidence or conflicts. A question cannot promote an older run over
   a newer recovery hold. Without an execution claim, the request has its own
   awaiting-input row. A request row without a run says only "No
   active run is reported for this task while this question is open" (or the
   feed reason when the feed is unavailable), never that no turn is in
   flight. A suspended task reaches the board as a blocked status, which is a
   separate claim.

## Where the feed semantics come from

Read in the Praxis repository on 2026-09-20 (paths relative to
`/Volumes/Projects/Praxis`):

- `src/executors/run-registry.ts` `onStreamEvent`: the registry updates
  `run.phase` and `run.updatedAt` only when an `executor.progress` event
  carries a different phase.
- `src/executors/claude-code.ts` line 1255, `src/executors/codex.ts` line
  1296, `src/executors/antigravity-cli.ts` line 890: each executor emits
  `phase: "thinking"` with no message immediately after spawning the process.
- `src/executors/claude-stream.ts` `phaseForTool` and the tail poller around
  line 456: later phases are derived from `tool_use` blocks and carry the tool
  and argument in `message`.
- `src/executors/session-registry.ts` lines 160 to 214: `lastUsedAt` is set
  on open, resume and `refreshOpenSession`, not per model turn.

## Provenance of the rules

Evidence read through the read-only Praxis bridge (`cortex_memory`
action=find then action=read), checked 2026-09-20, source
`report:2026-09-20.md`, sha256
`4f42b681cace2602f987a5a824ad68c3652acfe3f8f7f5894cae6f82690f3074`.

From "UI: activity indicators for Commander, Captain and task sessions",
krazyjakee/21x issue 95 (published 2026-09-19T20:59:21Z), report line 486,
read spans `7332a858…9be9cf0` (offset 91300) and `cf25a25d…779eea` (offset
92922):

> Preserve last-known durable lifecycle separately. Within the same current
> run: validate freshness first; confirmed terminal outcomes supersede earlier
> active events; current blocking request > speaking > listening > tool >
> thinking > running > queued > idle. Queue/active conflicts require
> reconciliation, not guessing.

> initSession defaults to working and transcript-only hydration can default to
> idle; neither is authoritative evidence for the proposed indicator.

> a cached activeTurnId proves neither provider health nor a tool subphase.
> Without phase evidence show running, not tool/thinking.

From "M030 — Live run observability and benchmark telemetry contract",
Michel836/trajectory-os issue 232 (published 2026-09-19T14:09:04Z), report
line 263, read span `d294f10d…942c6` (offset 50803):

> Frontends must read the same durable source of truth. Do not build operator
> state by grepping historical logs. ... Define semantics so process
> completion and trust readiness cannot be confused.

> telemetry unavailable values are null + reason, never guessed;

**Limits of this evidence.** Both passages are the ingestion report's
captured excerpts of third-party issue text, not the issues themselves, and
neither describes Praxis. They were adopted because the Praxis feeds have the
same shape: a cached per-run phase (the analogue of a cached
`activeTurnId`), a spawn-time default that is not a report, and several feeds
that can name one task at once. The trajectory-os "same durable source of
truth" requirement is satisfied here only in the narrow sense that the panel
reads Praxis's run registry and event stream rather than log files; the panel
does not verify that those feeds agree with Praxis's own persistence, and the
5 minute freshness window is the panel's existing stale threshold, not a
value from either source.
