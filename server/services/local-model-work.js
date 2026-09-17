/** Read-only model-server queue plus the durable Praxis jobs waiting to submit work. */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');
const { praxisJson } = require('./praxis-client');
const { readEvidenceWork } = require('./local-evidence-work');

function createLocalModelWorkReader({
  exec = promisify(execFile),
  readQueue = () => praxisJson('/local-llm/queue?active=1', { timeoutMs: 3000 }),
  readEvidence = () => readEvidenceWork(),
  lmsPath = process.env.LMS_CLI_PATH || path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
  now = Date.now,
} = {}) {
  let cache = null;
  let cachedAt = 0;
  let inflight = null;
  let generation = 0;
  async function readLocalModelWork() {
    if (cache && now() - cachedAt < 3000) return cache;
    if (inflight) return inflight;
    const startedGeneration = generation;
    const request = (async () => {
      const [native, background, evidence] = await Promise.allSettled([
        (async () => {
          const { stdout } = await exec(lmsPath, ['ps', '--json'], { timeout: 2500, maxBuffer: 1024 * 1024 });
          const rows = JSON.parse(stdout);
          if (!Array.isArray(rows)) throw new Error('Invalid model queue');
          return rows.map(row => {
            if (!row || typeof row.identifier !== 'string') throw new Error('Invalid model identity');
            return {
              id: row.identifier,
              name: typeof row.displayName === 'string' ? row.displayName : row.identifier,
              type: typeof row.type === 'string' ? row.type : null,
              status: typeof row.status === 'string' ? row.status : null,
              // `parallel` is configured capacity, NOT occupancy. Old CLIs and
              // embedding models may omit stats; preserve that as unknown.
              queued: Number.isInteger(row.queued) && row.queued >= 0 ? row.queued : null,
            };
          });
        })(),
        Promise.resolve().then(readQueue).then(queue => {
          if (!queue || !Array.isArray(queue.jobs) || typeof queue.worker?.paused !== 'boolean') {
            throw new Error('Invalid background queue');
          }
          return { worker: queue.worker, counts: queue.counts ?? {}, jobs: queue.jobs };
        }),
        Promise.resolve().then(readEvidence),
      ]);
      const snapshot = {
        observedAt: new Date(now()).toISOString(),
        lmStudio: native.status === 'fulfilled'
          ? { available: true, models: native.value }
          : { available: false, models: [], error: 'LM Studio request queue unavailable.' },
        background: background.status === 'fulfilled'
          ? { available: true, ...background.value }
          : { available: false, jobs: [], counts: {}, worker: null, error: 'Background job queue unavailable.' },
        evidence: evidence.status === 'fulfilled' ? evidence.value
          : { available: false, batch: null, error: 'Research batch progress unavailable.' },
      };
      if (generation === startedGeneration) {
        cache = snapshot;
        cachedAt = now();
      }
      return snapshot;
    })();
    inflight = request;
    try { return await request; }
    finally { if (inflight === request) inflight = null; }
  }
  readLocalModelWork.invalidate = () => { generation += 1; cache = null; inflight = null; };
  return readLocalModelWork;
}

module.exports = { createLocalModelWorkReader };
