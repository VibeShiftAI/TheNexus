const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const createStudioIngestion = require('../services/studio-ingestion');
const createAstroNightly = require('../services/astro-nightly');
const { startNightlyScheduler } = createAstroNightly;
const horizons = require('../services/horizons');
const astroParams = require('../services/astro-parameters');

const DEFAULT_CHANNEL_ID = 'praxis-youtube';
const IMPOSSIBLE_WORLDS_CHANNEL_ID = 'impossible-worlds-field-guide';
const STAGES = ['suggested', 'approved', 'scripted', 'thumbnail', 'ready', 'published'];
const ALL_STATUSES = [...STAGES, 'archived'];
const JSON_FIELDS = ['thumbnail_concepts', 'image_prompts', 'checklist', 'publish_kit'];
const EDITABLE_CHANNEL_FIELDS = [
  'name',
  'project_path',
  'positioning',
  'editorial_promise',
  'audience',
  'host_style',
  'visual_style_notes',
  'recurring_episode_format',
  'source_strategy',
  'monetization_notes',
  'risks_and_mitigations',
  'default_cadence_target',
  'prompt_guardrails',
];

function createStudioRouter({ callAI, ingestionDeps, astroDeps } = {}) {
  const router = express.Router();
  const DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../../nexus.db');
  const sql = new Database(DB_PATH);
  sql.pragma('journal_mode = WAL');
  setupSchema(sql);
  seedChannels(sql);
  seedSpecDefinitions(sql);
  seedSources(sql);

  const uuid = () => require('crypto').randomUUID();
  const now = () => new Date().toISOString();

  const ingestion = createStudioIngestion({
    sql, callAI, uuid, now,
    helpers: { upsertSpecValues, insertWonderPoints, extractJSON, stringifyMaybe, slugify },
    listSources,
    deps: ingestionDeps,
  });
  const astroNightly = createAstroNightly({ sql, uuid, now, ingestion, getChannel, callAI, deps: astroDeps });

  // Reference-image uploads land in a server-managed, channel-scoped folder and
  // are served back through an API route so the dashboard can preview them.
  const REF_ROOT = path.resolve(__dirname, '../../data/studio-references');
  const refStorage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(REF_ROOT, String(req.params.channelId || 'default').replace(/[^a-z0-9_-]/gi, ''));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '.img').slice(0, 10);
      cb(null, `${uuid()}${ext}`);
    },
  });
  const refUpload = multer({ storage: refStorage, limits: { fileSize: 25 * 1024 * 1024 } });

  if (process.env.NODE_ENV !== 'test' && process.env.STUDIO_NIGHTLY !== 'off') {
    startNightlyScheduler({
      runFn: () => astroNightly.run({ channelId: IMPOSSIBLE_WORLDS_CHANNEL_ID }),
      hour: Number(process.env.STUDIO_NIGHTLY_HOUR) || 2,
    });
  }

  function getChannelId(req) {
    return String(req.params.channelId || req.query.channelId || DEFAULT_CHANNEL_ID);
  }

  function getChannel(channelId) {
    return sql.prepare('SELECT * FROM studio_channels WHERE id = ?').get(channelId);
  }

  function requireChannel(res, channelId) {
    const channel = getChannel(channelId);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return null;
    }
    return channel;
  }

  function getSetting(channelId, key, fallback) {
    const hasChannelId = hasColumn(sql, 'studio_settings', 'channel_id');
    const row = hasChannelId
      ? sql.prepare('SELECT value FROM studio_settings WHERE channel_id = ? AND key = ?').get(channelId, key)
      : sql.prepare('SELECT value FROM studio_settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  function setSetting(channelId, key, value) {
    const hasChannelId = hasColumn(sql, 'studio_settings', 'channel_id');
    if (hasChannelId) {
      sql.prepare(
        `INSERT INTO studio_settings (channel_id, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id, key) DO UPDATE SET value = excluded.value`
      ).run(channelId, key, JSON.stringify(value));
      return;
    }
    sql.prepare(
      `INSERT INTO studio_settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, JSON.stringify(value));
  }

  function rowToIdea(row) {
    if (!row) return null;
    const idea = { ...row };
    for (const field of JSON_FIELDS) {
      try {
        idea[field] = row[field] ? JSON.parse(row[field]) : null;
      } catch {
        idea[field] = null;
      }
    }
    return idea;
  }

  function getIdea(id) {
    return rowToIdea(sql.prepare('SELECT * FROM studio_ideas WHERE id = ?').get(id));
  }

  function sourceRow(row) {
    return row ? { ...row, enabled: row.enabled !== 0 } : null;
  }

  function imageRow(row) {
    return row || null;
  }

  function specRow(row) {
    return row || null;
  }

  function wonderRow(row) {
    return row || null;
  }

  function objectRow(row) {
    if (!row) return null;
    return {
      ...row,
      spec_values: sql
        .prepare('SELECT * FROM space_object_spec_values WHERE object_id = ? ORDER BY created_at ASC')
        .all(row.id)
        .map(specRow),
      wonder_points: sql
        .prepare('SELECT * FROM points_of_wonder WHERE object_id = ? ORDER BY rowid ASC')
        .all(row.id)
        .map(wonderRow),
    };
  }

  function listIdeas(channelId) {
    return sql
      .prepare('SELECT * FROM studio_ideas WHERE channel_id = ? ORDER BY created_at DESC')
      .all(channelId)
      .map(rowToIdea);
  }

  function listSources(channelId) {
    return sql
      .prepare('SELECT * FROM studio_sources WHERE channel_id = ? ORDER BY name ASC')
      .all(channelId)
      .map(sourceRow);
  }

  function listObjects(channelId) {
    return sql
      .prepare('SELECT * FROM space_objects WHERE channel_id = ? ORDER BY updated_at DESC, name ASC')
      .all(channelId)
      .map(objectRow);
  }

  function listReferenceImages(channelId, episodeId) {
    const base = 'SELECT * FROM studio_reference_images WHERE channel_id = ?';
    const rows = episodeId
      ? sql.prepare(`${base} AND episode_id = ? ORDER BY created_at DESC`).all(channelId, episodeId)
      : sql.prepare(`${base} ORDER BY created_at DESC`).all(channelId);
    return rows.map(imageRow);
  }

  function listChannels() {
    return sql
      .prepare(
        `SELECT * FROM studio_channels
         ORDER BY CASE id WHEN 'praxis-youtube' THEN 0 WHEN 'impossible-worlds-field-guide' THEN 1 ELSE 2 END, name`
      )
      .all();
  }

  function buildChannelSystem(channel, suffix = '') {
    return [
      `You are the content strategist and scriptwriter for ${channel.name}.`,
      channel.positioning && `Positioning: ${channel.positioning}`,
      channel.editorial_promise && `Editorial promise: ${channel.editorial_promise}`,
      channel.audience && `Audience: ${channel.audience}`,
      channel.host_style && `Host style: ${channel.host_style}`,
      channel.visual_style_notes && `Visual style: ${channel.visual_style_notes}`,
      channel.recurring_episode_format && `Recurring format: ${channel.recurring_episode_format}`,
      channel.prompt_guardrails && `Guardrails: ${channel.prompt_guardrails}`,
      suffix,
    ].filter(Boolean).join('\n');
  }

  function objectContext(channelId) {
    const objects = listObjects(channelId).slice(0, 8);
    if (!objects.length) return 'No catalog objects attached yet.';
    return objects.map((obj) => {
      const summary = obj.field_guide_summary || obj.description || '';
      const specs = (obj.spec_values || []).slice(0, 5).map((spec) => {
        const value = spec.value_text || spec.value_number || spec.value_min || spec.value_max || 'unknown';
        return `${spec.spec_key}: ${value}${spec.unit ? ` ${spec.unit}` : ''} (${spec.status || 'unknown'})`;
      });
      return `- ${obj.name} [${obj.object_kind || 'object'}, ${obj.reality_status || 'unknown'}]: ${summary}${specs.length ? ` Specs: ${specs.join('; ')}` : ''}`;
    }).join('\n');
  }

  // Full parameter dump for the objects attached to a specific episode — feeds the
  // writer + critic so the script is grounded in real (and calculated) numbers.
  function episodeObjectContext(channelId, ideaId) {
    const links = sql.prepare('SELECT object_id, role FROM studio_episode_objects WHERE episode_id = ?').all(ideaId);
    if (!links.length) {
      return { hasObjects: false, text: 'No catalog objects are attached to this episode yet. Reason carefully from the title/angle and explicitly label every assumption.' };
    }
    const blocks = [];
    for (const link of links) {
      const obj = objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ? AND channel_id = ?').get(link.object_id, channelId));
      if (!obj) continue;
      const specs = (obj.spec_values || []).map((s) => {
        const v = s.value_text != null ? s.value_text
          : (s.value_number != null ? s.value_number
            : (s.value_min != null && s.value_max != null ? `${s.value_min}–${s.value_max}` : 'unknown'));
        return `    - ${s.spec_key}: ${v}${s.unit ? ` ${s.unit}` : ''} [${s.status}${s.confidence ? `/${s.confidence}` : ''}]${s.notes ? ` (${s.notes})` : ''}`;
      }).join('\n');
      blocks.push(
        `• ${obj.name} [${obj.object_kind || 'object'} / ${obj.reality_status || 'unknown'}] (role: ${link.role || 'subject'})\n` +
        `  ${obj.field_guide_summary || obj.description || ''}\n` +
        (obj.sensory_impression ? `  Sensory: ${obj.sensory_impression}\n` : '') +
        `  Parameters:\n${specs || '    (none recorded)'}`
      );
    }
    return { hasObjects: blocks.length > 0, text: blocks.join('\n\n') };
  }

  // Full parameter dump for an explicit list of object ids — feeds the catalog
  // "system" jobs (interaction idea, Unreal environment, physics analysis).
  function parseObjectIds(raw) {
    if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map((x) => x.trim()).filter(Boolean);
    return [];
  }

  function selectedObjectsContext(channelId, objectIds) {
    const ids = parseObjectIds(objectIds);
    const objects = [];
    for (const id of ids) {
      const obj = objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ? AND channel_id = ?').get(id, channelId));
      if (obj) objects.push(obj);
    }
    if (!objects.length) {
      return { hasObjects: false, objects: [], text: 'No objects selected.' };
    }
    const text = objects.map((obj) => {
      const specs = (obj.spec_values || []).map((s) => {
        const v = s.value_text != null ? s.value_text
          : (s.value_number != null ? s.value_number
            : (s.value_min != null && s.value_max != null ? `${s.value_min}–${s.value_max}` : 'unknown'));
        return `    - ${s.spec_key}: ${v}${s.unit ? ` ${s.unit}` : ''} [${s.status}${s.confidence ? `/${s.confidence}` : ''}]`;
      }).join('\n');
      return (
        `• ${obj.name} [${obj.object_kind || 'object'} / ${obj.reality_status || 'unknown'}]\n` +
        `  ${obj.field_guide_summary || obj.description || ''}\n` +
        (obj.sensory_impression ? `  Sensory: ${obj.sensory_impression}\n` : '') +
        `  Parameters:\n${specs || '    (none recorded)'}`
      );
    }).join('\n\n');
    return { hasObjects: true, objects, text };
  }

  const JOBS = {
    suggest_topics: {
      label: 'Suggest episodes',
      needsIdea: false,
      build({ channel, channelId, count = 6 }) {
        const existing = listIdeas(channelId).map((idea) => idea.title).join(', ');
        const objects = objectContext(channelId);
        return {
          system: buildChannelSystem(channel, 'Output strict JSON only.'),
          user:
            `Use the channel profile and catalog to suggest ${count} video ideas.\n\n` +
            `Existing ideas: ${existing || 'none'}\n\nCatalog:\n${objects}\n\n` +
            `Return a JSON array. Each item must include title, source, angle, build_promise, and category.`,
        };
      },
      apply({ channelId }, text) {
        const parsed = extractJSON(text);
        const rows = Array.isArray(parsed) ? parsed : [];
        const insert = sql.prepare(
          `INSERT INTO studio_ideas (id, channel_id, source, title, angle, build_promise, category, status, checklist, created_at, updated_at)
           VALUES (@id, @channel_id, @source, @title, @angle, @build_promise, @category, 'suggested', '[]', @ts, @ts)`
        );
        let created = 0;
        for (const item of rows) {
          if (!item?.title) continue;
          insert.run({
            id: uuid(),
            channel_id: channelId,
            source: String(item.source || 'ai-suggested').slice(0, 100),
            title: String(item.title).slice(0, 220),
            angle: String(item.angle || '').slice(0, 2000),
            build_promise: String(item.build_promise || '').slice(0, 1200),
            category: String(item.category || 'Suggested').slice(0, 120),
            ts: now(),
          });
          created++;
        }
        return { summary: `Suggested ${created} episode idea(s)`, created };
      },
    },
    write_script: {
      label: 'Write script (writer + critic)',
      needsIdea: true,
      // Two-agent agentic flow used by the generate endpoint: a writer drafts a
      // first-person sensory script from the episode's attached object parameters,
      // then a critic refines pacing and checks hard-science constraints.
      async custom({ channel, channelId, ideaId, model, modelLabel }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        const params = episodeObjectContext(channelId, ideaId);

        const writerSystem = buildChannelSystem(channel,
          'You write immersive, first-person, present-tense field-guide scripts that translate cold data into a deeply human experience. Robert is on camera as the human awe anchor.');
        const writerUser =
          `Write a full ready-to-record script for "${idea.title}".\n` +
          `Angle: ${idea.angle || ''}\nPromise: ${idea.build_promise || ''}\nCategory: ${idea.category || ''}\n\n` +
          `Object parameters to obey (these are the physics of this world):\n${params.text}\n\n` +
          `Sensory focus — script exactly what the viewer would SEE (sky color from atmospheric scattering, light quality), HEAR (wind, silence, pressure), and FEEL (gravity on the body, temperature, the immediate biological challenges of standing there). ` +
          `Follow the channel's recurring field-guide format. State assumptions plainly, label every uncertainty (unknown/estimated/disputed), use the real numbers above, and never invent measurements or hype.`;
        const draft = (await callAI(model, writerUser, writerSystem, [], { returnFullResult: true }));
        const draftText = draft.text || String(draft);

        const criticSystem = buildChannelSystem(channel,
          'You are a script editor and hard-science fact-checker. You improve pacing and flow, and you correct anything that contradicts the supplied physical parameters. You never weaken honest uncertainty labels.');
        const criticUser =
          `Revise the following draft for "${idea.title}".\n\n` +
          `PARAMETERS (ground truth):\n${params.text}\n\n` +
          `DRAFT:\n${draftText}\n\n` +
          `Tighten pacing, keep the first-person sensory voice, and fix any claim that conflicts with the parameters. ` +
          `Return ONLY strict JSON: {"script": "<full revised script>", "notes": ["<short note about each substantive change or remaining science caveat>"]}`;
        const criticRaw = (await callAI(model, criticUser, criticSystem, [], { returnFullResult: true }));
        const criticText = criticRaw.text || String(criticRaw);

        let finalScript = draftText;
        let notes = [];
        try {
          const parsed = extractJSON(criticText);
          if (parsed && typeof parsed.script === 'string' && parsed.script.trim().length > 40) finalScript = parsed.script;
          if (parsed && Array.isArray(parsed.notes)) notes = parsed.notes;
        } catch {
          if (criticText && criticText.trim().length > 40) finalScript = criticText;
        }

        const status = ['suggested', 'approved'].includes(idea.status) ? 'scripted' : idea.status;
        const checklist = Array.isArray(idea.checklist) ? idea.checklist : [];
        for (const note of notes.slice(0, 8)) checklist.push({ label: `Critic: ${String(note).slice(0, 200)}`, done: false });
        if (!params.hasObjects) checklist.push({ label: 'Attach object records so the script can be grounded in real parameters.', done: false });
        sql.prepare('UPDATE studio_ideas SET script = ?, script_model = ?, status = ?, checklist = ?, updated_at = ? WHERE id = ?')
          .run(String(finalScript), `${modelLabel} (writer+critic)`, status, JSON.stringify(checklist), now(), ideaId);
        return { summary: `Script written via writer+critic (${String(finalScript).length} chars, ${notes.length} critic note(s))`, ideaId };
      },
      // Prompt-mode + paste fallback (single pass).
      build({ channel, channelId, ideaId }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        const params = episodeObjectContext(channelId, ideaId);
        return {
          system: buildChannelSystem(channel, 'You write immersive, first-person, sensory field-guide scripts grounded in real physics.'),
          user:
            `Write a full ready-to-record first-person script in the channel's recurring field-guide format.\n\n` +
            `Episode: ${idea.title}\nAngle: ${idea.angle || ''}\nPromise: ${idea.build_promise || ''}\nCategory: ${idea.category || ''}\n\n` +
            `Attached object parameters:\n${params.text}\n\n` +
            `Channel catalog context:\n${objectContext(channelId)}\n\n` +
            `Sensory focus: what you SEE (sky color from scattering), HEAR (wind), and FEEL (gravity, temperature, immediate biological hazards). Clear assumptions, actual physics, uncertainty labels, Robert on camera, no hype.`,
        };
      },
      apply({ ideaId, model }, text) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        const status = ['suggested', 'approved'].includes(idea.status) ? 'scripted' : idea.status;
        sql.prepare('UPDATE studio_ideas SET script = ?, script_model = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(String(text), model || 'pasted', status, now(), ideaId);
        return { summary: `Script written (${String(text).length} chars)`, ideaId };
      },
    },
    physics_rigor_pass: {
      label: 'Physics rigor pass',
      needsIdea: true,
      build({ channel, channelId, ideaId }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        return {
          system: buildChannelSystem(channel, 'You are checking physics rigor and uncertainty labeling.'),
          user:
            `Review this episode for unsupported claims, missing assumptions, and places where uncertainty should be explicit.\n\n` +
            `Title: ${idea.title}\nScript:\n${idea.script || '(no script yet)'}\n\nCatalog:\n${objectContext(channelId)}\n\n` +
            `Return concise notes grouped as: fixes, assumptions, disputed/unknown, source needs.`,
        };
      },
      apply({ ideaId }, text) {
        const idea = getIdea(ideaId);
        const checklist = Array.isArray(idea.checklist) ? idea.checklist : [];
        checklist.push({ label: `Physics rigor pass: ${String(text).slice(0, 180)}`, done: false });
        sql.prepare('UPDATE studio_ideas SET checklist = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(checklist), now(), ideaId);
        return { summary: 'Physics rigor notes added to checklist', ideaId };
      },
    },
    thumbnail_concepts: {
      label: 'Thumbnail concepts',
      needsIdea: true,
      build({ channel, ideaId }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        return {
          system: buildChannelSystem(channel, 'You are also a YouTube thumbnail art director. Output strict JSON only.'),
          user:
            `Give 3 thumbnail concepts for "${idea.title}". Each must be scientifically grounded and visually inspectable.\n` +
            `JSON array only: overlay_text, visual, composition, palette, emotion.`,
        };
      },
      apply({ ideaId }, text) {
        const concepts = extractJSON(text);
        sql.prepare('UPDATE studio_ideas SET thumbnail_concepts = ?, status = CASE WHEN status = ? THEN ? ELSE status END, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(concepts), 'scripted', 'thumbnail', now(), ideaId);
        return { summary: `${Array.isArray(concepts) ? concepts.length : 0} thumbnail concepts generated`, ideaId };
      },
    },
    image_prompts: {
      label: 'Image prompt pack',
      needsIdea: true,
      build({ channel, channelId, ideaId }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        return {
          system: buildChannelSystem(channel, 'You plan reference images and image-generation prompts. Output strict JSON only.'),
          user:
            `Create 4-6 reference image prompts for "${idea.title}".\n\nCatalog:\n${objectContext(channelId)}\n\n` +
            `JSON array only. Each item: label, prompt, negative_prompt, intended_use.`,
        };
      },
      apply({ ideaId }, text) {
        const prompts = extractJSON(text);
        sql.prepare('UPDATE studio_ideas SET image_prompts = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(prompts), now(), ideaId);
        return { summary: `${Array.isArray(prompts) ? prompts.length : 0} image prompts generated`, ideaId };
      },
    },
    publish_kit: {
      label: 'Publish kit',
      needsIdea: true,
      build({ channel, ideaId }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        return {
          system: buildChannelSystem(channel, 'Produce publishing metadata. Output strict JSON only.'),
          user:
            `Produce a publish kit for "${idea.title}". Script:\n${idea.script || ''}\n\n` +
            `JSON object: titles, description, tags, pinned_comment.`,
        };
      },
      apply({ ideaId }, text) {
        const kit = extractJSON(text);
        sql.prepare('UPDATE studio_ideas SET publish_kit = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(kit), now(), ideaId);
        return { summary: 'Publish kit ready', ideaId };
      },
    },
    source_citation_pack: {
      label: 'Source/citation pack',
      needsIdea: true,
      build({ channel, channelId, ideaId }) {
        const idea = getIdea(ideaId);
        if (!idea) throw new Error('Idea not found.');
        const sources = listSources(channelId).filter((source) => source.enabled).map((source) => `- ${source.name}: ${source.url || source.query_template || source.source_type}`).join('\n');
        return {
          system: buildChannelSystem(channel, 'You are preparing a source trail.'),
          user:
            `Prepare a citation/source pack for "${idea.title}" using accepted source configs and catalog context.\n\n` +
            `Sources:\n${sources || 'none'}\n\nCatalog:\n${objectContext(channelId)}\n\nReturn source needs, likely citations, and fact-check questions.`,
        };
      },
      apply({ ideaId }, text) {
        const idea = getIdea(ideaId);
        const checklist = Array.isArray(idea.checklist) ? idea.checklist : [];
        checklist.push({ label: `Source pack: ${String(text).slice(0, 180)}`, done: false });
        sql.prepare('UPDATE studio_ideas SET checklist = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(checklist), now(), ideaId);
        return { summary: 'Source/citation notes added to checklist', ideaId };
      },
    },

    // ---- Catalog "system" jobs: act on a multi-object selection -----------
    interaction_idea: {
      label: 'Start video from selected objects',
      needsObjects: true,
      build({ channel, channelId, objectIds }) {
        const ctx = selectedObjectsContext(channelId, objectIds);
        return {
          system: buildChannelSystem(channel, 'You invent one compelling episode concept from the INTERACTION between the selected space objects. Output strict JSON only.'),
          user:
            `Invent a single video idea built on what happens when these objects interact, are compared, or share a system. Use their real parameters.\n\n` +
            `Selected objects:\n${ctx.text}\n\n` +
            `Return a JSON object: { "title": string, "angle": string, "build_promise": string, "category": string }.`,
        };
      },
      apply({ channelId, objectIds }, text) {
        const parsed = extractJSON(text);
        const item = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!item || !item.title) throw new Error('Model did not return a usable idea.');
        const id = uuid();
        const ts = now();
        sql.prepare(
          `INSERT INTO studio_ideas (id, channel_id, source, title, angle, build_promise, category, status, checklist, created_at, updated_at)
           VALUES (?, ?, 'object-interaction', ?, ?, ?, ?, 'suggested', '[]', ?, ?)`
        ).run(id, channelId, String(item.title).slice(0, 220), String(item.angle || '').slice(0, 2000), String(item.build_promise || '').slice(0, 1200), String(item.category || 'Object system').slice(0, 120), ts, ts);
        // Link every selected object to the new episode.
        const link = sql.prepare('INSERT OR IGNORE INTO studio_episode_objects (episode_id, object_id, role, notes) VALUES (?, ?, ?, ?)');
        for (const objId of parseObjectIds(objectIds)) {
          if (sql.prepare('SELECT 1 FROM space_objects WHERE id = ? AND channel_id = ?').get(objId, channelId)) {
            link.run(id, objId, 'system_member', null);
          }
        }
        return { summary: `Created "${item.title}" from ${parseObjectIds(objectIds).length} object(s)`, ideaId: id };
      },
    },
    unreal_environment: {
      label: 'Unreal 5 environment brief',
      needsObjects: true,
      build({ channel, channelId, objectIds }) {
        const ctx = selectedObjectsContext(channelId, objectIds);
        return {
          system: buildChannelSystem(channel, 'You are a senior technical artist writing a precise build brief for Unreal Engine 5.5. Ground every choice in the supplied physical parameters.'),
          user:
            `Write a copy-paste build brief to recreate this world/system as a playable environment in Unreal Engine 5.5.\n\n` +
            `Objects and parameters:\n${ctx.text}\n\n` +
            `Cover, with concrete UE5 settings and real numbers where available: ` +
            `Sky Atmosphere (Rayleigh/Mie tint from atmospheric composition + host-star color, density from pressure), ` +
            `Directional Light / star (color temperature, intensity, angle), exposure & post-process color grading, ` +
            `Landscape (scale, terrain type, dominant materials), water/ocean if present, ` +
            `Niagara FX (wind from wind speed, precipitation/condensates, dust/haze), ` +
            `and a Physics note (project gravity from surface gravity in m/s², scale). ` +
            `Label anything you must assume.`,
        };
      },
      apply({ channelId, objectIds, ideaId }, text) {
        const body = String(text);
        if (ideaId && getIdea(ideaId)) {
          sql.prepare('UPDATE studio_ideas SET unreal_prompt = ?, updated_at = ? WHERE id = ?').run(body, now(), ideaId);
        }
        return { summary: `Unreal 5 environment brief ready (${body.length} chars)`, text: body, ideaId: ideaId || null };
      },
    },
    physics_analysis: {
      label: 'System physics analysis',
      needsObjects: true,
      build({ channel, channelId, objectIds }) {
        const ctx = selectedObjectsContext(channelId, objectIds);
        return {
          system: buildChannelSystem(channel, 'You are a hard-science analyst. Reason quantitatively from the supplied parameters and label every assumption and uncertainty.'),
          user:
            `Analyze the physics of the system formed by these objects — especially their interactions.\n\n` +
            `Objects and parameters:\n${ctx.text}\n\n` +
            `Address: mutual gravity and orbital dynamics, tidal forces and Roche limits, orbital stability and resonances, ` +
            `illumination and sky appearance, radiation environment, and what a human standing in the system would actually experience. ` +
            `Use real numbers where available, show key formulas, and call out unknown/estimated/disputed values explicitly.`,
        };
      },
      apply({ channelId, objectIds, ideaId }, text) {
        const body = String(text);
        if (ideaId && getIdea(ideaId)) {
          sql.prepare('UPDATE studio_ideas SET physics_analysis = ?, updated_at = ? WHERE id = ?').run(body, now(), ideaId);
        }
        return { summary: `Physics analysis ready (${body.length} chars)`, text: body, ideaId: ideaId || null };
      },
    },
  };
  const PROMPTABLE = Object.keys(JOBS);

  async function runJob(type, params) {
    const def = JOBS[type];
    if (!def) throw new Error(`Unknown job type: ${type}`);
    if (def.needsIdea && !params.ideaId) throw new Error('This job needs an idea.');
    if (def.needsObjects && !parseObjectIds(params.objectIds).length) throw new Error('This job needs one or more selected objects.');
    const channel = getChannel(params.channelId);
    if (!channel) throw new Error('Channel not found.');
    if (!callAI) throw new Error('AI service is not available.');
    const mode = params.mode === 'local' ? 'local' : 'cloud';
    const model = mode === 'local'
      ? { provider: 'local', model: process.env.LOCAL_STUDIO_MODEL || 'llama3.2' }
      : { provider: params.provider || 'anthropic', model: process.env.STUDIO_CLOUD_MODEL || 'claude-sonnet-4-6' };
    const modelLabel = `${model.provider}/${model.model}`;
    // Jobs may define a `custom` runner for multi-call agentic flows (e.g. writer + critic).
    if (typeof def.custom === 'function') {
      return def.custom({ ...params, channel, model, modelLabel });
    }
    const built = def.build({ ...params, channel });
    const full = await callAI(model, built.user, built.system, [], { returnFullResult: true });
    return def.apply({ ...params, model: modelLabel }, full.text || full);
  }

  router.get('/channels', (_req, res) => {
    res.json(listChannels());
  });

  router.get('/channels/:channelId', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (channel) res.json(channel);
  });

  router.patch('/channels/:channelId', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (!channel) return;
    const fields = [];
    const values = [];
    for (const field of EDITABLE_CHANNEL_FIELDS) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(field === 'default_cadence_target'
          ? Math.max(1, Math.min(10, Number(req.body[field]) || 2))
          : String(req.body[field]));
      }
    }
    if (!fields.length) return res.json(channel);
    fields.push('updated_at = ?');
    values.push(now(), req.params.channelId);
    sql.prepare(`UPDATE studio_channels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json(getChannel(req.params.channelId));
  });

  router.get('/', (req, res) => {
    const channelId = getChannelId(req);
    const channel = requireChannel(res, channelId);
    if (!channel) return;
    res.json({
      channel,
      channels: listChannels(),
      ideas: listIdeas(channelId),
      targetReady: getSetting(channelId, 'targetReady', channel.default_cadence_target || 2),
      sources: listSources(channelId),
      objects: listObjects(channelId),
      referenceImages: listReferenceImages(channelId),
      promptable: PROMPTABLE,
    });
  });

  router.get('/ideas/:id', (req, res) => {
    const idea = getIdea(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    res.json(idea);
  });

  function createIdea(channelId, body) {
    const { title, source, angle, build_promise, category, status } = body || {};
    if (!title || !String(title).trim()) {
      const err = new Error('Title is required');
      err.status = 400;
      throw err;
    }
    const id = uuid();
    sql.prepare(
      `INSERT INTO studio_ideas (id, channel_id, source, title, angle, build_promise, category, status, checklist, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    ).run(
      id,
      channelId,
      String(source || 'manual').slice(0, 100),
      String(title).slice(0, 220),
      String(angle || '').slice(0, 2000),
      String(build_promise || '').slice(0, 1200),
      String(category || 'Episode').slice(0, 120),
      ALL_STATUSES.includes(status) ? status : 'suggested',
      now(),
      now()
    );
    return getIdea(id);
  }

  router.post('/ideas', (req, res) => {
    try {
      const idea = createIdea(DEFAULT_CHANNEL_ID, req.body);
      res.status(201).json(idea);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.post('/:channelId/ideas', (req, res) => {
    try {
      if (!requireChannel(res, req.params.channelId)) return;
      const idea = createIdea(req.params.channelId, req.body);
      res.status(201).json(idea);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.patch('/ideas/:id', (req, res) => {
    const idea = getIdea(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    const fields = [];
    const values = [];
    for (const field of ['title', 'source', 'angle', 'build_promise', 'category', 'script', 'youtube_id', 'unreal_prompt', 'physics_analysis']) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(String(req.body[field]));
      }
    }
    if (req.body.status !== undefined && ALL_STATUSES.includes(req.body.status)) {
      fields.push('status = ?');
      values.push(req.body.status);
    }
    for (const field of JSON_FIELDS) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(JSON.stringify(req.body[field]));
      }
    }
    if (!fields.length) return res.json(idea);
    fields.push('updated_at = ?');
    values.push(now(), req.params.id);
    sql.prepare(`UPDATE studio_ideas SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json(getIdea(req.params.id));
  });

  router.post('/ideas/:id/advance', (req, res) => {
    const idea = getIdea(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    const index = STAGES.indexOf(idea.status);
    const next = index === -1 ? 'approved' : STAGES[Math.min(index + 1, STAGES.length - 1)];
    sql.prepare('UPDATE studio_ideas SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), req.params.id);
    res.json(getIdea(req.params.id));
  });

  router.delete('/ideas/:id', (req, res) => {
    sql.prepare('DELETE FROM studio_ideas WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  router.post('/:channelId/settings', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (!channel) return;
    if (req.body.targetReady !== undefined) {
      setSetting(req.params.channelId, 'targetReady', Math.max(1, Math.min(10, Number(req.body.targetReady) || 2)));
    }
    res.json({ targetReady: getSetting(req.params.channelId, 'targetReady', channel.default_cadence_target || 2) });
  });

  router.post('/:channelId/seed', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (!channel) return;
    const seeds = req.params.channelId === IMPOSSIBLE_WORLDS_CHANNEL_ID ? impossibleWorldsSeeds() : praxisSeeds();
    const existing = new Set(sql.prepare('SELECT title FROM studio_ideas WHERE channel_id = ?').all(req.params.channelId).map((row) => row.title));
    const insert = sql.prepare(
      `INSERT INTO studio_ideas (id, channel_id, source, title, angle, build_promise, category, status, checklist, created_at, updated_at)
       VALUES (@id, @channel_id, @source, @title, @angle, @build_promise, @category, @status, @checklist, @ts, @ts)`
    );
    let seeded = 0;
    const tx = sql.transaction(() => {
      for (const seed of seeds) {
        if (existing.has(seed.title) && !req.body?.force) continue;
        insert.run({
          id: uuid(),
          channel_id: req.params.channelId,
          source: seed.source,
          title: seed.title,
          angle: seed.angle,
          build_promise: seed.build_promise,
          category: seed.category,
          status: seed.status || 'suggested',
          checklist: JSON.stringify(seed.checklist || []),
          ts: now(),
        });
        seeded++;
      }
    });
    tx();
    res.json({ seeded, message: seeded ? undefined : 'Seed ideas already exist.' });
  });

  router.get('/:channelId/sources', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    res.json(listSources(req.params.channelId));
  });

  router.post('/:channelId/sources', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const id = uuid();
    sql.prepare(
      `INSERT INTO studio_sources (id, channel_id, name, source_type, url, query_template, enabled, per_run_cap, relevance_floor, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.params.channelId,
      String(req.body.name || 'Untitled source').slice(0, 180),
      String(req.body.source_type || 'web').slice(0, 80),
      req.body.url ? String(req.body.url) : null,
      req.body.query_template ? String(req.body.query_template) : null,
      req.body.enabled === false ? 0 : 1,
      Math.max(1, Math.min(100, Number(req.body.per_run_cap) || 10)),
      Number.isFinite(Number(req.body.relevance_floor)) ? Number(req.body.relevance_floor) : 0.6,
      req.body.notes ? String(req.body.notes) : null,
      now(),
      now()
    );
    res.status(201).json(sourceRow(sql.prepare('SELECT * FROM studio_sources WHERE id = ?').get(id)));
  });

  router.patch('/:channelId/sources/:sourceId', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const source = sql.prepare('SELECT * FROM studio_sources WHERE id = ? AND channel_id = ?').get(req.params.sourceId, req.params.channelId);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    const fields = [];
    const values = [];
    for (const field of ['name', 'source_type', 'url', 'query_template', 'notes']) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(req.body[field] == null ? null : String(req.body[field]));
      }
    }
    if (req.body.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(req.body.enabled ? 1 : 0);
    }
    if (req.body.per_run_cap !== undefined) {
      fields.push('per_run_cap = ?');
      values.push(Math.max(1, Math.min(100, Number(req.body.per_run_cap) || 10)));
    }
    if (req.body.relevance_floor !== undefined) {
      fields.push('relevance_floor = ?');
      values.push(Number(req.body.relevance_floor) || 0);
    }
    if (!fields.length) return res.json(sourceRow(source));
    fields.push('updated_at = ?');
    values.push(now(), req.params.sourceId, req.params.channelId);
    sql.prepare(`UPDATE studio_sources SET ${fields.join(', ')} WHERE id = ? AND channel_id = ?`).run(...values);
    res.json(sourceRow(sql.prepare('SELECT * FROM studio_sources WHERE id = ?').get(req.params.sourceId)));
  });

  router.post('/:channelId/ingestion/run', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (!channel) return;
    const channelId = req.params.channelId;
    const trigger = String(req.body.trigger || 'manual');
    // Create the run synchronously so the client gets an id, then process in the background.
    const runId = ingestion.createRun(channelId, trigger);
    setImmediate(() => {
      ingestion.run({ channelId, trigger, channel, existingRunId: runId }).catch((e) => {
        try { ingestion.updateRun(runId, { status: 'failed', digest: `Ingestion failed: ${e.message}` }); } catch { /* noop */ }
      });
    });
    res.status(202).json({
      localOnly: true,
      run: sql.prepare('SELECT * FROM studio_ingestion_runs WHERE id = ?').get(runId),
    });
  });

  router.post('/:channelId/ingestion/astro', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (!channel) return;
    const channelId = req.params.channelId;
    const runId = ingestion.createRun(channelId, 'astro-manual');
    setImmediate(() => {
      astroNightly.run({ channelId, existingRunId: runId }).catch((e) => {
        try { ingestion.updateRun(runId, { status: 'failed', digest: `Astrophysics agent failed: ${e.message}` }); } catch { /* noop */ }
      });
    });
    res.status(202).json({ localOnly: true, run: sql.prepare('SELECT * FROM studio_ingestion_runs WHERE id = ?').get(runId) });
  });

  router.post('/:channelId/ingestion/enrich', (req, res) => {
    const channel = requireChannel(res, req.params.channelId);
    if (!channel) return;
    const channelId = req.params.channelId;
    const runId = ingestion.createRun(channelId, 'enrich');
    const batch = Number(req.body.batch) || undefined;
    setImmediate(() => {
      astroNightly.runEnrichment({ channelId, existingRunId: runId, batch }).catch((e) => {
        try { ingestion.updateRun(runId, { status: 'failed', digest: `Enrichment failed: ${e.message}` }); } catch { /* noop */ }
      });
    });
    res.status(202).json({ localOnly: true, run: sql.prepare('SELECT * FROM studio_ingestion_runs WHERE id = ?').get(runId) });
  });

  router.get('/:channelId/ingestion/runs', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const runs = sql.prepare('SELECT * FROM studio_ingestion_runs WHERE channel_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.channelId);
    res.json(runs);
  });

  // Seed the Sun + local planets with curated, data-rich reference values (the
  // Exoplanet Archive excludes our own system). Idempotent — upserts by name.
  router.post('/:channelId/seed-solar-system', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const records = require('../services/solar-system-seed');
    let seeded = 0;
    const tx = sql.transaction(() => {
      for (const rec of records) { if (ingestion.upsertObject(req.params.channelId, rec, null)) seeded += 1; }
    });
    tx();
    res.json({ seeded, names: records.map((r) => r.name) });
  });

  // Export the selected objects as a double-precision SI scene for the Unreal
  // Engine 5 N-body simulator. Solar System bodies use true NASA Horizons state
  // vectors (consistent barycentric frame); any other selection derives initial
  // conditions from orbital elements (central body at origin). Frames are never
  // mixed: if every selected object is a known Solar System body we use Horizons
  // for all of them, otherwise we derive all of them.
  router.post('/:channelId/export/unreal', async (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const channelId = req.params.channelId;
    const ids = parseObjectIds(req.body.objectIds);
    if (!ids.length) return res.status(400).json({ error: 'Select one or more objects to export.' });

    const M_EARTH = 5.972e24, R_EARTH = 6.371e6, M_JUP = 1.898e27, R_JUP = 6.9911e7;
    const M_SUN = 1.989e30, R_SUN = 6.957e8, AU = 1.495978707e11, G = 6.6743e-11;

    const objects = ids
      .map((id) => objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ? AND channel_id = ?').get(id, channelId)))
      .filter(Boolean);
    if (!objects.length) return res.status(404).json({ error: 'No matching objects.' });

    const sv = (o, key) => {
      const s = (o.spec_values || []).find((x) => x.spec_key === key);
      if (!s || s.status === 'unknown' || s.status === 'not_applicable') return null;
      if (s.value_number != null) return Number(s.value_number);
      const n = s.value_text != null ? parseFloat(s.value_text) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const isStar = (o) => /star|dwarf|neutron|pulsar|magnetar/i.test(o.object_kind || '');
    const massKg = (o) => {
      const me = sv(o, 'bulk.mass_earth'); if (me != null) return me * M_EARTH;
      const mj = sv(o, 'bulk.mass_jupiter'); if (mj != null) return mj * M_JUP;
      return isStar(o) ? M_SUN : M_EARTH;
    };
    const radiusM = (o) => {
      const re = sv(o, 'bulk.radius_earth'); if (re != null) return re * R_EARTH;
      const rj = sv(o, 'bulk.radius_jupiter'); if (rj != null) return rj * R_JUP;
      return isStar(o) ? R_SUN : R_EARTH;
    };
    // A star's spectral type lives in its subtype (e.g. 'G2V yellow dwarf').
    const starTeff = (o) => astroParams.spectralTypeToTeff(
      astroParams.parseSpectralType(o.subtype || '') || astroParams.parseSpectralType(o.name || '')
    );
    const colorOf = (o) => {
      if (isStar(o)) {
        const teff = starTeff(o);
        return (teff != null && astroParams.blackbodyToRGB(teff)) || [1.0, 0.9, 0.7];
      }
      const t = sv(o, 'energy.equilibrium_temperature_k');
      if (t == null) return [0.6, 0.65, 0.78];
      if (t > 1000) return [1.0, 0.42, 0.29];
      if (t > 400) return [0.91, 0.63, 0.35];
      if (t > 200) return [0.35, 0.82, 0.77];
      return [0.48, 0.64, 1.0];
    };

    const masses = objects.map(massKg);
    const centralIdx = masses.indexOf(Math.max(...masses));

    // --- positions + velocities (consistent frame) ---
    let states = null;
    let source = 'derived-from-elements';
    const allSolar = objects.every((o) => horizons.isSolarBody(o.name));
    if (allSolar) {
      try {
        // Sequential: JPL Horizons throttles concurrent requests from one IP.
        const fetched = [];
        for (const o of objects) {
          // eslint-disable-next-line no-await-in-loop
          fetched.push(await horizons.getSolarSystemState(o.name));
        }
        if (fetched.every(Boolean)) { states = fetched; source = 'nasa-horizons-j2000-barycentric'; }
      } catch { states = null; }
    }
    if (!states) {
      // Derive: central at origin; others on circular orbits at their semi-major axis.
      states = objects.map((o, i) => {
        if (i === centralIdx) return { position_m: [0, 0, 0], velocity_mps: [0, 0, 0] };
        const aAU = sv(o, 'orbital.semi_major_axis_au');
        const r = (aAU != null ? aAU : 1.2 + i) * AU;
        const angle = i * 2.399963; // golden angle spread
        const v = Math.sqrt((G * masses[centralIdx]) / r);
        return {
          position_m: [r * Math.cos(angle), r * Math.sin(angle), 0],
          velocity_mps: [-v * Math.sin(angle), v * Math.cos(angle), 0],
        };
      });
      // Zero net momentum so the system doesn't drift off-screen.
      const totalMass = masses.reduce((a, b) => a + b, 0);
      const p = [0, 0, 0];
      states.forEach((s, i) => { for (let k = 0; k < 3; k += 1) p[k] += masses[i] * s.velocity_mps[k]; });
      states.forEach((s) => { for (let k = 0; k < 3; k += 1) s.velocity_mps[k] -= p[k] / totalMass; });
    }

    // Per-body render model (rotation, atmosphere scattering, host-star light)
    // derived from catalog specs — feeds the Unreal surface stage.
    const specMapOf = (o) => {
      const map = {};
      for (const s of (o.spec_values || [])) map[s.spec_key] = s;
      return map;
    };
    const renderModels = objects.map((o) => {
      try { return astroParams.computeRenderModel(specMapOf(o)); } catch { return null; }
    });

    // Suns as seen from body i: one entry per star in the selection, with
    // illuminance/apparent size rescaled from the catalog's semi-major axis to
    // the ACTUAL separation in the exported state vectors (matters for
    // eccentric orbits and for Horizons epochs). Falls back to the render
    // model's host-star entry when no star was selected.
    const starIdxs = objects.map((o, j) => (isStar(o) ? j : -1)).filter((j) => j >= 0);
    const sunsFor = (o, i, rm) => {
      const base = (rm && rm.suns && rm.suns[0]) || null;
      if (!starIdxs.length) return base ? [base] : [];
      const aAU = sv(o, 'orbital.semi_major_axis_au');
      return starIdxs.map((j) => {
        const dp = states[i].position_m.map((p, k) => p - states[j].position_m[k]);
        const dAU = Math.sqrt(dp[0] * dp[0] + dp[1] * dp[1] + dp[2] * dp[2]) / AU;
        const teff = starTeff(objects[j]) != null ? starTeff(objects[j]) : (base ? base.teff_k : 5772);
        const rescale = (aAU != null && aAU > 0 && dAU > 0) ? (aAU / dAU) : 1;
        return {
          name: objects[j].name,
          teff_k: Math.round(teff),
          rgb: astroParams.blackbodyToRGB(teff),
          illuminance_lux: (base && base.illuminance_lux != null)
            ? Math.round(base.illuminance_lux * rescale * rescale) : null,
          angular_diameter_deg: (base && base.angular_diameter_deg != null)
            ? Number((base.angular_diameter_deg * rescale).toFixed(4)) : 0.5334,
        };
      }).sort((a, b) => (b.illuminance_lux || 0) - (a.illuminance_lux || 0));
    };

    const scene = {
      generated_at: now(),
      source,
      units: 'SI',
      G,
      unitsPerAU_hint: 1000,
      bodies: objects.map((o, i) => {
        const rm = renderModels[i];
        const body = {
          name: o.name,
          mass_kg: masses[i],
          radius_m: radiusM(o),
          position_m: states[i].position_m,
          velocity_mps: states[i].velocity_mps,
          isStar: isStar(o),
          color: colorOf(o),
          texture: o.name.trim().toLowerCase(),
        };
        if (rm) {
          if (rm.rotation.period_h != null) body.rotation_period_h = rm.rotation.period_h;
          if (rm.rotation.obliquity_deg != null) body.obliquity_deg = rm.rotation.obliquity_deg;
          if (rm.rotation.tidal_locked) body.tidal_locked = true;
          if (!body.isStar) {
            body.surface = rm.surface;
            if (body.surface.planet_radius_km == null) {
              body.surface.planet_radius_km = Math.round(body.radius_m / 1000);
            }
            body.suns = sunsFor(o, i, rm);
          }
        }
        return body;
      }),
    };

    // Save into the project: a timestamped copy in exports/, and — if the Unreal
    // simulator project lives inside this project — straight into its
    // Content/NBody/scene.json so it auto-feeds the sim (no manual copy needed).
    const written = [];
    try {
      const channel = getChannel(channelId);
      if (channel && channel.project_path) {
        const json = JSON.stringify(scene, null, 2);
        const exportsDir = path.join(channel.project_path, 'exports');
        fs.mkdirSync(exportsDir, { recursive: true });
        const archive = path.join(exportsDir, `nbody-scene-${slugify(objects.map((o) => o.name).join('-')).slice(0, 60) || 'scene'}.json`);
        fs.writeFileSync(archive, json);
        written.push(archive);

        const ueScene = path.join(channel.project_path, 'ImpossibleWorldsNBody', 'Content', 'NBody', 'scene.json');
        if (fs.existsSync(path.join(channel.project_path, 'ImpossibleWorldsNBody'))) {
          fs.mkdirSync(path.dirname(ueScene), { recursive: true });
          fs.writeFileSync(ueScene, json);
          written.push(ueScene);
        }
      }
    } catch (e) { /* non-fatal */ }

    res.json({ ...scene, written });
  });

  // Backfill progress: where each source's cursor has reached + objects left to enrich.
  router.get('/:channelId/ingestion/cursors', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const cursors = sql.prepare('SELECT * FROM studio_ingestion_cursors WHERE channel_id = ? ORDER BY source ASC').all(req.params.channelId);
    const objectsTotal = sql.prepare('SELECT COUNT(*) AS n FROM space_objects WHERE channel_id = ?').get(req.params.channelId).n;
    const enrichRemaining = sql.prepare('SELECT COUNT(*) AS n FROM space_objects WHERE channel_id = ? AND enriched_at IS NULL').get(req.params.channelId).n;
    res.json({ cursors, objectsTotal, enrichRemaining });
  });

  router.get('/:channelId/ingestion/runs/:runId', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const run = sql.prepare('SELECT * FROM studio_ingestion_runs WHERE id = ? AND channel_id = ?').get(req.params.runId, req.params.channelId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const items = sql.prepare('SELECT * FROM studio_source_items WHERE run_id = ? ORDER BY created_at ASC').all(req.params.runId);
    res.json({ run, items });
  });

  router.get('/:channelId/objects', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    res.json(listObjects(req.params.channelId));
  });

  router.post('/:channelId/objects', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const id = uuid();
    const ts = now();
    sql.prepare(
      `INSERT INTO space_objects (id, channel_id, name, aliases, object_kind, subtype, reality_status, description,
       field_guide_summary, sensory_impression, points_of_wonder_summary, visual_motifs, human_observer_shock, worldbuilding_relevance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.params.channelId,
      String(req.body.name || 'Untitled object').slice(0, 220),
      stringifyMaybe(req.body.aliases),
      req.body.object_kind || null,
      req.body.subtype || null,
      req.body.reality_status || 'observed',
      req.body.description || null,
      req.body.field_guide_summary || null,
      req.body.sensory_impression || null,
      req.body.points_of_wonder_summary || null,
      req.body.visual_motifs || null,
      req.body.human_observer_shock || null,
      req.body.worldbuilding_relevance || null,
      ts,
      ts
    );
    upsertSpecValues(sql, id, req.body.specs || [], ts, uuid);
    insertWonderPoints(sql, id, req.body.wonder_points || [], uuid);
    res.status(201).json(objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ?').get(id)));
  });

  router.get('/:channelId/objects/:id', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const object = objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ? AND channel_id = ?').get(req.params.id, req.params.channelId));
    if (!object) return res.status(404).json({ error: 'Object not found' });
    res.json(object);
  });

  router.patch('/:channelId/objects/:id', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const object = sql.prepare('SELECT * FROM space_objects WHERE id = ? AND channel_id = ?').get(req.params.id, req.params.channelId);
    if (!object) return res.status(404).json({ error: 'Object not found' });
    const fields = [];
    const values = [];
    for (const field of ['name', 'aliases', 'object_kind', 'subtype', 'reality_status', 'description', 'field_guide_summary', 'sensory_impression', 'points_of_wonder_summary', 'visual_motifs', 'human_observer_shock', 'worldbuilding_relevance']) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(field === 'aliases' ? stringifyMaybe(req.body[field]) : req.body[field]);
      }
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      values.push(now(), req.params.id, req.params.channelId);
      sql.prepare(`UPDATE space_objects SET ${fields.join(', ')} WHERE id = ? AND channel_id = ?`).run(...values);
    }
    upsertSpecValues(sql, req.params.id, req.body.specs || [], now(), uuid);
    insertWonderPoints(sql, req.params.id, req.body.wonder_points || [], uuid);
    res.json(objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ?').get(req.params.id)));
  });

  router.post('/:channelId/objects/:id/spec-values', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const object = sql.prepare('SELECT id FROM space_objects WHERE id = ? AND channel_id = ?').get(req.params.id, req.params.channelId);
    if (!object) return res.status(404).json({ error: 'Object not found' });
    upsertSpecValues(sql, req.params.id, Array.isArray(req.body) ? req.body : [req.body], now(), uuid);
    res.status(201).json(objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ?').get(req.params.id)));
  });

  router.post('/:channelId/objects/:id/wonder-points', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const object = sql.prepare('SELECT id FROM space_objects WHERE id = ? AND channel_id = ?').get(req.params.id, req.params.channelId);
    if (!object) return res.status(404).json({ error: 'Object not found' });
    insertWonderPoints(sql, req.params.id, Array.isArray(req.body) ? req.body : [req.body], uuid);
    res.status(201).json(objectRow(sql.prepare('SELECT * FROM space_objects WHERE id = ?').get(req.params.id)));
  });

  router.post('/ideas/:id/objects', (req, res) => {
    const idea = getIdea(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    const objectId = req.body.object_id;
    if (!objectId) return res.status(400).json({ error: 'object_id is required' });
    sql.prepare(
      `INSERT OR REPLACE INTO studio_episode_objects (episode_id, object_id, role, notes)
       VALUES (?, ?, ?, ?)`
    ).run(req.params.id, objectId, req.body.role || 'main_subject', req.body.notes || null);
    res.status(201).json({ episode_id: req.params.id, object_id: objectId, role: req.body.role || 'main_subject' });
  });

  router.delete('/ideas/:id/objects/:objectId', (req, res) => {
    sql.prepare('DELETE FROM studio_episode_objects WHERE episode_id = ? AND object_id = ?').run(req.params.id, req.params.objectId);
    res.json({ success: true });
  });

  router.get('/:channelId/reference-images', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    res.json(listReferenceImages(req.params.channelId, req.query.episodeId));
  });

  router.post('/:channelId/reference-images', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    if (!req.body.file_path_or_url) return res.status(400).json({ error: 'file_path_or_url is required' });
    const id = uuid();
    sql.prepare(
      `INSERT INTO studio_reference_images (id, channel_id, episode_id, object_id, file_path_or_url, prompt, negative_prompt, model, aspect_ratio, intended_use, tags, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.params.channelId,
      req.body.episode_id || null,
      req.body.object_id || null,
      String(req.body.file_path_or_url),
      req.body.prompt || null,
      req.body.negative_prompt || null,
      req.body.model || null,
      req.body.aspect_ratio || null,
      req.body.intended_use || null,
      req.body.tags || null,
      req.body.notes || null,
      now()
    );
    res.status(201).json(imageRow(sql.prepare('SELECT * FROM studio_reference_images WHERE id = ?').get(id)));
  });

  router.patch('/:channelId/reference-images/:imageId', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const image = sql.prepare('SELECT * FROM studio_reference_images WHERE id = ? AND channel_id = ?').get(req.params.imageId, req.params.channelId);
    if (!image) return res.status(404).json({ error: 'Reference image not found' });
    const fields = [];
    const values = [];
    for (const field of ['episode_id', 'object_id', 'file_path_or_url', 'prompt', 'negative_prompt', 'model', 'aspect_ratio', 'intended_use', 'tags', 'notes']) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(req.body[field] == null ? null : String(req.body[field]));
      }
    }
    if (!fields.length) return res.json(imageRow(image));
    values.push(req.params.imageId, req.params.channelId);
    sql.prepare(`UPDATE studio_reference_images SET ${fields.join(', ')} WHERE id = ? AND channel_id = ?`).run(...values);
    res.json(imageRow(sql.prepare('SELECT * FROM studio_reference_images WHERE id = ?').get(req.params.imageId)));
  });

  router.delete('/:channelId/reference-images/:imageId', (req, res) => {
    if (!requireChannel(res, req.params.channelId)) return;
    const row = sql.prepare('SELECT stored_path FROM studio_reference_images WHERE id = ? AND channel_id = ?').get(req.params.imageId, req.params.channelId);
    if (row && row.stored_path) { try { fs.unlinkSync(row.stored_path); } catch { /* best effort */ } }
    sql.prepare('DELETE FROM studio_reference_images WHERE id = ? AND channel_id = ?').run(req.params.imageId, req.params.channelId);
    res.json({ success: true });
  });

  router.post('/:channelId/reference-images/upload', refUpload.single('file'), (req, res) => {
    if (!getChannel(req.params.channelId)) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* noop */ } }
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
    const id = uuid();
    const fileUrl = `/api/studio/${req.params.channelId}/reference-images/${id}/file`;
    sql.prepare(
      `INSERT INTO studio_reference_images (id, channel_id, episode_id, object_id, file_path_or_url, stored_path, prompt, negative_prompt, model, aspect_ratio, intended_use, tags, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.params.channelId, req.body.episode_id || null, req.body.object_id || null,
      fileUrl, req.file.path, req.body.prompt || null, req.body.negative_prompt || null,
      req.body.model || null, req.body.aspect_ratio || null, req.body.intended_use || 'surface_reference',
      req.body.tags || null, req.body.notes || null, now()
    );
    res.status(201).json(imageRow(sql.prepare('SELECT * FROM studio_reference_images WHERE id = ?').get(id)));
  });

  router.get('/:channelId/reference-images/:imageId/file', (req, res) => {
    const row = sql.prepare('SELECT * FROM studio_reference_images WHERE id = ? AND channel_id = ?').get(req.params.imageId, req.params.channelId);
    if (!row || !row.stored_path || !fs.existsSync(row.stored_path)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(path.resolve(row.stored_path));
  });

  router.post('/:channelId/generate', async (req, res) => {
    try {
      const result = await runJob(req.body.type, { ...req.body, channelId: req.params.channelId });
      res.json({ success: true, result, idea: result?.ideaId ? getIdea(result.ideaId) : (req.body.ideaId ? getIdea(req.body.ideaId) : null) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/generate', async (req, res) => {
    try {
      const channelId = req.body.channelId || DEFAULT_CHANNEL_ID;
      const result = await runJob(req.body.type, { ...req.body, channelId });
      res.json({ success: true, result, idea: result?.ideaId ? getIdea(result.ideaId) : (req.body.ideaId ? getIdea(req.body.ideaId) : null) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/:channelId/prompt', (req, res) => {
    try {
      const channel = getChannel(req.params.channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      const def = JOBS[req.query.type];
      if (!def) return res.status(404).json({ error: 'Unknown job type' });
      const built = def.build({ channel, channelId: req.params.channelId, ideaId: req.query.ideaId, objectIds: req.query.objectIds, count: req.query.count });
      res.json({ label: def.label, system: built.system, user: built.user });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/prompt', (req, res) => {
    try {
      const channelId = req.query.channelId || DEFAULT_CHANNEL_ID;
      const channel = getChannel(channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      const def = JOBS[req.query.type];
      if (!def) return res.status(404).json({ error: 'Unknown job type' });
      const built = def.build({ channel, channelId, ideaId: req.query.ideaId, objectIds: req.query.objectIds, count: req.query.count });
      res.json({ label: def.label, system: built.system, user: built.user });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/:channelId/apply', (req, res) => {
    try {
      const def = JOBS[req.body.type];
      if (!def) return res.status(404).json({ error: 'Unknown job type' });
      const result = def.apply({ channelId: req.params.channelId, ideaId: req.body.ideaId, objectIds: req.body.objectIds, model: 'pasted' }, String(req.body.text || ''));
      res.json({ success: true, result, idea: result?.ideaId ? getIdea(result.ideaId) : (req.body.ideaId ? getIdea(req.body.ideaId) : null) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/apply', (req, res) => {
    try {
      const def = JOBS[req.body.type];
      if (!def) return res.status(404).json({ error: 'Unknown job type' });
      const result = def.apply({ channelId: req.body.channelId || DEFAULT_CHANNEL_ID, ideaId: req.body.ideaId, objectIds: req.body.objectIds, model: 'pasted' }, String(req.body.text || ''));
      res.json({ success: true, result, idea: result?.ideaId ? getIdea(result.ideaId) : (req.body.ideaId ? getIdea(req.body.ideaId) : null) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

function setupSchema(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS studio_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT,
      type TEXT DEFAULT 'youtube',
      positioning TEXT,
      editorial_promise TEXT,
      audience TEXT,
      host_style TEXT,
      visual_style_notes TEXT,
      recurring_episode_format TEXT,
      source_strategy TEXT,
      monetization_notes TEXT,
      risks_and_mitigations TEXT,
      default_cadence_target INTEGER DEFAULT 2,
      prompt_guardrails TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS studio_ideas (
      id TEXT PRIMARY KEY,
      channel_id TEXT DEFAULT 'praxis-youtube',
      source TEXT,
      title TEXT NOT NULL,
      angle TEXT,
      build_promise TEXT,
      category TEXT,
      status TEXT DEFAULT 'suggested',
      script TEXT,
      script_model TEXT,
      thumbnail_concepts TEXT,
      image_prompts TEXT,
      checklist TEXT,
      publish_kit TEXT,
      youtube_id TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS studio_settings (
      channel_id TEXT NOT NULL DEFAULT 'praxis-youtube',
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (channel_id, key)
    );
    CREATE TABLE IF NOT EXISTS studio_sources (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      url TEXT,
      query_template TEXT,
      enabled INTEGER DEFAULT 1,
      per_run_cap INTEGER DEFAULT 10,
      relevance_floor REAL DEFAULT 0.6,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS studio_ingestion_runs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      trigger TEXT,
      status TEXT,
      discovered_count INTEGER DEFAULT 0,
      deduped_count INTEGER DEFAULT 0,
      items_enqueued INTEGER DEFAULT 0,
      items_succeeded INTEGER DEFAULT 0,
      items_failed INTEGER DEFAULT 0,
      digest TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS studio_source_items (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      run_id TEXT,
      title TEXT,
      url TEXT,
      source_type TEXT,
      source_name TEXT,
      published_at TEXT,
      content_hash TEXT,
      raw_content_path TEXT,
      excerpt TEXT,
      ingestion_status TEXT DEFAULT 'candidate',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS space_objects (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT,
      object_kind TEXT,
      subtype TEXT,
      reality_status TEXT,
      description TEXT,
      field_guide_summary TEXT,
      sensory_impression TEXT,
      points_of_wonder_summary TEXT,
      visual_motifs TEXT,
      human_observer_shock TEXT,
      worldbuilding_relevance TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS space_spec_definitions (
      key TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      unit TEXT,
      value_type TEXT DEFAULT 'text',
      applies_to_kinds TEXT,
      collection_guidance TEXT,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS space_object_spec_values (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL,
      spec_key TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_min REAL,
      value_max REAL,
      unit TEXT,
      status TEXT DEFAULT 'unknown',
      confidence TEXT DEFAULT 'medium',
      source_item_id TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS space_object_relationships (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      from_object_id TEXT,
      to_object_id TEXT,
      relationship_type TEXT,
      description TEXT,
      confidence TEXT DEFAULT 'medium',
      source_item_id TEXT
    );
    CREATE TABLE IF NOT EXISTS points_of_wonder (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL,
      wonder_type TEXT,
      note TEXT NOT NULL,
      episode_hook_potential TEXT,
      visual_prompt_seed TEXT,
      source_item_id TEXT,
      confidence TEXT DEFAULT 'medium'
    );
    CREATE TABLE IF NOT EXISTS studio_episode_objects (
      episode_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      role TEXT,
      notes TEXT,
      PRIMARY KEY (episode_id, object_id, role)
    );
    CREATE TABLE IF NOT EXISTS studio_reference_images (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      episode_id TEXT,
      object_id TEXT,
      file_path_or_url TEXT NOT NULL,
      prompt TEXT,
      negative_prompt TEXT,
      model TEXT,
      aspect_ratio TEXT,
      intended_use TEXT,
      tags TEXT,
      notes TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS studio_ingestion_cursors (
      channel_id TEXT NOT NULL,
      source TEXT NOT NULL,
      mode TEXT DEFAULT 'backfill',
      position TEXT,
      last_run_at TEXT,
      processed_count INTEGER DEFAULT 0,
      total_estimate INTEGER,
      updated_at TEXT,
      PRIMARY KEY (channel_id, source)
    );
  `);
  ensureColumn(sql, 'studio_ideas', 'channel_id', "TEXT DEFAULT 'praxis-youtube'");
  ensureColumn(sql, 'studio_ideas', 'source', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'angle', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'build_promise', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'category', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'status', "TEXT DEFAULT 'suggested'");
  ensureColumn(sql, 'studio_ideas', 'script', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'script_model', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'thumbnail_concepts', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'image_prompts', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'checklist', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'publish_kit', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'youtube_id', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'unreal_prompt', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'physics_analysis', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'sort_order', 'INTEGER DEFAULT 0');
  ensureColumn(sql, 'studio_ideas', 'created_at', 'TEXT');
  ensureColumn(sql, 'studio_ideas', 'updated_at', 'TEXT');
  ensureColumn(sql, 'studio_reference_images', 'stored_path', 'TEXT');
  ensureColumn(sql, 'space_objects', 'enriched_at', 'TEXT');
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_studio_ideas_channel_status ON studio_ideas(channel_id, status);
    CREATE INDEX IF NOT EXISTS idx_studio_sources_channel ON studio_sources(channel_id);
    CREATE INDEX IF NOT EXISTS idx_space_objects_channel_kind ON space_objects(channel_id, object_kind);
    CREATE INDEX IF NOT EXISTS idx_space_spec_values_object ON space_object_spec_values(object_id);
    CREATE INDEX IF NOT EXISTS idx_reference_images_channel_episode ON studio_reference_images(channel_id, episode_id);
  `);
}

function ensureColumn(sql, table, column, definition) {
  if (!hasColumn(sql, table, column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hasColumn(sql, table, column) {
  return sql.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function seedChannels(sql) {
  const ts = new Date().toISOString();
  const insert = sql.prepare(
    `INSERT INTO studio_channels (id, name, project_path, type, positioning, editorial_promise, audience, host_style,
      visual_style_notes, recurring_episode_format, source_strategy, monetization_notes, risks_and_mitigations,
      default_cadence_target, prompt_guardrails, created_at, updated_at)
     VALUES (@id, @name, @project_path, @type, @positioning, @editorial_promise, @audience, @host_style,
      @visual_style_notes, @recurring_episode_format, @source_strategy, @monetization_notes, @risks_and_mitigations,
      @default_cadence_target, @prompt_guardrails, @ts, @ts)
     ON CONFLICT(id) DO NOTHING`
  );
  insert.run({
    id: DEFAULT_CHANNEL_ID,
    name: 'Praxis YouTube Channel',
    project_path: '/Volumes/Projects/Praxis YouTube Channel',
    type: 'youtube',
    positioning: 'Robert teaches viewers how his personal AI operating system works and how to build minimal versions of its pieces.',
    editorial_promise: 'Concrete, build-along, honest about trade-offs, no hype.',
    audience: 'Builders, AI-agent enthusiasts, indie hackers, technically curious viewers.',
    host_style: 'Robert as builder/teacher; calm, direct, specific, transparent about what works and what breaks.',
    visual_style_notes: 'Clean system diagrams, screen captures, host-on-camera explanations, practical build artifacts.',
    recurring_episode_format: 'Concrete hook, system map, smallest buildable version, trade-offs, next step.',
    source_strategy: 'Draw from Robert projects in The Nexus and concrete implementation artifacts.',
    monetization_notes: 'Sponsorships, tool/repo products, consulting credibility, long-term audience trust.',
    risks_and_mitigations: 'Avoid hype by showing real builds, limits, and trade-offs.',
    default_cadence_target: 2,
    prompt_guardrails: 'No hype. Teach the smallest useful implementation. Be honest about what breaks.',
    ts,
  });
  insert.run({
    id: IMPOSSIBLE_WORLDS_CHANNEL_ID,
    name: 'Impossible Worlds Field Guide',
    project_path: '/Volumes/Projects/Impossible Worlds Field Guide',
    type: 'youtube',
    positioning: "I help curious people feel how strange the real and possible universe is by treating extreme and hypothetical worlds like a naturalist's field guide.",
    editorial_promise: 'Every scenario worked through with actual physics, no hype, and clear uncertainty labels.',
    audience: 'Curious science viewers, speculative worldbuilders, space and physics enthusiasts.',
    host_style: 'Robert narrates and appears on camera; human awe is part of the channel voice.',
    visual_style_notes: 'Scientifically grounded surfaces, skies, diagrams, specimen-card overlays, and clear uncertainty notes.',
    recurring_episode_format: 'Cold sensory hook, specimen card, physics walk-through, human observer experience, uncertainty ledger, field notes.',
    source_strategy: 'Start from trustworthy astronomy and physics sources, then extract objects, measurable specs, relationships, wonder notes, visual seeds, and episode hooks.',
    monetization_notes: 'Sponsorships, AdSense, science-inspired digital products, posters, prints, and worldbuilder PDFs.',
    risks_and_mitigations: 'Local catalog facts carry status, confidence, source notes, and explicit unknown/disputed states.',
    default_cadence_target: 2,
    prompt_guardrails: 'Physics first. No unsupported claims. Use uncertainty labels. Vivid sensory writing without hype.',
    ts,
  });
}

function seedSources(sql) {
  const ts = new Date().toISOString();
  const sources = [
    { name: 'Kurzgesagt YouTube Channel', source_type: 'youtube_channel', url: 'https://www.youtube.com/@kurzgesagt', per_run_cap: 10, notes: 'Reference/research source for science storytelling demand and factual trails.' },
    { name: "YouTube: what it's like on rogue planet", source_type: 'youtube_search', query_template: "what it's like on rogue planet" },
    { name: 'YouTube: strangest planets', source_type: 'youtube_search', query_template: 'strangest planets' },
    { name: 'YouTube: hot jupiter weather', source_type: 'youtube_search', query_template: 'hot jupiter weather' },
    { name: 'YouTube: tidally locked exoplanet habitability', source_type: 'youtube_search', query_template: 'tidally locked exoplanet habitability' },
    { name: 'YouTube: ocean world pressure', source_type: 'youtube_search', query_template: 'ocean world pressure' },
    { name: 'NASA', source_type: 'web', url: 'https://www.nasa.gov/' },
    { name: 'ESA', source_type: 'web', url: 'https://www.esa.int/' },
    { name: 'arXiv astro-ph', source_type: 'academic', url: 'https://arxiv.org/archive/astro-ph' },
    { name: 'NASA Exoplanet Archive', source_type: 'database', url: 'https://exoplanetarchive.ipac.caltech.edu/' },
    { name: 'User-provided URLs', source_type: 'manual_url', notes: 'Paste source URLs here as research expands.' },
  ];
  const insert = sql.prepare(
    `INSERT INTO studio_sources (id, channel_id, name, source_type, url, query_template, enabled, per_run_cap, relevance_floor, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0.6, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  for (const source of sources) {
    const id = `${IMPOSSIBLE_WORLDS_CHANNEL_ID}:${slugify(source.name)}`;
    insert.run(id, IMPOSSIBLE_WORLDS_CHANNEL_ID, source.name, source.source_type, source.url || null, source.query_template || null, source.per_run_cap || 10, source.notes || null, ts, ts);
  }
}

