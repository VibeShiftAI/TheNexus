# Predecessor automatic start

User approved keeping prepared linked work visible, distinguishing it from actual queued work, and providing an action to queue it for automatic execution after predecessors finish.

Goal: Calendar/Home follow-ups stay visible after their prerequisite completes. Explicit operator action registers durable automatic-start intent in Praxis; all dependencies must complete and ordinary dispatch safeguards still apply. Already-complete dependencies allow immediate dispatch/CLI capacity queueing. Cancel removes pending intent without cancelling a running task.

Architecture: Praxis owns a small durable automatic-start registry and bounded poller using the existing dispatcher. Nexus proxies operator-authorized mutations and joins registry state with its read-only live-work projection. Dashboard uses one reusable action component and distinct prepared/automatic-start/CLI-queued wording. No changes to task scope, no force dispatch, no automatic authorization of the Canva task by this development request. Use existing working trees; preserve all unrelated edits. No commits.

- [x] Runtime: tests first for persistence, all-predecessor gating, already-ready, cancellation, duplicate requests, held and uncertain dispatch, restart, changed contracts, missing predecessor, completed/cancelled tasks. Add registry, route/state and boot poller wiring.
- [x] Nexus: tests first for operator-only proxy and persistent prepared follow-ups after completed dependency; integrate runtime automatic-start state without treating planning as execution queue.
- [x] Dashboard: reusable start/cancel action with actionable errors, task links and refresh; separate queue and prepared headings, truthful automatic-start labels, retain task-page access after predecessor completion.
- [x] Review, scoped regressions/type checks and safe activation; verify live read-only surfaces without starting Canva or interrupting active work.
