/**
 * Export round trip against the REAL packet, in isolation: the packet and
 * roster are copied read-only into a temp gold-set directory, synthetic
 * answers are saved and committed for every packet item through the API,
 * the three scorer documents are exported into that temp directory, and the
 * Groundrules scorer (`python3 -m src.ledger goldset`) is run on them with
 * `--labels/--judgments/--vpu/--report` pointing at the temp paths only.
 *
 * Nothing is written under /Volumes/Projects/Groundrules.club: the scorer
 * reads its roster, controls and pairs from there and writes only the report
 * we point it at. The answers are synthetic (modalities cycled, actor = the
 * shortest unique prefix of the passage) and never leave the temp directory;
 * they are not Robert's labels and this test records none.
 *
 * Skips, with a reason, when the Groundrules checkout or python3 is absent.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const createRouter = require('../routes/groundrules-labeling');
const { createLabelingWriteAuthority } = require('../services/groundrules-labeling/authority');
const { createPacketSource, DEFAULT_GOLD_DIR } = require('../services/groundrules-labeling/packet');
const { resolveQuote } = require('../services/groundrules-labeling/quotes');
const { MODALITIES } = require('../services/groundrules-labeling/validation');
const { closeRaw } = require('../../db/raw');

const GROUNDRULES_REPO = path.resolve(DEFAULT_GOLD_DIR, '../../..');
const REAL_PACKET = path.join(DEFAULT_GOLD_DIR, 'packet', 'packet.json');
const REAL_ROSTER = path.join(DEFAULT_GOLD_DIR, 'roster.json');
const REAL_SOURCES = path.join(path.dirname(DEFAULT_GOLD_DIR), 'sources');
/** The row the QA reviewer's probe used: its first words open both sentences of its unit. */
const AMBIGUOUS_ROW = 'fmla-substitution-health.serious';
const TASK = 'task-synthetic-roundtrip-0001';
const OPERATOR_KEY = 'synthetic-operator-key-0123456789abcdef';

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const available = fs.existsSync(REAL_PACKET) && fs.existsSync(REAL_ROSTER) && fs.existsSync(path.join(REAL_SOURCES, 'manifest.json')) && fs.existsSync(path.join(GROUNDRULES_REPO, 'src', 'ledger', 'goldset.py')) && python.status === 0;
const describeIf = available ? describe : describe.skip;

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}

/** Shortest word prefix of `text` that the anchor rule resolves uniquely (in `wide` too, when given). */
const unique = (text, wide, quote) => resolveQuote(text, quote).ok && (!wide || resolveQuote(wide, quote).ok);
function uniquePrefix(text, min = 1, wide = null) {
    const parts = text.split(/\s+/).filter(Boolean);
    for (let n = min; n <= parts.length; n += 1) {
        const quote = parts.slice(0, n).join(' ');
        if (unique(text, wide, quote)) return quote;
    }
    return text;
}
function uniqueSuffix(text, n = 4, wide = null) {
    const parts = text.split(/\s+/).filter(Boolean);
    for (let k = n; k <= parts.length; k += 1) {
        const quote = parts.slice(-k).join(' ');
        if (unique(text, wide, quote)) return quote;
    }
    return null;
}

