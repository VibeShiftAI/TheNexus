# Impossible Worlds Multi-Channel Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a tracked, multi-channel YouTube Studio inside The Nexus with editable channel profiles for Praxis and Impossible Worlds, an Impossible Worlds project folder, channel-scoped production boards, field-guide object catalog tables, local-only ingestion controls, and reference image storage/prompt workflows.

**Architecture:** Add a self-contained `/api/studio` Express router backed by additive SQLite tables in `nexus.db`, mounted from `server/server.js`. Add a typed Next client plus `/studio` and `/studio/idea/[id]` dashboard pages. Studio data is scoped by `channel_id`, with default fallback to `praxis-youtube`. Impossible Worlds sources feed a reusable space-object catalog, not one-off episode notes. Local ingestion is represented as local queue jobs and run records in v1, with cloud generation allowed only for creative production jobs.

**Tech Stack:** Node.js, Express, better-sqlite3, Jest, Next.js App Router, React, TypeScript, Tailwind CSS, lucide-react, local LLM via existing Model Control/local provider.

---

## Baseline

- [x] Worktree created at `/Volumes/Projects/TheNexus/.worktrees/impossible-worlds-studio` on branch `feature/impossible-worlds-studio`.
- [x] Server tests pass in the clean worktree:

  ```bash
  npm test -- --runInBand
  ```

  Expected current output: `Test Suites: 24 passed, 24 total` and `Tests: 125 passed, 125 total`.

- [x] Dashboard lint currently cannot run in the clean worktree:

  ```bash
  cd dashboard && npm run lint
  ```

  Current output: `sh: eslint: command not found`. Treat this as a pre-existing verification gap unless a dependency-install task explicitly fixes it.

- [x] The clean worktree does not contain the untracked Studio files from `/Volumes/Projects/TheNexus`; this implementation must create tracked Studio files from the plan rather than relying on untracked main-checkout state.

## Target File Structure

- [ ] Create project folder:

  ```text
  /Volumes/Projects/Impossible Worlds Field Guide/
    project.json
    README.md
    sources/
    references/
    references/channel/
    references/episodes/
    episodes/
    prompts/
    reports/
  ```

- [ ] Add backend route and tests:

  ```text
  server/routes/studio.js
  server/__tests__/studio-route.test.js
  server/server.js
  ```

- [ ] Add dashboard client/pages:

  ```text
  dashboard/src/lib/studio.ts
  dashboard/src/app/studio/page.tsx
  dashboard/src/app/studio/idea/[id]/page.tsx
  dashboard/src/components/nav-sidebar.tsx
  ```

- [ ] Optional, if component size becomes hard to review:

  ```text
  dashboard/src/components/studio/channel-profile-editor.tsx
  dashboard/src/components/studio/object-catalog-panel.tsx
  dashboard/src/components/studio/reference-image-panel.tsx
  dashboard/src/components/studio/source-ingestion-panel.tsx
  ```

## Data Model

- [ ] In `server/routes/studio.js`, open the same SQLite database with:

  ```js
  const DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../../nexus.db');
  const sql = new Database(DB_PATH);
  sql.pragma('journal_mode = WAL');
  ```

- [ ] Add idempotent schema setup:

  ```sql
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
  ```

- [ ] Add guarded migrations for existing databases:

  ```js
  function ensureColumn(table, column, definition) {
    const hasColumn = sql.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
    if (!hasColumn) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  ensureColumn('studio_ideas', 'channel_id', "TEXT DEFAULT 'praxis-youtube'");
  ```

- [ ] Add indexes:

  ```sql
  CREATE INDEX IF NOT EXISTS idx_studio_ideas_channel_status ON studio_ideas(channel_id, status);
  CREATE INDEX IF NOT EXISTS idx_studio_sources_channel ON studio_sources(channel_id);
  CREATE INDEX IF NOT EXISTS idx_space_objects_channel_kind ON space_objects(channel_id, object_kind);
  CREATE INDEX IF NOT EXISTS idx_space_spec_values_object ON space_object_spec_values(object_id);
  CREATE INDEX IF NOT EXISTS idx_reference_images_channel_episode ON studio_reference_images(channel_id, episode_id);
  ```

## Seed Data

- [ ] Seed `studio_channels` idempotently with:

  - `praxis-youtube`
  - `impossible-worlds-field-guide`

