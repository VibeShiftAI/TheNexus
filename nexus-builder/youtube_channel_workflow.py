"""
YouTube Channel Workflow — Praxis produces and publishes videos about himself.

Design memory:
  ~/.claude/projects/-Volumes-Projects/memory/youtube_channel_workflow.md

Architecture (three HITL gates + cadence review every 3 episodes):

  load_identity -> pick_topic -> research_topic -> draft_concept
                                                       |
                                           await_concept_approval (GATE 1)
                                             approve | revise | reject
                                                |        |        |
                                            write_script revise END
                                                |
                                           await_script_approval (GATE 2)
                                             approve | revise | reject
                                                |
                                     generate_voiceover -> generate_stills
                                                              |
                                                       animate_clips -> assemble_video
                                                                            |
                                                           await_final_approval (GATE 3)
                                                             approve | revise(script|visuals) | reject
                                                                |
                                                     publish_to_youtube (private!)
                                                                |
                                                     update_channel_state
                                                                |
                                                         check_cadence
                                                         (every 3 episodes)
                                                                |
                                                     propose_next_three
                                                                |
                                                     await_cadence_review (GATE 4)
                                                                |
                                                               END

Cognitive nodes (research_topic, draft_concept, write_script, revise_*,
propose_next_three) call an LLM via `model_config`. If the LLM isn't wired up
in the current environment, they fall back to clearly-marked placeholder
content so the graph still runs end-to-end for pipeline testing.

Adapter nodes call the functional adapters in `tools/media/` (some in dry-run
mode until real credentials are wired). See `tools/media/STATUS.md`.

Privacy: publish_to_youtube forces privacyStatus="private". Robert flips to
public manually in YouTube Studio.
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Annotated, Any, Dict, List, Literal, Optional, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver

from tools.media import episode_store
from tools.media.cost_ledger import summarize_episode
from tools.media.ffmpeg_assembler import FfmpegAssembleTool
from tools.media.nano_banana import NanoBananaGenerateTool, NANO_BANANA_USD_PER_IMAGE
from tools.media.tts import TTSGenerateTool
from tools.media.veo import VeoAnimateTool, VEO_USD_PER_SECOND
from tools.media.youtube import YouTubeUploadTool

logger = logging.getLogger(__name__)

# Gate names — also used as interrupt_after checkpoints at compile time.
GATE_CONCEPT = "await_concept_approval"
GATE_SCRIPT = "await_script_approval"
GATE_FINAL = "await_final_approval"
GATE_CADENCE = "await_cadence_review"

CADENCE_EVERY_N_EPISODES = 3


# ═══════════════════════════════════════════════════════════════
# STATE
# ═══════════════════════════════════════════════════════════════


class YouTubeChannelState(TypedDict, total=False):
    """State carried through a single episode run.

    `total=False` so each node can return partial updates without needing every
    field; LangGraph merges partials into the running state.
    """

    messages: Annotated[List[Dict[str, Any]], add_messages]

    # Series plan (seeded by load_identity)
    channel_plan: Dict[str, Any]

    # Episode identity
    episode_kind: Literal["intro", "deep_dive"]
    topic: Dict[str, Any]  # {slug, title, angle}

    # Creative artifacts
    research_brief: Optional[Dict[str, Any]]
    concept: Optional[Dict[str, Any]]
    script: Optional[Dict[str, Any]]
    voiceover: Optional[Dict[str, Any]]
    stills: Optional[Dict[str, Any]]      # {image_id -> path}
    clips: Optional[Dict[str, Any]]       # {clip_id -> {video_path, has_source_audio}}
    final_cut: Optional[Dict[str, Any]]   # {video_path, thumbnail_path, cost_actual}

    # Publish outputs
    youtube: Optional[Dict[str, Any]]  # {video_id, url, privacy}

    # HITL
    pending_approval: Optional[Dict[str, Any]]
    review_decision: Optional[Literal["approve", "revise", "reject"]]
    review_notes: Optional[str]
    revision_target: Optional[Literal["concept", "script", "visuals"]]

    # Dry-run: if True, paid-API adapters return placeholder data.
    dry_run: bool


# ═══════════════════════════════════════════════════════════════
# LLM (lazy — so the module imports cleanly without API keys)
# ═══════════════════════════════════════════════════════════════


def _get_llm():
    """Return an LLM handle or None if no provider is configured.

    Cognitive nodes check for None and fall back to placeholder content.
    This seam is where the upcoming local-model agent plugs in.
    """
    try:
        from model_config import get_claude_sonnet
        return get_claude_sonnet(temperature=0.7)
    except Exception as e:
        logger.warning("LLM unavailable (%s) — cognitive nodes will use placeholder content.", e)
        return None


# ═══════════════════════════════════════════════════════════════
# ADAPTER TOOLS (module-level singletons)
# ═══════════════════════════════════════════════════════════════

_tts_tool = TTSGenerateTool()
_still_tool = NanoBananaGenerateTool()
_clip_tool = VeoAnimateTool()
_assemble_tool = FfmpegAssembleTool()
_upload_tool = YouTubeUploadTool()


# ═══════════════════════════════════════════════════════════════
# NODES — SETUP
# ═══════════════════════════════════════════════════════════════


async def load_identity(state: YouTubeChannelState) -> Dict[str, Any]:
    """Seed channel_plan from Praxis identity + episode backlog.

    Real identity pull should hit Praxis's get_identity tool; for now we
    hydrate the backlog from the SQLite table and leave voice/tone as a stub
    the agent will refine.
    """
    upcoming = episode_store.list_episodes(status="upcoming")
    published = episode_store.published_count()
    channel_plan = {
        "persona": "Praxis — an autonomous agent discussing his own architecture",
        "voice": {"tone": "thoughtful, technical, first-person", "pace": "measured"},
        "backlog": upcoming,
        "published_count": published,
        "due_for_review": False,
    }
    return {"channel_plan": channel_plan, "dry_run": state.get("dry_run", True)}


async def pick_topic(state: YouTubeChannelState) -> Dict[str, Any]:
    """Choose the next episode. Intro series (3 episodes) runs first; after
    that, pull the next 'upcoming' slug from the backlog.

    Side effect: marks the chosen slug in_progress in the episode table.
    """
    plan = state["channel_plan"]
    published = plan["published_count"]
    backlog: List[Dict[str, Any]] = plan.get("backlog", [])

    chosen: Optional[Dict[str, Any]] = None
    if published < 3:
        # Intro series: seed deterministic 3 episodes if not already present.
        intro_slugs = [
            ("intro-who-praxis-is", "Who Praxis is",
             "Introducing a personified autonomous agent who narrates his own design."),
            ("intro-how-he-thinks", "How Praxis thinks — the Cortex",
             "A tour of the cognitive layer: Pinecone memory, Neo4j graph, council deliberation."),
            ("intro-how-he-acts", "How Praxis acts — cockpit and executors",
             "From prompt to action: HITL gates, executors, the Nexus cockpit."),
        ]
        target_slug = intro_slugs[published][0]
        existing = episode_store.get_episode(target_slug)
        if not existing:
            episode_store.upsert_episode(
                slug=intro_slugs[published][0],
                kind="intro",
                title=intro_slugs[published][1],
                angle=intro_slugs[published][2],
                status="upcoming",
            )
        chosen = episode_store.get_episode(target_slug)
        episode_kind = "intro"
    else:
        if not backlog:
            raise RuntimeError(
                "No upcoming episodes in backlog and intro series complete. "
                "Run the cadence review to propose the next 3."
            )
        chosen = backlog[0]
        episode_kind = chosen["kind"]

    if chosen is None:
        raise RuntimeError("pick_topic failed to choose an episode")

    episode_store.mark_in_progress(chosen["slug"])
    return {
        "episode_kind": episode_kind,
        "topic": {
            "slug": chosen["slug"],
            "title": chosen["title"],
            "angle": chosen.get("angle"),
        },
    }


# ═══════════════════════════════════════════════════════════════
# NODES — RESEARCH + DRAFT
# ═══════════════════════════════════════════════════════════════


async def research_topic(state: YouTubeChannelState) -> Dict[str, Any]:
    """Gather facts about Praxis relevant to the topic.

    Full implementation: query Cortex memory + recent git activity + skill
    inventory. For now: placeholder research brief.
    """
    topic = state["topic"]
    llm = _get_llm()
    if llm is None:
        brief = {
            "summary": f"[placeholder] research brief for '{topic['title']}'",
            "sources": [],
        }
    else:
        prompt = (
            f"You are gathering material for a short YouTube video titled "
            f"'{topic['title']}'. Angle: {topic.get('angle')}. "
            f"Produce a 3-5 bullet factual brief about Praxis the autonomous "
            f"agent, drawing only on widely-known architecture patterns; this "
            f"is a placeholder until Cortex integration lands."
        )
        resp = await llm.ainvoke(prompt)
        brief = {"summary": str(resp.content), "sources": []}
    return {"research_brief": brief}


async def draft_concept(state: YouTubeChannelState) -> Dict[str, Any]:
    """Produce a logline + 5-7 beats + runtime target."""
    topic = state["topic"]
    brief = state.get("research_brief", {}).get("summary", "")
    llm = _get_llm()
    if llm is None:
        concept = {
            "logline": f"[placeholder] logline for {topic['title']}",
            "beats": [f"Beat {i+1} placeholder" for i in range(5)],
            "runtime_target_s": 90,
        }
    else:
        prompt = (
            f"Draft a YouTube video concept.\n"
            f"Title: {topic['title']}\nAngle: {topic.get('angle')}\n"
            f"Brief:\n{brief}\n\n"
            f"Return a logline (1 sentence), 5-7 beats (bulleted), and a "
            f"runtime target in seconds (60-120 for intros). "
            f"Voice: Praxis speaking in first person about himself."
        )
        resp = await llm.ainvoke(prompt)
        concept = {"logline": "", "beats": [], "runtime_target_s": 90, "raw": str(resp.content)}
    return {"concept": concept, "review_notes": None, "review_decision": None}


async def revise_concept(state: YouTubeChannelState) -> Dict[str, Any]:
    """Rewrite the concept using review_notes from Gate 1."""
    notes = state.get("review_notes") or ""
    prior = state.get("concept") or {}
    llm = _get_llm()
    if llm is None:
        prior["raw"] = f"{prior.get('raw','')}\n[placeholder revised per notes: {notes}]"
        return {"concept": prior, "review_decision": None, "review_notes": None}
    prompt = (
        f"Revise this video concept per feedback.\nFeedback: {notes}\n\n"
        f"Prior concept: {prior}\nReturn the revised concept in the same shape."
    )
    resp = await llm.ainvoke(prompt)
    prior["raw"] = str(resp.content)
    return {"concept": prior, "review_decision": None, "review_notes": None}


# ═══════════════════════════════════════════════════════════════
# NODES — SCRIPT (with token-spend plan per scene)
# ═══════════════════════════════════════════════════════════════


def _estimate_cost(scenes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Roll up estimated Nano Banana + Veo spend for the script artifact."""
    imgs = sum(len(s.get("visual_plan", {}).get("images", [])) for s in scenes)
    clip_seconds = sum(
        c.get("duration_s", 0)
        for s in scenes
        for c in s.get("visual_plan", {}).get("clips", [])
    )
    nb_usd = round(imgs * NANO_BANANA_USD_PER_IMAGE, 4)
    veo_usd = round(clip_seconds * VEO_USD_PER_SECOND, 4)
    return {
        "nano_banana_2": {"images": imgs, "usd": nb_usd},
        "veo_3": {"clip_seconds": clip_seconds, "usd": veo_usd},
        "total_usd": round(nb_usd + veo_usd, 4),
    }


