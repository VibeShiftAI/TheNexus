from __future__ import annotations

import json
from typing import Annotated, Any, Dict, List, Optional, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

from .models import (
    ApprovalPayload,
    AssetRecord,
    ChannelProfile,
    ComplianceReport,
    Concept,
    CostEntry,
    ProductionPlan,
    ResearchBrief,
    ReviewDecision,
    RevisionTarget,
    Script,
    WorkflowInput,
)


def append_assets(
    existing: Optional[List[AssetRecord]],
    incoming: Optional[List[AssetRecord]],
) -> List[AssetRecord]:
    merged: List[AssetRecord] = []
    seen: set[tuple[str, str, str, str]] = set()
    for asset in [*(existing or []), *(incoming or [])]:
        identity = (asset.scene_id, asset.asset_type, asset.path, asset.provider)
        if identity in seen:
            continue
        seen.add(identity)
        merged.append(asset)
    return merged


def append_costs(
    existing: Optional[List[CostEntry]],
    incoming: Optional[List[CostEntry]],
) -> List[CostEntry]:
    merged: List[CostEntry] = []
    seen: set[tuple[str, str, float, Optional[str], str]] = set()
    for cost in [*(existing or []), *(incoming or [])]:
        metadata_json = json.dumps(
            cost.metadata,
            sort_keys=True,
            separators=(",", ":"),
        )
        identity = (
            cost.provider,
            cost.operation,
            cost.usd,
            cost.scene_id,
            metadata_json,
        )
        if identity in seen:
            continue
        seen.add(identity)
        merged.append(cost)
    return merged


def append_warnings(
    existing: Optional[List[str]],
    incoming: Optional[List[str]],
) -> List[str]:
    return [*(existing or []), *(incoming or [])]


class YouTubeWorkflowState(TypedDict, total=False):
    messages: Annotated[List[AnyMessage], add_messages]
    input: WorkflowInput
    channel_profile: ChannelProfile
    research_brief: ResearchBrief
    concept: Concept
    script: Script
    production_plan: ProductionPlan
    assets: Annotated[List[AssetRecord], append_assets]
    costs: Annotated[List[CostEntry], append_costs]
    warnings: Annotated[List[str], append_warnings]
    compliance: ComplianceReport
    pending_approval: Optional[ApprovalPayload]
    review_decision: Optional[ReviewDecision]
    review_notes: Optional[str]
    revision_target: Optional[RevisionTarget]
    final_output: Dict[str, Any]


def initial_state(workflow_input: WorkflowInput) -> YouTubeWorkflowState:
    return {
        "messages": [],
        "input": workflow_input,
        "assets": [],
        "costs": [],
        "warnings": [],
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }


def clear_pending_approval() -> Dict[str, Any]:
    return {
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }
