"""
Council Spawner API Routes — REST endpoint for on-demand Council deliberations.

Allows external agents (like Praxis) to spawn their own
Council of 4 deliberation on any topic.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


class SpawnCouncilRequest(BaseModel):
    topic: str
    context: str = ""
    session_id: Optional[str] = None


class AnalystResult(BaseModel):
    analyst_id: str
    name: str
    analysis: str
    status: str


class CouncilResponse(BaseModel):
    session_id: str
    topic: str
    analyses: list
    synthesis: str
    stats: dict


@router.post("/council/spawn")
async def spawn_council_endpoint(req: SpawnCouncilRequest):
    """
    Spawn a Council of 4 deliberation on any topic.

    All 4 analysts run in parallel using Gemini Flash.
    Results are written to a Blackboard session for persistent access.
    """
    if not req.topic or len(req.topic.strip()) < 5:
        raise HTTPException(status_code=400, detail="Topic must be at least 5 characters")

    try:
        from cortex.agents.standalone_council import spawn_council

        result = await spawn_council(
            topic=req.topic,
            context=req.context,
            session_id=req.session_id,
        )

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Council spawning failed: {str(e)}")