async def write_script(state: YouTubeChannelState) -> Dict[str, Any]:
    """Expand approved concept beats into scenes with narration + visual_plan.

    visual_plan per scene itemizes every Nano Banana 2 image and Veo 3 clip
    so Gate 2 doubles as the token-spend approval.
    """
    concept = state["concept"]
    topic = state["topic"]
    llm = _get_llm()

    if llm is None:
        # Placeholder: 5 scenes with one image and one 5s clip each.
        scenes: List[Dict[str, Any]] = []
        for i in range(5):
            scenes.append({
                "scene_id": f"s{i+1}",
                "narration": f"[placeholder] Scene {i+1} narration for {topic['title']}",
                "visual_plan": {
                    "images": [{
                        "id": f"img-{i+1}",
                        "model": "nano-banana-2",
                        "prompt": f"[placeholder] visual for scene {i+1}: {topic['title']}",
                    }],
                    "clips": [{
                        "id": f"clip-{i+1}",
                        "model": "veo-3",
                        "source_image": f"img-{i+1}",
                        "motion": "slow zoom",
                        "duration_s": 5.0,
                    }],
                },
            })
    else:
        prompt = (
            f"Write a scene-by-scene script for a YouTube video about Praxis.\n"
            f"Concept: {concept}\nTitle: {topic['title']}\n\n"
            f"For each scene produce JSON: scene_id, narration (1-3 sentences, "
            f"first-person from Praxis), visual_plan with images[] "
            f"(model='nano-banana-2', detailed prompt) and clips[] "
            f"(model='veo-3', source_image id, motion description, "
            f"duration_s 3-8). 4-7 scenes total."
        )
        resp = await llm.ainvoke(prompt)
        # Real implementation would parse structured output. Placeholder
        # captures raw for now.
        scenes = [{
            "scene_id": "s1",
            "narration": str(resp.content)[:500],
            "visual_plan": {"images": [], "clips": []},
            "raw": str(resp.content),
        }]

    cost_estimate = _estimate_cost(scenes)
    script = {"scenes": scenes, "cost_estimate": cost_estimate}
    return {"script": script, "review_decision": None, "review_notes": None}


