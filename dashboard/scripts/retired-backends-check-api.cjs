#!/usr/bin/env node
/**
 * Isolated API for scripts/retired-backends-browser-check.mjs (task 62b7c967,
 * 2026-11-19): lets the browser check exercise the two comment surfaces that
 * must keep working, document-review comments and task-feature comments, on
 * throwaway data.
 *
 * One Express app on a port the OS assigns (listen(0)):
 *   - /api/documents/*              the real documents router;
 *   - /api/projects/<fixture id>/*  the real tasks router (feature comments);
 *     both on a temporary SQLite database (NEXUS_DB_PATH in a fresh temp dir);
 *   - anything else                 passed through unchanged to the API the
 *     dashboard uses when NEXT_PUBLIC_API_URL is unset (the contract's default
 *     nexus endpoint), so the rest of the page loads as it does without this
 *     script. Those are the page's ordinary reads; the fixture writes never
 *     leave the temp database.
 *
 * Fixture: one project rooted in the temp dir, one task, one Markdown document
 * registered for review, and one feature comment inserted with the facade's
 * own insertInlineComment.
 *
 * CHECK_SERVER_ROOT picks the repo whose db/ and server/ are loaded (default:
 * this checkout), so the same fixture runs on a baseline tree. Prints one line
 * `CHECK_READY {json}` once serving, and serves until it is signalled.
 */
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(process.env.CHECK_SERVER_ROOT || path.join(__dirname, "..", ".."));
const fromRoot = (id) => require(require.resolve(id, { paths: [ROOT] }));

const DOC_TITLE = "Synthetic review fixture (retired-backends check)";
const DOC_BODY = [
    `# ${DOC_TITLE}`,
    "",
    "This file exists only for scripts/retired-backends-browser-check.mjs. It is not a real document.",
    "",
    "## What the check does here",
    "",
    "It leaves a passage comment on this paragraph, reloads, and resolves the comment.",
    "",
].join("\n");

/** A loopback port nothing listens on: the OS hands one out, and it is closed again before use. */
const closedPort = () => new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

(async () => {
    // realpath: the documents router checks a project root lexically before
    // resolving it, and macOS /tmp is a symlink to /private/tmp.
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retired-api-")));
    fs.mkdirSync(path.join(dir, "docs"));
    process.env.NEXUS_DB_PATH = path.join(dir, "nexus.db");
    // Nothing in the checked flow needs Praxis; point it at a closed port so no
    // fixture action can reach the live one.
    process.env.PRAXIS_URL = `http://127.0.0.1:${await closedPort()}`;

    const express = fromRoot("express");
    const { resolveEndpoints } = fromRoot("@praxis/contract");
    const db = require(path.join(ROOT, "db"));
    const createDocumentsRouter = require(path.join(ROOT, "server", "routes", "documents"));
    const createTasksRouter = require(path.join(ROOT, "server", "routes", "tasks"));

    const project = await db.upsertProject({ name: "retired-backends-check", description: "throwaway project for scripts/retired-backends-browser-check.mjs", type: "tool", path: dir, tasks_list: [] });
    if (!project?.id) throw new Error("could not create the throwaway project");
    const task = await db.createTask({ project_id: project.id, name: "Synthetic feature for the comment check", description: "verification fixture", status: "todo" });
    if (!task?.id) throw new Error("could not create the throwaway task");
    const featureComment = await db.insertInlineComment({ project_id: project.id, task_id: task.id, stage: "plan", selection_text: "Step one", comment: "Seeded feature comment (verification fixture)" });
    if (!featureComment?.id) throw new Error("could not seed the feature comment");
    const docPath = path.join(dir, "docs", "retired-backends-review-fixture.md");
    fs.writeFileSync(docPath, DOC_BODY);

    const unavailable = async () => { throw new Error("not available in the retired-backends check API"); };
    const stampUser = (req, _res, next) => { req.user = { id: "local_user", role: "admin", is_service: false }; next(); };
    const fixtureTasks = express.Router();
    fixtureTasks.use(express.json(), stampUser, createTasksRouter({
        db, PROJECT_ROOT: dir, getProjectById: async () => project, getAllProjects: async () => [project],
        callAI: unavailable, validateInitiativeRequest: unavailable, pushService: null,
    }));

    const upstream = new URL(resolveEndpoints({}).nexus);
    const passThrough = (req, res) => {
        const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.originalUrl, headers: req.headers }, (answer) => {
            res.writeHead(answer.statusCode, answer.headers);
            answer.pipe(res);
        });
        up.on("error", (err) => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `retired-backends check API: upstream ${upstream.origin} unreachable (${err.code || err.message})` }));
        });
        req.pipe(up);
    };

    const app = express();
    app.use("/api/documents", express.json(), stampUser, createDocumentsRouter({ db, delivery: null }));
    app.use("/api/projects", (req, res, next) => (req.path.startsWith(`/${project.id}/`) ? fixtureTasks(req, res, next) : next()));
    app.use(passThrough);

    const server = app.listen(0, "127.0.0.1", async () => {
        const api = `http://127.0.0.1:${server.address().port}`;
        try {
            const res = await fetch(`${api}/api/documents`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    path: docPath, title: DOC_TITLE, project_id: project.id, task_id: task.id, kind: "document",
                    deliverable: { requires_review: true, purpose: "Verification fixture for the comment check", intended_action: "none" },
                }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(`register failed: ${res.status} ${JSON.stringify(body)}`);
            console.log(`CHECK_READY ${JSON.stringify({
                api, dir, serverRoot: ROOT, upstream: upstream.origin, projectId: project.id, taskId: task.id,
                documentId: body.document.id, documentTitle: DOC_TITLE, featureCommentId: featureComment.id,
            })}`);
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
