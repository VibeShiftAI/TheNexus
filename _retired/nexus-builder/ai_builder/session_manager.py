"""
AI Workflow Builder Session Manager - Phase 8

Manages multi-turn conversation sessions for the workflow builder.
Reference: packages/@n8n/ai-workflow-builder.ee/src/session-manager.service.ts

Features:
1. Session isolation - multiple users can build workflows concurrently
2. Session persistence - sessions survive server restarts (optional)
3. Session cleanup - stale sessions are automatically cleaned up
"""

from typing import Dict, Optional, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import threading
import asyncio

from .state import BuilderState, create_initial_builder_state
from .tools import apply_operations_to_workflow


# ═══════════════════════════════════════════════════════════════════════════
# SESSION DATA
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class BuilderSession:
    """
    A workflow builder session.
    
    Tracks the conversation state and workflow being constructed.
    """
    session_id: str
    state: BuilderState
    created_at: datetime = field(default_factory=datetime.utcnow)
    last_accessed: datetime = field(default_factory=datetime.utcnow)
    project_id: Optional[str] = None
    user_id: Optional[str] = None
    
    def touch(self):
        """Update last accessed timestamp."""
        self.last_accessed = datetime.utcnow()
    
    def is_stale(self, max_age_minutes: int = 60) -> bool:
        """Check if session is stale (not accessed recently)."""
        age = datetime.utcnow() - self.last_accessed
        return age > timedelta(minutes=max_age_minutes)


# ═══════════════════════════════════════════════════════════════════════════
# SESSION MANAGER SINGLETON
# ═══════════════════════════════════════════════════════════════════════════

class SessionManager:
    """
    Singleton manager for workflow builder sessions.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/session-manager.service.ts
    """
    
    _instance: Optional["SessionManager"] = None
    _lock = threading.Lock()
    
    def __new__(cls) -> "SessionManager":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self._sessions: Dict[str, BuilderSession] = {}
        self._cleanup_interval_minutes = 15
        self._max_session_age_minutes = 60
        self._initialized = True
    
    async def _persist_session(self, session: BuilderSession) -> None:
        """Persist session to database (fire and forget)."""
        from supabase_client import get_supabase
        
        supabase = get_supabase()
        if not supabase.is_configured():
            return
            
        try:
            # We map builder session to the 'runs' table
            # status='building', context=state
            data = {
                "id": session.session_id,
                "project_id": session.project_id,
                "status": "building",
                "context": session.state,
                "updated_at": datetime.utcnow().isoformat()
            }
            
            # Using client directly to access specific table logic if needed,
            # but upsert_nexus_run is close enough (though it assumes 'runs' table)
            # Let's use the generic client to be safe and explicit
            
            # Note: upsert_nexus_run does this:
            # await self.client.post("/runs", params={"on_conflict": "id"}, json=data)
            
            await supabase.client.post(
                "/runs", 
                params={"on_conflict": "id"}, 
                json=data
            )
        except Exception as e:
            print(f"[SessionManager] Warning: Failed to persist session {session.session_id}: {e}")

    async def _restore_session(self, session_id: str) -> Optional[BuilderSession]:
        """Try to restore session from database."""
        from supabase_client import get_supabase
        
        supabase = get_supabase()
        if not supabase.is_configured():
            return None
            
        try:
            response = await supabase.client.get(f"/runs?id=eq.{session_id}&select=*")
            if response.status_code != 200:
                return None
                
            rows = response.json()
            if not rows:
                return None
            
            row = rows[0]
            
            # Reconstruct session
            state = row.get("context", {})
            # Ensure state has defaults if DB schema is old
            if "messages" not in state:
                state["messages"] = []
                
            session = BuilderSession(
                session_id=row.get("id"),
                state=state,
                project_id=row.get("project_id"),
                created_at=datetime.fromisoformat(row.get("created_at") or datetime.utcnow().isoformat().replace("Z", "")),
                last_accessed=datetime.utcnow()
            )
            
            # Cache it
            with self._lock:
                self._sessions[session_id] = session
                
            print(f"[SessionManager] Restored session {session_id} from DB")
            return session
        except Exception as e:
            print(f"[SessionManager] Warning: Failed to restore session {session_id}: {e}")
            return None

    async def create_session(
        self,
        session_id: str,
        user_request: str,
        project_id: Optional[str] = None,
        user_id: Optional[str] = None,
        existing_workflow: Optional[Dict[str, Any]] = None
    ) -> BuilderSession:
        """Create a new builder session."""
        initial_state = create_initial_builder_state(
            user_request=user_request,
            session_id=session_id,
            project_id=project_id,
            existing_workflow=existing_workflow
        )
        
        session = BuilderSession(
            session_id=session_id,
            state=initial_state,
            project_id=project_id,
            user_id=user_id
        )
        
        with self._lock:
            self._sessions[session_id] = session
        
        print(f"[SessionManager] Created session {session_id}")
        
        # Persist immediately
        asyncio.create_task(self._persist_session(session))
        
        return session
    
    async def get_session(self, session_id: str) -> Optional[BuilderSession]:
        """Get an existing session by ID (check memory then DB)."""
        session = self._sessions.get(session_id)
        if session:
            session.touch()
            return session
            
        # Try DB restore
        return await self._restore_session(session_id)
    
    async def update_session_state(
        self,
        session_id: str,
        new_state: BuilderState
    ) -> bool:
        """Update a session's state and persist."""
        session = self._sessions.get(session_id)
        if not session:
            return False
        
        # Apply pending operations to workflow
        pending_ops = new_state.get("pending_operations", [])
        if pending_ops:
            updated_workflow = apply_operations_to_workflow(
                new_state.get("workflow", {}),
                pending_ops
            )
            new_state["workflow"] = updated_workflow
            new_state["pending_operations"] = []
        
        session.state = new_state
        session.touch()
        
        # Persist
        asyncio.create_task(self._persist_session(session))
        
        return True
    
    async def add_user_message(
        self,
        session_id: str,
        user_request: str
    ) -> Optional[BuilderState]:
        """Add a new user message to continue the conversation."""
        session = self._sessions.get(session_id)
        if not session:
            # Try restore first if not in memory
            session = await self._restore_session(session_id)
            if not session:
                return None
        
        messages = list(session.state.get("messages", []))
        messages.append({
            "role": "user",
            "content": user_request,
            "timestamp": datetime.utcnow().isoformat()
        })
        
        session.state["messages"] = messages
        session.state["user_request"] = user_request
        session.state["is_complete"] = False
        session.state["next_agent"] = "discovery"
        session.touch()
        
        # Persist
        asyncio.create_task(self._persist_session(session))
        
        return session.state
    
    async def delete_session(self, session_id: str) -> bool:
        """Delete a session from memory and DB."""
        # Memory delete
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
        
        # DB delete
        from supabase_client import get_supabase
        supabase = get_supabase()
        if supabase.is_configured():
            try:
                await supabase.client.delete(f"/runs?id=eq.{session_id}")
            except Exception as e:
                print(f"[SessionManager] Failed to delete session {session_id} from DB: {e}")
                
        print(f"[SessionManager] Deleted session {session_id}")
        return True
    
    def cleanup_stale_sessions(self) -> int:
        """Remove stale sessions from memory (not DB)."""
        # We only clean up memory. DB is persistent history.
        stale_ids = []
        
        with self._lock:
            for session_id, session in self._sessions.items():
                if session.is_stale(self._max_session_age_minutes):
                    stale_ids.append(session_id)
            
            for session_id in stale_ids:
                del self._sessions[session_id]
        
        if stale_ids:
            print(f"[SessionManager] Cleaned up {len(stale_ids)} stale sessions from memory")
        
        return len(stale_ids)
    
    def get_session_count(self) -> int:
        """Get count of active sessions in memory."""
        return len(self._sessions)
    
    def get_user_sessions(self, user_id: str) -> list:
        """Get all sessions for a user (memory only for now)."""
        # TODO: Add DB lookup for comprehensive history
        return [
            s for s in self._sessions.values()
            if s.user_id == user_id
        ]


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def get_session_manager() -> SessionManager:
    """Get the global session manager instance."""
    return SessionManager()