async def revise_script(state: YouTubeChannelState) -> Dict[str, Any]:
    """Rewrite script per Gate 2 or Gate 3 revision notes."""
    notes = state.get("review_notes") or ""
    prior = state.get("script") or {}
    llm = _get_llm()
    if llm is None:
        prior["_revision_note"] = f"placeholder revised per: {notes}"
        return {
            "script": prior,
            "review_decision": None,
            "review_notes": None,
            "revision_target": None,
        }
    prompt = (
        f"Revise this script per feedback.\nFeedback: {notes}\n\n"
        f"Prior script: {prior}\nReturn revised script in the same shape."
    )
    resp = await llm.ainvoke(prompt)
    prior["_raw_revision"] = str(resp.content)
    prior["cost_estimate"] = _estimate_cost(prior.get("scenes", []))
    return {
        "script": prior,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }


# ═══════════════════════════════════════════════════════════════
# NODES — PRODUCTION (adapters)
# ═══════════════════════════════════════════════════════════════


async def generate_voiceover(state: YouTubeChannelState) -> Dict[str, Any]:
    """Synthesize per-scene narration via ElevenLabs (or say fallback)."""
    slug = state["topic"]["slug"]
    scenes = state["script"]["scenes"]
    results: Dict[str, Any] = {}
    for sc in scenes:
        text = sc.get("narration", "")
        if not text:
            continue
        r = await _tts_tool.execute(
            {}, text=text, episode_slug=slug, scene_id=sc["scene_id"],
        )
        if not r.get("success"):
            return {"voiceover": {"error": r.get("error"), "scene_id": sc["scene_id"]}}
        results[sc["scene_id"]] = r["result"]
    return {"voiceover": {"per_scene": results}}


