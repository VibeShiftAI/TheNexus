from __future__ import annotations

from typing import Any, Dict, Literal

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
from .profiles import get_channel_profile
from .provider_router import ProviderRouter
from .state import YouTubeWorkflowState, clear_pending_approval


GATE_CONCEPT = "concept_gate"
GATE_SCRIPT = "script_gate"
GATE_COST = "cost_gate"
GATE_FINAL = "final_gate"


async def load_channel_profile(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    return {"channel_profile": get_channel_profile(workflow_input.channel_profile_id)}


async def research(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    return {
        "research_brief": {
            "summary": f"Dry-run research brief for: {workflow_input.prompt}",
            "sources": [],
        }
    }


async def draft_concept(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    profile = state["channel_profile"]
    concept = Concept(
        title="Nexus Architecture Explainer",
        logline=f"A useful video about {workflow_input.prompt}.",
        audience="Builders and operators using The Nexus.",
        promise="Show the viewer what the system does and why the workflow matters.",
        retention_hook="Open with the concrete outcome before explaining the machinery.",
        outline=[
            "State the practical problem.",
            "Show the workflow shape.",
            "Explain where human review protects quality.",
            "Close with the next action.",
        ],
        risk_notes=list(profile.style_rules),
    )
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


async def fanout_assets(state: YouTubeWorkflowState) -> Dict[str, Any]:
    assets = []
    costs = []
    for scene in state["script"].scenes:
        assets.extend(
            [
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="voiceover",
                    path=f"/tmp/nexus-youtube/{scene.scene_id}.aiff",
                    provider="dry_run",
                ),
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="still",
                    path=f"/tmp/nexus-youtube/{scene.scene_id}.png",
                    provider="dry_run",
                ),
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="clip",
                    path=f"/tmp/nexus-youtube/{scene.scene_id}.mp4",
                    provider="dry_run",
                    metadata={"duration_s": scene.duration_s},
                ),
            ]
        )
        costs.append(
            CostEntry(
                provider="dry_run",
                operation="scene_assets",
                usd=0.0,
                scene_id=scene.scene_id,
            )
        )
    return {"assets": assets, "costs": costs}


async def reduce_assets(state: YouTubeWorkflowState) -> Dict[str, Any]:
    return {}


async def assemble_video(state: YouTubeWorkflowState) -> Dict[str, Any]:
    final = AssetRecord(
        scene_id="final",
        asset_type="final_video",
        path="/tmp/nexus-youtube/final.mp4",
        provider="dry_run",
        metadata={"scene_count": len(state["script"].scenes)},
    )
    return {
        "assets": [final],
        "final_output": {"video_path": final.path, "dry_run": True},
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
    builder.add_node("draft_concept", draft_concept)
    builder.add_node(GATE_CONCEPT, concept_gate)
    builder.add_node("write_script", write_script)
    builder.add_node(GATE_SCRIPT, script_gate)
    builder.add_node("production_plan", production_plan)
    builder.add_node(GATE_COST, cost_gate)
    builder.add_node("fanout_assets", fanout_assets)
    builder.add_node("reduce_assets", reduce_assets)
    builder.add_node("assemble_video", assemble_video)
    builder.add_node("compliance_review", compliance_review)
    builder.add_node(GATE_FINAL, final_gate)
    builder.add_node("finish", finish)

    builder.add_edge(START, "load_channel_profile")
    builder.add_edge("load_channel_profile", "research")
    builder.add_edge("research", "draft_concept")
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
        {"approve": "fanout_assets", "revise": "production_plan", "reject": "finish"},
    )
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
        interrupt_after=[GATE_CONCEPT, GATE_SCRIPT, GATE_COST, GATE_FINAL],
    )
