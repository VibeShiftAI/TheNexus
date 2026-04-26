# Media adapters — status & handoff

Scaffolding for Praxis's YouTube channel workflow (LangGraph, private-first
publish, 3 HITL gates). Design memory:
`~/.claude/projects/-Volumes-Projects/memory/youtube_channel_workflow.md`.

## Why these live here (not in Praxis)

Robert is swapping Praxis (TypeScript agent) for a local open-source model in
~early May 2026. The agent owns *cognition* (writing scripts, picking topics).
Everything else — credentials, external-API calls, cost accounting — lives in
TheNexus so the agent swap is a one-seam change. Workflow nodes import these
modules directly.

## File map

| File | Status | Summary |
|---|---|---|
| `__init__.py` | ✅ done | Exports + `register_tools(registry)` |
| `cost_ledger.py` | ✅ functional | SQLite append-only ledger, WAL mode, `record_usage()` + `summarize_episode(slug)`. DB at `nexus-builder/data/media_cost_ledger.db` (gitignored). |
| `tts.py` | ✅ functional | ElevenLabs primary (Praxis's voice id, eleven_turbo_v2_5) + macOS `say` fallback. Pricing lives in `ELEVENLABS_USD_PER_CHAR` module constant. |
| `ffmpeg_assembler.py` | ✅ functional | Per-scene mux + concat + thumbnail. **Preserves Veo 3 music and mixes narration over it** via amix (narration 1.0, music 0.25 — tunable module constants). Requires `ffmpeg` + `ffprobe`. |
| `nano_banana.py` | ✅ wired (verify) | `gemini-2.5-flash-image` via `generateContent` with `responseModalities:["IMAGE"]`. Model ID env-overridable. Dry-run falls back to grey PNG when no key. Verify against Google docs on first live call. |
| `veo.py` | ✅ wired (verify) | `veo-3.0-generate-preview` via `:predictLongRunning` + poll loop. Decodes inline base64 video OR downloads video URI from response. Model ID + poll cadence env-overridable. Dry-run produces silent loop. Verify request shape on first live call. |
| `youtube.py` | ✅ wired | Real resumable upload via `google-api-python-client`. One-time consent: `python -m tools.media.youtube --authorize`. Refresh token at `TheNexus/.secrets/youtube_oauth.json`. **`privacyStatus = "private"` is hardcoded — do not change.** |

## What works end-to-end right now

With `dry_run=True` on the three stubs + real TTS/ffmpeg, you can drive the
whole pipeline (prompt → placeholder image → placeholder clip → real voiceover
→ real ffmpeg mux → fake YouTube ID) and see the cost ledger populate with
the ElevenLabs charges only. That's enough to validate the LangGraph wiring
before any paid image/video calls happen.

## Env vars added (`.env.example` updated)

```
ELEVENLABS_API_KEY=          # same key Praxis uses — copy from Praxis/.env
ELEVENLABS_VOICE_ID=onwK4e9ZLuTAKqWW03F9
NANO_BANANA_API_KEY=         # needed to remove dry_run from nano_banana.py
VEO_API_KEY=                 # needed to remove dry_run from veo.py
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
```

**Pricing lives in each adapter module as a constant** (`ELEVENLABS_USD_PER_CHAR`,
`NANO_BANANA_USD_PER_IMAGE`, `VEO_USD_PER_SECOND`), not in env — model version
and price belong together in one source file. Update when plans change.

YouTube OAuth refresh token will persist to `TheNexus/.secrets/youtube_oauth.json`
(directory gitignored).

## Dependencies added to requirements.txt

- `httpx` — already present, used by tts.py, nano_banana.py, veo.py.
- `google-api-python-client`, `google-auth-oauthlib`, `google-auth-httplib2` —
  uncommented; required for `youtube.py` live uploads and `--authorize` flow.
  `pip install -r requirements.txt` picks them up.

## Next concrete steps (priority order)

1. ~~**Write the LangGraph workflow file**~~ ✅ DONE —
   `nexus-builder/youtube_channel_workflow.py` exists and compiles. 20+ nodes,
   4 HITL gates (concept / script / final / cadence), MemorySaver checkpointer,
   `youtube_channel_graph` pre-compiled at module load. Adapters are leaves.
2. ~~**Register media tools** with the Nexus registry.~~ ✅ DONE — see
   `tools/registry.py` `initialize_defaults()`. All 5 media tools register
   automatically via `from . import media; media.register_tools(self)`.
3. **Cockpit review-UI check**: verify `pending_approval` with the new
   `visual_plan` + `cost_estimate` payload renders cleanly. Likely no code
   change needed (existing JSON renderer), but confirm before Gate 2 goes live.
4. ~~**Finish Nano Banana 2**~~ ✅ wired — verify on first live call.
5. ~~**Finish Veo 3**~~ ✅ wired — verify on first live call.
6. ~~**Finish YouTube upload + OAuth**~~ ✅ wired — run
   `pip install -r requirements.txt` then
   `python -m tools.media.youtube --authorize` in `nexus-builder/` to complete
   one-time consent before first upload.
7. **First live smoke test** (order of operations):
   - Install new deps: `pip install -r requirements.txt`.
   - Set `NANO_BANANA_API_KEY` + `VEO_API_KEY` in `.env` (may be the same
     Google API key — check your GCP console).
   - Set `YOUTUBE_CLIENT_ID` + `YOUTUBE_CLIENT_SECRET`, then authorize.
   - Run the workflow with `dry_run=False` on one intro episode. Watch the
     cost ledger at `data/media_cost_ledger.db` populate in real time.
8. **Praxis tools**: add TypeScript tools over `src/youtube/` so the agent
   can query/update the episode table from its side (Python already does this
   directly via `episode_store.py`).

## Decisions locked in (previous open questions)

1. **Episode table access from Python**: direct SQLite file read from
   `Praxis/data/youtube.db`. Call sites: `pick_topic` (read backlog +
   publishedCount), `check_cadence` (read publishedCount), `propose_next_three`
   (read published history + write 3 new rows), `update_channel_state` (write
   recordPublished), plus a periodic analytics sync (write recordMetrics).
   Helper module to write: `nexus-builder/tools/media/episode_store.py`.
2. **Real pricing** — still a TODO. Module constants are rough placeholders.
   Update before enabling live calls.
3. **Music / sound design** — RESOLVED: Veo 3 output includes music, so no
   separate music adapter needed. ffmpeg_assembler preserves Veo's audio and
   mixes narration on top.

## How a future agent picks this up

- Read the design memory first (path above).
- Read this file.
- Read the Praxis-side STATUS: `Praxis/src/youtube/STATUS.md`.
- Then start at "Next concrete steps" step 1.

Every stub module has a self-contained TODO in its docstring — no hidden
context needed.