async def generate_stills(state: YouTubeChannelState) -> Dict[str, Any]:
    """Nano Banana 2 — one image per `visual_plan.images[*]`."""
    slug = state["topic"]["slug"]
    dry = state.get("dry_run", True)
    stills: Dict[str, Any] = {}
    for sc in state["script"]["scenes"]:
        for img in sc.get("visual_plan", {}).get("images", []):
            r = await _still_tool.execute(
                {},
                prompt=img["prompt"],
                episode_slug=slug,
                scene_id=sc["scene_id"],
                image_id=img["id"],
                dry_run=dry,
            )
            if not r.get("success"):
                return {"stills": {"error": r.get("error"), "image_id": img["id"]}}
            stills[img["id"]] = r["result"]["image_path"]
    return {"stills": stills}


async def animate_clips(state: YouTubeChannelState) -> Dict[str, Any]:
    """Veo 3 — animate each clip from its source still."""
    slug = state["topic"]["slug"]
    dry = state.get("dry_run", True)
    stills: Dict[str, str] = state.get("stills") or {}
    clips: Dict[str, Any] = {}
    for sc in state["script"]["scenes"]:
        for clip in sc.get("visual_plan", {}).get("clips", []):
            src_id = clip["source_image"]
            src_path = stills.get(src_id)
            if not src_path:
                return {"clips": {"error": f"missing still for {src_id}"}}
            r = await _clip_tool.execute(
                {},
                source_image_path=src_path,
                motion_prompt=clip["motion"],
                duration_s=clip.get("duration_s", 5.0),
                episode_slug=slug,
                scene_id=sc["scene_id"],
                clip_id=clip["id"],
                dry_run=dry,
            )
            if not r.get("success"):
                return {"clips": {"error": r.get("error"), "clip_id": clip["id"]}}
            clips[clip["id"]] = {
                "video_path": r["result"]["video_path"],
                "has_source_audio": r["result"].get("has_source_audio", False),
                "duration_s": r["result"]["duration_s"],
            }
    return {"clips": clips}