- [ ] Praxis profile values:

  - `name`: `Praxis YouTube Channel`
  - `project_path`: `/Volumes/Projects/Praxis YouTube Channel`
  - `positioning`: `Robert teaches viewers how his personal AI operating system works and how to build minimal versions of its pieces.`
  - `editorial_promise`: `Concrete, build-along, honest about trade-offs, no hype.`
  - `host_style`: `Robert as builder/teacher; calm, direct, specific, transparent about what works and what breaks.`
  - `audience`: `Builders, AI-agent enthusiasts, indie hackers, technically curious viewers.`
  - `monetization_notes`: `Sponsorships, tool/repo products, consulting credibility, long-term audience trust.`

- [ ] Impossible Worlds profile values:

  - `name`: `Impossible Worlds Field Guide`
  - `project_path`: `/Volumes/Projects/Impossible Worlds Field Guide`
  - `positioning`: `I help curious people feel how strange the real and possible universe is by treating extreme and hypothetical worlds like a naturalist's field guide.`
  - `editorial_promise`: `Every scenario worked through with actual physics, no hype, and clear uncertainty labels.`
  - `host_style`: `Robert narrates and appears on camera; human awe is part of the channel voice.`
  - `audience`: `Curious science viewers, speculative worldbuilders, space and physics enthusiasts.`
  - `recurring_episode_format`: `Cold sensory hook, specimen card, physics walk-through, human observer experience, uncertainty ledger, field notes.`
  - `source_strategy`: `Start from trustworthy astronomy and physics sources, then extract objects, measurable specs, relationships, wonder notes, visual seeds, and episode hooks.`
  - `monetization_notes`: `Sponsorships, AdSense, science-inspired digital products, posters, prints, and worldbuilder PDFs.`

- [ ] Seed the 10 Impossible Worlds episode ideas exactly once by title and channel:

  1. `What it's actually like to stand on a rogue planet`
  2. `The real planet where it rains molten glass - sideways`
  3. `Could a planet orbit a black hole? What its sky would look like`
  4. `Diamond planets are real. Here's what's actually under the surface`
  5. `A day on a tidally-locked world: eternal noon vs. the frozen dark side`
  6. `What life could plausibly look like under two suns`
  7. `The biggest a planet can possibly get - and the physics that caps it`
  8. `Ocean worlds: what's at the bottom of a planet-wide sea?`
  9. `What if Earth had rings like Saturn?`
  10. `The stars that shouldn't exist (but do)`

- [ ] Seed source configs for Impossible Worlds:

  - Kurzgesagt YouTube channel
  - YouTube query: `what it's like on rogue planet`
  - YouTube query: `strangest planets`
  - YouTube query: `hot jupiter weather`
  - YouTube query: `tidally locked exoplanet habitability`
  - YouTube query: `ocean world pressure`
  - NASA slot
  - ESA slot
  - arXiv astro-ph slot
  - NASA Exoplanet Archive slot
  - user-provided URL slot

- [ ] Seed canonical `space_spec_definitions` idempotently. Include at least these keys:

  ```text
  classification.object_kind
  classification.subtype
  classification.formation_pathway
  classification.evolutionary_stage
  classification.reality_status
  discovery.discovery_date
  discovery.discovery_method
  discovery.catalog_ids
  discovery.distance_from_earth_ly
  discovery.observing_instrument
  location.constellation
  location.system
  location.host_star_or_object
  location.galactic_environment
  orbital.semi_major_axis_au
  orbital.eccentricity
  orbital.inclination_deg
  orbital.orbital_period_days
  orbital.rotation_period_hours
  orbital.obliquity_deg
  orbital.tidal_lock_status
  orbital.resonance
  bulk.mass_earth
  bulk.mass_jupiter
  bulk.radius_earth
  bulk.radius_jupiter
  bulk.density_g_cm3
  bulk.surface_gravity_g
  bulk.escape_velocity_km_s
  energy.stellar_flux_earth
  energy.luminosity_exposure
  energy.equilibrium_temperature_k
  energy.internal_heat
  energy.albedo
  atmosphere.pressure_bar
  atmosphere.composition
  atmosphere.scale_height_km
  atmosphere.clouds_hazes
  atmosphere.dominant_weather
  atmosphere.wind_speed_km_h
  atmosphere.precipitation_condensates
  surface.surface_state
  surface.dominant_materials
  surface.ocean_depth_km
  surface.ice_thickness_km
  surface.mantle_core_notes
  surface.geology
  surface.volcanism
  magnetic.magnetosphere
  magnetic.radiation_environment
  magnetic.stellar_activity_exposure
  magnetic.aurora_potential
  habitability.liquid_water_plausibility
  habitability.chemistry
  habitability.energy_gradients
  habitability.stability_window
  habitability.blockers
  observation.evidence_type
  observation.uncertainty
  observation.source_reliability
  observation.disputed_claims
  human_experience.sky_appearance
  human_experience.horizon_lighting
  human_experience.sound_air_implications
  human_experience.movement_difficulty
  human_experience.immediate_hazards
  human_experience.survival_impossibilities
  ```

