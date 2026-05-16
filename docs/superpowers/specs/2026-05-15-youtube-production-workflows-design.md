# YouTube Production Workflows Design

## Goal

Add reusable LangGraph workflows to The Nexus for producing YouTube videos with a local-first LLM workflow, structured human review gates, and controlled escalation to premium SOTA providers such as Veo. The first usable path should support the existing Praxis self-narrated channel, but the architecture should not be hardcoded to Praxis.

The system should turn a topic or Nexus task into a reviewed concept, script, scene plan, generated assets, assembled video, compliance report, and private upload or local export. The workflow must prioritize low-cost local reasoning and dry-run testing before paid media generation.

## Current Starting Point

The Nexus already has useful pieces:

- `nexus-builder/youtube_channel_workflow.py`: an end-to-end Praxis-focused LangGraph scaffold with concept, script, final, and cadence gates.
- `nexus-builder/tools/media/`: media adapters for TTS, still generation, Veo animation, ffmpeg assembly, YouTube upload, credentials, episode persistence, and cost logging.
- `config/model_registry.yaml` and `cortex/llm_factory.py`: local-first model routing through an OpenAI-compatible endpoint.
- `server/routes/langgraph.js` and `server/services/langgraph-supervisor.js`: existing Node-to-Python LangGraph proxy and dashboard workflow integration.

The design should extend these pieces rather than creating a second orchestration system.

## Architecture

Create a reusable `youtube_workflows` package inside `nexus-builder/`.

Proposed files:

- `youtube_workflows/state.py`: Typed LangGraph state, reducers, pointer-only media references, approval state, cost state, and compliance state.
- `youtube_workflows/models.py`: Pydantic schemas for channel profiles, concepts, scenes, scripts, production plans, provider decisions, cost estimates, and compliance reports.
- `youtube_workflows/llm.py`: local-first LLM helpers using the existing Cortex `LLMFactory`.
- `youtube_workflows/provider_router.py`: provider selection and escalation rules for stills, clips, TTS, and SOTA video calls.
- `youtube_workflows/profiles.py`: reusable default profile plus a Praxis profile that preserves the current channel behavior.
- `youtube_workflows/graph.py`: the reusable LangGraph graph.
- `youtube_workflows/api.py`: FastAPI helpers for starting, resuming, and inspecting YouTube workflow runs when the generic graph engine is not enough.

The existing `youtube_channel_workflow.py` should remain during migration. Once the reusable graph reaches parity, it can become a thin compatibility wrapper around the Praxis profile.

## Workflow Shape

The reusable graph should run:

`intake -> load_channel_profile -> research -> draft_concept -> concept_gate -> write_script -> script_gate -> production_plan -> cost_gate -> fanout_assets -> reduce_assets -> assemble_video -> compliance_review -> final_gate -> upload_or_export`

The graph has four mandatory human-in-the-loop gates:

- Concept gate: approve the idea, audience, angle, and expected value.
- Script gate: approve narrative, voice, and scene list before production planning.
- Cost gate: approve paid provider calls before Veo or other external media APIs run.
- Final gate: approve the compiled asset before private upload or export.

The graph may add a cadence gate for channel-managed workflows, but cadence should be profile-driven rather than a core requirement.

## State Design

LangGraph state must store structured metadata and file paths only. It must not store raw media bytes, base64 image/video payloads, or large transcript blobs.

Core state fields:

- `input`: original prompt, project/task IDs, desired duration, target channel profile ID.
- `channel_profile`: voice, tone, style rules, publishing policy, disclosure policy, and default providers.
- `research_brief`: summarized sources and facts, with source paths or URLs.
- `concept`: logline, audience, promise, retention hook, outline, risk notes.
- `script`: scene-by-scene structured script.
- `production_plan`: per-scene media requirements, provider choices, and render prompts.
- `assets`: append-only asset manifest of audio, stills, clips, captions, thumbnails, and assembled outputs.
- `cost`: estimated, approved, and actual costs by provider/model.
- `compliance`: disclosure flags, reused-content risks, static-slideshow risk, cadence risk, and required human notes.
- `pending_approval`: current gate payload.
- `review_decision`, `review_notes`, `revision_target`: review inputs injected on resume.

Reducers should append assets, warnings, and cost entries safely when parallel workers return. Single-writer fields such as `concept`, `script`, and `production_plan` can be replaced by revision nodes.

## Local-First Cognition

The workflow should use local LLM roles by default:

- `youtube_router`: classify request type, channel profile, and escalation needs.
- `youtube_researcher`: summarize local context, transcripts, and user-provided material.
- `youtube_strategist`: draft concept and retention structure.
- `youtube_scriptwriter`: write the structured scene script.
- `youtube_producer`: convert script scenes into production prompts.
- `youtube_compliance`: inspect script, plan, metadata, and final publish payload.

These roles should be added to `config/model_registry.yaml` and routed to `local-default` initially.

Cloud/SOTA models should be explicit escalation options. A node can request escalation when:

