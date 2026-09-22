#!/usr/bin/env node
/**
 * Throwaway Nexus API for scripts/mermaid-browser-check.mjs: the real
 * documents router on a temporary SQLite database, so the broken/hostile
 * Mermaid fixture can be registered and viewed without writing to the live
 * board. Copies the fixture under a temp project root (the documents router
 * only accepts paths inside a registered project), registers it, prints the
 * document id, and serves on 127.0.0.1:4100 until stopped.
 *
 *   node scripts/mermaid-check-api.cjs
 *   # then in another shell, from dashboard/:
 *   NEXT_DIST_DIR=.next-ui NEXT_PUBLIC_API_URL=http://127.0.0.1:4100 npx next dev -p 3100
 *
 * Env: CHECK_API_PORT (4100), CHECK_API_DIR (a fresh directory under
 * os.tmpdir(); pass one to reuse it). CHECK_API_EXTRA=<absolute .md path> also
 * registers a copy of that document (for the CHECK_NAV navigation step).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.CHECK_API_PORT || 4100);
// realpath: the router checks the project root lexically before resolving it,
// and macOS /tmp is a symlink to /private/tmp.
const dir = fs.realpathSync.native(process.env.CHECK_API_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mermaid-check-")));
fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
process.env.NEXUS_DB_PATH = path.join(dir, "nexus.db");
process.env.PRAXIS_URL = process.env.PRAXIS_URL || "http://127.0.0.1:1";

const express = require(path.join(REPO, "node_modules", "express"));
const db = require(path.join(REPO, "db"));
const createDocumentsRouter = require(path.join(REPO, "server", "routes", "documents"));

const fixture = path.join(__dirname, "fixtures", "mermaid-cases.md");
const fixtureCopy = path.join(dir, "docs", "mermaid-cases.md");
fs.copyFileSync(fixture, fixtureCopy);
const extra = process.env.CHECK_API_EXTRA ? path.resolve(process.env.CHECK_API_EXTRA) : null;
const extraCopy = extra ? path.join(dir, "docs", path.basename(extra)) : null;
if (extra) fs.copyFileSync(extra, extraCopy);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
    req.user = { id: "local_user", role: "admin", is_service: false };
    next();
});
app.use("/api/documents", createDocumentsRouter({ db, delivery: null }));

(async () => {
    await db.upsertProject({ name: "mermaid-check", description: "throwaway project for scripts/mermaid-browser-check.mjs", type: "tool", path: dir, tasks_list: [] });
    const server = app.listen(PORT, "127.0.0.1", async () => {
        const register = async (docPath, title) => {
            const res = await fetch(`http://127.0.0.1:${PORT}/api/documents`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ path: docPath, title }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(`register ${docPath} failed: ${res.status} ${JSON.stringify(body)}`);
            return body.document.id;
        };
        try {
            const id = await register(fixtureCopy, "Mermaid verification cases");
            console.log(`CHECK_DOC=${id}`);
            if (extraCopy) console.log(`CHECK_NAV=${await register(extraCopy, path.basename(extra, ".md"))}`);
            console.log(`api on http://127.0.0.1:${PORT} (db ${process.env.NEXUS_DB_PATH}); Ctrl-C to stop`);
        } catch (err) {
            console.error(err);
            server.close();
            process.exit(1);
        }
    });
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