## Backend API Tasks

- [ ] Write `server/__tests__/studio-route.test.js` before product code. Use an isolated temp `NEXUS_DB_PATH`, mount the router in an Express app, and stub `callAI`.

- [ ] Tests to write first:

  - `GET /api/studio/channels` returns both seeded channels.
  - `PATCH /api/studio/channels/impossible-worlds-field-guide` saves editable profile fields.
  - `GET /api/studio?channelId=impossible-worlds-field-guide` returns only Impossible Worlds ideas.
  - `GET /api/studio` defaults to Praxis.
  - `POST /api/studio/impossible-worlds-field-guide/seed` creates 10 ideas and is idempotent.
  - `GET /api/studio/impossible-worlds-field-guide/sources` returns seeded sources.
  - `POST /api/studio/impossible-worlds-field-guide/ingestion/run` creates a local-only run with queued item metadata and never calls a cloud provider.
  - `GET /api/studio/impossible-worlds-field-guide/objects` returns seeded/created objects with spec summaries.
  - `POST /api/studio/impossible-worlds-field-guide/reference-images` stores prompt/image metadata scoped to channel.
  - `GET /api/studio/impossible-worlds-field-guide/prompt?type=write_script&ideaId=...` includes the selected channel profile, not hardcoded Praxis copy.

- [ ] Implement route helpers in `server/routes/studio.js`:

  ```js
  const DEFAULT_CHANNEL_ID = 'praxis-youtube';
  const IMPOSSIBLE_WORLDS_CHANNEL_ID = 'impossible-worlds-field-guide';
  const STAGES = ['suggested', 'approved', 'scripted', 'thumbnail', 'ready', 'published'];
  const ALL_STATUSES = [...STAGES, 'archived'];

  function getChannelId(req) {
    return String(req.params.channelId || req.query.channelId || DEFAULT_CHANNEL_ID);
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
  ```

- [ ] Implement channel endpoints:

  ```text
  GET /api/studio/channels
  GET /api/studio/channels/:channelId
  PATCH /api/studio/channels/:channelId
  ```

  Editable fields: `name`, `project_path`, `positioning`, `editorial_promise`, `audience`, `host_style`, `visual_style_notes`, `recurring_episode_format`, `source_strategy`, `monetization_notes`, `risks_and_mitigations`, `default_cadence_target`, `prompt_guardrails`.

- [ ] Implement board endpoints:

  ```text
  GET /api/studio?channelId=...
  GET /api/studio/ideas/:id
  POST /api/studio/:channelId/ideas
  PATCH /api/studio/ideas/:id
  POST /api/studio/ideas/:id/advance
  DELETE /api/studio/ideas/:id
  POST /api/studio/:channelId/settings
  POST /api/studio/:channelId/seed
  ```

  Compatibility rule: existing unscoped idea routes keep working; create/generate/seed routes should prefer channel-scoped versions but fall back to `praxis-youtube`.

- [ ] Implement source endpoints:

  ```text
  GET /api/studio/:channelId/sources
  POST /api/studio/:channelId/sources
  PATCH /api/studio/:channelId/sources/:sourceId
  ```

