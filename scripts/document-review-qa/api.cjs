// Isolated Nexus document API for UI verification: temp DB, throwaway project
// root, real router + real delivery worker, Praxis replaced by a local receiver.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const QA_DIR = process.env.NEXUS_REVIEW_QA_DIR;
if (!QA_DIR || !fs.realpathSync(QA_DIR).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
    throw new Error('NEXUS_REVIEW_QA_DIR must be a fresh directory under the system temp directory');
}
if (fs.existsSync(path.join(QA_DIR, 'nexus.db'))) throw new Error('Use a fresh QA directory for each run');
fs.mkdirSync(path.join(QA_DIR, 'Praxis'), { recursive: true });
process.env.NEXUS_DB_PATH = path.join(QA_DIR, 'nexus.db');
process.env.PRAXIS_URL = 'http://127.0.0.1:4199';
process.env.PRAXIS_CHAT_TIMEOUT_MS = '10000';
const ROOT = path.resolve(__dirname, '../..');
const REPORT = path.join(QA_DIR, 'Praxis/readiness.md');
fs.copyFileSync(path.join(ROOT, '../Praxis/docs/reports/2026-09-10-reliability-readiness.md'), REPORT);
const express = require(path.join(ROOT, 'node_modules/express'));
const db = require(path.join(ROOT, 'db'));
const createDocumentsRouter = require(path.join(ROOT, 'server/routes/documents'));
const { createDocumentReviewDelivery } = require(path.join(ROOT, 'server/services/document-review-delivery'));
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const delivery = createDocumentReviewDelivery({ db, io: null, intervalMs: 2000, backoffMs: [3000] });
const app = express();
app.use(express.json({ limit: '2mb' }));
const log = [];
app.use((req, _res, next) => { log.push({ t: new Date().toISOString(), method: req.method, url: req.url }); next(); });
app.get('/__qa', (_req, res) => res.json({ qaDirectory: QA_DIR }));
app.get('/__log', (_req, res) => res.json(log));
app.use('/api/documents', (req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
app.use('/api/documents', createDocumentsRouter({ db, delivery }));
(async () => {
    await db.upsertProject({ id: PROJECT_ID, name: 'Isolated project', path: fs.realpathSync.native(path.join(QA_DIR, 'Praxis')) });
    await db.createTask({ id: TASK_ID, project_id: PROJECT_ID, name: 'Isolated verification', status: 'completed', metadata: { status_message: 'QA repair verification' } });
    delivery.start();
    app.listen(4100, '127.0.0.1', async () => {
        const response = await fetch('http://127.0.0.1:4100/api/documents', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: fs.realpathSync.native(REPORT), title: 'Isolated reliability report', project_id: PROJECT_ID, task_id: TASK_ID }),
        });
        if (!response.ok) throw new Error(`fixture registration failed: ${response.status} ${await response.text()}`);
        console.log('iso api on 4100; report registered');
    });
})().catch(err => { console.error(err); process.exit(1); });
