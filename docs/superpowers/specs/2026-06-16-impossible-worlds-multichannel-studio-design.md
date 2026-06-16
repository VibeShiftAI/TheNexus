# Impossible Worlds Multi-Channel Studio Design

## Purpose

Create a new content project, **Impossible Worlds Field Guide**, inside The Nexus Studio. The project is a YouTube channel concept:

> I help curious people feel how strange the real and possible universe is, by treating extreme and hypothetical worlds like a naturalist's field guide - every scenario worked through with actual physics, no hype.

The first implementation should turn The Nexus Studio from a Praxis-only production board into a reusable multi-channel Studio. Impossible Worlds gets its own isolated channel profile, episode pipeline, source ingestion configuration, local object catalog, reference image library, prompts, and seeded first 10 videos. Praxis also receives an editable channel profile so the new system can distinguish channel voice, audience, source strategy, and production goals without hardcoded assumptions.

## Context Reviewed

- The local TheGayGuyde.com Studio implementation has the fuller production pattern: cadence health, six-stage kanban, nightly/local job queue, signal gathering, topic suggestions, voice/script generation, thumbnail concepts, thumbnail image rendering, publish kits, stats snapshots, prompt mode, and final thumbnail storage.
- The live thegayguyde.com domain currently serves a Squarespace "Coming Soon" page, so the local app is the authoritative Studio reference.
- The current The Nexus Studio already mirrors part of that pattern but is hardcoded around the Praxis YouTube channel and project-source ideas.
- Praxis has the relevant overnight knowledge ingestion architecture: source discovery, deduplication, run manifests, local queue jobs, per-item local LLM reading, fact/entity/relation extraction, finalization, and run digests.

## Design Decisions

1. Build a **multi-channel Studio** inside The Nexus rather than a separate app.
2. Store active Studio state in The Nexus `nexus.db`, scoped by `channel_id`.
3. Create `/Volumes/Projects/Impossible Worlds Field Guide` as the project identity and durable content home.
4. Treat sources as inputs to a **field-guide object catalog**, not just as one-off links for episodes.
5. Start the object catalog in SQLite with graph-ready relationships. Do not require Neo4j for v1.
6. Run the Impossible Worlds ingestion/extraction pipeline entirely local on this machine. No Gemini/Claude tier-up for ingestion. Long items should be chunked and processed locally instead.
7. Preserve the existing Studio generation modes for creative production jobs where appropriate: local, cloud, and prompt mode. The local-only constraint applies to the ingestion/object extraction pipeline.

## Non-Goals

- Do not build a standalone Impossible Worlds web app in v1.
- Do not migrate all Studio data to Neo4j in v1.
- Do not upload generated videos to YouTube automatically.
- Do not claim original science or fabricate measurements. Unknown, estimated, disputed, and not-applicable states must be explicit.
- Do not copy source scripts or visual language from reference channels. Sources inform facts, structure, and research trails.

## Project Folder

Create:

```text
/Volumes/Projects/Impossible Worlds Field Guide/
  project.json
  README.md
  sources/
  references/
  episodes/
  prompts/
  reports/
```

`project.json` should allow The Nexus scanner to discover it as a `content` project. The folder stores durable project-facing artifacts and exported assets. The Nexus database stores the live production system.

## Channel Profiles

Seed `studio_channels` with:

- `id`: `impossible-worlds-field-guide`
- `name`: `Impossible Worlds Field Guide`
- `project_path`: `/Volumes/Projects/Impossible Worlds Field Guide`
- `type`: `youtube`
- `positioning`: rigorous field-guide treatment of real and possible worlds
- `editorial_promise`: actual physics, no hype, clear uncertainty labels
- `host_style`: Robert narrates and appears on camera; human awe is part of the channel voice
- `audience`: curious science viewers, speculative worldbuilders, space/physics enthusiasts
- `monetization`: sponsorships, AdSense, science-inspired digital products and prints

The channel profile should drive generation prompts, seed content, source defaults, and UI copy.

Also seed `praxis-youtube` with an editable profile that captures the current Praxis Studio assumptions:

- `id`: `praxis-youtube`
- `name`: `Praxis YouTube Channel`
- `project_path`: `/Volumes/Projects/Praxis YouTube Channel`
- `type`: `youtube`
- `positioning`: Robert teaches viewers how his personal AI operating system works and how to build minimal versions of its pieces.
- `editorial_promise`: concrete, build-along, honest about trade-offs, no hype.
- `host_style`: Robert as builder/teacher; calm, direct, specific, transparent about what works and what breaks.
- `audience`: builders, AI-agent enthusiasts, indie hackers, technically curious viewers.
- `monetization`: sponsorships, tool/repo products, consulting credibility, long-term audience trust.

Channel profiles should drive generation prompts, seed content, source defaults, UI copy, and channel-specific job behavior. Hardcoded Praxis channel prompt text should be replaced with profile-driven prompt assembly as part of the migration.

### Editable Profile Fields

The profile editor should expose the fields that materially change generation and planning:

- name
- project path
- positioning
- editorial promise
- audience
- host style / narrator voice
- visual style notes
- recurring episode format
- source strategy
- monetization notes
- risks and mitigations
- default cadence target
- prompt guardrails

These fields can be stored as columns plus JSON metadata where appropriate, but the UI should present them as normal editable fields, not raw JSON.

## Studio UI

### Channel-Level Studio

`/studio` gains a channel selector. Selecting Impossible Worlds changes the whole board to that channel's state:

- editable channel profile panel
- cadence banner
- six-stage episode board: suggested, approved, scripted, thumbnail, ready, published
- quick jobs
- source ingestion panel
- object catalog summary
- reference image library summary
- recent jobs/run digest
- manual episode add

The channel profile panel should be visible from the main Studio view for every channel. It can be collapsed by default once populated, but it must be easy to open, edit, save, and see which profile is currently driving prompts.

Quick jobs for Impossible Worlds:

- scan sources
- ingest source candidates
- suggest episodes from object catalog
- write script
- physics rigor pass
- thumbnail concepts
- image prompt pack
- publish kit
- source/citation pack

### Episode Detail

Each episode detail page contains:

- title, status, category, angle, promise
- field-guide structure controls
- script editor
- physics assumptions and uncertainty notes
- source notes and attached object records
- rigor pass output
- thumbnail concepts
- image prompt pack
- attached reference images
- final thumbnail upload
- publish kit
- checklist

The existing teleprompter pattern can be wired later if the episode has a finished script.

## First 10 Seed Episodes

Seed the first 10 Impossible Worlds ideas:

1. What it's actually like to stand on a rogue planet
2. The real planet where it rains molten glass - sideways
3. Could a planet orbit a black hole? What its sky would look like
4. Diamond planets are real. Here's what's actually under the surface
5. A day on a tidally-locked world: eternal noon vs. the frozen dark side
6. What life could plausibly look like under two suns
7. The biggest a planet can possibly get - and the physics that caps it
8. Ocean worlds: what's at the bottom of a planet-wide sea?
9. What if Earth had rings like Saturn?
10. The stars that shouldn't exist (but do)

Each seed should include angle, field-guide promise, suggested object records to research, and a production checklist.

## Field-Guide Object Catalog

Sources should build a reusable catalog of space objects and phenomena. Episodes then draw from that catalog.

### Core Tables

`space_objects`

- `id`
- `channel_id`
- `name`
- `aliases`
- `object_kind`
- `subtype`
- `reality_status`: `observed`, `candidate`, `theoretical`, `fictional_physics_sandbox`
- `description`
- `field_guide_summary`
- `sensory_impression`
- `points_of_wonder_summary`
- `visual_motifs`
- `human_observer_shock`
- `worldbuilding_relevance`
- `created_at`
- `updated_at`

`space_spec_definitions`

- `key`
- `category`
- `label`
- `unit`
- `value_type`
- `applies_to_kinds`
- `collection_guidance`
- `sort_order`

`space_object_spec_values`

- `id`
- `object_id`
- `spec_key`
- `value_text`
- `value_number`
- `value_min`
- `value_max`
- `unit`
- `status`: `known`, `estimated`, `unknown`, `not_applicable`, `disputed`
- `confidence`: `low`, `medium`, `high`
- `source_item_id`
- `notes`
- `created_at`
- `updated_at`

