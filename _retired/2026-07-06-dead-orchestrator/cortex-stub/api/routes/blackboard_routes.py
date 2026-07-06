"""
Blackboard API Routes — Exposes the Blackboard as REST endpoints.

Allows external agents (like Praxis) to observe and interact
with the Council of 4's blackboard sessions.
"""

from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from cortex.blackboard import Blackboard

router = APIRouter()


# ── Request/Response Models ─────────────────────────────────────────────

class SessionResponse(BaseModel):
    session_id: str
    topic: str
    status: str
    finding_count: int
    created_at: str
    updated_at: str


class StateResponse(BaseModel):
    session_id: str
    version: int
    sections: dict
    comments: list
    hashtags: list
    raw: str


class FindingResponse(BaseModel):
    worker_id: str
    tool_name: str
    query: str
    content: str
    tags: list


class SubmitFindingRequest(BaseModel):
    worker_id: str
    content: str
    tool_name: str = ""
    query: str = ""
    tags: list = []


class AppendStepRequest(BaseModel):
    agent_id: str
    content: str


class AddCommentRequest(BaseModel):
    agent_id: str
    content: str
    line_ref: Optional[int] = None
    parent_id: Optional[str] = None


# ── Endpoints ───────────────────────────────────────────────────────────

@router.get("/blackboard/sessions")
async def list_sessions():
    """List all blackboard sessions."""
    sessions = Blackboard.list_sessions()
    return {
        "sessions": [
            {
                "session_id": s.session_id,
                "topic": s.topic,
                "status": s.status.value if hasattr(s.status, 'value') else str(s.status),
                "finding_count": s.finding_count,
                "created_at": s.created_at.isoformat() if isinstance(s.created_at, datetime) else str(s.created_at),
                "updated_at": s.updated_at.isoformat() if isinstance(s.updated_at, datetime) else str(s.updated_at),
            }
            for s in sessions
        ]
    }


@router.get("/blackboard/{session_id}/state")
async def get_session_state(session_id: str):
    """Get the full state of a blackboard session (plan, notes, comments, etc.)."""
    try:
        bb = Blackboard.get_or_create(session_id)
        state = bb.read_state()
        return {
            "session_id": session_id,
            "version": state.get("version", 0),
            "sections": {
                k: v for k, v in state.items()
                if k not in ("version", "line_map", "hashtags", "comments", "raw")
            },
            "comments": [
                {
                    "id": c.id,
                    "agent_id": c.agent_id,
                    "content": c.content,
                    "line_ref": c.line_ref,
                    "score": c.score,
                    "promoted": c.promoted,
                }
                for c in state.get("comments", [])
            ],
            "hashtags": state.get("hashtags", []),
            "raw": state.get("raw", ""),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/blackboard/{session_id}/plan")
async def get_plan(session_id: str):
    """Get the current plan from a blackboard session."""
    bb = Blackboard.get_or_create(session_id)
    plan = bb.read_plan()
    return {"session_id": session_id, "plan": plan}


@router.get("/blackboard/{session_id}/findings")
async def get_findings(
    session_id: str,
    worker_id: Optional[str] = None,
    tool_name: Optional[str] = None,
):
    """Get all findings from a session, optionally filtered."""
    bb = Blackboard.get_or_create(session_id)
    findings = bb.get_findings(worker_id=worker_id, tool_name=tool_name)
    return {
        "session_id": session_id,
        "findings": [
            {
                "worker_id": f.worker_id,
                "tool_name": f.tool_name,
                "query": f.query,
                "content": f.content,
                "tags": f.tags,
            }
            for f in findings
        ],
    }


@router.get("/blackboard/{session_id}/synthesis")
async def get_synthesis(session_id: str):
    """Get the synthesis document from a session."""
    bb = Blackboard.get_or_create(session_id)
    synthesis = bb.read_synthesis()
    return {"session_id": session_id, "synthesis": synthesis}


@router.get("/blackboard/{session_id}/context")
async def get_full_context(session_id: str):
    """Get the full context (plan + findings) formatted for LLM consumption."""
    bb = Blackboard.get_or_create(session_id)
    return {"session_id": session_id, "context": bb.get_full_context()}


@router.post("/blackboard/{session_id}/findings")
async def submit_finding(session_id: str, req: SubmitFindingRequest):
    """Submit a new finding to the blackboard."""
    bb = Blackboard.get_or_create(session_id)
    finding = bb.submit_finding(
        worker_id=req.worker_id,
        content=req.content,
        tool_name=req.tool_name,
        query=req.query,
        tags=req.tags,
    )
    if finding is None:
        return {"status": "duplicate", "message": "Finding already exists"}
    return {"status": "ok", "finding_id": finding.id}


@router.post("/blackboard/{session_id}/step")
async def append_step(session_id: str, req: AppendStepRequest):
    """Append a timestamped agent step to the blackboard state."""
    bb = Blackboard.get_or_create(session_id)
    bb.append_step(agent_id=req.agent_id, content=req.content)
    return {"status": "ok"}


@router.post("/blackboard/{session_id}/comments")
async def add_comment(session_id: str, req: AddCommentRequest):
    """Add a comment to the blackboard."""
    bb = Blackboard.get_or_create(session_id)
    comment_id = bb.add_comment(
        agent_id=req.agent_id,
        content=req.content,
        line_ref=req.line_ref,
        parent_id=req.parent_id,
    )
    return {"status": "ok", "comment_id": comment_id}
