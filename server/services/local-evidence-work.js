/** Observe the source batch held upstream of LM Studio; never start or retry extraction. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (source, version) => {
  const { index, ...content } = source;
  return hash({ version, content });
};
const settledStatuses = new Set(['complete', 'partial', 'failed']);
// Match the producer's settled-cache validation. Source order and the report
// fingerprint may change while the source content/extractor identity stays valid.
function reusableSettled(cp) {
  if (!settledStatuses.has(cp.status) || cp.result?.status !== cp.status || !Array.isArray(cp.claims)) return false;
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  return cp.claims.every(claim => {
    const quote = typeof claim?.support_quote === 'string' ? normalize(claim.support_quote) : '';
    return typeof claim?.claim === 'string' && claim.claim.trim() &&
      Number.isInteger(claim.source_index) && claim.source_index === cp.source.index && quote &&
      [cp.source.title, cp.source.summary ?? ''].some(text => normalize(text).includes(quote));
  });
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readEvidenceWork({
  dataDir = process.env.PRAXIS_DATA_DIR || path.resolve(__dirname, '../../../Praxis/data'),
  now = Date.now(),
} = {}) {
  try {
    const work = await readJson(path.join(dataDir, 'morning/recovery/knowledge-council.json'));
    if (!work || work.status !== 'running') return { available: true, batch: null };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(work.date) || !Number.isFinite(Date.parse(work.startedAt))) throw new Error('Invalid work record');
    const report = await readJson(path.join(dataDir, 'ingestion/reports', `${work.date}.json`));
    if (report?.date !== work.date || !Array.isArray(report.sections)) throw new Error('Report unavailable');
    // Wire shape/order matches Praxis collectEvidenceSources and evidenceHash.
    // The fingerprint prevents joining progress to a report edited mid-run.
    const sources = [];
    for (const section of report.sections) {
      if (!Array.isArray(section.items)) throw new Error('Invalid source section');
      for (const item of section.items) {
        if (typeof item.title !== 'string') throw new Error('Invalid source title');
        sources.push({ index: sources.length + 1, title: item.title, source: item.source, url: item.url,
          ...(typeof item.published_at === 'string' ? { published_at: item.published_at } : {}), summary: item.summary ?? '' });
      }
    }
    if (!sources.length) return { available: true, batch: null };
    const checkpointDir = path.join(dataDir, 'ingestion/evidence/checkpoints');
    const files = (await fs.readdir(checkpointDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const checkpoints = [];
    // Bound concurrent file opens. This is shared by the cached work reader.
    for (let start = 0; start < files.length; start += 16) {
      const sealed = await Promise.all(files.slice(start, start + 16).map(file => readJson(path.join(checkpointDir, file))));
      for (const row of sealed) {
        const cp = row?.checkpoint;
        if (!cp) continue;
        if (row.checksum !== hash(cp) || !cp.source || typeof cp.version !== 'string' ||
            identity(cp.source, cp.version) !== cp.source_identity || !Number.isFinite(Date.parse(cp.started_at))) throw new Error('Invalid checkpoint');
        checkpoints.push(cp);
      }
    }
    const currentRun = checkpoints.filter(cp => Date.parse(cp.started_at) >= Date.parse(work.startedAt));
    const latest = currentRun.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || Number(b.status === 'running') - Number(a.status === 'running'))[0];
    const published = await readJson(path.join(dataDir, 'ingestion/evidence', `${work.date}.json`));
    const publishedVersion = latest?.version ?? published?.extractor_version;
    const publishedMatches = typeof publishedVersion === 'string' && published?.coverage?.status &&
      published.report_fingerprint === hash({ date: work.date, sources, extractorVersion: publishedVersion });
    // A council rerun may reuse yesterday's finished extraction without writing
    // new checkpoints. A newer invocation, however, is an active explicit retry.
    if (publishedMatches && (!latest || Date.parse(published.generated_at) >= Date.parse(latest.started_at))) {
      return { available: true, batch: null };
    }
    if (!latest) throw new Error('No source progress yet');
    const fingerprint = hash({ date: work.date, sources, extractorVersion: latest.version });
    if (fingerprint !== latest.report_fingerprint) throw new Error('Report changed during extraction');
    const byIdentity = new Map(checkpoints.filter(cp => cp.version === latest.version &&
      (reusableSettled(cp) || (!settledStatuses.has(cp.status) &&
        Date.parse(cp.started_at) >= Date.parse(work.startedAt) && cp.report_fingerprint === fingerprint)))
      .map(cp => [cp.source_identity, cp]));
    const counts = { complete: 0, partial: 0, failed: 0 };
    const current = [], waiting = [];
    let lastProgressAt = work.startedAt;
    for (const source of sources) {
      const cp = byIdentity.get(identity(source, latest.version));
      const item = { index: source.index, title: source.title, source: source.source ?? '' };
      if (!cp) waiting.push(item);
      else {
        const at = cp.finished_at ?? cp.started_at;
        if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid progress timestamp');
        if (Date.parse(at) > Date.parse(lastProgressAt)) lastProgressAt = at;
        if (cp.status === 'deferred') waiting.push(item);
        else if (cp.status === 'running') current.push({ ...item, startedAt: cp.started_at });
        else if (Object.hasOwn(counts, cp.status)) counts[cp.status] += 1;
        else throw new Error('Invalid progress status');
      }
    }
    const attempted = counts.complete + counts.partial + counts.failed;
    return { available: true, batch: {
      date: work.date, name: 'Morning research evidence extraction', total: sources.length, attempted,
      ...counts, remaining: sources.length - attempted, current, waiting, lastProgressAt,
      // A durable running record is not a heartbeat. Preserve stale work but
      // never assert that it is still executing after a crash/restart.
      activity: now - Date.parse(lastProgressAt) > 15 * 60_000 ? 'unconfirmed' : current.length ? 'processing' : 'between-sources',
    } };
  } catch {
    return { available: false, batch: null, error: 'Research batch progress unavailable.' };
  }
}

module.exports = { readEvidenceWork };
