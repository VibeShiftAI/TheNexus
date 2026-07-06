"""
Terminal Routes - File upload and direct injection endpoints.

Enables the Nexus Terminal to send files/content directly to Cortex.
"""

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
import shutil
import os

router = APIRouter()


@router.post("/terminal/upload")
async def upload_file(
    file: UploadFile = File(...),
    comment: str = Form("")
):
    """
    Upload a file from the Nexus Terminal.
    Saves to disk for project context.
    """
    try:
        os.makedirs("data/uploads", exist_ok=True)
        safe_path = f"data/uploads/{file.filename}"
        with open(safe_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        
        return {
            "filename": file.filename,
            "path": safe_path,
            "success": True
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/terminal/interact")
async def interact_with_graph(
    thread_id: str = Form(...),
    action: str = Form(...),  # "APPROVE" or "REJECT"
    comment: str = Form("")
):
    """
    Human feedback endpoint for paused graphs.
    
    Resumes a paused System 2 graph with the human's decision.
    The action is injected as a message and the graph continues.
    """
    from langgraph.types import Command
    from cortex.core.orchestrator import build_system2_graph
    from cortex.core.persistence import CheckpointFactory
    
    try:
        # 1. Get the checkpointer and build graph with it
        checkpointer = await CheckpointFactory.get_saver()
        graph = build_system2_graph(checkpointer=checkpointer)
        
        config = {"configurable": {"thread_id": thread_id}}
        
        # 2. Get current state
        state = await graph.aget_state(config)
        
        if not state.next:
            return {
                "success": False,
                "message": f"Thread {thread_id} is not paused or doesn't exist"
            }
        
        # 3. Inject human feedback as a message
        feedback_content = f"[HUMAN {action}]: {comment}" if comment else f"[HUMAN {action}]"
        
        # 4. Resume the graph with the command
        # The feedback is passed via update_state to add to messages
        await graph.aupdate_state(
            config,
            {"messages": [{"role": "user", "content": feedback_content}]}
        )
        
        # 5. Resume execution
        async for event in graph.astream(None, config):
            print(f"   Resume Event: {list(event.keys())}")
        
        return {
            "success": True,
            "thread_id": thread_id,
            "action": action,
            "message": "Graph resumed and completed"
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/terminal/state/{thread_id}")
async def get_thread_state(thread_id: str):
    """
    Phase 9: State Rehydration API.
    
    Allows frontend to check if a thread has pending state.
    Called on AI Terminal mount to restore interrupted plans.
    """
    from cortex.core.orchestrator import build_system2_graph
    from cortex.core.persistence import CheckpointFactory
    
    try:
        checkpointer = await CheckpointFactory.get_saver()
        graph = build_system2_graph(checkpointer=checkpointer)
        
        config = {"configurable": {"thread_id": thread_id}}
        state = await graph.aget_state(config)
        
        if not state or not state.values:
            return {
                "thread_id": thread_id,
                "exists": False,
                "is_paused": False,
                "markdown_plan": None,
                "compiled_plan": None,
                "current_plan": None,  # Legacy
                "votes": []
            }
        
        # Phase 12: Extract relevant state for frontend
        values = state.values
        markdown_plan = values.get("markdown_plan")
        compiled_plan = values.get("compiled_plan")
        current_plan = values.get("current_plan")  # Legacy fallback
        votes = values.get("votes", [])
        
        return {
            "thread_id": thread_id,
            "exists": True,
            "is_paused": bool(state.next),
            "next_node": state.next[0] if state.next else None,
            # Phase 12 fields
            "markdown_plan": markdown_plan.model_dump() if markdown_plan else None,
            "compiled_plan": compiled_plan.model_dump() if compiled_plan else None,
            # Legacy
            "current_plan": current_plan.model_dump() if current_plan else None,
            "votes": [v.model_dump() for v in votes] if votes else [],
            "simulation_report": values.get("simulation_report").model_dump() if values.get("simulation_report") else None
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
