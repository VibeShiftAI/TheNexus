/** A small map in the generator's shape (schema 2), for the System Map tests. */
export function fixtureMap(overrides = {}) {
    return {
        _generated: "GENERATED: praxis-system-map; do not edit.",
        generatedAt: "2026-11-13T18:21:16.068Z",
        factsHash: "9d77d6536e79b27a",
        schemaVersion: 2,
        repos: { nexus: { path: "TheNexus", branch: "main", head: "ba2ece2", headDate: "2026-11-13", dirty: true } },
        callResolution: { resolved: 508, unresolved: 16 },
        nodes: [
            { id: "praxis", name: "Praxis", kind: "system", level: 0, attrs: {} },
            { id: "praxis/daemon", name: "Praxis daemon", kind: "process", level: 1, parent: "praxis", attrs: { running: true, ports: [54322], launchd: "com.praxis.bot" }, purpose: "The agent runtime process.", purposeSource: "notes: Praxis/system-map-notes.json" },
            { id: "praxis/reports", name: "reports", kind: "subsystem", level: 2, parent: "praxis/daemon", path: "Praxis/src/reports", attrs: { files: 4, lines: 1200, commits90d: 9, lastCommit: "2026-11-01", jobs: 1 }, purpose: "Builds the weekly reports.", purposeSource: "notes: Praxis/system-map-notes.json" },
            { id: "praxis/quiet", name: "quiet", kind: "subsystem", level: 2, parent: "praxis/daemon", path: "Praxis/src/quiet", attrs: { files: 1, lines: 40, commits90d: 0, lastCommit: "2026-05-01" } },
            { id: "nexus", name: "The Nexus", kind: "system", level: 0, attrs: {} },
            { id: "nexus/api", name: "Nexus API", kind: "process", level: 1, parent: "nexus", attrs: { running: true, ports: [4000], supervisedBy: "praxis/daemon" }, purpose: "Express server on :4000.", purposeSource: "notes: TheNexus/system-map-notes.json" },
            { id: "nexus/routes/tasks", name: "tasks", kind: "routes", level: 2, parent: "nexus/api", path: "TheNexus/server/routes/tasks.js", attrs: { files: 1, lines: 906, commits90d: 13, lastCommit: "2026-10-30", routeCount: 2, mounts: ["/api/tasks"] }, purpose: "Task CRUD and lifecycle updates.", purposeSource: "code comment in TheNexus/server/routes/tasks.js" },
            { id: "nexus/dashboard", name: "Nexus dashboard", kind: "process", level: 1, parent: "nexus", attrs: { running: true, ports: [3000] }, purpose: "Next.js dashboard on :3000." },
            { id: "cortex", name: "The Cortex", kind: "system", level: 0, attrs: {} },
            { id: "cortex/gateway", name: "Cortex gateway", kind: "process", level: 1, parent: "cortex", attrs: { running: false, ports: [8100] } },
            { id: "sat/Nexus-Mobile-Android", name: "Nexus-Mobile-Android", kind: "satellite", level: 0, attrs: { references: 3, why: ["its code calls the Nexus API"] } },
            { id: "ext/openrouter", name: "OpenRouter", kind: "external", level: 0, attrs: { references: 12 } },
            { id: "ext/bin:claude", name: "claude CLI", kind: "external", level: 0, attrs: { references: 5 } },
        ],
        edges: [
            { from: "praxis/reports", to: "nexus/routes/tasks", kind: "http", count: 7, evidence: ["Praxis/src/reports/attention-economics.ts:120 -> GET /api/tasks", "Praxis/src/reports/weekly.ts:44 -> GET /api/tasks"] },
            { from: "nexus/routes/tasks", to: "praxis/reports", kind: "local-port", count: 2, evidence: ["TheNexus/server/routes/tasks.js:310 -> :54322/api/reports"] },
            { from: "praxis/reports", to: "ext/openrouter", kind: "external", count: 3, evidence: ["Praxis/src/reports/summary.ts:18"] },
            { from: "praxis/reports", to: "praxis/quiet", kind: "imports", count: 1, evidence: ["Praxis/src/reports/index.ts:3 -> Praxis/src/quiet/index.ts"] },
            { from: "sat/Nexus-Mobile-Android", to: "nexus/api", kind: "http", count: 4, evidence: ["Nexus-Mobile-Android/lib/api.ts:10"] },
            { from: "praxis/daemon", to: "nexus/api", kind: "supervises", count: 1, evidence: ["Praxis/src/supervisor/index.ts:74"] },
        ],
        checks: [
            { severity: "info", id: "jobs-paused", title: "Paused jobs", detail: "Registered but paused.", items: ["trading-run"] },
            { severity: "warn", id: "jobs-not-registered", title: "Jobs in code that are not registered", detail: "Found in code, absent from the live registry.", items: ["morning-routine", "morning-status-report"] },
            { severity: "ok", id: "self-check", title: "Self-check", detail: "Every route lands on a definition.", items: ["routes: 2 of 2"] },
        ],
        catalogs: {
            routes: [
                { service: "nexus", method: "GET", path: "/api/tasks", owner: "nexus/routes/tasks", at: "TheNexus/server/routes/tasks.js:88", calledFromCode: true },
                { service: "nexus", method: "PATCH", path: "/api/tasks/:taskId", owner: "nexus/routes/tasks", at: "TheNexus/server/routes/tasks.js:140" },
                { service: "praxis", method: "GET", path: "/api/reports", owner: "praxis/reports", at: "Praxis/src/reports/routes.ts:12", calledFromCode: true },
            ],
            crons: [
                { key: "attention-economics", label: "Attention economics report", cadence: "Weekly · Sun 6:30 PM ET", schedule: "30 18 * * 0", category: "system", description: "Weekly per-project spend.", paused: false, registeredLive: true, owner: "praxis/reports", file: "Praxis/src/reports/attention-economics.ts", line: 381 },
                { key: "heartbeat", label: "Heartbeat", cadence: "Every 10 minutes", schedule: "*/10 * * * *", category: "system", paused: false, registeredLive: true, owner: "praxis/daemon", file: "Praxis/src/index.ts", line: 90 },
                { key: "morning-routine", label: "Morning routine", schedule: "0 7 * * *", category: "daily", registeredLive: false, file: "Praxis/src/morning.ts", line: 5 },
            ],
            agentTools: [{ name: "report_now", owner: "praxis/reports" }],
            tables: [{ name: "tasks", users: ["nexus/routes/tasks"] }],
            siblings: [
                { dir: "Nexus-Mobile-Android", class: "connected", reasons: ["calls the Nexus API"], launchAgents: [], ports: [] },
                { dir: "adventuresofdean", class: "workspace", reasons: [], launchAgents: [], ports: [], board: { name: "Adventures of Dean" } },
            ],
            tunnelIngress: [{ hostname: "nexus.example.test", service: "http://localhost:3000", listening: true, node: "nexus/dashboard" }],
            launchAgents: [{ label: "com.praxis.bot", node: "praxis/daemon", keepAlive: true, projectDirs: ["Praxis"] }],
            env: [{ name: "GOOGLE_API_KEY", systems: ["praxis", "nexus"] }, { name: "ONLY_ONE", systems: ["praxis"] }],
            fleetEnvKeys: ["GOOGLE_API_KEY"],
            symlinks: [{ from: "~/.claude/skills", to: "shared-mind/skills" }],
            docs: [
                { file: "Praxis/docs/client-workflow.md", kind: "living", lastCommit: "2026-06-01", refs: 32, missingRefs: 13, refsChangedSince: 2 },
                { file: "Praxis/docs/fresh.md", kind: "living", lastCommit: "2026-11-01", refs: 4, missingRefs: 0, refsChangedSince: 0 },
                { file: "Praxis/docs/2026-01-01-record.md", kind: "dated record", refs: 9, missingRefs: 9, refsChangedSince: 0 },
            ],
        },
        ...overrides,
    };
}