describeIf('groundrules labeling export round trip (real packet, temp gold dir)', () => {
    let handle;
    let tmpDir;
    let goldDir;
    let dbPath;
    let packet;
    const saved = {};

    beforeAll(async () => {
        saved.NEXUS_OPERATOR_APPROVAL_KEY = process.env.NEXUS_OPERATOR_APPROVAL_KEY;
        saved.GROUNDRULES_LABELING_TASK_IDS = process.env.GROUNDRULES_LABELING_TASK_IDS;
        process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
        process.env.GROUNDRULES_LABELING_TASK_IDS = TASK;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-groundrules-roundtrip-'));
        goldDir = path.join(tmpDir, 'gold-set');
        fs.mkdirSync(path.join(goldDir, 'packet'), { recursive: true });
        fs.copyFileSync(REAL_PACKET, path.join(goldDir, 'packet', 'packet.json'));
        fs.copyFileSync(REAL_ROSTER, path.join(goldDir, 'roster.json'));
        // The corpus the scorer resolves anchors in, copied beside the gold
        // set so the unit-scope "within" check reads the isolated copy too.
        fs.cpSync(REAL_SOURCES, path.join(tmpDir, 'sources'), { recursive: true });
        dbPath = path.join(tmpDir, 'board.db');
        const packetSource = createPacketSource({ packetDir: path.join(goldDir, 'packet'), goldDir });
        expect(packetSource.sourcesDir).toBe(path.join(tmpDir, 'sources'));
        packet = packetSource.load();
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
        // No Access session in this process: writes rely on the synthetic operator key above.
        const noAccess = async () => ({ operator: false, identity: null, reason: 'assertion-missing' });
        const authorizeWrite = createLabelingWriteAuthority({ authenticateOperator: { inspect: noAccess } });
        app.use('/api/groundrules-labeling', createRouter({ dbPath, packetSource, authorizeWrite, operatorInspect: noAccess }));
        handle = await listen(app);
    });
    afterAll(async () => {
        for (const s of handle.sockets) s.destroy();
        await new Promise(resolve => handle.server.close(resolve));
        closeRaw(dbPath);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    });

    const api = async (method, route, body) => {
        const res = await fetch(`${handle.baseUrl}/api/groundrules-labeling${route}`, {
            method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR_KEY}` }, body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    test('synthetic answers for every packet item export as scorer documents the Groundrules scorer accepts', async () => {
        const realSha = require('crypto').createHash('sha256').update(fs.readFileSync(REAL_PACKET)).digest('hex');
        expect(packet.sha256).toBe(realSha);
        expect(packet.counts).toEqual({ provisions: 15, rows: 37, controls: 12, pairs: 3 });

        const started = await api('POST', `/tasks/${TASK}/session`);
        expect(started.status).toBe(201);
        const session = started.body.session;
        const sha = packet.sha256;

        // Stage A: one synthetic reading per row. Rows with a context whose
        // source unit is on file quote the actor from the context, so the
        // sourceUnit + within export path is checked by the scorer too.
        let contextQuoted = 0;
        let sectionBound = 0;
        let index = 0;
        let ambiguous = null;
        for (const provision of packet.stageA.provisions) {
            for (const row of provision.rows) {
                if (row.id === AMBIGUOUS_ROW) {
                    // The reviewer's case: actor quote and "within" both "An
                    // eligible employee", unique in the passage but opening both
                    // sentences of unit /us/usc/t29/s2612/d/2/B, where the scorer
                    // resolves "within". It is refused here, not by the scorer.
                    const view = packet.rowsById.get(row.id);
                    expect([view.sourceId, view.sourceUnit]).toEqual(['fmla', '/us/usc/t29/s2612/d/2/B']);
                    const span = { quote: 'An eligible employee', within: 'An eligible employee', source: 'row' };
                    const res = await api('PUT', `/sessions/${session.id}/answers/A/${encodeURIComponent(row.id)}`, { packet_sha256: sha, base_revision: null, state: 'draft', answer: { modality: 'may', actor: span, propositionsDeclared: 'none', propositions: [], notes: 'ambiguous anchor' } });
                    expect([res.status, res.body.answer.state]).toEqual([200, 'draft']);
                    expect(res.body.validation.errors).toEqual([expect.objectContaining({ path: 'actor.within', reason: 'within_not_unique_in_unit', count: 2 })]);
                    ambiguous = { row: view, revision: res.body.answer.revision };
                    index += 1;
                    continue;
                }
                const context = row.contexts.find(c => c.quotable);
                const actor = context
                    ? { quote: uniquePrefix(context.quote, 2), source: row.contexts.indexOf(context) }
                    : { quote: uniquePrefix(row.text, 2, row.anchorWithin), source: 'row' };
                if (context) contextQuoted += 1;
                if (row.anchorWithin) sectionBound += 1;
                const suffix = index % 2 === 0 ? uniqueSuffix(row.text, 4, row.anchorWithin) : null;
                const answer = {
                    modality: MODALITIES[index % MODALITIES.length],
                    actor,
                    propositionsDeclared: suffix ? 'some' : 'none',
                    propositions: suffix ? [{ category: 'condition', quote: suffix, numeric: index % 4 === 0 ? { value: index + 1, unit: 'day', operator: '<=' } : null }] : [],
                    notes: 'synthetic round-trip answer',
                };
                const res = await api('PUT', `/sessions/${session.id}/answers/A/${encodeURIComponent(row.id)}`, { packet_sha256: sha, base_revision: null, state: 'draft', answer });
                expect([row.id, res.status, res.body.validation?.errors]).toEqual([row.id, 200, []]);
                expect(res.body.answer.state).toBe('complete');
                index += 1;
            }
        }
        expect(index).toBe(37);
        expect(contextQuoted).toBeGreaterThan(0);
        expect(sectionBound).toBeGreaterThan(0);
        expect(ambiguous).not.toBeNull();

        // The commit refuses the stage while that anchor is ambiguous; the
        // draft is kept, nothing is exported.
        const refused = await api('POST', `/sessions/${session.id}/commit/A`, { packet_sha256: sha });
        expect([refused.status, refused.body.code, refused.body.missing, refused.body.unsure]).toEqual([422, 'incomplete', [], []]);
        expect(refused.body.invalid).toEqual([{ item_id: AMBIGUOUS_ROW, errors: [expect.objectContaining({ path: 'actor.within', reason: 'within_not_unique_in_unit', count: 2 })] }]);
        expect(fs.existsSync(path.join(goldDir, 'labels'))).toBe(false);

        // A "within" unique in the unit (the shortest prefix of the passage
        // that occurs once there) is accepted and is what the scorer gets.
        const unit = packet.unitText(ambiguous.row.sourceId, ambiguous.row.sourceUnit);
        expect(unit.ok).toBe(true);
        expect(resolveQuote(unit.text, 'An eligible employee')).toMatchObject({ ok: false, count: 2 });
        const uniqueWithin = uniquePrefix(ambiguous.row.text, 4, unit.text);
        expect(resolveQuote(unit.text, uniqueWithin).ok).toBe(true);
        const fixed = await api('PUT', `/sessions/${session.id}/answers/A/${encodeURIComponent(AMBIGUOUS_ROW)}`, { packet_sha256: sha, base_revision: ambiguous.revision, state: 'draft', answer: { modality: 'may', actor: { quote: 'An eligible employee', within: uniqueWithin, source: 'row' }, propositionsDeclared: 'none', propositions: [], notes: 'synthetic round-trip answer' } });
        expect([fixed.status, fixed.body.validation.errors, fixed.body.answer.state]).toEqual([200, [], 'complete']);

        const commitA = await api('POST', `/sessions/${session.id}/commit/A`, { packet_sha256: sha });
        expect(commitA.status).toBe(201);
        expect(commitA.body.commit.item_count).toBe(37);

        // Reading never reveals: the first disclosure is the operator's own POST.
        expect((await api('GET', `/sessions/${session.id}/stages/B`)).body.code).toBe('stage_not_revealed');
        expect((await api('POST', `/sessions/${session.id}/reveal/B`, { packet_sha256: sha })).status).toBe(201);
        const stageB = await api('GET', `/sessions/${session.id}/stages/B`);
        expect(stageB.status).toBe(200);
        expect(stageB.body.content.items).toHaveLength(12);
        for (const item of stageB.body.content.items) {
            const verdict = item.form === 'pair' ? 'equivalent' : 'accept';
            const res = await api('PUT', `/sessions/${session.id}/answers/B/${item.id}`, { packet_sha256: sha, base_revision: null, state: 'draft', answer: { verdict, note: 'synthetic' } });
            expect(res.body.answer.state).toBe('complete');
        }
        expect((await api('POST', `/sessions/${session.id}/commit/B`, { packet_sha256: sha })).status).toBe(201);
        expect((await api('POST', `/sessions/${session.id}/reveal/C`, { packet_sha256: sha })).status).toBe(201);
        const stageC = await api('GET', `/sessions/${session.id}/stages/C`);
        expect(stageC.body.content.items).toHaveLength(3);
        for (const item of stageC.body.content.items) {
            const res = await api('PUT', `/sessions/${session.id}/answers/C/${item.id}`, { packet_sha256: sha, base_revision: null, state: 'draft', answer: { exampleOutcomeSame: 'yes', meaning: 'different', divergingCase: 'synthetic diverging case', note: '' } });
            expect(res.body.answer.state).toBe('complete');
        }
        expect((await api('POST', `/sessions/${session.id}/commit/C`, { packet_sha256: sha })).status).toBe(201);

        for (const kind of ['A', 'B', 'C']) {
            const res = await api('POST', `/sessions/${session.id}/exports/${kind}`, { packet_sha256: sha });
            expect([kind, res.status]).toEqual([kind, 201]);
            expect(res.body.export.path.startsWith(goldDir)).toBe(true);
        }
        const labelsDir = path.join(goldDir, 'labels');
        const judgments = path.join(goldDir, 'judgments', 'robert.json');
        const vpu = path.join(goldDir, 'judgments', 'robert-vpu.json');
        const report = path.join(tmpDir, 'report.json');
        const labels = JSON.parse(fs.readFileSync(path.join(labelsDir, 'robert.json'), 'utf8'));
        expect(labels.rows).toHaveLength(37);
        expect(labels.blind).toBe(true);
        expect(labels.provenance.notBlind).toBeUndefined();
        expect(labels.rosterSha256).toBe(packet.digests.rosterSha256);
        expect(labels.labeledAt).toBe(commitA.body.commit.committed_at);
        expect(labels.rows.some(r => r.actor.sourceUnit && r.actor.within)).toBe(true);
        expect(labels.rows.some(r => !r.actor.sourceUnit && r.actor.within)).toBe(true);
        expect(labels.rows.find(r => r.rowId === AMBIGUOUS_ROW).actor).toEqual({ quote: 'An eligible employee', within: uniqueWithin });

        const run = spawnSync('python3', ['-m', 'src.ledger', 'goldset', '--labels', labelsDir, '--judgments', judgments, '--vpu', vpu, '--report', report], { cwd: GROUNDRULES_REPO, encoding: 'utf8', timeout: 180000 });
        const output = `${run.stdout}\n${run.stderr}`;
        expect([run.status, run.stderr.slice(-2500)]).toEqual([0, run.stderr.slice(-2500)]);
        expect(output).toMatch(/GOLD-SET extractors=0 gold=yes/);
        expect(output).toMatch(/CONTROLS robert: .*judged: every fixture answered/);
        expect(output).toMatch(/VPU robert: 3 pairs/);
        const written = JSON.parse(fs.readFileSync(report, 'utf8'));
        expect(written.gold).toBe('robert');
        expect(written.rosterSha256).toBe(packet.digests.rosterSha256);

        // The real gold set gained no labels, judgments or report from this run.
        expect(fs.existsSync(path.join(DEFAULT_GOLD_DIR, 'labels'))).toBe(false);
        expect(fs.existsSync(path.join(DEFAULT_GOLD_DIR, 'judgments'))).toBe(false);
        expect(fs.existsSync(path.join(DEFAULT_GOLD_DIR, 'post-exposure'))).toBe(false);
    }, 240000);
});
