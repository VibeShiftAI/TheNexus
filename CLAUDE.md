# TheNexus map

## Role

TheNexus is the cockpit, not the orchestration runtime: it exposes the SQLite
task board and Praxis activity through an Express API and Next.js dashboard.
The adjacent Praxis runtime owns scheduling, dispatch, and production process
supervision; keep new orchestration there unless the change is specifically a
cockpit surface.

## Load-bearing map

- `server/server.js` — Express + Socket.IO entry point; mounts API routes and
  starts on `PORT` or `4000`.
- `server/routes/tasks.js`, `server/routes/projects.js`, and
  `server/routes/dispatches.js` — task-board, project, and dispatch APIs.
  `server/routes/praxis-stream.js` and the small proxy routes are the cockpit's
  seams to Praxis.
- `db/index.js` — SQLite facade (not a raw `better-sqlite3` connection), using
  `NEXUS_DB_PATH` or `nexus.db` and WAL mode. Route code needing raw SQL should
  follow `server/routes/fleet.js` and open its own connection.
- `dashboard/src/app/` — App Router pages; `dashboard/src/components/` is the
  UI; `dashboard/src/lib/` and `dashboard/src/hooks/` hold client data logic.
  `dashboard/next.config.ts` proxies `/api/*` to `NEXT_PUBLIC_API_URL` or
  `http://localhost:4000`.
- `services/praxis-mind-mcp/stdio.js` — stdio MCP entry point spawned per MCP
  client. Tools are grouped in `tools/{identity,vault,memory,brain,nexus}.js`;
  `lib/config.js` holds its backend and local-state configuration.
- `services/vault-watcher/index.js` — launchd-run daemon for
  `/Volumes/Projects/shared-mind`: regenerates vault projections/indexes and
  performs hourly git-sync checks. `node services/vault-watcher/index.js --once`
  regenerates once without watching.
- `@praxis/contract` is the sibling repo `../nexus-shared` (one copy). Both the
  root server (`file:../nexus-shared`) and the dashboard (`file:../../nexus-shared`)
  resolve it from there; after a contract change run `npm run build` in
  `nexus-shared` so consumers see the new `dist/`. The dashboard installs it
  as a real copy, not a symlink (`dashboard/.npmrc` sets `install-links=true`
  because turbopack refuses to resolve a symlink whose target is outside the
  repo), and npm does not refresh that copy on a plain install: after the
  rebuild also run `rm -rf node_modules/@praxis && npm install` in `dashboard/`.

## Runtime and commands

- API: from repo root, `npm start` (`node server/server.js`) serves :4000.
  `npm run dev` uses nodemon for local API iteration.
- Dashboard development: `cd dashboard && npm run dev` runs `next dev` on
  :3000 with development hot reload.
- Dashboard production: `cd dashboard && npm run build && npm run start` runs
  compiled output on :3000. `next start` does **not** compile source: after a
  dashboard source change, rebuild and restart the supervised dashboard process
  before expecting production :3000 to show it. For an isolated build that does
  not replace the default `.next`, use
  `cd dashboard && NEXT_DIST_DIR=.next-verify npm run build` (Next also appends
  `.next-verify/types/**/*.ts` to `dashboard/tsconfig.json`; discard that rewrite).
- Fleet-shared secrets: `server/utils/fleet-env.js` (called first in
  `server/server.js`) loads `/Volumes/Projects/.fleet-env`
  (outside every repo; template `/Volumes/Projects/.fleet-env.example`) before
  the repo `.env`. `GOOGLE_API_KEY` and `CORTEX_GATEWAY_KEY` live there once,
  shared with Praxis and TheCortex. Precedence: process env > fleet file >
  repo `.env`. Override the path with `FLEET_ENV_PATH`.
- Server tests: `npm test`; scope a server area with `npx jest server/<area>`.
- Dashboard tests: `cd dashboard && npm test`.
- MCP smoke start: `cd services/praxis-mind-mcp && npm start`; it speaks
  JSON-RPC on stdout, so diagnostics must stay on stderr.

## Conventions and gotchas

- Treat API route modules as factories with injected dependencies; keep
  `server/server.js` as the mounting/startup layer.
- Do not call `db.exec` or `db.prepare` on the facade imported from `db/`.
- The dashboard is a consumer, not an alternate API: preserve its `/api/*`
  proxy seam rather than hard-coding a second backend path.
- Keep security-sensitive MCP changes covered by the existing server tests,
  especially `server/__tests__/mcp-boundary-security.test.js`,
  `server/__tests__/praxis-mind-stateless-conformance.test.js` and
  `server/__tests__/praxis-mind-board-governance.test.js`. The only MCP server
  in this repo is praxis-mind; `server/mcp.js` was retired 2026-09-04 (M-1).
- Follow `docs/verification-protocol.md` for task evidence and quality gates;
  point to deeper documentation instead of copying it into this preload map.
