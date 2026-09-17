/** Read-only cockpit telemetry. No producer calls, write operations, or raw tool arguments. */
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");
const { vaultRoot } = require("../lib/vault-paths");
const { readTopicAccess } = require("../services/topic-access");

// Authored documents only: exclude generated indexes, private config, and archives.
const ROOTS = new Set([
  "memories",
  "skills",
  "projects",
  "incidents",
  "workflows",
  "_journal",
]);
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

module.exports = function createKnowledgeActivityRouter({
  ledgerPath = process.env.PRAXIS_MIND_LEDGER_DB ||
    path.join(os.homedir(), ".praxis-mind", "cost_ledger.sqlite"),
  vaultPath = vaultRoot(),
  cacheMs = 5000,
  readTopics = readTopicAccess,
} = {}) {
  const router = express.Router();
  let cached = null,
    cachedAt = 0,
    inflight = null;

  async function snapshot() {
    if (cached && Date.now() - cachedAt < cacheMs) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      const sources = { memory: false, vault: false, topics: false };
      // Independent of MCP: Cortex stamps entity reads by all retrieval callers.
      // Resolve in parallel with the vault scan, and keep failures source-local.
      const topics = Promise.resolve().then(() => readTopics()).then(rows => {
        sources.topics = true;
        return rows;
      }).catch(() => []);
      let calls = [];
      let db;
      try {
        db = new Database(ledgerPath, { readonly: true, fileMustExist: true });
        calls = db
          .prepare(
            `SELECT id, ts AS at, caller, tool, latency_ms, success FROM calls
          WHERE tool IN ('memory_search', 'memory_recent', 'memory_cite', 'memory_write', 'vault_read', 'vault_search', 'vault_write', 'vault_list')
          AND ts >= ? ORDER BY id DESC LIMIT 120`,
          )
          .all(new Date(Date.now() - 86400000).toISOString())
          .map((row) => ({ ...row, success: Boolean(row.success) }));
        sources.memory = true;
      } catch {
        /* Explicit source status distinguishes missing telemetry from no calls. */
      } finally {
        db?.close();
      }

      const files = [];
      try {
        const root = await fs.realpath(vaultPath);
        // Iterative walk, no symlinks, fixed traversal budget; ~900 documents in this vault.
        const dirs = [root];
        let visited = 0;
        while (dirs.length && visited < 10000) {
          const dir = dirs.pop();
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (++visited > 10000)
              throw new Error("Vault scan budget exceeded");
            if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
            const absolute = path.join(dir, entry.name);
            const relative = path
              .relative(root, absolute)
              .split(path.sep)
              .join("/");
            if (!ROOTS.has(relative.split("/")[0])) continue;
            if (entry.isDirectory()) {
              if (!entry.name.startsWith("_archive")) dirs.push(absolute);
              continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
            const stat = await fs.stat(absolute);
            files.push({
              path: relative,
              at: stat.mtime.toISOString(),
              bytes: stat.size,
            });
          }
        }
        sources.vault = true;
      } catch {
        /* Partial records can still be inspected, but freshness is unavailable. */
      }
      files.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const topicAccesses = await topics;
      cached = {
        at: new Date().toISOString(),
        sources,
        calls,
        topicAccesses,
        files: files.slice(0, 80),
      };
      cachedAt = Date.now();
      return cached;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await snapshot());
  });
  router.get("/document", async (req, res) => {
    const relative = req.query.path;
    if (
      typeof relative !== "string" ||
      relative.includes("\\") ||
      relative.includes("\0") ||
      relative.split("/").some((p) => p === ".." || p.startsWith(".")) ||
      !ROOTS.has(relative.split("/")[0]) ||
      !relative.endsWith(".md")
    ) {
      return res.status(400).json({ error: "Invalid document path" });
    }
    try {
      const root = await fs.realpath(vaultPath);
      // Refuse symlink aliases even when they point back into a private vault directory.
      let segmentPath = root;
      for (const segment of relative.split("/")) {
        segmentPath = path.join(segmentPath, segment);
        if ((await fs.lstat(segmentPath)).isSymbolicLink())
          return res
            .status(403)
            .json({ error: "Document alias is not supported" });
      }
      const file = await fs.realpath(segmentPath);
      if (!file.startsWith(root + path.sep))
        return res.status(403).json({ error: "Document outside vault" });
      const handle = await fs.open(
        file,
        require("fs").constants.O_RDONLY | require("fs").constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES)
          return res
            .status(413)
            .json({ error: "Document exceeds viewer size limit" });
        const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            total,
            buffer.length - total,
            total,
          );
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > MAX_DOCUMENT_BYTES)
          return res
            .status(413)
            .json({ error: "Document exceeds viewer size limit" });
        res.set("Cache-Control", "no-store");
        return res.json({
          path: relative,
          at: stat.mtime.toISOString(),
          content: buffer.subarray(0, total).toString("utf8"),
        });
      } finally {
        await handle.close();
      }
    } catch {
      return res.status(404).json({ error: "Document unavailable" });
    }
  });
  return router;
};
