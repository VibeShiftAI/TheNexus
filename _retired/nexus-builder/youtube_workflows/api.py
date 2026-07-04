from __future__ import annotations

import os
import uuid
from collections import OrderedDict
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel

from .graph import build_youtube_graph
from .models import ReviewDecision, RevisionTarget, WorkflowInput
from .state import initial_state


router = APIRouter()
_graph = build_youtube_graph()
MAX_IN_MEMORY_RUNS = 100
_runs: OrderedDict[str, Dict[str, Any]] = OrderedDict()


class ResumeRequest(BaseModel):
    review_decision: ReviewDecision
    review_notes: Optional[str] = None
    revision_target: Optional[RevisionTarget] = None


def _remember_run(run_id: str, run: Dict[str, Any]) -> None:
    _runs[run_id] = run
    _runs.move_to_end(run_id)
    while len(_runs) > MAX_IN_MEMORY_RUNS:
        evictable_id = next(
            (
                key
                for key, value in _runs.items()
                if not value.get("state", {}).get("pending_approval")
            ),
            None,
        )
        if evictable_id is None:
            _runs.popitem(last=False)
        else:
            _runs.pop(evictable_id)


def _jsonable_state(state: Dict[str, Any]) -> Dict[str, Any]:
    return jsonable_encoder(state)


@router.post("/runs")
async def start_run(workflow_input: WorkflowInput):
    if not workflow_input.dry_run and os.getenv("NEXUS_YOUTUBE_LIVE_ENABLED") != "1":
        raise HTTPException(
            status_code=403,
            detail="Live YouTube production runs require NEXUS_YOUTUBE_LIVE_ENABLED=1",
        )
    run_id = f"yt-{uuid.uuid4().hex[:10]}"
    config = {"configurable": {"thread_id": run_id}}
    result = await _graph.ainvoke(initial_state(workflow_input), config)
    _remember_run(run_id, {"run_id": run_id, "config": config, "state": result})
    state = _jsonable_state(result)
    return {
        "success": True,
        "run_id": run_id,
        "pending_approval": state.get("pending_approval"),
        "state": state,
    }


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="YouTube workflow run not found")
    return {"success": True, "run_id": run_id, "state": _jsonable_state(run["state"])}


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str, body: ResumeRequest):
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="YouTube workflow run not found")
    update = {
        "review_decision": body.review_decision,
        "review_notes": body.review_notes,
        "revision_target": body.revision_target,
        "pending_approval": None,
    }
    await _graph.aupdate_state(run["config"], update)
    result = await _graph.ainvoke(None, run["config"])
    run["state"] = result
    _runs.move_to_end(run_id)
    state = _jsonable_state(result)
    return {
        "success": True,
        "run_id": run_id,
        "pending_approval": state.get("pending_approval"),
        "state": state,
    }