function seedSpecDefinitions(sql) {
  const keys = [
    ['classification.object_kind', 'Classification', 'Object kind', null],
    ['classification.subtype', 'Classification', 'Subtype', null],
    ['classification.formation_pathway', 'Classification', 'Formation pathway', null],
    ['classification.evolutionary_stage', 'Classification', 'Evolutionary stage', null],
    ['classification.reality_status', 'Classification', 'Reality status', null],
    ['discovery.discovery_date', 'Discovery', 'Discovery date', null],
    ['discovery.discovery_method', 'Discovery', 'Discovery method', null],
    ['discovery.catalog_ids', 'Discovery', 'Catalog ids', null],
    ['discovery.distance_from_earth_ly', 'Discovery', 'Distance from Earth', 'ly'],
    ['discovery.observing_instrument', 'Discovery', 'Observing instrument', null],
    ['location.constellation', 'Location', 'Constellation', null],
    ['location.system', 'Location', 'System', null],
    ['location.host_star_or_object', 'Location', 'Host star/object', null],
    ['location.galactic_environment', 'Location', 'Galactic environment', null],
    ['orbital.semi_major_axis_au', 'Orbital', 'Semi-major axis', 'AU'],
    ['orbital.eccentricity', 'Orbital', 'Eccentricity', null],
    ['orbital.inclination_deg', 'Orbital', 'Inclination', 'deg'],
    ['orbital.orbital_period_days', 'Orbital', 'Orbital period', 'days'],
    ['orbital.rotation_period_hours', 'Orbital', 'Rotation period', 'hours'],
    ['orbital.obliquity_deg', 'Orbital', 'Obliquity', 'deg'],
    ['orbital.tidal_lock_status', 'Orbital', 'Tidal lock status', null],
    ['orbital.resonance', 'Orbital', 'Resonance', null],
    ['bulk.mass_earth', 'Bulk', 'Mass', 'Earth masses'],
    ['bulk.mass_jupiter', 'Bulk', 'Mass', 'Jupiter masses'],
    ['bulk.radius_earth', 'Bulk', 'Radius', 'Earth radii'],
    ['bulk.radius_jupiter', 'Bulk', 'Radius', 'Jupiter radii'],
    ['bulk.density_g_cm3', 'Bulk', 'Density', 'g/cm3'],
    ['bulk.surface_gravity_g', 'Bulk', 'Surface gravity', 'g'],
    ['bulk.escape_velocity_km_s', 'Bulk', 'Escape velocity', 'km/s'],
    ['energy.stellar_flux_earth', 'Energy', 'Stellar flux', 'Earth flux'],
    ['energy.luminosity_exposure', 'Energy', 'Luminosity exposure', null],
    ['energy.equilibrium_temperature_k', 'Energy', 'Equilibrium temperature', 'K'],
    ['energy.internal_heat', 'Energy', 'Internal heat', null],
    ['energy.albedo', 'Energy', 'Albedo', null],
    ['atmosphere.pressure_bar', 'Atmosphere', 'Pressure', 'bar'],
    ['atmosphere.composition', 'Atmosphere', 'Composition', null],
    ['atmosphere.scale_height_km', 'Atmosphere', 'Scale height', 'km'],
    ['atmosphere.density_kg_m3', 'Atmosphere', 'Surface air density', 'kg/m3'],
    ['atmosphere.clouds_hazes', 'Atmosphere', 'Clouds/hazes', null],
    ['atmosphere.dominant_weather', 'Atmosphere', 'Dominant weather', null],
    ['atmosphere.wind_speed_km_h', 'Atmosphere', 'Wind speed', 'km/h'],
    ['atmosphere.precipitation_condensates', 'Atmosphere', 'Precipitation/condensates', null],
    ['surface.surface_state', 'Surface and Interior', 'Surface state', null],
    ['surface.dominant_materials', 'Surface and Interior', 'Dominant materials', null],
    ['surface.ocean_depth_km', 'Surface and Interior', 'Ocean depth', 'km'],
    ['surface.ice_thickness_km', 'Surface and Interior', 'Ice thickness', 'km'],
    ['surface.mantle_core_notes', 'Surface and Interior', 'Mantle/core notes', null],
    ['surface.geology', 'Surface and Interior', 'Geology', null],
    ['surface.volcanism', 'Surface and Interior', 'Volcanism', null],
    ['magnetic.magnetosphere', 'Magnetic and Radiation', 'Magnetosphere', null],
    ['magnetic.radiation_environment', 'Magnetic and Radiation', 'Radiation environment', null],
    ['magnetic.stellar_activity_exposure', 'Magnetic and Radiation', 'Stellar activity exposure', null],
    ['magnetic.aurora_potential', 'Magnetic and Radiation', 'Aurora potential', null],
    ['habitability.liquid_water_plausibility', 'Habitability', 'Liquid water plausibility', null],
    ['habitability.chemistry', 'Habitability', 'Chemistry', null],
    ['habitability.energy_gradients', 'Habitability', 'Energy gradients', null],
    ['habitability.stability_window', 'Habitability', 'Stability window', null],
    ['habitability.blockers', 'Habitability', 'Likely blockers', null],
    ['observation.evidence_type', 'Observation Quality', 'Evidence type', null],
    ['observation.uncertainty', 'Observation Quality', 'Uncertainty', null],
    ['observation.source_reliability', 'Observation Quality', 'Source reliability', null],
    ['observation.disputed_claims', 'Observation Quality', 'Disputed claims', null],
    ['human_experience.sky_appearance', 'Human Experience', 'Sky appearance', null],
    ['human_experience.horizon_lighting', 'Human Experience', 'Horizon/lighting', null],
    ['human_experience.sound_air_implications', 'Human Experience', 'Sound/air implications', null],
    ['human_experience.movement_difficulty', 'Human Experience', 'Movement difficulty', null],
    ['human_experience.immediate_hazards', 'Human Experience', 'Immediate hazards', null],
    ['human_experience.survival_impossibilities', 'Human Experience', 'Survival impossibilities', null],
    // Appended after initial release (ON CONFLICT DO NOTHING keeps old rows).
    ['energy.star_effective_temperature_k', 'Energy', 'Host star effective temperature', 'K'],
    ['human_experience.daylight_illuminance_lux', 'Human Experience', 'Daylight illuminance', 'lux'],
  ];
  const insert = sql.prepare(
    `INSERT INTO space_spec_definitions (key, category, label, unit, value_type, collection_guidance, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO NOTHING`
  );
  keys.forEach(([key, category, label, unit], index) => {
    insert.run(key, category, label, unit, unit ? 'number' : 'text', 'Collect consistently; use unknown/not_applicable/disputed when needed.', index);
  });
}