- [ ] Implement ingestion run endpoint:

  ```text
  POST /api/studio/:channelId/ingestion/run
  ```

  V1 behavior:

  - create a `studio_ingestion_runs` row with `status = 'queued'`
  - discover from enabled source config as source item placeholders, not network-heavy crawling yet
  - create `studio_source_items` rows with `ingestion_status = 'queued'`
  - return run digest and `items_enqueued`
  - include a `localOnly: true` response flag
  - do not call `callAI` with a cloud provider from this route

- [ ] Implement object catalog endpoints:

  ```text
  GET /api/studio/:channelId/objects
  POST /api/studio/:channelId/objects
  GET /api/studio/:channelId/objects/:id
  PATCH /api/studio/:channelId/objects/:id
  POST /api/studio/:channelId/objects/:id/spec-values
  POST /api/studio/:channelId/objects/:id/wonder-points
  POST /api/studio/ideas/:id/objects
  DELETE /api/studio/ideas/:id/objects/:objectId
  ```

- [ ] Implement reference image endpoints:

  ```text
  GET /api/studio/:channelId/reference-images
  POST /api/studio/:channelId/reference-images
  PATCH /api/studio/:channelId/reference-images/:imageId
  DELETE /api/studio/:channelId/reference-images/:imageId
  ```

  V1 stores uploaded/imported file path or URL and prompt metadata. It does not need to generate images directly.

- [ ] Implement prompt/generation jobs with channel profile context:

  ```text
  suggest_topics
  write_script
  physics_rigor_pass
  thumbnail_concepts
  image_prompts
  publish_kit
  source_citation_pack
  ```

  Impossible Worlds jobs must include field-guide format, uncertainty labels, object-catalog grounding, actual-physics framing, and Robert's on-camera/awe-host style.

- [ ] Preserve LLM Activity ledger behavior from the reference Studio route for creative generation jobs. Record caller as `nexus.studio`.

- [ ] Mount route in `server/server.js`:

  ```js
  const createStudioRouter = require('./routes/studio');
  app.use('/api/studio', createStudioRouter({ db, callAI }));
  ```

- [ ] Backend verification after route work:

  ```bash
  npm test -- --runInBand server/__tests__/studio-route.test.js
  npm test -- --runInBand
  ```

  Expected output: all Studio route tests pass, then all existing Jest suites still pass.

- [ ] Commit:

  ```bash
  git add server/routes/studio.js server/server.js server/__tests__/studio-route.test.js
  git commit -m "feat: add multi-channel studio backend"
  ```

## Project Folder Tasks

- [ ] Create `/Volumes/Projects/Impossible Worlds Field Guide` after backend seeds exist.

- [ ] Add `project.json`:

  ```json
  {
    "name": "Impossible Worlds Field Guide",
    "type": "content",
    "description": "A rigorous field-guide YouTube channel for extreme real and possible worlds.",
    "status": "active",
    "studioChannelId": "impossible-worlds-field-guide",
    "urls": {
      "nexusStudio": "http://localhost:3000/studio?channelId=impossible-worlds-field-guide"
    }
  }
  ```

- [ ] Add `README.md` with positioning, editorial promise, first 10 video runway, source strategy, and folder conventions.

- [ ] Run project scanner through the existing API or restart server and confirm the project appears in The Nexus project list.

- [ ] Record folder creation in the final implementation summary. The folder is intentionally outside the The Nexus git repository, so do not try to `git add` it from the Nexus worktree.

## Dashboard Client Tasks