async def assemble_video(state: YouTubeChannelState) -> Dict[str, Any]:
    """ffmpeg: per-scene clip + narration (mixed over Veo's music) -> MP4."""
    slug = state["topic"]["slug"]
    scenes_input: List[Dict[str, Any]] = []
    voiceover_per_scene = (state.get("voiceover") or {}).get("per_scene", {})
    clips = state.get("clips") or {}

    for sc in state["script"]["scenes"]:
        plan_clips = sc.get("visual_plan", {}).get("clips", [])
        if not plan_clips:
            continue
        clip_meta = clips.get(plan_clips[0]["id"], {})
        narr = voiceover_per_scene.get(sc["scene_id"], {})
        scenes_input.append({
            "scene_id": sc["scene_id"],
            "visual_path": clip_meta.get("video_path"),
            "audio_path": narr.get("audio_path"),
            "duration_s": clip_meta.get("duration_s", 5.0),
            "has_source_audio": clip_meta.get("has_source_audio", False),
        })

    if not scenes_input:
        return {"final_cut": {"error": "no assembled scenes"}}

    r = await _assemble_tool.execute({}, scenes=scenes_input, episode_slug=slug)
    if not r.get("success"):
        return {"final_cut": {"error": r.get("error")}}

    cost_actual = summarize_episode(slug)
    return {
        "final_cut": {
            "video_path": r["result"]["video_path"],
            "thumbnail_path": r["result"]["thumbnail_path"],
            "had_music": r["result"].get("had_music"),
            "cost_actual": cost_actual,
        }
    }


# ═══════════════════════════════════════════════════════════════
# NODES — REVISIONS (visuals only; script/concept revise above)
# ═══════════════════════════════════════════════════════════════


async def revise_visuals(state: YouTubeChannelState) -> Dict[str, Any]:
    """Clear stills+clips+final_cut so the pipeline re-renders with updated script.

    The review_notes from Gate 3 are expected to have been applied to the
    script already (either by `revise_script` on a script-target revision, or
    by the user editing the script directly before resuming with
    revision_target='visuals').
    """
    return {
        "stills": None,
        "clips": None,
        "final_cut": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }


# ═══════════════════════════════════════════════════════════════
# NODES — HITL GATES
#
# Each sets `pending_approval` and does nothing else. The graph is
# compiled with `interrupt_after=[gate_node_names]` so execution pauses
# after the gate populates state. The cockpit observes `pending_approval`
# via SSE, renders the review UI, and resumes the graph with the user's
# review_decision / review_notes / revision_target merged into state.
# ═══════════════════════════════════════════════════════════════


async def await_concept_approval(state: YouTubeChannelState) -> Dict[str, Any]:
    artifact = {
        "id": f"concept-{uuid.uuid4().hex[:8]}",
        "kind": "concept",
        "content": state.get("concept"),
    }
    return {
        "pending_approval": {
            "gate": GATE_CONCEPT,
            "artifact": artifact,
            "message": "Approve the concept to proceed to scripting. Revise with notes, or reject to cancel.",
            "decisions": ["approve", "revise", "reject"],
        }
    }


