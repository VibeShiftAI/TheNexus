// Independent QA evidence only. Production databases are opened read-only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const Database = require(path.join(root, 'node_modules/better-sqlite3'));
const { createDocumentReviewStore } = require(path.join(root, 'db/document-reviews'));
const plan = JSON.parse(fs.readFileSync(path.join(root, 'scripts/reviews-resort-2026-11-25.json')));
const bundle = JSON.parse(fs.readFileSync('/Volumes/Projects/Praxis/data/qa-evidence/4f84385a961d31e18ba7c13a6b45c9bc4ca00358edb867aecaa6509636ff43a3.txt'));
const reportPath = path.join(root, 'docs/reports/2026-11-25-reviews-resort.md');
const reportBytes = fs.readFileSync(reportPath);
const report = new TextDecoder('utf-8', { fatal: true }).decode(reportBytes);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const revision = 'b8267efa5f93467dbe96b4a24bc1a1c039e8c6d5';
const changed = execFileSync('git', ['diff', '--name-only', 'a5463aedbe3414486ebfb1ec132b96cc1df5c309', revision], { cwd: root, encoding: 'utf8' }).trim().split('\n');
console.log(JSON.stringify({ sourceFiles: changed.length, sourceMismatches: changed.filter(file => hash(fs.readFileSync(path.join(root, file))) !== hash(execFileSync('git', ['show', `${revision}:${file}`], { cwd: root }))) }));
const snapshotIds = bundle.observations.find(o => o.id === 'A34').output.split('\n').map(line => line.split('\t')[0]).filter(id => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id));
console.log(JSON.stringify({ dispatchSnapshotDocuments: snapshotIds.length, planDocuments: plan.documents.length, absentFromPlan: snapshotIds.filter(id => !plan.documents.some(d => d.id === id)), notInSnapshot: plan.documents.filter(d => !snapshotIds.includes(d.id)).map(d => d.id), absentFromReport: plan.documents.filter(d => !report.includes(d.id.slice(0,8))).map(d => d.id), utf8: 'valid', replacementCharacters: [...report].filter(c => c === '\ufffd').length, reportHash: hash(reportBytes) }));
const live = new Database('/Volumes/Projects/TheNexus/nexus.db', { readonly: true, fileMustExist: true });
const backup = new Database('/Volumes/Projects/TheNexus/backups/nexus-2026-11-25-before-reviews-resort.db', { readonly: true, fileMustExist: true });
const store = createDocumentReviewStore(live);
function guards(raw, id) {
  const d = raw.prepare('SELECT * FROM review_documents WHERE id=?').get(id);
  const replacements = raw.prepare("SELECT id FROM review_document_replacements WHERE document_id=? AND (state IN ('accepted','queued','held','running','implemented','qa_passed') OR (state IN ('failed','cancelled') AND result_revision_id=?))").all(id, d.current_revision_id);
  return {
    outgoing: raw.prepare("SELECT count(*) AS n FROM review_document_outgoing WHERE document_id=? AND status IN ('draft','approved','delivering','uncertain')").get(id).n,
    draftWork: raw.prepare("SELECT count(*) AS n FROM document_reviews r WHERE r.document_id=? AND r.status='draft' AND (trim(r.summary) != '' OR json_array_length(coalesce(r.decision_answers,'[]'))>0 OR EXISTS (SELECT 1 FROM document_review_comments c WHERE c.review_id=r.id))").get(id).n,
    waitingTasks: raw.prepare("SELECT count(*) AS n FROM review_documents d, json_each(d.blocking_task_ids) b JOIN tasks t ON t.id=b.value WHERE d.id=? AND t.archived_at IS NULL AND lower(t.status) NOT IN ('completed','complete','done','cancelled','canceled','archived','rejected','deleted')").get(id).n,
    replacements: replacements.length,
    agentReviews: raw.prepare("SELECT count(*) AS n FROM document_agent_reviews ar WHERE ar.document_id=? AND json_extract(ar.data,'$.status')='submitted' AND json_extract(ar.data,'$.base_revision_id')=?").get(id, d.current_revision_id).n,
  };
}
for (const [label, raw] of [['before-resort', backup], ['current', live]]) {
  const guarded = plan.documents.map(d => ({ id: d.id, guards: guards(raw, d.id) })).filter(d => Object.values(d.guards).some(Boolean));
  console.log(JSON.stringify({ database: label, checkedDocuments: plan.documents.length, guarded }));
}
const stayed = plan.documents.filter(d => d.outcome !== 'move').map(d => {
  const row = store.getDocumentListRow(d.id);
  return { id: d.id, groundInForce: row.ground_in_force, grounds: ['task','decision','action','request'].filter(k => row[`ground_${k}`]) };
});
console.log(JSON.stringify({ stayed, stayedWithoutGround: stayed.filter(d => !d.groundInForce) }));
console.log(JSON.stringify({ decisionsBefore: backup.prepare('SELECT count(*) n FROM review_document_decisions').get().n, decisionsNow: live.prepare('SELECT count(*) n FROM review_document_decisions').get().n }));
live.close(); backup.close();

async function registrationProbe() {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-qa-review-probe-')));
  process.env.NEXUS_DB_PATH = path.join(temporary, 'nexus.db');
  process.env.NEXUS_REVIEW_BLOB_DIR = path.join(temporary, 'blobs');
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  const db = require(path.join(root, 'db'));
  const express = require(path.join(root, 'node_modules/express'));
  const app = express();
  const server = http.createServer(app);
  try {
    const projectId = '55555555-5555-4555-8555-555555555555';
    const taskId = '66666666-6666-4666-8666-66666666666a';
    await db.upsertProject({ id: projectId, name: 'QA probe', path: temporary });
    await db.createTask({ id: taskId, project_id: projectId, name: 'Produce QA fixture', status: 'completed' });
    const file = path.join(temporary, 'brief.md');
    fs.writeFileSync(file, '# Draft\nReady to send once approved.\n');
    app.use(express.json());
    app.use('/api/documents', (req, res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
    app.use('/api/documents', require(path.join(root, 'server/routes/documents'))({ db, delivery: { deliver: async () => null } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/documents`;
    const register = async action => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file, title: 'QA brief', project_id: projectId, task_id: taskId, kind: 'document', deliverable: { key: 'qa-probe', purpose: 'Approve sending the draft', requires_review: true, intended_action: action } }) });
      return { status: response.status, body: await response.json() };
    };
    const first = await register('none');
    const second = await register('send');
    if (!first.body.document || !second.body.document) throw new Error(JSON.stringify({ first, second }));
    const detailResponse = await fetch(`${url}/${first.body.document.id}`);
    const detail = await detailResponse.json();
    originalLog(JSON.stringify({ probe: 'same-bytes change from no ground to intended_action send, optional review_ground omitted', first: { status: first.status, outcome: first.body.review_ground?.outcome }, second: { status: second.status, intended_action: second.body.document?.intended_action, requires_review: second.body.document?.requires_review, outcome: second.body.review_ground?.outcome, message: second.body.review_ground?.message }, read: { status: detailResponse.status, review_status: detail.review_status, ground_in_force: detail.ground_in_force, review_grounds: detail.review_grounds } }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log = originalLog;
    console.warn = originalWarn;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
registrationProbe().catch(error => { console.error(error); process.exitCode = 1; });
