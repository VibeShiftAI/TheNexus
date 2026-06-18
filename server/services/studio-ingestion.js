/**
 * Studio ingestion worker.
 *
 * Turns the Studio "Run local ingestion" button into a real pipeline:
 *   discover → dedup → fetch → local-LLM extract → upsert into the object catalog
 *   → derive physical parameters → expand the topic with related YouTube videos.
 *
 * Constraints (per design spec):
 *  - Extraction is LOCAL ONLY. We never tier up to a cloud provider here.
 *  - Every spec value carries a status + confidence + provenance (source_item_id).
 *
 * Dependencies are injected from server/routes/studio.js so we reuse its db
 * handle and helpers rather than re-implementing them.
 */

const astro = require('./astro-parameters');
const crypto = require('crypto');

const CHUNK_CHARS = 12000; // keep each local-LLM call comfortably within context

function createStudioIngestion({ sql, callAI, uuid, now, helpers, listSources, deps = {} }) {
  const { upsertSpecValues, insertWonderPoints, extractJSON } = helpers;
  // Injectable for tests; default to the real network-backed implementations.
  const youtube = deps.youtube || require('./youtube-api');
  const fetchSourceContent = deps.fetchSourceContent || require('./source-fetch').fetchSourceContent;

  function localModel() {
    return { provider: 'local', model: process.env.LOCAL_STUDIO_MODEL || 'gemma4' };
  }

  function hashOf(...parts) {
    return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex');
  }

  function specKeyList() {
    try {
      return sql.prepare('SELECT key, label, unit, category FROM space_spec_definitions ORDER BY sort_order ASC').all();
    } catch {
      return [];
    }
  }

  function extractionSystem(channel) {
    return [
      `You are an astrophysics research extractor for the YouTube channel "${channel?.name || 'Impossible Worlds Field Guide'}".`,
      'You read source material (article text or video transcript) and extract structured records about space objects and phenomena.',
      'Only record what the source supports. Use the status field honestly: known (stated/measured), estimated (derived/approximate), unknown, not_applicable, disputed.',
      'Never invent catalog ids, distances, or measurements. Prefer fewer, well-supported facts over many guesses.',
      'Output strict JSON only — no prose, no markdown fences.',
    ].join('\n');
  }

  function extractionUser(item, text) {
    const keys = specKeyList();
    const keyLines = keys.map((k) => `  ${k.key}${k.unit ? ` (${k.unit})` : ''} — ${k.label}`).join('\n');
    return [
      `SOURCE TITLE: ${item.title || '(untitled)'}`,
      item.url ? `SOURCE URL: ${item.url}` : null,
      '',
      'SOURCE CONTENT:',
      text.slice(0, CHUNK_CHARS),
      '',
      'Extract a JSON object with this shape:',
      `{
  "objects": [
    {
      "name": string,
      "aliases": string[],
      "object_kind": string,           // e.g. exoplanet, neutron star, rogue planet, moon, star
      "subtype": string,
      "reality_status": "observed" | "candidate" | "theoretical" | "fictional_physics_sandbox",
      "field_guide_summary": string,   // 1-3 sentences, vivid but accurate
      "sensory_impression": string,    // what standing there might be like, if supportable
      "spec_values": [
        { "spec_key": string, "value_number": number|null, "value_text": string|null, "unit": string|null,
          "status": "known"|"estimated"|"unknown"|"not_applicable"|"disputed", "confidence": "low"|"medium"|"high", "notes": string|null }
      ],
      "wonder_points": [
        { "wonder_type": "sensory"|"scale"|"danger"|"beauty"|"paradox"|"life_possibility"|"worldbuilding",
          "note": string, "episode_hook_potential": string|null, "visual_prompt_seed": string|null }
      ],
      "relationships": [
        { "to_object_name": string, "relationship_type": string, "description": string, "confidence": "low"|"medium"|"high" }
      ]
    }
  ]
}`,
      '',
      'Use ONLY these canonical spec_key values (omit any you have no support for):',
      keyLines || '  (no spec definitions available)',
      '',
      'Return {"objects": []} if the source contains no concrete space objects.',
    ].filter((l) => l !== null).join('\n');
  }

  async function runLocalExtraction(channel, item, text) {
    if (!callAI) throw new Error('AI service is not available for local extraction.');
    const model = localModel();
    const full = await callAI(model, extractionUser(item, text), extractionSystem(channel), [], { returnFullResult: true });
    const parsed = extractJSON(full.text || full);
    const objects = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.objects) ? parsed.objects : []);
    return { objects, model: `${model.provider}/${model.model}` };
  }

  function findObjectByName(channelId, name) {
    if (!name) return null;
    return sql.prepare('SELECT * FROM space_objects WHERE channel_id = ? AND lower(name) = lower(?)').get(channelId, String(name).trim());
  }

  /** Replace prior spec rows for the incoming keys, then insert (keeps catalog from piling duplicates). */
  function replaceSpecValues(objectId, specs, sourceItemId, ts) {
    const clean = (Array.isArray(specs) ? specs : []).filter((s) => s && s.spec_key);
    if (!clean.length) return;
    const del = sql.prepare('DELETE FROM space_object_spec_values WHERE object_id = ? AND spec_key = ?');
    for (const s of clean) del.run(objectId, String(s.spec_key));
    upsertSpecValues(sql, objectId, clean.map((s) => ({ ...s, source_item_id: s.source_item_id || sourceItemId })), ts, uuid);
  }

  /** Insert or update a space object from an extraction record; returns the object id. */
  function upsertObject(channelId, rec, sourceItemId) {
    if (!rec || !rec.name) return null;
    const ts = now();
    const existing = findObjectByName(channelId, rec.name);
    let id;
    if (existing) {
      id = existing.id;
      const fields = [];
      const values = [];
      for (const f of ['object_kind', 'subtype', 'reality_status', 'field_guide_summary', 'sensory_impression', 'description']) {
        if (rec[f] && !existing[f]) { fields.push(`${f} = ?`); values.push(String(rec[f])); }
      }
      if (rec.aliases) {
        const aliases = Array.isArray(rec.aliases) ? rec.aliases.join(', ') : String(rec.aliases);
        if (!existing.aliases) { fields.push('aliases = ?'); values.push(aliases); }
      }
      fields.push('updated_at = ?');
      values.push(ts, id);
      sql.prepare(`UPDATE space_objects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    } else {
      id = uuid();
      sql.prepare(
        `INSERT INTO space_objects (id, channel_id, name, aliases, object_kind, subtype, reality_status, description,
         field_guide_summary, sensory_impression, points_of_wonder_summary, visual_motifs, human_observer_shock, worldbuilding_relevance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, channelId, String(rec.name).slice(0, 220),
        Array.isArray(rec.aliases) ? rec.aliases.join(', ') : (rec.aliases || null),
        rec.object_kind || null, rec.subtype || null, rec.reality_status || 'candidate',
        rec.description || null, rec.field_guide_summary || null, rec.sensory_impression || null,
        null, null, null, null, ts, ts
      );
    }

    replaceSpecValues(id, rec.spec_values, sourceItemId, ts);
    if (Array.isArray(rec.wonder_points) && rec.wonder_points.length) {
      insertWonderPoints(sql, id, rec.wonder_points.map((w) => ({ ...w, source_item_id: sourceItemId })), uuid);
    }
    insertRelationships(channelId, id, rec.relationships, sourceItemId);
    applyDerivedParams(id);
    return id;
  }

  function insertRelationships(channelId, fromId, rels, sourceItemId) {
    if (!Array.isArray(rels)) return;
    const insert = sql.prepare(
      `INSERT INTO space_object_relationships (id, channel_id, from_object_id, to_object_id, relationship_type, description, confidence, source_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const rel of rels) {
      if (!rel || !rel.to_object_name) continue;
      const target = findObjectByName(channelId, rel.to_object_name);
      if (!target || target.id === fromId) continue; // only link objects we actually have
      insert.run(uuid(), channelId, fromId, target.id, rel.relationship_type || 'related', rel.description || null, rel.confidence || 'medium', sourceItemId || null);
    }
  }

  /** Run the deterministic parameter calculator over an object and persist derived specs. */
  function applyDerivedParams(objectId) {
    const rows = sql.prepare('SELECT * FROM space_object_spec_values WHERE object_id = ?').all(objectId);
    const specMap = {};
    for (const r of rows) specMap[r.spec_key] = r; // last write wins; rows ordered by insert
    const derived = astro.computeDerivedSpecs(specMap);
    if (!derived.length) return 0;
    const ts = now();
    // Clear prior auto-derived rows for these keys so reruns refresh instead of pile up.
    const del = sql.prepare("DELETE FROM space_object_spec_values WHERE object_id = ? AND spec_key = ? AND notes LIKE '[auto-derived]%'");
    for (const d of derived) del.run(objectId, d.spec_key);
    upsertSpecValues(sql, objectId, derived, ts, uuid);
    return derived.length;
  }

  // ---- source item + run bookkeeping -------------------------------------

  function alreadySeen(channelId, contentHash) {
    return Boolean(sql.prepare('SELECT 1 FROM studio_source_items WHERE channel_id = ? AND content_hash = ?').get(channelId, contentHash));
  }

  function insertSourceItem(channelId, runId, item) {
    const ts = now();
    const id = uuid();
    sql.prepare(
      `INSERT INTO studio_source_items (id, channel_id, run_id, title, url, source_type, source_name, published_at, content_hash, ingestion_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    ).run(id, channelId, runId, item.title || null, item.url || null, item.source_type || null, item.source_name || null, item.published_at || null, item.content_hash, ts, ts);
    return id;
  }

  function setItemStatus(itemId, status, excerpt) {
    sql.prepare('UPDATE studio_source_items SET ingestion_status = ?, excerpt = COALESCE(?, excerpt), updated_at = ? WHERE id = ?')
      .run(status, excerpt || null, now(), itemId);
  }

  function updateRun(runId, patch) {
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(patch)) { fields.push(`${k} = ?`); values.push(v); }
    fields.push('updated_at = ?');
    values.push(now(), runId);
    sql.prepare(`UPDATE studio_ingestion_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  function createRun(channelId, trigger) {
    const id = uuid();
    const ts = now();
    sql.prepare(
      `INSERT INTO studio_ingestion_runs (id, channel_id, trigger, status, discovered_count, deduped_count, items_enqueued, items_succeeded, items_failed, digest, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, 0, 0, 0, 0, ?, ?, ?)`
    ).run(id, channelId, trigger || 'manual', 'Queued — discovering source items…', ts, ts);
    return id;
  }

  // ---- discovery ----------------------------------------------------------

  async function discover(channelId, sources, notes) {
    const items = [];
    for (const source of sources) {
      try {
        if (source.source_type === 'youtube_search' && (source.query_template || source.name)) {
          if (!youtube.hasKey()) { notes.push(`Skipped "${source.name}" — no YouTube API key.`); continue; }
          const vids = await youtube.searchVideos(source.query_template || source.name, source.per_run_cap || 6);
          vids.forEach((v) => items.push(asItem(v, source)));
        } else if (source.source_type === 'youtube_channel' && (source.url || source.query_template)) {
          if (!youtube.hasKey()) { notes.push(`Skipped "${source.name}" — no YouTube API key.`); continue; }
          const vids = await youtube.channelUploads(source.url || source.query_template, source.per_run_cap || 6);
          vids.forEach((v) => items.push(asItem(v, source)));
        } else if (source.url) {
          items.push({ title: source.name, url: source.url, source_type: source.source_type, source_name: source.name, content_hash: hashOf(source.url, source.name) });
        } else {
          notes.push(`Skipped "${source.name}" — no URL or supported query.`);
        }
      } catch (e) {
        notes.push(`Discovery failed for "${source.name}": ${e.message}`);
      }
    }
    return items;
  }

  function asItem(video, source) {
    return {
      title: video.title,
      url: video.url,
      source_type: source ? source.source_type : 'youtube_search',
      source_name: source ? source.name : 'youtube',
      published_at: video.publishedAt || null,
      content_hash: hashOf(video.url, video.title),
    };
  }

  // ---- per-item processing ------------------------------------------------

  async function processItem(channel, runId, item) {
    const channelId = channel.id;
    const sourceItemId = insertSourceItem(channelId, runId, item);
    try {
      setItemStatus(sourceItemId, 'fetching');
      const fetched = item.url ? await fetchSourceContent(item.url, { userTitle: item.title }) : { content: item.text || '', title: item.title };
      const text = fetched.content || '';
      if (!text || text.trim().length < 40) { setItemStatus(sourceItemId, 'empty', 'No usable content.'); return { objects: 0, expanded: 0 }; }
      setItemStatus(sourceItemId, 'extracting');
      const { objects } = await runLocalExtraction(channel, { ...item, title: fetched.title || item.title }, text);
      let created = 0;
      const upsertedIds = [];
      const tx = sql.transaction(() => {
        for (const rec of objects) {
          const id = upsertObject(channelId, rec, sourceItemId);
          if (id) { created++; upsertedIds.push({ id, name: rec.name }); }
        }
      });
      tx();
      setItemStatus(sourceItemId, 'done', `Extracted ${created} object(s).`);
      return { objects: created, upsertedIds };
    } catch (e) {
      setItemStatus(sourceItemId, 'failed', e.message);
      return { objects: 0, error: e.message };
    }
  }

  /**
   * Expand a topic/object by searching YouTube for related videos and ingesting
   * their transcripts. Bounded by perObject cap. Dedupes against prior items.
   */
  async function expandObjectFromYouTube(channel, runId, object, { perObject = 3 } = {}) {
    if (!youtube.hasKey()) return { videos: 0, objects: 0, skipped: 'no-key' };
    const channelId = channel.id;
    let videos = 0;
    let objects = 0;
    try {
      const results = await youtube.searchVideos(object.name, perObject + 3);
      for (const v of results) {
        if (videos >= perObject) break;
        const contentHash = hashOf(v.url, v.title);
        if (alreadySeen(channelId, contentHash)) continue;
        videos++;
        const item = { title: v.title, url: v.url, source_type: 'youtube_expansion', source_name: `related: ${object.name}`, published_at: v.publishedAt, content_hash: contentHash };
        const result = await processItem(channel, runId, item);
        objects += result.objects || 0;
      }
    } catch (e) {
      return { videos, objects, error: e.message };
    }
    return { videos, objects };
  }

  // ---- orchestration ------------------------------------------------------

  async function run({ channelId, trigger, channel, existingRunId }) {
    const ch = channel || sql.prepare('SELECT * FROM studio_channels WHERE id = ?').get(channelId);
    const runId = existingRunId || createRun(channelId, trigger);
    const notes = [];
    let discovered = 0;
    let enqueued = 0;
    let deduped = 0;
    let succeeded = 0;
    let failed = 0;
    let objectsTotal = 0;
    let expansionObjects = 0;

    try {
      const sources = (listSources(channelId) || []).filter((s) => s.enabled);
      const candidates = await discover(channelId, sources, notes);
      discovered = candidates.length;

      // dedup against history
      const fresh = [];
      const seen = new Set();
      for (const c of candidates) {
        if (seen.has(c.content_hash) || alreadySeen(channelId, c.content_hash)) { deduped++; continue; }
        seen.add(c.content_hash);
        fresh.push(c);
      }
      enqueued = fresh.length;
      updateRun(runId, { discovered_count: discovered, deduped_count: deduped, items_enqueued: enqueued, digest: `Processing ${enqueued} item(s)…` });

      const expandTargets = [];
      for (const item of fresh) {
        const result = await processItem(ch, runId, item);
        if (result.error) failed++; else succeeded++;
        objectsTotal += result.objects || 0;
        for (const o of (result.upsertedIds || [])) expandTargets.push(o);
      }

      // Related-video expansion for newly seen objects (bounded)
      const uniqueTargets = [];
      const targetSeen = new Set();
      for (const t of expandTargets) { if (!targetSeen.has(t.id)) { targetSeen.add(t.id); uniqueTargets.push(t); } }
      for (const t of uniqueTargets.slice(0, 4)) {
        const full = sql.prepare('SELECT * FROM space_objects WHERE id = ?').get(t.id);
        if (!full) continue;
        const exp = await expandObjectFromYouTube(ch, runId, full, { perObject: 2 });
        expansionObjects += exp.objects || 0;
        if (exp.skipped === 'no-key') break;
      }

      const digest = [
        `Discovered ${discovered}, deduped ${deduped}, processed ${enqueued}.`,
        `Extracted ${objectsTotal} object record(s); +${expansionObjects} from related videos.`,
        notes.length ? `Notes: ${notes.join(' ')}` : null,
      ].filter(Boolean).join(' ');

      updateRun(runId, {
        status: 'complete', items_succeeded: succeeded, items_failed: failed,
        items_enqueued: enqueued, discovered_count: discovered, deduped_count: deduped, digest,
      });
    } catch (e) {
      updateRun(runId, { status: 'failed', digest: `Ingestion failed: ${e.message}. ${notes.join(' ')}` });
    }
    return runId;
  }

  return { run, processItem, expandObjectFromYouTube, upsertObject, applyDerivedParams, createRun, updateRun, runLocalExtraction, localModel, alreadySeen, _findObjectByName: findObjectByName };
}

module.exports = createStudioIngestion;