async def await_script_approval(state: YouTubeChannelState) -> Dict[str, Any]:
    """Gate 2 — ALSO the token-spend approval gate."""
    script = state.get("script", {})
    artifact = {
        "id": f"script-{uuid.uuid4().hex[:8]}",
        "kind": "script",
        "content": script,
        "cost_estimate": script.get("cost_estimate"),
    }
    return {
        "pending_approval": {
            "gate": GATE_SCRIPT,
            "artifact": artifact,
            "message": (
                "Approve the script (this also authorizes the Nano Banana 2 + "
                "Veo 3 token spend shown in cost_estimate). Revise with notes, "
                "or reject to cancel."
            ),
            "decisions": ["approve", "revise", "reject"],
        }
    }


async def await_final_approval(state: YouTubeChannelState) -> Dict[str, Any]:
    """Gate 3 — last stop before anything reaches YouTube."""
    final = state.get("final_cut", {})
    artifact = {
        "id": f"final-{uuid.uuid4().hex[:8]}",
        "kind": "final_cut",
        "video_path": final.get("video_path"),
        "thumbnail_path": final.get("thumbnail_path"),
        "cost_actual": final.get("cost_actual"),
    }
    return {
        "pending_approval": {
            "gate": GATE_FINAL,
            "artifact": artifact,
            "message": (
                "Final review. Approve to upload as PRIVATE (flip to public in "
                "YouTube Studio). Revise with revision_target in "
                "{'script','visuals'}, or reject to cancel."
            ),
            "decisions": ["approve", "revise", "reject"],
        }
    }


async def await_cadence_review(state: YouTubeChannelState) -> Dict[str, Any]:
    plan = state.get("channel_plan", {})
    artifact = {
        "id": f"cadence-{uuid.uuid4().hex[:8]}",
        "kind": "cadence_review",
        "proposed_next_three": plan.get("proposed_next_three", []),
        "published_count": plan.get("published_count"),
    }
    return {
        "pending_approval": {
            "gate": GATE_CADENCE,
            "artifact": artifact,
            "message": (
                "Review the proposed next 3 episodes. Approve to seed the "
                "backlog, revise to regenerate with notes, or reject to stop."
            ),
            "decisions": ["approve", "revise", "reject"],
        }
    }


# ═══════════════════════════════════════════════════════════════
# NODES — PUBLISH + CADENCE
# ═══════════════════════════════════════════════════════════════


async def publish_to_youtube(state: YouTubeChannelState) -> Dict[str, Any]:
    """Upload as PRIVATE. Robert flips to public manually."""
    topic = state["topic"]
    final = state.get("final_cut", {})
    dry = state.get("dry_run", True)

    description = (
        f"{topic.get('angle') or ''}\n\n"
        f"An episode of Praxis's self-narrated channel."
    )
    r = await _upload_tool.execute(
        {},
        video_path=final["video_path"],
        title=topic["title"],
        description=description,
        tags=["Praxis", "AI agents", "architecture"],
        thumbnail_path=final.get("thumbnail_path"),
        episode_slug=topic["slug"],
        dry_run=dry,
    )
    if not r.get("success"):
        return {"youtube": {"error": r.get("error")}}
    return {"youtube": r["result"]}


async def update_channel_state(state: YouTubeChannelState) -> Dict[str, Any]:
    """Persist the published row in Praxis's youtube_episodes table."""
    topic = state["topic"]
    yt = state.get("youtube") or {}
    if "video_id" in yt:
        episode_store.record_published(topic["slug"], yt["video_id"])
    new_count = episode_store.published_count()
    plan = {**state.get("channel_plan", {}), "published_count": new_count}
    plan["due_for_review"] = (new_count % CADENCE_EVERY_N_EPISODES) == 0 and new_count > 0
    return {"channel_plan": plan}


async def check_cadence(state: YouTubeChannelState) -> Dict[str, Any]:
    """No-op node that exists so conditional routing has a stable anchor."""
    return {}