`space_object_relationships`

- `id`
- `channel_id`
- `from_object_id`
- `to_object_id`
- `relationship_type`
- `description`
- `confidence`
- `source_item_id`

`points_of_wonder`

- `id`
- `object_id`
- `wonder_type`: `sensory`, `scale`, `danger`, `beauty`, `paradox`, `life_possibility`, `worldbuilding`
- `note`
- `episode_hook_potential`
- `visual_prompt_seed`
- `source_item_id`
- `confidence`

`studio_source_items`

- discovered pages/videos/articles/transcripts
- title, url, source type, source name, published date
- content hash
- raw content path or text excerpt
- ingestion status
- run id

`studio_ingestion_runs`

- `id`
- `channel_id`
- `trigger`
- `status`
- `discovered_count`
- `deduped_count`
- `items_enqueued`
- `items_succeeded`
- `items_failed`
- `digest`
- `created_at`
- `updated_at`

`studio_episode_objects`

- `episode_id`
- `object_id`
- `role`: `main_subject`, `comparison`, `analogy`, `constraint`, `visual_reference`
- notes

### Canonical Spec Categories

Seed `space_spec_definitions` with enough detail that every object uses the same specimen sheet:

- Classification: object kind, subtype, formation pathway, evolutionary stage, reality status
- Discovery: discovery date, discovery method, catalog ids, distance from Earth, observing instrument
- Location: constellation, system, host star/object, galactic environment
- Orbital: semi-major axis, eccentricity, inclination, orbital period, rotation period, obliquity, tidal lock status, resonance
- Bulk: mass, radius, density, surface gravity, escape velocity
- Energy: stellar flux, luminosity exposure, equilibrium temperature, internal heat, albedo
- Atmosphere: pressure, composition, scale height, clouds/hazes, dominant weather, wind speed, precipitation/condensates
- Surface and Interior: surface state, dominant materials, ocean depth, ice thickness, mantle/core notes, geology, cryovolcanism/volcanism
- Magnetic and Radiation: magnetosphere, radiation environment, stellar activity exposure, aurora potential
- Habitability: liquid water plausibility, chemistry, energy gradients, stability window, likely habitability blockers
- Observation Quality: confirmed/candidate, evidence type, uncertainty, source reliability, disputed claims
- Human Experience: sky appearance, horizon/lighting, sound/air implications, movement difficulty, immediate hazards, survival impossibilities

Unknown and not-applicable values are useful and should be stored. They help the script generator reason honestly.

## Local Ingestion Pipeline

The Impossible Worlds source engine should follow the Praxis knowledge intake pattern:

1. Load channel sources and ingestion config.
2. Discover source items by type.
3. Deduplicate by content hash and URL.
4. Create a run manifest.
5. Enqueue one local job per item, such as `studio_ingest_space_item`.
6. Local LLM reads the item and extracts:
   - candidate objects
   - canonical spec values
   - claims
   - relationships
   - points of wonder
   - episode hooks
   - visual prompt seeds
   - uncertainties and disputed points
7. Finalizer applies outputs to the object catalog and writes a digest.

The local reader prompt should be a channel-specific variant of Praxis `local-reader.ts`, but its output schema should be a space-object extraction schema rather than the generic factoid schema.

Long items should be chunked locally. The pipeline must not tier up to cloud LLMs for ingestion.

## Source Defaults

Initial source configuration should include:

- Kurzgesagt YouTube channel as a reference/research source
- YouTube search query templates:
  - `what it's like on rogue planet`
  - `strangest planets`
  - `hot jupiter weather`
  - `tidally locked exoplanet habitability`
  - `ocean world pressure`
- Web/academic source slots for NASA, ESA, arXiv/astro-ph, exoplanet archives, and user-provided URLs
- Editable ingestion config for source enablement, per-source caps, and web search relevance floor

The UI should clearly distinguish source candidates from accepted catalog facts.

## Reference Image Library

Add channel-level and episode-level reference images.

`studio_reference_images`