- [ ] Write `dashboard/src/lib/studio.ts` with typed API helpers:

  ```ts
  export const STAGES = [
    ['suggested', 'Suggested'],
    ['approved', 'Approved'],
    ['scripted', 'Scripted'],
    ['thumbnail', 'Thumbnail'],
    ['ready', 'Ready to film'],
    ['published', 'Published'],
  ] as const;

  export type StudioStatus = 'suggested' | 'approved' | 'scripted' | 'thumbnail' | 'ready' | 'published' | 'archived';
  export interface StudioChannel { id: string; name: string; project_path?: string; positioning?: string; editorial_promise?: string; audience?: string; host_style?: string; visual_style_notes?: string; recurring_episode_format?: string; source_strategy?: string; monetization_notes?: string; risks_and_mitigations?: string; default_cadence_target?: number; prompt_guardrails?: string; }
  export interface Idea { id: string; channel_id: string; source: string; title: string; angle?: string; build_promise?: string; category?: string; status: StudioStatus; script?: string | null; script_model?: string | null; thumbnail_concepts?: ThumbnailConcept[] | null; image_prompts?: ImagePrompt[] | null; checklist?: ChecklistItem[] | null; publish_kit?: PublishKit | null; youtube_id?: string | null; created_at?: string; updated_at?: string; }
  export interface StudioSource { id: string; channel_id: string; name: string; source_type: string; url?: string; query_template?: string; enabled: boolean; per_run_cap: number; relevance_floor: number; notes?: string; }
  export interface SpaceObject { id: string; channel_id: string; name: string; object_kind?: string; subtype?: string; reality_status?: string; field_guide_summary?: string; sensory_impression?: string; points_of_wonder_summary?: string; spec_values?: SpaceSpecValue[]; wonder_points?: WonderPoint[]; }
  export interface ReferenceImage { id: string; channel_id: string; episode_id?: string | null; object_id?: string | null; file_path_or_url: string; prompt?: string; negative_prompt?: string; model?: string; aspect_ratio?: string; intended_use?: string; tags?: string; notes?: string; }
  export interface BoardState { channel: StudioChannel; channels: StudioChannel[]; ideas: Idea[]; targetReady: number; sources: StudioSource[]; objects: SpaceObject[]; referenceImages: ReferenceImage[]; promptable: string[]; }
  ```

- [ ] Add helpers:

  ```ts
  getChannels()
  getChannel(channelId)
  updateChannel(channelId, body)
  getBoard(channelId)
  getIdea(id)
  createIdea(channelId, body)
  updateIdea(id, body)
  advanceIdea(id)
  archiveIdea(id)
  setTargetReady(channelId, targetReady)
  seedSeries(channelId, force)
  generate(channelId, type, opts)
  getPrompt(channelId, type, ideaId)
  applyPaste(channelId, type, text, ideaId)
  getSources(channelId)
  createSource(channelId, body)
  updateSource(channelId, sourceId, body)
  runIngestion(channelId)
  getObjects(channelId)
  createObject(channelId, body)
  updateObject(channelId, objectId, body)
  getReferenceImages(channelId, filters)
  createReferenceImage(channelId, body)
  updateReferenceImage(channelId, imageId, body)
  deleteReferenceImage(channelId, imageId)
  ```

## Dashboard UI Tasks

- [ ] Add Studio to `dashboard/src/components/nav-sidebar.tsx`:

  ```tsx
  import { Clapperboard } from "lucide-react";
  { href: "/studio", label: "Studio", icon: Clapperboard, color: "text-violet-400 hover:text-violet-300" }
  ```

- [ ] Create `/studio` page:

  - channel selector in the sticky header
  - editable channel profile panel visible for every channel
  - cadence banner using channel `default_cadence_target`
  - quick actions row
  - source ingestion panel
  - object catalog summary/table
  - reference image library summary
  - six-stage board
  - manual episode add form

- [ ] Profile editor UI fields:

  ```text
  name
  project_path
  positioning
  editorial_promise
  audience
  host_style
  visual_style_notes
  recurring_episode_format
  source_strategy
  monetization_notes
  risks_and_mitigations
  default_cadence_target
  prompt_guardrails
  ```

  Use normal inputs/textareas. Do not expose raw JSON to the user.

- [ ] Channel switching behavior:

  - read initial channel from `?channelId=...`
  - default to `praxis-youtube`
  - update URL with `router.replace('/studio?channelId=' + selectedId)`
  - reload board data after switch
  - make idea cards link to `/studio/idea/${idea.id}?channelId=${channel.id}`

- [ ] Add Impossible Worlds-specific panels when selected:

  - source configs with enable toggle, cap, relevance floor, and notes
  - ingestion run button labeled local-only
  - object catalog table with filters for object kind and reality status
  - reference image form with URL/path, prompt, negative prompt, model, aspect ratio, intended use, tags, notes

- [ ] Create `/studio/idea/[id]` page:

  - preserve reference Studio functionality: save, advance, archive, local/cloud/prompt generation, checklist, thumbnail concepts, image prompts, publish kit
  - add channel breadcrumb and return link with `channelId`
  - add field-guide controls/notes for Impossible Worlds by using existing `angle`, `build_promise`, `category`, `script`, and checklist fields in v1
  - show attached object records and allow attach/detach from catalog
  - show reference images attached to the episode and allow adding image prompt metadata
  - include generation actions for `physics_rigor_pass` and `source_citation_pack`

