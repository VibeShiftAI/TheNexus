/**
 * Nightly Astrophysics Agent.
 *
 * A Cortex-style overnight knowledge ingestion specialized for the Impossible
 * Worlds Field Guide catalog. Two cooperating parts:
 *
 *   1. Astrophysics Agent — pulls real data from key-free public sources:
 *        - NASA Exoplanet Archive (TAP) for confirmed/candidate planets
 *        - ArXiv (astro-ph) abstracts for neutron stars, rogue planets, exoplanets
 *      NASA rows map deterministically to known spec values; ArXiv abstracts are
 *      read by the LOCAL LLM via the shared extraction pipeline.
 *
 *   2. Parameter Calculator — server/services/astro-parameters.js, applied to
 *      every touched object so surface gravity, escape velocity, density,
 *      equilibrium temperature, atmospheric density, scale height, and sky
 *      appearance are filled in and mathematically sound.
 *
 * BACKFILL vs INCREMENTAL — the agent does NOT just re-pull the newest slice
 * every night. A per-source cursor (studio_ingestion_cursors) tracks progress:
 *   - NASA runs in "backfill" mode, keyset-paginating the whole archive by
 *     pl_name a batch at a time, advancing the cursor each night. When the
 *     archive is drained it flips to "incremental" (only rows whose rowupdate is
 *     newer than the last run).
 *   - ArXiv pages through results by a start offset per topic, applying the
 *     content_hash dedup so the same abstract is never re-read.
 *   - An enrichment worklist drains objects that have never had related-video
 *     expansion (tracked by space_objects.enriched_at).
 *
 * Runs entirely local for any LLM step. Writes a studio_ingestion_runs digest.
 */

const crypto = require('crypto');
const youtube = require('./youtube-api');

const NASA_TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const ARXIV_API = 'http://export.arxiv.org/api/query';
const PC_TO_LY = 3.261563777;
const NASA_COLS = 'pl_name,hostname,pl_bmasse,pl_rade,pl_dens,pl_orbper,pl_eqt,pl_insol,st_spectype,sy_dist,disc_year,discoverymethod';
const NASA_WHERE = 'default_flag=1 and pl_rade is not null';

const ARXIV_TOPICS = [
  { kind: 'rogue planet', query: 'cat:astro-ph.EP AND (abs:"rogue planet" OR abs:"free-floating planet")' },
  { kind: 'neutron star', query: 'cat:astro-ph.HE AND (abs:"neutron star" OR abs:magnetar OR abs:pulsar)' },
  { kind: 'exoplanet', query: 'cat:astro-ph.EP AND (abs:"hot Jupiter" OR abs:"ocean world" OR abs:"tidally locked")' },
];

const NASA_BATCH = Number(process.env.STUDIO_NASA_BATCH) || 200;
const ARXIV_BATCH = Number(process.env.STUDIO_ARXIV_BATCH) || 6;
const ENRICH_BATCH = Number(process.env.STUDIO_ENRICH_BATCH) || 25;

// ---- pure cursor logic (exported for tests) ----------------------------