async def propose_next_three(state: YouTubeChannelState) -> Dict[str, Any]:
    """Produce 3 candidate slugs using LLM + analytics (when wired).

    Placeholder: emits 3 TBD slugs. The real implementation should read
    metrics via episode_store.list_episodes(status='published') and pull
    remaining architecture topics from Cortex.
    """
    llm = _get_llm()
    if llm is None:
        proposals = [
            {"slug": f"tbd-{i+1}", "title": f"[placeholder topic {i+1}]", "angle": ""}
            for i in range(CADENCE_EVERY_N_EPISODES)
        ]
    else:
        published = episode_store.list_episodes(status="published")
        prompt = (
            f"Praxis has published {len(published)} episodes. Propose the next "
            f"3 deep-dive topics about his own architecture. Output as a JSON "
            f"list of {{slug, title, angle}}. Published so far: "
            f"{[p['slug'] for p in published]}"
        )
        resp = await llm.ainvoke(prompt)
        # Real impl parses JSON; placeholder records raw.
        proposals = [{"slug": "tbd-1", "title": "LLM output", "angle": str(resp.content)[:200]}]

    plan = {**state.get("channel_plan", {}), "proposed_next_three": proposals}
    return {"channel_plan": plan}


async def seed_backlog_from_approval(state: YouTubeChannelState) -> Dict[str, Any]:
    """After cadence gate approval, upsert the 3 proposals into the backlog."""
    plan = state.get("channel_plan", {})
    for p in plan.get("proposed_next_three", []):
        if not p.get("slug", "").startswith("tbd-"):
            episode_store.upsert_episode(
                slug=p["slug"], kind="deep_dive",
                title=p["title"], angle=p.get("angle"), status="upcoming",
            )
    return {}


# ═══════════════════════════════════════════════════════════════
# ROUTING
# ═══════════════════════════════════════════════════════════════


def _route_concept(state: YouTubeChannelState) -> Literal["write_script", "revise_concept", "end"]:
    d = state.get("review_decision")
    if d == "approve":
        return "write_script"
    if d == "revise":
        return "revise_concept"
    return "end"


def _route_script(state: YouTubeChannelState) -> Literal["generate_voiceover", "revise_script", "end"]:
    d = state.get("review_decision")
    if d == "approve":
        return "generate_voiceover"
    if d == "revise":
        return "revise_script"
    return "end"


def _route_final(
    state: YouTubeChannelState,
) -> Literal["publish_to_youtube", "revise_script", "revise_visuals", "end"]:
    d = state.get("review_decision")
    if d == "approve":
        return "publish_to_youtube"
    if d == "reject":
        return "end"
    # revise: target decides which artifact to rewind to
    target = state.get("revision_target", "visuals")
    return "revise_script" if target == "script" else "revise_visuals"


def _route_cadence_check(state: YouTubeChannelState) -> Literal["propose_next_three", "end"]:
    plan = state.get("channel_plan", {})
    return "propose_next_three" if plan.get("due_for_review") else "end"


def _route_cadence_review(
    state: YouTubeChannelState,
) -> Literal["seed_backlog_from_approval", "propose_next_three", "end"]:
    d = state.get("review_decision")
    if d == "approve":
        return "seed_backlog_from_approval"
    if d == "revise":
        return "propose_next_three"
    return "end"


# ═══════════════════════════════════════════════════════════════
# GRAPH ASSEMBLY
# ═══════════════════════════════════════════════════════════════


