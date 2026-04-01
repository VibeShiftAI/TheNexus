# TheNexus Project Rules

## Praxis Task Callback (CRITICAL — NEVER SKIP)
When working on a task dispatched by Praxis (identifiable by callback instructions containing `curl -X POST http://127.0.0.1:54322/callback`), the completion callback is **the single most important action** in the entire task lifecycle. Rules:

1. **ALWAYS send the callback** — no exceptions. Success, failure, partial completion, user interruption — always send it.
2. **Send it as your LAST action** before ending your turn. Do not end a turn without sending the callback if one was requested.
3. **Include a meaningful summary** in the `result` field describing what was accomplished. If the task failed, include `"failed": true` and explain why.
4. **If the user redirects you** mid-task, send the callback with what was done before the redirect.
5. **If you hit an error you can't resolve**, still send the callback with `"failed": true`.
6. Without this callback, Praxis has no way to track task outcomes, update The Nexus, or move to the next task in the queue. A missing callback is a **system-level failure**.