function buildNasaQuery(cursor, batch) {
  if (cursor.mode === 'incremental' && cursor.last_run_at) {
    const since = String(cursor.last_run_at).slice(0, 10);
    return `select top ${batch} ${NASA_COLS} from ps where ${NASA_WHERE} and rowupdate > '${since}' order by rowupdate desc`;
  }
  const pos = String(cursor.position || '').replace(/'/g, "''");
  const gate = pos ? ` and pl_name > '${pos}'` : '';
  return `select top ${batch} ${NASA_COLS} from ps where ${NASA_WHERE}${gate} order by pl_name asc`;
}

function advanceNasaCursor(cursor, rows, batch) {
  const next = { ...cursor, processed_count: (cursor.processed_count || 0) + rows.length };
  if (cursor.mode === 'incremental') {
    next.last_run_at = new Date().toISOString();
    return next;
  }
  if (rows.length) next.position = rows[rows.length - 1].pl_name;
  if (rows.length < batch) {
    // Archive drained — switch to staying current.
    next.mode = 'incremental';
    next.last_run_at = new Date().toISOString();
  }
  return next;
}

function advanceArxivCursor(cursor, gotCount, batch) {
  const start = Number(cursor.position || 0);
  const next = { ...cursor, processed_count: (cursor.processed_count || 0) + gotCount };
  // Walk deeper while pages stay full; wrap back to the front (newest) when a
  // short/empty page signals we've reached the end of useful history.
  next.position = gotCount < batch ? '0' : String(start + batch);
  return next;
}

function decodeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

function parseArxiv(xml) {
  const entries = [];
  const blocks = String(xml).split('<entry>').slice(1);
  for (const block of blocks) {
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const summary = decodeXml((block.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').trim();
    const id = ((block.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '').trim();
    if (title && summary) entries.push({ title, summary, url: id });
  }
  return entries;
}

function createAstroNightly({ sql, uuid, now, ingestion, getChannel, callAI, deps = {} }) {
  const IMPOSSIBLE_WORLDS = 'impossible-worlds-field-guide';

  const fetchNasa = deps.fetchNasa || (async (query) => {
    const url = `${NASA_TAP}?query=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`NASA TAP HTTP ${res.status}`);
    return res.json();
  });

  const fetchNasaCount = deps.fetchNasaCount || (async () => {
    const url = `${NASA_TAP}?query=${encodeURIComponent(`select count(*) as n from ps where ${NASA_WHERE}`)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`NASA TAP count HTTP ${res.status}`);
    const data = await res.json();
    const row = (data && data[0]) || {};
    return Number(row.n ?? row.N ?? row.count ?? 0) || null;
  });

  const fetchArxiv = deps.fetchArxiv || (async (query, max, start) => {
    const url = `${ARXIV_API}?search_query=${encodeURIComponent(query)}&start=${start || 0}&max_results=${max}&sortBy=submittedDate&sortOrder=descending`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`ArXiv HTTP ${res.status}`);
    return parseArxiv(await res.text());
  });

  // ---- cursor persistence ------------------------------------------------

  function getCursor(channelId, source) {
    const row = sql.prepare('SELECT * FROM studio_ingestion_cursors WHERE channel_id = ? AND source = ?').get(channelId, source);
    return row || { channel_id: channelId, source, mode: 'backfill', position: '', last_run_at: null, processed_count: 0, total_estimate: null };
  }

  function saveCursor(c) {
    sql.prepare(
      `INSERT INTO studio_ingestion_cursors (channel_id, source, mode, position, last_run_at, processed_count, total_estimate, updated_at)
       VALUES (@channel_id, @source, @mode, @position, @last_run_at, @processed_count, @total_estimate, @updated_at)
       ON CONFLICT(channel_id, source) DO UPDATE SET
         mode = excluded.mode, position = excluded.position, last_run_at = excluded.last_run_at,
         processed_count = excluded.processed_count, total_estimate = excluded.total_estimate, updated_at = excluded.updated_at`
    ).run({
      channel_id: c.channel_id, source: c.source, mode: c.mode || 'backfill',
      position: c.position == null ? '' : String(c.position), last_run_at: c.last_run_at || null,
      processed_count: c.processed_count || 0, total_estimate: c.total_estimate == null ? null : Number(c.total_estimate),
      updated_at: now(),
    });
  }

  function nasaRowToRecord(row) {
    const specs = [];
    const known = (spec_key, value_number, unit, notes) => {
      if (value_number == null || value_number === '' || !Number.isFinite(Number(value_number))) return;
      specs.push({ spec_key, value_number: Number(value_number), unit, status: 'known', confidence: 'high', notes: notes || 'NASA Exoplanet Archive' });
    };
    const knownText = (spec_key, value_text, notes) => {
      if (!value_text) return;
      specs.push({ spec_key, value_text: String(value_text), status: 'known', confidence: 'high', notes: notes || 'NASA Exoplanet Archive' });
    };

    known('bulk.mass_earth', row.pl_bmasse, 'Earth masses');
    known('bulk.radius_earth', row.pl_rade, 'Earth radii');
    known('bulk.density_g_cm3', row.pl_dens, 'g/cm3');
    known('orbital.orbital_period_days', row.pl_orbper, 'days');
    known('energy.equilibrium_temperature_k', row.pl_eqt, 'K', 'NASA Exoplanet Archive (measured/modeled T_eq)');
    known('energy.stellar_flux_earth', row.pl_insol, 'Earth flux');
    if (row.sy_dist != null && Number.isFinite(Number(row.sy_dist))) {
      known('discovery.distance_from_earth_ly', Number(row.sy_dist) * PC_TO_LY, 'ly', `${row.sy_dist} pc × 3.262`);
    }
    knownText('discovery.discovery_date', row.disc_year != null ? String(row.disc_year) : null);
    knownText('discovery.discovery_method', row.discoverymethod);
    knownText('location.host_star_or_object', row.hostname ? `${row.hostname}${row.st_spectype ? ` (${row.st_spectype})` : ''}` : null);

    return {
      name: row.pl_name,
      object_kind: 'exoplanet',
      reality_status: 'observed',
      field_guide_summary: `${row.pl_name} is a confirmed exoplanet orbiting ${row.hostname || 'its host star'}${row.discoverymethod ? `, found via ${row.discoverymethod}` : ''}.`,
      spec_values: specs,
    };
  }

  // ---- phases ------------------------------------------------------------

  async function runNasaPhase(channelId, touched, notes) {
    const cursor = getCursor(channelId, 'nasa_exoplanets');
    if (cursor.total_estimate == null) {
      try { cursor.total_estimate = await fetchNasaCount(); } catch { /* progress estimate is best-effort */ }
    }
    const query = buildNasaQuery(cursor, NASA_BATCH);
    const rows = await fetchNasa(query);
    let added = 0;
    const tx = sql.transaction(() => {
      for (const row of rows) {
        if (!row.pl_name) continue;
        const id = ingestion.upsertObject(channelId, nasaRowToRecord(row), null);
        if (id) { added++; touched.push({ id, name: row.pl_name }); }
      }
    });
    tx();
    const next = advanceNasaCursor(cursor, rows, NASA_BATCH);
    saveCursor(next);

    if (next.mode === 'incremental' && cursor.mode === 'backfill') {
      return `NASA backfill complete (${next.processed_count} planets); now incremental. +${added} this run.`;
    }
    if (next.mode === 'backfill') {
      const total = next.total_estimate ? `/${next.total_estimate}` : '';
      return `NASA backfill ${next.processed_count}${total} planets (resume after "${next.position}"); +${added} this run.`;
    }
    return `NASA incremental: +${added} new/updated planet(s).`;
  }

  async function runArxivPhase(channel, runId, touched, notes) {
    let arxivObjects = 0;
    for (const topic of ARXIV_TOPICS) {
      const source = `arxiv:${topic.kind}`;
      try {
        const cursor = getCursor(channel.id, source);
        const start = Number(cursor.position || 0);
        const entries = await fetchArxiv(topic.query, ARXIV_BATCH, start);
        for (const entry of entries) {
          const contentHash = crypto.createHash('sha1').update(entry.url || entry.title).digest('hex');
          if (ingestion.alreadySeen(channel.id, contentHash)) continue; // never re-read the same abstract
          const item = {
            title: entry.title,
            text: `${entry.title}\n\n${entry.summary}`,
            url: null,
            source_type: 'arxiv',
            source_name: source,
            content_hash: contentHash,
          };
          const result = await ingestion.processItem(channel, runId, item);
          arxivObjects += result.objects || 0;
          for (const o of (result.upsertedIds || [])) touched.push(o);
        }
        saveCursor(advanceArxivCursor(cursor, entries.length, ARXIV_BATCH));
      } catch (e) {
        notes.push(`ArXiv "${topic.kind}" failed: ${e.message}.`);
      }
    }
    return arxivObjects;
  }

  // Drain objects that have never been enriched (parameter refresh + related-video
  // expansion), oldest first, marking enriched_at so the backlog counts down.
  async function enrichBacklog(channel, runId, batch = ENRICH_BATCH) {
    const objects = sql.prepare(
      'SELECT * FROM space_objects WHERE channel_id = ? AND enriched_at IS NULL ORDER BY created_at ASC LIMIT ?'
    ).all(channel.id, Math.max(1, batch));
    let expanded = 0;
    let ytErrors = 0;
    let ytErrorMsg = null;
    const hasKey = youtube.hasKey();
    for (const obj of objects) {
      // Parameter calculation always runs (no network needed).
      ingestion.applyDerivedParams(obj.id);
      let enriched = true;
      if (hasKey) {
        const exp = await ingestion.expandObjectFromYouTube(channel, runId, obj, { perObject: 2 });
        expanded += exp.objects || 0;
        // If the YouTube call errored (e.g. Data API disabled), DON'T mark the
        // object enriched — leave it in the queue so it retries once fixed.
        if (exp.error) { ytErrors += 1; ytErrorMsg = exp.error; enriched = false; }
      }
      if (enriched) sql.prepare('UPDATE space_objects SET enriched_at = ? WHERE id = ?').run(now(), obj.id);
    }
    const remaining = sql.prepare('SELECT COUNT(*) AS n FROM space_objects WHERE channel_id = ? AND enriched_at IS NULL').get(channel.id).n;
    return { processed: objects.length, expanded, remaining, ytErrors, ytErrorMsg, hasKey };
  }

  // ---- orchestration -----------------------------------------------------

  async function run({ channelId = IMPOSSIBLE_WORLDS, existingRunId } = {}) {
    const channel = getChannel(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const runId = existingRunId || ingestion.createRun(channelId, 'nightly');
    const notes = [];
    const touched = [];
    let nasaSummary = '';
    let arxivObjects = 0;

    ingestion.updateRun(runId, { status: 'running', digest: 'Astrophysics agent backfilling NASA + ArXiv…' });

    try { nasaSummary = await runNasaPhase(channelId, touched, notes); }
    catch (e) { notes.push(`NASA phase failed: ${e.message}.`); }

    try { arxivObjects = await runArxivPhase(channel, runId, touched, notes); }
    catch (e) { notes.push(`ArXiv phase failed: ${e.message}.`); }

    // Parameter calculator over everything touched this run.
    const uniqueIds = [...new Set(touched.map((t) => t.id))];
    for (const id of uniqueIds) ingestion.applyDerivedParams(id);

    const enrich = await enrichBacklog(channel, runId);
    if (enrich.ytErrors) notes.push(`Related-video enrichment skipped (will retry): ${enrich.ytErrorMsg}`);
    else if (!enrich.hasKey) notes.push('Related-video enrichment skipped — no YOUTUBE_API_KEY (parameters still computed).');

    const digest = [
      nasaSummary || 'NASA: no data this run.',
      `ArXiv: +${arxivObjects} object record(s).`,
      `Enrichment: processed ${enrich.processed}, +${enrich.expanded} from related videos, ${enrich.remaining} object(s) left to enrich.`,
      notes.length ? `Notes: ${notes.join(' ')}` : null,
    ].filter(Boolean).join(' ');

    ingestion.updateRun(runId, {
      status: 'complete', items_succeeded: uniqueIds.length, items_enqueued: uniqueIds.length, digest,
    });
    return { runId, nasaSummary, arxivObjects, enriched: enrich.processed, objects: uniqueIds.length };
  }

  // Standalone enrichment drain — used by the "Enrich catalog" button to deepen
  // existing objects (parameters + related videos) without re-pulling NASA/ArXiv.
  async function runEnrichment({ channelId = IMPOSSIBLE_WORLDS, existingRunId, batch } = {}) {
    const channel = getChannel(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const runId = existingRunId || ingestion.createRun(channelId, 'enrich');
    ingestion.updateRun(runId, { status: 'running', digest: 'Enriching catalog objects…' });
    const enrich = await enrichBacklog(channel, runId, batch || ENRICH_BATCH);
    const notes = [];
    if (enrich.ytErrors) notes.push(`Related-video enrichment errored (will retry): ${enrich.ytErrorMsg}`);
    else if (!enrich.hasKey) notes.push('No YOUTUBE_API_KEY — only parameters computed.');
    const digest = `Enrichment: processed ${enrich.processed}, +${enrich.expanded} from related videos, ${enrich.remaining} object(s) left to enrich.${notes.length ? ' ' + notes.join(' ') : ''}`;
    ingestion.updateRun(runId, { status: 'complete', items_succeeded: enrich.processed, items_enqueued: enrich.processed, digest });
    return { runId, ...enrich };
  }

  return {
    run, runEnrichment, getCursor, saveCursor, nasaRowToRecord, parseArxiv,
    runNasaPhase, runArxivPhase, enrichBacklog,
    // pure helpers re-exported for convenience
    buildNasaQuery, advanceNasaCursor, advanceArxivCursor,
  };
}

/**
 * Lightweight daily scheduler (mirrors server/services/calendar-scheduler.js).
 * Fires runFn once per day at the configured local hour.
 */
function startNightlyScheduler({ runFn, hour = 2, log = console }) {
  let lastRunDay = null;
  const tick = async () => {
    const d = new Date();
    const dayKey = d.toISOString().slice(0, 10);
    if (d.getHours() === hour && lastRunDay !== dayKey) {
      lastRunDay = dayKey;
      try { log.log('[astro-nightly] starting scheduled run'); await runFn(); log.log('[astro-nightly] scheduled run complete'); }
      catch (e) { log.warn('[astro-nightly] scheduled run failed:', e.message); }
    }
  };
  const intervalId = setInterval(tick, 10 * 60 * 1000); // check every 10 min
  if (intervalId.unref) intervalId.unref();
  return () => clearInterval(intervalId);
}

module.exports = createAstroNightly;
module.exports.startNightlyScheduler = startNightlyScheduler;
module.exports.buildNasaQuery = buildNasaQuery;
module.exports.advanceNasaCursor = advanceNasaCursor;
module.exports.advanceArxivCursor = advanceArxivCursor;
module.exports.parseArxiv = parseArxiv;