def build_youtube_channel_graph(checkpointer=None):
    """Build and compile the YouTube channel workflow graph."""
    b = StateGraph(YouTubeChannelState)

    # Setup
    b.add_node("load_identity", load_identity)
    b.add_node("pick_topic", pick_topic)
    b.add_node("research_topic", research_topic)
    b.add_node("draft_concept", draft_concept)

    # Gate 1 + revision
    b.add_node(GATE_CONCEPT, await_concept_approval)
    b.add_node("revise_concept", revise_concept)

    # Script
    b.add_node("write_script", write_script)
    b.add_node(GATE_SCRIPT, await_script_approval)
    b.add_node("revise_script", revise_script)

    # Production
    b.add_node("generate_voiceover", generate_voiceover)
    b.add_node("generate_stills", generate_stills)
    b.add_node("animate_clips", animate_clips)
    b.add_node("assemble_video", assemble_video)

    # Gate 3 + visual revision
    b.add_node(GATE_FINAL, await_final_approval)
    b.add_node("revise_visuals", revise_visuals)

    # Publish
    b.add_node("publish_to_youtube", publish_to_youtube)
    b.add_node("update_channel_state", update_channel_state)

    # Cadence
    b.add_node("check_cadence", check_cadence)
    b.add_node("propose_next_three", propose_next_three)
    b.add_node(GATE_CADENCE, await_cadence_review)
    b.add_node("seed_backlog_from_approval", seed_backlog_from_approval)

    # ── Edges ─────────────────────────────────────────────────
    b.add_edge(START, "load_identity")
    b.add_edge("load_identity", "pick_topic")
    b.add_edge("pick_topic", "research_topic")
    b.add_edge("research_topic", "draft_concept")
    b.add_edge("draft_concept", GATE_CONCEPT)

    # Gate 1
    b.add_conditional_edges(
        GATE_CONCEPT, _route_concept,
        {"write_script": "write_script", "revise_concept": "revise_concept", "end": END},
    )
    b.add_edge("revise_concept", GATE_CONCEPT)

    # Script
    b.add_edge("write_script", GATE_SCRIPT)
    b.add_conditional_edges(
        GATE_SCRIPT, _route_script,
        {"generate_voiceover": "generate_voiceover", "revise_script": "revise_script", "end": END},
    )
    # revise_script returns to the same gate it was triggered from. Two entry
    # points (Gate 2 script-revise, Gate 3 script-target revise) are
    # disambiguated by whether revision_target was set. Default: return to Gate 2.
    b.add_edge("revise_script", GATE_SCRIPT)

    # Production pipeline
    b.add_edge("generate_voiceover", "generate_stills")
    b.add_edge("generate_stills", "animate_clips")
    b.add_edge("animate_clips", "assemble_video")
    b.add_edge("assemble_video", GATE_FINAL)

    # Gate 3
    b.add_conditional_edges(
        GATE_FINAL, _route_final,
        {
            "publish_to_youtube": "publish_to_youtube",
            "revise_script": "revise_script",
            "revise_visuals": "revise_visuals",
            "end": END,
        },
    )
    b.add_edge("revise_visuals", "assemble_video")

    # Publish + cadence
    b.add_edge("publish_to_youtube", "update_channel_state")
    b.add_edge("update_channel_state", "check_cadence")
    b.add_conditional_edges(
        "check_cadence", _route_cadence_check,
        {"propose_next_three": "propose_next_three", "end": END},
    )
    b.add_edge("propose_next_three", GATE_CADENCE)
    b.add_conditional_edges(
        GATE_CADENCE, _route_cadence_review,
        {
            "seed_backlog_from_approval": "seed_backlog_from_approval",
            "propose_next_three": "propose_next_three",
            "end": END,
        },
    )
    b.add_edge("seed_backlog_from_approval", END)

    if checkpointer is None:
        checkpointer = MemorySaver()

    return b.compile(
        checkpointer=checkpointer,
        interrupt_after=[GATE_CONCEPT, GATE_SCRIPT, GATE_FINAL, GATE_CADENCE],
    )


# Pre-compiled instance for direct import
youtube_channel_graph = build_youtube_channel_graph()


# ═══════════════════════════════════════════════════════════════
# CONVENIENCE
# ═══════════════════════════════════════════════════════════════


def create_initial_state(*, dry_run: bool = True) -> YouTubeChannelState:
    """Initial state for a fresh episode run."""
    return {
        "messages": [],
        "channel_plan": {},
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
        "dry_run": dry_run,
    }


async def run_episode(*, thread_id: Optional[str] = None, dry_run: bool = True):
    """Kick off a new episode run. The graph will interrupt at Gate 1; the
    cockpit is responsible for submitting review_decision + review_notes and
    resuming via the checkpointer."""
    state = create_initial_state(dry_run=dry_run)
    config = {"configurable": {"thread_id": thread_id or f"yt-{uuid.uuid4().hex[:8]}"}}
    return await youtube_channel_graph.ainvoke(state, config)
