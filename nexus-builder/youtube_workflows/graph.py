from __future__ import annotations

import json
from typing import Any, Dict, List, Literal

from tools import get_registry

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from .models import (
    ApprovalPayload,
    AssetRecord,
    ComplianceReport,
    Concept,
    CostEntry,
    ProductionPlan,
    SceneScript,
    Script,
)
from .llm import get_youtube_llm, strip_thought_blocks
from .profiles import get_channel_profile
from .provider_router import ProviderRouter
from .praxis_research import gather_praxis_research
from .state import YouTubeWorkflowState, clear_pending_approval


GATE_RESEARCH = "research_gate"
GATE_CONCEPT = "concept_gate"
GATE_SCRIPT = "script_gate"
GATE_COST = "cost_gate"
GATE_FINAL = "final_gate"


def _extract_json_object(text: str) -> Dict[str, Any]:
    cleaned = strip_thought_blocks(text).strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        parsed = json.loads(cleaned[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("YouTube strategist concept response must be a JSON object")
    return parsed


def _stringify_list_item(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        preferred_keys = ("beat", "point", "note", "title", "purpose", "description", "detail")
        values = [str(item[key]).strip() for key in preferred_keys if item.get(key)]
        if values:
            return " ".join(values)
    return str(item).strip()


def _normalize_concept_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(payload)
    for key in ("outline", "risk_notes"):
        value = normalized.get(key)
        if isinstance(value, list):
            normalized[key] = [
                text
                for item in value
                if (text := _stringify_list_item(item))
            ]
    return normalized


def _fallback_concept(
    workflow_input: Any,
    profile: Any,
    research_brief: Any,
    reason: str | None = None,
) -> Concept:
    evidence_titles = [item.title for item in research_brief.evidence[:3]]
    risk_notes = [
        *profile.style_rules,
        "Concept is grounded in internal Praxis evidence, not generic web research.",
        *(f"Evidence: {title}" for title in evidence_titles),
        *research_brief.gaps,
    ]
    if reason:
        risk_notes.append(f"Strategist fallback used: {reason}")
    return Concept(
        title="Praxis Introduction",
        logline=f"A grounded introduction to Praxis through the lens of: {workflow_input.prompt}.",
        audience="Builders and operators using The Nexus.",
        promise="Show what Praxis can actually inspect, reason about, and produce inside The Nexus.",
        retention_hook="Open with Praxis researching himself before explaining the workflow machinery.",
        outline=[
            research_brief.summary,
            "Show the internal faculties Praxis used: tools, code evidence, workflow templates, and project history.",
            "Turn those findings into a creator-facing explanation of how Praxis works.",
            "Explain where human review protects quality before any expensive media generation or upload.",
        ],
        risk_notes=risk_notes,
    )


async def _draft_concept_with_strategist(
    workflow_input: Any,
    profile: Any,
    research_brief: Any,
) -> Concept:
    evidence = [
        {
            "source_type": item.source_type,
            "title": item.title,
            "path": item.path,
            "excerpt": item.excerpt,
        }
        for item in research_brief.evidence[:8]
    ]
    prompt = f"""
You are Praxis's YouTube content strategist inside The Nexus.

Create a concrete approval-ready YouTube concept for this request:
{workflow_input.prompt}

Use this internal Praxis research brief as source material:
summary: {research_brief.summary}
claims: {json.dumps(research_brief.claims, ensure_ascii=False)}
angle_notes: {json.dumps(research_brief.angle_notes, ensure_ascii=False)}
gaps: {json.dumps(research_brief.gaps, ensure_ascii=False)}
evidence: {json.dumps(evidence, ensure_ascii=False)}

Channel style rules:
{json.dumps(profile.style_rules, ensure_ascii=False)}

Return only JSON with exactly these keys:
title, logline, audience, promise, retention_hook, outline, risk_notes.

Requirements:
- Do not echo the user request as the logline.
- Make Praxis the subject of the video, not a generic automation product.
- Ground every major claim in the provided internal evidence.
- Keep outline to 4-6 specific beats.
- Include risk_notes for any claims that need human review.
"""
    response = await get_youtube_llm("youtube_strategist").ainvoke(prompt)
    payload = _normalize_concept_payload(_extract_json_object(str(getattr(response, "content", response))))
    concept = Concept.model_validate(payload)
    concept.risk_notes = [
        *profile.style_rules,
        *concept.risk_notes,
        "Concept drafted by youtube_strategist from internal Praxis evidence.",
    ]
    return concept


async def load_channel_profile(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    return {"channel_profile": get_channel_profile(workflow_input.channel_profile_id)}


async def research(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    return {"research_brief": await gather_praxis_research(workflow_input.prompt, via_chat=True), **clear_pending_approval()}


async def research_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="research",
        message="Approve the Praxis research brief before drafting the concept.",
        artifact=state["research_brief"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["research"],
    )
    return {"pending_approval": payload}


async def draft_concept(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    profile = state["channel_profile"]
    research_brief = state["research_brief"]
    if workflow_input.dry_run:
        concept = _fallback_concept(workflow_input, profile, research_brief)
    else:
        try:
            concept = await _draft_concept_with_strategist(workflow_input, profile, research_brief)
        except Exception as exc:
            concept = _fallback_concept(workflow_input, profile, research_brief, str(exc))
    return {"concept": concept, **clear_pending_approval()}


async def concept_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="concept",
        message="Approve the concept to continue to scriptwriting.",
        artifact=state["concept"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["concept"],
    )
    return {"pending_approval": payload}


async def write_script(state: YouTubeWorkflowState) -> Dict[str, Any]:
    concept = state["concept"]
    script = Script(
        title=concept.title,
        scenes=[
            SceneScript(
                scene_id="s1",
                narration="The Nexus turns a rough idea into a reviewed, trackable workflow.",
                visual_prompt="A dark operational dashboard with task cards and workflow lines.",
                motion_prompt="Slow push across the dashboard with subtle parallax.",
                duration_s=5,
            ),
            SceneScript(
                scene_id="s2",
                narration="Local models handle routine reasoning while premium providers stay behind approval gates.",
                visual_prompt="A local workstation connected to labeled model providers.",
                motion_prompt="Camera moves from the local node toward a highlighted cloud node.",
                duration_s=5,
                requires_sota=True,
            ),
        ],
    )
    return {"script": script, **clear_pending_approval()}


async def script_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="script",
        message="Approve the script to build the production plan.",
        artifact=state["script"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["script"],
    )
    return {"pending_approval": payload}


async def production_plan(state: YouTubeWorkflowState) -> Dict[str, Any]:
    router = ProviderRouter()
    decisions = [
        router.choose_scene_provider(scene, state["input"], state["channel_profile"])
        for scene in state["script"].scenes
    ]
    plan = ProductionPlan(
        scenes=[
            {
                "scene_id": scene.scene_id,
                "provider": decision.provider,
                "visual_prompt": scene.visual_prompt,
                "motion_prompt": scene.motion_prompt,
                "duration_s": scene.duration_s,
                "estimated_cost_usd": decision.estimated_cost_usd,
                "requires_cost_approval": decision.requires_cost_approval,
            }
            for scene, decision in zip(state["script"].scenes, decisions)
        ],
        total_estimated_cost_usd=sum(decision.estimated_cost_usd for decision in decisions),
        cost_approved=False,
    )
    return {"production_plan": plan, **clear_pending_approval()}


async def cost_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="cost",
        message="Approve the production plan and any paid provider spend.",
        artifact=state["production_plan"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["production_plan", "script"],
    )
    return {"pending_approval": payload}


async def mark_cost_approved(state: YouTubeWorkflowState) -> Dict[str, Any]:
    plan = state["production_plan"].model_copy(update={"cost_approved": True})
    return {"production_plan": plan, **clear_pending_approval()}


async def fanout_assets(state: YouTubeWorkflowState) -> Dict[str, Any]:
    plan = state["production_plan"]
    paid_approval_required = any(scene.requires_cost_approval for scene in plan.scenes)
    if paid_approval_required and not plan.cost_approved:
        raise RuntimeError("Cost approval is required before asset generation")

    registry = get_registry()
    media_context = {"project_root": state["input"].project_id or ""}
    episode_slug = f"youtube_{state['input'].project_id or 'local'}"
    assets = []
    costs = []
    plan_by_scene = {scene.scene_id: scene for scene in plan.scenes}
    existing_assets_by_scene: Dict[str, set[str]] = {}
    for asset in state.get("assets", []):
        existing_assets_by_scene.setdefault(asset.scene_id, set()).add(asset.asset_type)
    for scene in state["script"].scenes:
        if {"voiceover", "still", "clip"}.issubset(existing_assets_by_scene.get(scene.scene_id, set())):
            continue
        plan_scene = plan_by_scene[scene.scene_id]
        provider = plan_scene.provider
        still_result = await registry.get("nano_banana_generate").execute(
            media_context,
            prompt=scene.visual_prompt,
            episode_slug=episode_slug,
            scene_id=scene.scene_id,
            dry_run=state["input"].dry_run,
        )
        if not still_result.get("success"):
            raise RuntimeError(f"Still generation failed for {scene.scene_id}: {still_result.get('error')}")
        still = still_result["result"]

        tts_tool = registry.get("tts_generate")
        tts_provider = "macos_say" if state["input"].dry_run else "elevenlabs"
        voiceover_result = await tts_tool.execute(
            media_context,
            text=scene.narration,
            episode_slug=episode_slug,
            scene_id=scene.scene_id,
            provider=tts_provider,
        )
        if not voiceover_result.get("success") and tts_provider != "macos_say":
            voiceover_result = await tts_tool.execute(
                media_context,
                text=scene.narration,
                episode_slug=episode_slug,
                scene_id=scene.scene_id,
                provider="macos_say",
            )
        if not voiceover_result.get("success"):
            raise RuntimeError(f"Voiceover generation failed for {scene.scene_id}: {voiceover_result.get('error')}")
        voiceover = voiceover_result["result"]

        clip_result = await registry.get("veo_animate").execute(
            media_context,
            source_image_path=still["image_path"],
            motion_prompt=scene.motion_prompt,
            duration_s=scene.duration_s,
            episode_slug=episode_slug,
            scene_id=scene.scene_id,
            dry_run=state["input"].dry_run or provider != "veo",
        )
        if not clip_result.get("success"):
            raise RuntimeError(f"Clip generation failed for {scene.scene_id}: {clip_result.get('error')}")
        clip = clip_result["result"]

        assets.extend(
            [
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="voiceover",
                    path=voiceover["audio_path"],
                    provider=voiceover["provider"],
                    metadata={"duration_s": voiceover.get("duration_s", 0)},
                ),
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="still",
                    path=still["image_path"],
                    provider=still["model"],
                    metadata={"dry_run": still.get("dry_run", False)},
                ),
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="clip",
                    path=clip["video_path"],
                    provider=provider,
                    metadata={
                        "duration_s": clip.get("duration_s", scene.duration_s),
                        "has_source_audio": clip.get("has_source_audio", False),
                        "dry_run": clip.get("dry_run", False),
                    },
                ),
            ]
        )
        costs.append(
            CostEntry(
                provider=provider,
                operation="scene_assets",
                usd=plan_scene.estimated_cost_usd,
                scene_id=scene.scene_id,
            )
        )
    return {"assets": assets, "costs": costs}


async def reduce_assets(state: YouTubeWorkflowState) -> Dict[str, Any]:
    return {}


async def assemble_video(state: YouTubeWorkflowState) -> Dict[str, Any]:
    existing_final = next(
        (asset for asset in state.get("assets", []) if asset.asset_type == "final_video"),
        None,
    )
    if existing_final:
        return {
            "assets": [existing_final],
            "final_output": {
                "video_path": existing_final.path,
                "thumbnail_path": existing_final.metadata.get("thumbnail_path"),
                "dry_run": state["input"].dry_run,
                "scene_count": existing_final.metadata.get("scene_count"),
            },
        }

    assets_by_scene: Dict[str, Dict[str, AssetRecord]] = {}
    for asset in state.get("assets", []):
        assets_by_scene.setdefault(asset.scene_id, {})[asset.asset_type] = asset

    scenes: List[Dict[str, Any]] = []
    for scene in state["script"].scenes:
        scene_assets = assets_by_scene.get(scene.scene_id, {})
        clip = scene_assets.get("clip")
        voiceover = scene_assets.get("voiceover")
        if not clip:
            raise RuntimeError(f"Missing clip asset for {scene.scene_id}")
        scenes.append(
            {
                "scene_id": scene.scene_id,
                "visual_path": clip.path,
                "audio_path": voiceover.path if voiceover else None,
                "duration_s": scene.duration_s,
                "has_source_audio": bool(clip.metadata.get("has_source_audio")),
            }
        )

    episode_slug = f"youtube_{state['input'].project_id or 'local'}"
    assembled = await get_registry().get("ffmpeg_assemble").execute(
        {"project_root": state["input"].project_id or ""},
        scenes=scenes,
        episode_slug=episode_slug,
    )
    if not assembled.get("success"):
        raise RuntimeError(f"Video assembly failed: {assembled.get('error')}")
    result = assembled["result"]
    final = AssetRecord(
        scene_id="final",
        asset_type="final_video",
        path=result["video_path"],
        provider="ffmpeg",
        metadata={
            "scene_count": len(state["script"].scenes),
            "thumbnail_path": result.get("thumbnail_path"),
            "had_narration": result.get("had_narration", False),
        },
    )
    return {
        "assets": [final],
        "final_output": {
            "video_path": final.path,
            "thumbnail_path": result.get("thumbnail_path"),
            "dry_run": state["input"].dry_run,
            "scene_count": result.get("scene_count"),
        },
    }


async def compliance_review(state: YouTubeWorkflowState) -> Dict[str, Any]:
    report = ComplianceReport(
        disclosure_required=True,
        blocks_publish=False,
        warnings=["AI-generated media disclosure review is required before upload."],
    )
    return {"compliance": report, **clear_pending_approval()}


async def final_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="final",
        message="Approve the final artifact for local export or private upload.",
        artifact={
            "assets": [asset.model_dump() for asset in state.get("assets", [])],
            "compliance": state["compliance"].model_dump(),
        },
        decisions=["approve", "revise", "reject"],
        revision_targets=["assets", "compliance", "script"],
    )
    return {"pending_approval": payload}


def route_review(state: YouTubeWorkflowState) -> Literal["approve", "revise", "reject"]:
    return state.get("review_decision") or "reject"


async def finish(state: YouTubeWorkflowState) -> Dict[str, Any]:
    return clear_pending_approval()


def build_youtube_graph(checkpointer=None):
    builder = StateGraph(YouTubeWorkflowState)
    builder.add_node("load_channel_profile", load_channel_profile)
    builder.add_node("research", research)
    builder.add_node(GATE_RESEARCH, research_gate)
    builder.add_node("draft_concept", draft_concept)
    builder.add_node(GATE_CONCEPT, concept_gate)
    builder.add_node("write_script", write_script)
    builder.add_node(GATE_SCRIPT, script_gate)
    builder.add_node("production_plan", production_plan)
    builder.add_node(GATE_COST, cost_gate)
    builder.add_node("mark_cost_approved", mark_cost_approved)
    builder.add_node("fanout_assets", fanout_assets)
    builder.add_node("reduce_assets", reduce_assets)
    builder.add_node("assemble_video", assemble_video)
    builder.add_node("compliance_review", compliance_review)
    builder.add_node(GATE_FINAL, final_gate)
    builder.add_node("finish", finish)

    builder.add_edge(START, "load_channel_profile")
    builder.add_edge("load_channel_profile", "research")
    builder.add_edge("research", GATE_RESEARCH)
    builder.add_conditional_edges(
        GATE_RESEARCH,
        route_review,
        {"approve": "draft_concept", "revise": "research", "reject": "finish"},
    )
    builder.add_edge("draft_concept", GATE_CONCEPT)
    builder.add_conditional_edges(
        GATE_CONCEPT,
        route_review,
        {"approve": "write_script", "revise": "draft_concept", "reject": "finish"},
    )
    builder.add_edge("write_script", GATE_SCRIPT)
    builder.add_conditional_edges(
        GATE_SCRIPT,
        route_review,
        {"approve": "production_plan", "revise": "write_script", "reject": "finish"},
    )
    builder.add_edge("production_plan", GATE_COST)
    builder.add_conditional_edges(
        GATE_COST,
        route_review,
        {"approve": "mark_cost_approved", "revise": "production_plan", "reject": "finish"},
    )
    builder.add_edge("mark_cost_approved", "fanout_assets")
    builder.add_edge("fanout_assets", "reduce_assets")
    builder.add_edge("reduce_assets", "assemble_video")
    builder.add_edge("assemble_video", "compliance_review")
    builder.add_edge("compliance_review", GATE_FINAL)
    builder.add_conditional_edges(
        GATE_FINAL,
        route_review,
        {"approve": "finish", "revise": "production_plan", "reject": "finish"},
    )
    builder.add_edge("finish", END)

    return builder.compile(
        checkpointer=checkpointer or MemorySaver(),
        interrupt_after=[GATE_RESEARCH, GATE_CONCEPT, GATE_SCRIPT, GATE_COST, GATE_FINAL],
    )
