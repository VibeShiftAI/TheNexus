const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const express = require("express");
const createRouter = require("../routes/knowledge-activity");

let dir, server, base, readTopics;
beforeEach(async () => {
  readTopics = jest.fn(async () => []);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-activity-"));
  fs.mkdirSync(path.join(dir, "vault", "memories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vault", "memories", "note.md"),
    "# A real report\nEvidence",
  );
  const db = new Database(path.join(dir, "ledger.sqlite"));
  db.exec(
    "CREATE TABLE calls (id INTEGER PRIMARY KEY, ts TEXT, caller TEXT, tool TEXT, latency_ms INTEGER, success INTEGER)",
  );
  db.prepare("INSERT INTO calls VALUES (1, ?, ?, ?, 12, 1)").run(
    new Date().toISOString(),
    "codex",
    "memory_search",
  );
  db.prepare("INSERT INTO calls VALUES (2, ?, ?, ?, 12, 0)").run(
    new Date().toISOString(),
    "codex",
    "vault_write",
  );
  db.close();
  const app = express();
  app.use(
    "/api/knowledge-activity",
    createRouter({
      ledgerPath: path.join(dir, "ledger.sqlite"),
      vaultPath: path.join(dir, "vault"),
      cacheMs: 0,
      readTopics: (...args) => readTopics(...args),
    }),
  );
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}/api/knowledge-activity`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
test("reports actual calls and latest vault writes, without conflating failed writes with success", async () => {
  const res = await fetch(base);
  const data = await res.json();
  expect(res.status).toBe(200);
  expect(data.sources).toEqual({ memory: true, vault: true, topics: true });
  expect(data.calls.map((x) => x.id)).toEqual([2, 1]);
  expect(data.calls[0].success).toBe(false);
  expect(data.files[0].path).toBe("memories/note.md");
  expect(data.files[0].at).toBeTruthy();
});
test('includes topic-specific retrieval independently of MCP; failures preserve the other telemetry', async () => {
  const access = {topicId:12,title:'Memory',at:new Date().toISOString(),entityCount:1,entities:['Neo4j']};
  readTopics.mockResolvedValue([access]);
  let data = await (await fetch(base)).json();
  expect(data.topicAccesses).toEqual([access]);
  expect(data.sources.topics).toBe(true);
  readTopics.mockRejectedValue(new Error('Cortex unavailable'));
  data = await (await fetch(base)).json();
  expect(data.topicAccesses).toEqual([]);
  expect(data.sources.topics).toBe(false);
  expect(data.sources.memory).toBe(true);
  expect(data.calls.length).toBe(2);
});
test("missing ledger is unavailable rather than an empty successful source", async () => {
  fs.unlinkSync(path.join(dir, "ledger.sqlite"));
  const data = await (await fetch(base)).json();
  expect(data.sources.memory).toBe(false);
  expect(data.sources.vault).toBe(true);
});
test("reads a full vault report and refuses traversal, private paths, and symlink escapes", async () => {
  const good = await fetch(`${base}/document?path=memories%2Fnote.md`);
  expect((await good.json()).content).toContain("A real report");
  fs.writeFileSync(path.join(dir, "secret.md"), "secret");
  fs.symlinkSync(
    path.join(dir, "secret.md"),
    path.join(dir, "vault", "memories", "escape.md"),
  );
  for (const p of [
    "../secret.md",
    "memories/../../secret.md",
    ".env",
    "memories/escape.md",
  ]) {
    const res = await fetch(`${base}/document?path=${encodeURIComponent(p)}`);
    expect([400, 403]).toContain(res.status);
    expect(await res.text()).not.toContain("secret");
  }
});
test("refuses symlink aliases to private documents inside the vault and oversized reports", async () => {
  fs.mkdirSync(path.join(dir, "vault", ".private"));
  fs.writeFileSync(
    path.join(dir, "vault", ".private", "credentials.md"),
    "do-not-return",
  );
  fs.symlinkSync(
    path.join(dir, "vault", ".private", "credentials.md"),
    path.join(dir, "vault", "memories", "alias.md"),
  );
  const res = await fetch(`${base}/document?path=memories%2Falias.md`);
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain("do-not-return");
  fs.writeFileSync(
    path.join(dir, "vault", "memories", "large.md"),
    "a".repeat(2 * 1024 * 1024 + 1),
  );
  expect(
    (await fetch(`${base}/document?path=memories%2Flarge.md`)).status,
  ).toBe(413);
});
test("includes recent-memory and graph-citation access telemetry", async () => {
  const db = new Database(path.join(dir, "ledger.sqlite"));
  for (const tool of ["memory_recent", "memory_cite"])
    db.prepare(
      "INSERT INTO calls (ts,caller,tool,success) VALUES (?,?,?,1)",
    ).run(new Date().toISOString(), "codex", tool);
  db.close();
  const data = await (await fetch(base)).json();
  expect(data.calls.map((c) => c.tool)).toEqual(
    expect.arrayContaining(["memory_recent", "memory_cite"]),
  );
});