function upsertSpecValues(sql, objectId, specs, ts, uuid) {
  if (!Array.isArray(specs)) return;
  const insert = sql.prepare(
    `INSERT INTO space_object_spec_values (id, object_id, spec_key, value_text, value_number, value_min, value_max, unit, status, confidence, source_item_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const spec of specs) {
    if (!spec?.spec_key) continue;
    insert.run(
      uuid(),
      objectId,
      String(spec.spec_key),
      spec.value_text == null ? null : String(spec.value_text),
      spec.value_number == null ? null : Number(spec.value_number),
      spec.value_min == null ? null : Number(spec.value_min),
      spec.value_max == null ? null : Number(spec.value_max),
      spec.unit || null,
      spec.status || 'unknown',
      spec.confidence || 'medium',
      spec.source_item_id || null,
      spec.notes || null,
      ts,
      ts
    );
  }
}

function insertWonderPoints(sql, objectId, points, uuid) {
  if (!Array.isArray(points)) return;
  const insert = sql.prepare(
    `INSERT INTO points_of_wonder (id, object_id, wonder_type, note, episode_hook_potential, visual_prompt_seed, source_item_id, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const point of points) {
    if (!point?.note) continue;
    insert.run(uuid(), objectId, point.wonder_type || 'sensory', String(point.note), point.episode_hook_potential || null, point.visual_prompt_seed || null, point.source_item_id || null, point.confidence || 'medium');
  }
}

function extractJSON(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start !== -1 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('Could not parse JSON from the model response.');
  }
}