- [ ] UI design constraints:

  - keep the Studio utilitarian, dense, and scan-friendly
  - use icons in action buttons from `lucide-react`
  - do not use explanatory marketing text inside the app
  - keep cards only for repeated items/panels; avoid nested cards
  - ensure mobile wrapping for profile fields, board columns, and image prompt rows

- [ ] Dashboard verification:

  ```bash
  cd dashboard
  npm run build
  ```

  Expected output: production build completes. If it fails due pre-existing dependency mismatch, record exact failure and still run targeted TypeScript/source review.

- [ ] Commit:

  ```bash
  git add dashboard/src/lib/studio.ts dashboard/src/app/studio dashboard/src/components/nav-sidebar.tsx
  git commit -m "feat: add multi-channel studio dashboard"
  ```

## Local Ingestion Follow-Through

- [ ] Keep v1 ingestion local-only and lightweight:

  - source config and run records live in Nexus SQLite
  - generated run manifests create local source item placeholders
  - local item processing schema is represented in code and tests
  - no cloud model call is made by ingestion run routes

- [ ] Add a parser helper in `server/routes/studio.js` or a small module if the route grows too large:

  ```js
  function normalizeSpaceExtraction(raw) {
    return {
      objects: Array.isArray(raw.objects) ? raw.objects : [],
      relationships: Array.isArray(raw.relationships) ? raw.relationships : [],
      wonderPoints: Array.isArray(raw.wonder_points) ? raw.wonder_points : [],
      episodeHooks: Array.isArray(raw.episode_hooks) ? raw.episode_hooks : [],
      uncertainties: Array.isArray(raw.uncertainties) ? raw.uncertainties : [],
    };
  }
  ```

- [ ] Add tests for the extraction parser and catalog upsert:

  - known spec values
  - estimated ranges
  - unknown
  - not_applicable
  - disputed

- [ ] Defer real network crawling or YouTube transcript fetching unless already available through existing stable code. The UI and storage contracts should be ready for those jobs, but v1 can create run/source item records first.

## End-to-End Verification

- [ ] Run server tests:

  ```bash
  npm test -- --runInBand
  ```

- [ ] Start backend:

  ```bash
  PORT=4001 NEXUS_DB_PATH=/Volumes/Projects/TheNexus/.worktrees/impossible-worlds-studio/nexus.db npm start
  ```

- [ ] Start dashboard:

  ```bash
  cd dashboard
  NEXT_PUBLIC_API_URL=http://localhost:4001 npm run dev -- -p 3001
  ```

- [ ] Open with Browser:

  ```text
  http://localhost:3001/studio?channelId=impossible-worlds-field-guide
  ```

- [ ] Manual checks:

  - `/studio` loads.
  - Channel selector shows Praxis and Impossible Worlds.
  - Both channel profiles are visible and editable.
  - Saving Impossible Worlds profile persists after refresh.
  - Switching to Praxis does not show Impossible Worlds ideas.
  - Impossible Worlds board shows 10 seeded episodes.
  - Source config panel shows Kurzgesagt and physics/space source slots.
  - Ingestion run button creates a local-only queued run.
  - Object catalog panel renders canonical spec/wonder fields.
  - Reference image form stores prompt/image metadata.
  - Episode detail opens, saves, and returns to the selected channel.
  - Prompt mode for an Impossible Worlds script includes field-guide/object-catalog instructions.

- [ ] Browser screenshot/pass notes should be captured in the final response with the local URLs tested.

## Final Commit And Handoff

- [ ] Review changed files:

  ```bash
  git status --short
  git diff --stat
  git diff --check
  ```

- [ ] Run final verification:

  ```bash
  npm test -- --runInBand
  cd dashboard && npm run build
  ```

- [ ] If `dashboard npm run build` fails for dependency/runtime reasons, capture exact output and explain what did and did not verify.

- [ ] Final implementation commit, if needed:

  ```bash
  git add .
  git commit -m "feat: create impossible worlds studio"
  ```

- [ ] Final response should include:

  - what changed
  - project folder path
  - tested commands and outcomes
  - local URL to try
  - any verification gaps
