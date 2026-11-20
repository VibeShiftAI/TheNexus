// The /api/token-usage route end to end: real GET handler, real shared
// service, real sqlite-backed ledger and antigravity readers, all pointed at a
// generated home directory (HOME and NEXUS_DB_PATH). No real session log,
// ledger or board database is read.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { dayKey } from "../token-usage-service.ts";
import { claudeLine, codexTokenLine, originalTokenUsageBody, writeLog } from "./token-usage-oracle.ts";

const previous = { home: process.env.HOME, db: process.env.NEXUS_DB_PATH };
let home = "";
after(async () => {
  if (previous.home === undefined) delete process.env.HOME;
  else process.env.HOME = previous.home;
  if (previous.db === undefined) delete process.env.NEXUS_DB_PATH;
  else process.env.NEXUS_DB_PATH = previous.db;
  if (home) await fs.rm(home, { recursive: true, force: true });
});

function sqlite(db: string, sql: string) {
  execFileSync("sqlite3", [db, sql]);
}

test("GET serves the unchanged contract from one shared refresh, ledger and estimate included", async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "token-usage-route-"));
  process.env.HOME = home;
  process.env.NEXUS_DB_PATH = path.join(home, "nexus.db");
  assert.equal(os.homedir(), home);

  const claudeRoot = path.join(home, ".claude", "projects");
  const codexRoot = path.join(home, ".codex", "sessions");
  await writeLog(path.join(claudeRoot, "p", "a.jsonl"), [
    claudeLine({ id: "m1", input: 100, output: 20 }),
    claudeLine({ id: "m1", input: 100, output: 80 }),
  ]);
  await writeLog(path.join(codexRoot, "2026", "rollout.jsonl"), [codexTokenLine({ input: 500, cached: 200, output: 50 })]);

  await fs.mkdir(path.join(home, ".praxis-mind"), { recursive: true });
  const ledgerDb = path.join(home, ".praxis-mind", "cost_ledger.sqlite");
  sqlite(
    ledgerDb,
    "CREATE TABLE llm_calls(ts TEXT, provider TEXT, total_tokens INTEGER);" +
      "INSERT INTO llm_calls VALUES (datetime('now'),'local',1500),(datetime('now'),'openrouter',700)," +
      "(datetime('now'),NULL,25),(datetime('now'),'claude-code',99999),(datetime('now','-40 days'),'local',5000);",
  );
  sqlite(
    process.env.NEXUS_DB_PATH,
    "CREATE TABLE task_dispatches(executor TEXT, tokens INTEGER, tokens_estimated INTEGER, completed_at TEXT, started_at TEXT);" +
      "INSERT INTO task_dispatches VALUES ('antigravity',400,1,datetime('now'),datetime('now'))," +
      "('antigravity',100,0,datetime('now'),datetime('now')),('codex',999,1,datetime('now'),datetime('now'));",
  );

  const { GET } = await import("../route.ts");
  const { sharedTokenUsageService } = await import("../token-usage-service.ts");

  const responses = await Promise.all(Array.from({ length: 10 }, () => GET()));
  const bodies = await Promise.all(responses.map((r) => r.json()));
  for (const r of responses) assert.equal(r.status, 200);
  for (const b of bodies) assert.deepEqual(b, bodies[0]);
  assert.equal(sharedTokenUsageService().metrics().refreshesStarted, 1);

  const body = bodies[0];
  const today = dayKey(new Date());
  assert.deepEqual(Object.keys(body), ["today", "record", "days", "antigravity", "windowDays", "computedAt"]);
  // claude: m1 deduped to 180; codex: (500 - 200) + 50; ledger: local 1500, cloud 700 + 25
  // (the claude-code row is a CLI provider and the 40-day-old row is outside the window).
  assert.deepEqual(body.today, { date: today, claudeCode: 180, codex: 350, local: 1500, cloud: 725, total: 2755 });
  assert.deepEqual(body.antigravity, { today: 400, estimated: true });
  assert.deepEqual(body.record, { date: today, total: 2755 });

  const expected = await originalTokenUsageBody({
    claudeRoot,
    codexRoot,
    now: new Date(body.computedAt),
    ledger: { local: new Map([[today, 1500]]), cloud: new Map([[today, 725]]) },
    agyEstimate: new Map([[today, 400]]),
  });
  assert.deepEqual(body, expected);
});