- `id`
- `channel_id`
- `episode_id` nullable
- `object_id` nullable
- `file_path_or_url`
- `prompt`
- `negative_prompt`
- `model`
- `aspect_ratio`
- `intended_use`: `thumbnail`, `surface_reference`, `sky_reference`, `diagram_reference`, `b_roll`, `style_reference`
- `tags`
- `notes`
- `created_at`

V1 should support upload/import and prompt storage. Direct image generation can be added after storage and attachment workflows are reliable.

## Prompts

Impossible Worlds prompts should enforce:

- field-guide format
- physics-first reasoning
- clear assumptions
- no hype
- no claims without uncertainty labels
- vivid sensory writing
- Robert on camera as a human awe anchor
- object-catalog grounding

Key prompt outputs:

- episode idea suggestions from object catalog gaps and source trends
- script
- physics rigor pass
- source/citation pack
- thumbnail concepts
- image prompt pack
- publish kit

## API Shape

Keep the current `/api/studio` surface, but scope it by channel:

- `GET /api/studio/channels`
- `GET /api/studio/channels/:channelId`
- `PATCH /api/studio/channels/:channelId`
- `GET /api/studio?channelId=...`
- `GET /api/studio/ideas/:id`
- `POST /api/studio/:channelId/ideas`
- `POST /api/studio/:channelId/generate`
- `GET /api/studio/:channelId/prompt`
- `POST /api/studio/:channelId/apply`
- `GET/POST/PATCH /api/studio/:channelId/sources`
- `POST /api/studio/:channelId/ingestion/run`
- `GET /api/studio/:channelId/objects`
- `GET/PATCH /api/studio/:channelId/objects/:id`
- `GET/POST /api/studio/:channelId/reference-images`

Existing Praxis endpoints should keep working through default channel fallback.

## Migration

- Create `studio_channels`.
- Insert `praxis-youtube` as the default channel.
- Seed an editable Praxis channel profile from the current hardcoded Nexus Studio prompt assumptions.
- Add `channel_id` to existing `studio_ideas` for v1 and default existing rows to `praxis-youtube`.
- Insert `impossible-worlds-field-guide`.
- Seed Impossible Worlds ideas, source definitions, spec definitions, and reference-image folders.

Prefer additive migrations and compatibility code over destructive rewrites.

## Testing

Focused tests:

- channel list includes Praxis and Impossible Worlds
- channel profile editor reads and saves Praxis and Impossible Worlds profiles
- prompt builders use the selected channel profile instead of hardcoded Praxis assumptions
- existing Praxis ideas do not appear in Impossible Worlds
- Impossible Worlds seed creates the first 10 episodes once
- source config CRUD is channel scoped
- object spec definitions are seeded idempotently
- source ingestion enqueues local-only jobs
- local reader parser accepts the space-object extraction schema
- object catalog upsert handles known, unknown, estimated, disputed, and not-applicable spec states
- reference image CRUD and episode attachment are channel scoped
- prompt builder includes object catalog context for Impossible Worlds

Manual/browser verification:

- `/studio` loads with a channel selector
- channel profile is visible and editable for Praxis and Impossible Worlds
- switching channels changes the board without data leakage
- Impossible Worlds shows source/object/reference panels
- episode detail can attach object records and reference images

## Risks

- The object catalog may become too large for one screen. Mitigation: add filtering by object kind, reality status, and episode attachment.
- LLM extraction may invent facts. Mitigation: every spec value carries status, confidence, notes, and source link; disputed/estimated/unknown are first-class states.
- Local-only ingestion may be slow. Mitigation: queue overnight, chunk long items, and surface run digests.
- Neo4j may eventually become desirable. Mitigation: keep `space_object_relationships` graph-ready so a later projection can be built without changing Studio UX.

## Implementation Constraints

- Use additive schema changes in v1: `channel_id` on current Studio ideas, plus new tables for channels, sources, ingestion runs, object catalog records, relationships, wonder points, and reference images.
- Preserve default-channel fallback so existing Praxis Studio URLs keep working.
- Do not include `.superpowers/brainstorm` visual companion artifacts in implementation commits unless a future task explicitly asks to track them.