- The user asks for it.
- The scene is marked `requires_sota`.
- Local output fails schema validation after bounded retries.
- Compliance review detects ambiguity that needs stronger reasoning.
- The approved provider policy allows premium model use and the cost gate approves it.

Historical thinking or chain-of-thought style blocks from local models should be stripped before state persistence or prompt reuse. The graph should keep compact artifacts, not rolling raw conversations.

## Provider Routing

The provider router should return a structured decision for each scene:

- `provider`: local placeholder, existing adapter, Veo, or future provider.
- `reason`: short reason suitable for logs and review UI.
- `estimated_cost_usd`: estimate before execution.
- `requires_cost_approval`: true for paid or premium providers.
- `fallback_provider`: low-cost fallback for failure or rejection.

Default behavior:

- Use dry-run placeholders unless `dry_run=false`.
- Use local or low-cost adapters for routine scenes.
- Reserve Veo for approved cinematic or high-impact scenes.
- Fail closed when a provider key is missing, a cost ceiling is exceeded, or the cost gate has not approved paid calls.

The existing `tools/media/veo.py` adapter should be updated against the current Google video generation API before live use, because Google now documents Veo 3.1 as the current API family.

## Parallel Asset Generation

After the cost gate, use LangGraph fan-out/fan-in for scene asset generation.

Per-scene workers:

- `voiceover_worker`: generate narration audio.
- `still_worker`: generate or resolve source stills.
- `clip_worker`: animate stills or generate video clips.
- `caption_worker`: generate captions and timing metadata.

The fan-out should use LangGraph `Send` so scenes run concurrently. Reducers merge worker outputs into the asset manifest. The assembler consumes only validated paths from the manifest.

## Human Review UX

The existing dashboard can initially render gate payloads as structured JSON, but the payloads should be shaped for a richer future review panel.

Each gate payload should include:

- Gate name and run ID.
- Artifact type and human-readable summary.
- Primary content to review.
- Cost estimate or actual cost when relevant.
- Required decisions.
- Suggested revision targets.
- Risk warnings and compliance notes.

The final gate should show local video path, thumbnail path, actual cost, disclosure recommendation, and publish destination. Upload remains private-first by default.

## YouTube Compliance And Publication Policy

The pipeline must not auto-publish public videos. Uploads should default to private, or export locally if credentials are missing.

Compliance review should check:

- Whether AI disclosure is required for realistic synthetic scenes, voice cloning, altered real events, or other synthetic media.
- Whether the content is mostly automated summary without original commentary.
- Whether the visual plan is likely to become a static slideshow.
- Whether metadata looks templated across episodes.
- Whether recent posting cadence looks automated or excessive.

The compliance node should block upload/export approval when required fields are missing. It should route back to script or production-plan revision when the issue is fixable.

## Dashboard And API Integration

Add a workflow template for reusable YouTube production so the dashboard can start it like other LangGraph templates.

Initial integration options:

- Template starts a generic graph with a new `youtube_production` node type that delegates to the reusable graph.
- Dedicated FastAPI endpoint starts the reusable graph and Node proxies it through `/api/langgraph/youtube`.

Prefer the dedicated endpoint for the first slice if generic graph execution cannot represent the media workflow cleanly. The endpoint should still return standard run IDs and stream events so the dashboard can monitor progress.

The dashboard should not need a large first-pass UI rebuild. It only needs to start runs, display run status, and surface the existing gate payloads clearly enough for review.

## Migration Plan

Phase 1: Extract schemas and reusable graph package while keeping existing Praxis workflow intact.

Phase 2: Add local-first LLM roles and replace `_get_llm()` in the YouTube path with `LLMFactory` role-based selection.

Phase 3: Add provider router and cost gate enforcement. Keep dry-run default.

Phase 4: Add API/template integration so a Nexus project or task can start the workflow.

Phase 5: Migrate Praxis channel behavior into a `praxis` channel profile and turn `youtube_channel_workflow.py` into a wrapper or remove it after parity.

Phase 6: Verify live provider calls one at a time: TTS, stills, Veo, ffmpeg assembly, then private YouTube upload.

## Testing

Add focused tests for:

- Pydantic schemas rejecting malformed scripts and production plans.
- State reducers appending assets and cost entries without overwrites.
- Provider router decisions for dry-run, cost ceiling exceeded, SOTA requested, missing credentials, and approved Veo calls.
- Graph execution reaching concept, script, cost, and final gates in dry-run mode.
- Compliance node blocking missing disclosure and static-slideshow risk.
- Compatibility with the Praxis profile.

The first end-to-end smoke test should run in dry-run mode and avoid paid APIs.

## Out Of Scope

- Public auto-publishing.
- Full YouTube Analytics integration.
- Multi-channel scheduling automation.
- Real-time video editing UI.
- Replacing the existing dashboard workflow builder.
- Building every provider adapter at once.

## References

- Google Gemma 4 announcement: https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/
- Gemini API video generation docs: https://ai.google.dev/gemini-api/docs/video
- LangGraph Graph API: https://docs.langchain.com/oss/python/langgraph/graph-api
