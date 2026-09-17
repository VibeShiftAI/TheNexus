const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readEvidenceWork } = require('../services/local-evidence-work');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let dir;
const date = '2026-09-10';
const now = Date.parse('2026-09-10T10:50:00Z');
const sources = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: `Source ${i + 1}`, source: 'Research feed', url: `https://example.org/${i}`, summary: 'Summary' }));
const version = 'test-version';
const fingerprint = hash({ date, sources, extractorVersion: version });
const identity = source => { const { index, ...content } = source; return hash({ version, content }); };
async function write(relative, value) { const file = path.join(dir, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function checkpoint(index, status, extra = {}) {
 const source = sources[index];
 const cp = { version, source_identity: identity(source), report_fingerprint: fingerprint, source, status, started_at: '2026-09-10T10:48:00Z', ...(status !== 'running' ? { finished_at: '2026-09-10T10:49:00Z', duration_ms: 60000 } : {}), ...(['complete', 'partial', 'failed'].includes(status) ? { result: { status }, claims: [] } : {}), ...extra };
 await write(`ingestion/evidence/checkpoints/${identity(source)}.json`, { checksum: hash(cp), checkpoint: cp });
}
beforeEach(async () => {
 dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-evidence-work-'));
 await write('morning/recovery/knowledge-council.json', { date, status: 'running', startedAt: '2026-09-10T09:40:00Z' });
 await write(`ingestion/reports/${date}.json`, { date, sections: [{ items: sources.map(({ index, ...item }) => item) }] });
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

test('shows work still in the batch before it reaches the model queue', async () => {
 await checkpoint(0, 'complete'); await checkpoint(1, 'partial'); await checkpoint(2, 'failed'); await checkpoint(3, 'running');
 const result = await readEvidenceWork({ dataDir: dir, now });
 expect(result.available).toBe(true);
 expect(result.batch).toMatchObject({ date, total: 5, attempted: 3, complete: 1, partial: 1, failed: 1, remaining: 2, activity: 'processing' });
 expect(result.batch.current.map(s => s.title)).toEqual(['Source 4']);
 expect(result.batch.waiting.map(s => s.title)).toEqual(['Source 5']);
 expect(JSON.stringify(result)).not.toMatch(/Summary|raw_output|claims/);
});

test('stale running records remain unconfirmed instead of claiming live activity', async () => {
 await checkpoint(0, 'running', { started_at: '2026-09-10T09:40:00Z' });
 const { batch } = await readEvidenceWork({ dataDir: dir, now });
 expect(batch.activity).toBe('unconfirmed');
 expect(batch.remaining).toBe(5);
});

test('ignores checkpoints for another report version and reports a changed source list as unavailable', async () => {
 await checkpoint(0, 'complete', { report_fingerprint: 'old-report', result: undefined, claims: undefined });
 await checkpoint(1, 'running');
 expect((await readEvidenceWork({ dataDir: dir, now })).batch.attempted).toBe(0);
 await write(`ingestion/reports/${date}.json`, { date, sections: [{ items: [{ title: 'Changed', source: 'Feed', summary: '' }] }] });
 expect((await readEvidenceWork({ dataDir: dir, now })).available).toBe(false);
});

test('corrupt progress is unavailable instead of an invented empty queue', async () => {
 await checkpoint(0, 'running');
 const file = `ingestion/evidence/checkpoints/${identity(sources[0])}.json`;
 const sealed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
 sealed.checkpoint.source.title = 'Tampered';
 await write(file, sealed);
 expect((await readEvidenceWork({ dataDir: dir, now })).available).toBe(false);
});

test('a published matching ledger removes the finished extraction batch', async () => {
 await checkpoint(0, 'complete');
 await write(`ingestion/evidence/${date}.json`, { date, report_fingerprint: fingerprint, generated_at: '2026-09-10T10:50:00Z', coverage: { status: 'partial' } });
 expect((await readEvidenceWork({ dataDir: dir, now })).batch).toBe(null);
});

test('resumed batches reuse validated settled sources across council starts, report fingerprints, and source ordering', async () => {
 const old = { started_at: '2026-09-09T08:00:00Z', finished_at: '2026-09-09T08:01:00Z', report_fingerprint: 'prior-report' };
 await checkpoint(0, 'complete', { ...old, source: { ...sources[0], index: 9 }, result: { status: 'complete' }, claims: [{ claim: 'A finding', source_index: 9, support_quote: 'Summary' }] });
 await checkpoint(1, 'partial', { ...old, claims: [{ claim: 'A retained finding', source_index: 2, support_quote: 'Summary' }] });
 await checkpoint(2, 'failed', old);
 await checkpoint(3, 'running');
 const { batch } = await readEvidenceWork({ dataDir: dir, now });
 expect(batch).toMatchObject({ attempted: 3, complete: 1, partial: 1, failed: 1, remaining: 2, lastProgressAt: '2026-09-10T10:48:00Z' });
 expect(batch.waiting.map(s => s.index)).toEqual([5]);
});

test('deferred source checkpoints remain waiting and resumable', async () => {
 await checkpoint(0, 'complete');
 await checkpoint(1, 'deferred', { error: 'CLI capacity unavailable' });
 await checkpoint(2, 'running');
 const result = await readEvidenceWork({ dataDir: dir, now });
 expect(result.available).toBe(true);
 expect(result.batch).toMatchObject({ attempted: 1, complete: 1, partial: 0, failed: 0, remaining: 4 });
 expect(result.batch.current.map(s => s.index)).toEqual([3]);
 expect(result.batch.waiting.map(s => s.index)).toEqual([2, 4, 5]);
});

test.each(['complete', 'partial', 'failed'])('invalid %s claims and inconsistent settled results remain waiting on resume', async status => {
 const old = { started_at: '2026-09-09T08:00:00Z', finished_at: '2026-09-09T08:01:00Z' };
 await checkpoint(0, status, { ...old, claims: [{ claim: 'Unsupported old finding', source_index: 1, support_quote: 'Missing quote' }] });
 await checkpoint(1, status, { claims: [{ claim: 'Unsupported current finding', source_index: 2, support_quote: 'Missing quote' }] });
 await checkpoint(2, status, { ...old, result: { status: 'running' } });
 await checkpoint(3, 'running');
 const { batch } = await readEvidenceWork({ dataDir: dir, now });
 expect(batch.attempted).toBe(0);
 expect(batch.waiting.map(s => s.index)).toEqual([1, 2, 3, 5]);
});

test('invalid prior claims remain waiting because the producer will extract them again', async () => {
 await checkpoint(0, 'complete', { started_at: '2026-09-09T08:00:00Z', finished_at: '2026-09-09T08:01:00Z', result: { status: 'complete' }, claims: [{ claim: 'A finding', source_index: 1, support_quote: 'Missing quote' }] });
 await checkpoint(1, 'running');
 const { batch } = await readEvidenceWork({ dataDir: dir, now });
 expect(batch.attempted).toBe(0);
 expect(batch.waiting.map(s => s.index)).toEqual([1, 3, 4, 5]);
});

test('an older partial ledger cannot hide an active retry', async () => {
 await checkpoint(0, 'running');
 await write(`ingestion/evidence/${date}.json`, { date, extractor_version: version, report_fingerprint: fingerprint, generated_at: '2026-09-10T08:00:00Z', coverage: { status: 'partial' } });
 expect((await readEvidenceWork({ dataDir: dir, now })).batch.current[0].index).toBe(1);
});

test('a council rerun can reuse an already published ledger without new checkpoints', async () => {
 await write(`ingestion/evidence/${date}.json`, { date, extractor_version: version, report_fingerprint: fingerprint, generated_at: '2026-09-10T08:00:00Z', coverage: { status: 'partial' } });
 expect(await readEvidenceWork({ dataDir: dir, now })).toEqual({ available: true, batch: null });
});

test('missing progress does not turn a running morning record into zero work', async () => {
 const result = await readEvidenceWork({ dataDir: dir, now });
 expect(result.available).toBe(false);
});