async def handle_builder_request(
    session_id: str,
    user_request: str,
    project_id: Optional[str] = None,
    user_id: Optional[str] = None,
    existing_workflow: Optional[Dict[str, Any]] = None,
    stream_manager: Optional[Any] = None
) -> Dict[str, Any]:
    """
    Handle a workflow builder request.
    
    Creates a new session or continues an existing one.
    Runs the builder graph and returns the result.
    
    Args:
        session_id: Session identifier
        user_request: User's natural language request
        project_id: Optional project context
        user_id: Optional user identifier
        existing_workflow: Optional existing workflow to modify
        stream_manager: Optional StreamManager instance for real-time updates
    
    Returns:
        Dict with session_id, response, workflow, and is_complete
    """
    from .graph import build_workflow_builder_graph
    
    manager = get_session_manager()
    
    # Get or create session
    session = await manager.get_session(session_id)
    
    if session:
        # Continue existing session
        state = await manager.add_user_message(session_id, user_request)
    else:
        # Create new session
        session = await manager.create_session(
            session_id=session_id,
            user_request=user_request,
            project_id=project_id,
            user_id=user_id,
            existing_workflow=existing_workflow
        )
        state = session.state
    
    # Run the builder graph with streaming
    graph = build_workflow_builder_graph()
    final_state = state
    
    if stream_manager:
        await stream_manager.broadcast_log(session_id, f"Processing request: {user_request[:50]}...", "info")
    
    try:
        async for event in graph.astream_events(state, version="v2"):
            kind = event["event"]
            name = event.get("name", "")
            data = event.get("data", {})
            
            # Broadcast interesting events
            if stream_manager:
                # 1. Stream tokens from chat models
                if kind == "on_chat_model_stream":
                    await stream_manager.publish(session_id, {
                        "type": "graph_event",
                        "kind": kind,
                        "name": name,
                        "data": {"chunk": {"content": data.get("chunk", {}).content}}
                    })
                
                # 2. Log tool usage
                elif kind == "on_tool_start":
                    await stream_manager.broadcast_log(
                        session_id, 
                        f"Allocating tool: {name}", 
                        "info"
                    )
                
                # 3. Log agent transitions
                elif kind == "on_chain_start" and name in ["supervisor", "discovery", "builder", "configurator", "responder"]:
                    await stream_manager.broadcast_log(
                        session_id, 
                        f"Agent Active: {name.title()}", 
                        "info"
                    )
            
            # Capture final output
            if kind == "on_chain_end" and name == "LangGraph":
                output = data.get("output")
                if output and isinstance(output, dict):
                    final_state = output
                    
    except Exception as e:
        print(f"[SessionManager] Error during streaming: {e}")
        # Fallback to ainvoke if streaming fails
        final_state = await graph.ainvoke(state)

    # Update session with result
    await manager.update_session_state(session_id, final_state)
    
    return {
        "session_id": session_id,
        "response": final_state.get("final_response", ""),
        "workflow": final_state.get("workflow", {}),
        "is_complete": final_state.get("is_complete", False),
        "messages": final_state.get("messages", []),
    }