function stringifyMaybe(value) {
  if (value == null) return null;
  return Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function cl(...labels) {
  return labels.map((label) => ({ label, done: false }));
}

function impossibleWorldsSeeds() {
  return [
    {
      source: 'field-guide seed',
      category: 'Rogue Worlds',
      status: 'suggested',
      title: "What it's actually like to stand on a rogue planet",
      angle: 'A starless world where the sky gives almost nothing back, but geology and leftover heat may still make a place.',
      build_promise: 'Understand starless-world physics, surface temperature, heat sources, and what a human observer would actually sense.',
      checklist: cl('Collect rogue planet sources', 'Create specimen sheet', 'Write sensory hook', 'Physics rigor pass', 'Reference image prompts'),
    },
    {
      source: 'HD 189733 b',
      category: 'Hot Jupiters',
      status: 'suggested',
      title: 'The real planet where it rains molten glass - sideways',
      angle: 'HD 189733 b turns a familiar phrase into violent atmospheric physics: blue skies, extreme winds, and silicate condensates.',
      build_promise: 'Separate the real observations from the shorthand and show what the atmosphere likely means.',
      checklist: cl('Verify glass-rain claim', 'Collect wind/temperature specs', 'Uncertainty labels', 'Thumbnail concepts'),
    },
    {
      source: 'black hole planets',
      category: 'Orbital Extremes',
      status: 'suggested',
      title: 'Could a planet orbit a black hole? What its sky would look like',
      angle: 'Use the Interstellar hook but walk through stable orbits, tidal forces, accretion disks, and sky appearance honestly.',
      build_promise: 'Understand black-hole orbit constraints and what would make the sky deadly, beautiful, or impossible.',
      checklist: cl('Collect orbit math sources', 'Define safe assumptions', 'Sky diagram prompt pack', 'Rigor pass'),
    },
    {
      source: 'carbon planets',
      category: 'Exotic Interiors',
      status: 'suggested',
      title: "Diamond planets are real. Here's what's actually under the surface",
      angle: 'Take the viral diamond-planet idea apart into carbon chemistry, pressure, and what "diamond" does and does not mean.',
      build_promise: 'Understand carbon-rich planet hypotheses, interiors, and uncertainty.',
      checklist: cl('Catalog carbon planet candidates', 'Spec sheet', 'Disputed claims', 'Reference prompts'),
    },
    {
      source: 'tidally locked worlds',
      category: 'Habitability',
      status: 'suggested',
      title: 'A day on a tidally-locked world: eternal noon vs. the frozen dark side',
      angle: 'One hemisphere is trapped under a permanent star while the other never sees sunrise; the terminator may be the story.',
      build_promise: 'Understand heat transport, atmospheric circulation, dark-side collapse, and habitability tension.',
      checklist: cl('Collect climate model sources', 'Spec definitions', 'Terminator visual prompts', 'Script'),
    },
    {
      source: 'circumbinary worlds',
      category: 'Multiple Stars',
      status: 'suggested',
      title: 'What life could plausibly look like under two suns',
      angle: 'Use Tatooine as the doorway, then make the biology and orbital constraints do the work.',
      build_promise: 'Understand circumbinary orbits, lighting cycles, climate stress, and plausible adaptation.',
      checklist: cl('Collect circumbinary planets', 'Life plausibility notes', 'Sky reference prompts', 'Source pack'),
    },
    {
      source: 'planet mass limits',
      category: 'Planet Physics',
      status: 'suggested',
      title: 'The biggest a planet can possibly get - and the physics that caps it',
      angle: 'At some point adding more stuff stops making a bigger planet and starts making something stranger.',
      build_promise: 'Understand gas giant compression, brown dwarf boundaries, and mass/radius limits.',
      checklist: cl('Collect mass-radius sources', 'Comparison chart', 'Rigor pass', 'Thumbnail'),
    },
    {
      source: 'ocean worlds',
      category: 'Ocean Worlds',
      status: 'suggested',
      title: "Ocean worlds: what's at the bottom of a planet-wide sea?",
      angle: 'A sea with no shore sounds beautiful until pressure, exotic ice, and no sunlight turn it alien.',
      build_promise: 'Understand pressure, high-pressure ice phases, chemistry, and habitability at depth.',
      checklist: cl('Collect ocean world specs', 'Pressure/depth math', 'Bottom-of-ocean prompt pack', 'Script'),
    },
    {
      source: 'Earth rings scenario',
      category: 'What-if Earth',
      status: 'suggested',
      title: 'What if Earth had rings like Saturn?',
      angle: 'A familiar planet becomes visually impossible, but orbital mechanics decides what survives.',
      build_promise: 'Understand ring stability, sky appearance by latitude, lighting, and daily consequences.',
      checklist: cl('Collect ring dynamics sources', 'Latitude sky visuals', 'Human experience notes', 'Publish kit'),
    },
    {
      source: 'stellar oddities',
      category: 'Stellar Field Notes',
      status: 'suggested',
      title: "The stars that shouldn't exist (but do)",
      angle: 'Open a recurring stellar-oddities series with objects that look like exceptions until the physics catches up.',
      build_promise: 'Understand why stellar oddities matter and how observation stretches theory.',
      checklist: cl('Select first stellar objects', 'Spec sheets', 'Wonder points', 'Series map'),
    },
  ];
}

function praxisSeeds() {
  return [
    {
      source: 'overview',
      category: 'Overview',
      status: 'suggested',
      title: "I Built My Own AI Operating System (Here's the Whole Map)",
      angle: 'Map Praxis, The Nexus, The Cortex, shared-mind, and the human approval surfaces.',
      build_promise: 'A viewer understands the smallest version of the personal AI operating system they can build.',
      checklist: cl('System map', 'Screen captures', 'Script', 'Thumbnail'),
    },
  ];
}

module.exports = createStudioRouter;
