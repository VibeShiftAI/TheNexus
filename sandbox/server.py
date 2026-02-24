"""
Sandbox API Server - FastAPI endpoints for code execution.
"""

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .executor import get_executor
from .models import (
    ExecutionRequest,
    ExecutionResult,
    HealthResponse,
    SessionInfo,
)
from .sessions import get_session_manager

# Configure logging
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    logger.info("🚀 Sandbox API starting...")
    
    # Initialize DB
    from .database import db
    await db.connect()
    
    manager = get_session_manager()
    
    # Cleanup orphaned containers from previous runs
    await manager.cleanup_orphaned_containers()
    
    # Check executor images
    images = manager._verify_images()
    for lang, available in images.items():
        status_icon = "✅" if available else "❌"
        logger.info(f"{status_icon} {lang} executor image")
    
    yield
    
    # Close DB
    await db.disconnect()
    logger.info("👋 Sandbox API shutting down...")


app = FastAPI(
    title="Sandbox Execution API",
    description="Network-isolated code execution for AI agents",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════════════════════
# HEALTH
# ═══════════════════════════════════════════════════════════════════════════

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    manager = get_session_manager()
    return HealthResponse(
        status="healthy",
        docker_available=True,
        executor_images=manager._verify_images(),
    )


# ═══════════════════════════════════════════════════════════════════════════
# SESSIONS
# ═══════════════════════════════════════════════════════════════════════════

@app.post("/sessions", response_model=SessionInfo)
async def create_session(name: str = None):
    """Create a new sandbox session."""
    manager = get_session_manager()
    session = await manager.create_session(name)
    return SessionInfo(
        id=session.id,
        name=session.name,
        created_at=session.created_at,
        last_activity=session.last_activity,
    )


@app.get("/sessions", response_model=list[SessionInfo])
async def list_sessions():
    """List all active sessions."""
    manager = get_session_manager()
    sessions = await manager.list_all_sessions()
    return [
        SessionInfo(
            id=s.id,
            name=s.name,
            created_at=s.created_at,
            last_activity=s.last_activity,
        )
        for s in sessions
    ]


@app.get("/sessions/{session_id}", response_model=SessionInfo)
async def get_session(session_id: str):
    """Get session info."""
    manager = get_session_manager()
    session = await manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return SessionInfo(
        id=session.id,
        name=session.name,
        created_at=session.created_at,
        last_activity=session.last_activity,
    )


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and its containers."""
    manager = get_session_manager()
    success = await manager.delete_session(session_id)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "deleted"}


# ═══════════════════════════════════════════════════════════════════════════
# EXECUTION
# ═══════════════════════════════════════════════════════════════════════════

@app.post("/sessions/{session_id}/execute", response_model=ExecutionResult)
async def execute_code(session_id: str, request: ExecutionRequest):
    """
    Execute code in the sandbox.
    
    For streaming output, set `stream: true` and use the /stream endpoint.
    """
    manager = get_session_manager()
    session = await manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    executor = get_executor()
    return await executor.execute(session_id, request)


@app.post("/sessions/{session_id}/execute/stream")
async def execute_code_stream(session_id: str, request: ExecutionRequest):
    """
    Execute code with streaming output via SSE.
    
    Returns Server-Sent Events with stdout/stderr chunks.
    """
    manager = get_session_manager()
    session = await manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    executor = get_executor()
    
    async def generate() -> AsyncIterator[str]:
        async for chunk in executor.execute_stream(session_id, request):
            yield f"data: {json.dumps(chunk)}\n\n"
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


# ═══════════════════════════════════════════════════════════════════════════
# ROOT
# ═══════════════════════════════════════════════════════════════════════════

@app.get("/")
async def root():
    """API root."""
    return {
        "name": "Sandbox Execution API",
        "version": "1.0.0",
        "docs": "/docs",
    }
