# Measured routing economics implementation plan

Goal: read-only comparison of observed dispatch attempts by model and execution lane.

Design: aggregate complete task_dispatches history, using the same fields consumed by buildRunTrace. Reuse the existing dispatch-insight cost estimator without adding prices or billing integrations. Known local executors have zero provider inference fees (excluding hardware/electricity); cloud values are API-equivalent estimates, never metered bills. Unknown executors/providers remain an unknown lane. Include configured active models without runs and both local/cloud lane summaries with null metrics. Count each metric's contributing runs separately. Exclude unfinished/invalid durations from latency and nonterminal outcomes from completion rate. Include all attempts in cost/token accounting; do not claim QA quality or causal routing superiority.

Alternatives considered: aggregating git activity would duplicate dispatches and use heuristic correlations; provider billing integration is outside scope. Direct dispatch aggregation gives stable identities and clickable evidence.

Implementation sequence:
- [x] Write Jest fixtures for aggregation, missing/thin data, estimated cost provenance, lane classification, full history, and read-only HTTP behavior; run red.
- [x] Extract the existing pricing helpers into a shared service, implement a pure aggregator and read-only route, mount after dispatch storage; run focused Jest suites.
- [x] Add a dashboard comparison table with per-metric sample sizes and expandable run links on Activity; link from Usage & Routing. Exercise rendered fetching/error/empty/sample/link behavior.
- [x] Run npm test, dashboard tests, isolated dashboard build, and real-data route/page checks. Review the attributable diff and validate UTF-8 before completion.

Work stays uncommitted in the assigned shared workspace, per the execution brief. Existing .env.example changes are foreign and untouched. The brief authorizes direct implementation, so no extra design approval or worktree is needed.
