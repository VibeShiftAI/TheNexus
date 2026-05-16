from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel

from .graph import build_youtube_graph
from .models import WorkflowInput
from .state import initial_state


router = APIRouter()
_graph = build_youtube_graph()
_runs: Dict[str, Dict[str, Any]] = {}


class ResumeRequest(BaseModel):
    review_decision: str
    review_notes: str | None = None
    revision_target: str | None = None


def _jsonable_state(state: Dict[str, Any]) -> Dict[str, Any]:
    return jsonable_encoder(state)


@router.post("/runs")
async def start_run(body: Dict[str, Any]):
    workflow_input = WorkflowInput(**body)
    run_id = f"yt-{uuid.uuid4().hex[:10]}"
    config = {"configurable": {"thread_id": run_id}}
    result = await _graph.ainvoke(initial_state(workflow_input), config)
    _runs[run_id] = {"run_id": run_id, "config": config, "state": result}
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
    state = _jsonable_state(result)
    return {
        "success": True,
        "run_id": run_id,
        "pending_approval": state.get("pending_approval"),
        "state": state,
    }
