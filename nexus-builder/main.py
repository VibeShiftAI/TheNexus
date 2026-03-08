"""
TheNexus LangGraph Engine
FastAPI backend for workflow orchestration with LangGraph

Run with: uvicorn main:app --reload
"""
import os
import sys
import asyncio

# Fix for psycopg on Windows (Must be set before any async loops are created)
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Body, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv
from contextlib import asynccontextmanager
import httpx

# Load environment variables
load_dotenv()

# Import our modules
from graph_engine import GraphEngine
from nodes.registry import NodeRegistry, get_registry
from supabase_client import get_supabase
from stream_manager import StreamManager
from fastapi.responses import StreamingResponse



# Lifespan context manager for startup/shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize connections on startup, cleanup on shutdown"""
    # Startup
    print("[LangGraph Engine] Starting up...")
    
    # Initialize stream manager (must be before engine so engine can broadcast)
    app.state.stream_manager = StreamManager()
    
    # Initialize the graph engine with stream manager for SSE broadcasting
    app.state.engine = GraphEngine(stream_manager=app.state.stream_manager)
    await app.state.engine.initialize()
    
    # Load active workflow runs from database into memory
    await _load_active_runs_from_db()
    
    # Initialize atomic nodes registry (user-defined agents deprecated)
    from nodes.registry import get_registry, init_atomic_nodes
    init_atomic_nodes()
    

    print("[LangGraph Engine] Ready!")
    
    yield
    
    # Shutdown
    print("[LangGraph Engine] Shutting down...")
    await app.state.engine.close()

# Create FastAPI app
app = FastAPI(
    title="TheNexus LangGraph Engine",
    description="Workflow orchestration engine using LangGraph",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # Dashboard
        "http://localhost:4000",  # Node.js backend
        "https://nexus.vibeshiftai.com"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



# ═══════════════════════════════════════════════════════════════
# PYDANTIC MODELS
# ═══════════════════════════════════════════════════════════════

class NodeConfig(BaseModel):
    """Configuration for a single node in the workflow"""
    id: str
    type: str  # 'researcher', 'planner', 'coder', 'reviewer', 'supervisor'
    data: Dict[str, Any] = Field(default_factory=dict)
    position: Optional[Dict[str, float]] = None

class EdgeConfig(BaseModel):
    """Configuration for an edge between nodes"""
    id: str
    source: str
    target: str
    label: Optional[str] = None

class GraphConfig(BaseModel):
    """Full workflow graph configuration from React Flow"""
    nodes: List[NodeConfig]
    edges: List[EdgeConfig]
    conditionalEdges: Optional[List[Dict[str, Any]]] = None
    
class WorkflowCreateRequest(BaseModel):
    """Request to save a new workflow"""
    name: str
    description: Optional[str] = None
    graph_config: GraphConfig
    is_template: bool = False

class WorkflowRunRequest(BaseModel):
    """Request to execute a workflow"""
    workflow_id: Optional[str] = None
    graph_config: Optional[GraphConfig] = None  # Can provide inline
    project_id: str
    task_id: Optional[str] = None
    input_data: Dict[str, Any] = Field(default_factory=dict)

class CheckpointRequest(BaseModel):
    """Request to rewind to a checkpoint"""
    checkpoint_id: str

class TemplateSaveRequest(BaseModel):
    """Request to save a workflow as a template"""
    name: str
    description: str
    nodes: List[NodeConfig]
    edges: List[EdgeConfig]
    level: str = "task"  # 'dashboard', 'project', or 'task'
    overwrite: bool = False

class FileContent(BaseModel):
    """Uploaded file content"""
    name: str
    content: str
    type: str = "text/plain"

class AIBuilderRequest(BaseModel):
    """Request for the AI Workflow Builder"""
    user_request: str
    session_id: Optional[str] = None
    project_id: Optional[str] = None
    existing_workflow: Optional[Dict[str, Any]] = None
    files: Optional[List[FileContent]] = None  # Uploaded file contents
    use_cortex_brain: Optional[bool] = False  # Route to full Cortex pipeline


# ═══════════════════════════════════════════════════════════════
# HEALTH & INFO ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "service": "TheNexus LangGraph Engine",
        "status": "running",
        "version": "1.0.0"
    }

@app.get("/health")
async def health():
    """Detailed health check"""
    from nodes.registry import get_registry
    engine: GraphEngine = app.state.engine
    registry = get_registry()
    
    return {
        "status": "healthy",
        "database": await engine.check_database(),
        "node_types": list(registry.get_all_descriptions())
    }

@app.get("/node-types")
async def get_node_types():
    """Get available node types for the visual builder.
    Returns dict keyed by type_id for frontend compatibility.
    """
    from nodes.registry import get_registry, init_atomic_nodes
    init_atomic_nodes()
    registry = get_registry()
    
    # Convert array to dict keyed by typeId for frontend
    descriptions = registry.get_all_descriptions()
    result = {}
    for desc in descriptions:
        # Handle both dict and Pydantic model
        if hasattr(desc, 'model_dump'):
            desc = desc.model_dump()
        elif hasattr(desc, '__dict__') and not isinstance(desc, dict):
            desc = dict(desc)
        
        type_id = desc.get("type") or desc.get("typeId") or desc.get("type_id") or desc.get("id", "unknown")
        result[type_id] = {
            "name": desc.get("displayName") or desc.get("name", type_id),
            "icon": desc.get("icon", "🤖"),
            "description": desc.get("description", ""),
            "category": desc.get("category", "agent"),
            "levels": desc.get("levels", ["dashboard", "project", "task"]),
            "properties": desc.get("properties", []),
        }
    return result


@app.get("/node-types/atomic")
async def get_atomic_node_types():
    """
    Get atomic node types with full property schemas.
    Used by Phase 3 Visual Builder for dynamic configuration panels.
    """
    try:
        from nodes.registry import get_atomic_registry, init_atomic_nodes
        
        # Ensure nodes are initialized
        init_atomic_nodes()
        
        atomic_registry = get_atomic_registry()
        descriptions = atomic_registry.get_all_descriptions()
        
        return {
            "success": True,
            "node_types": descriptions,
            "count": len(descriptions)
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e),
            "node_types": []
        }


@app.get("/node-types/atomic/{type_id}")
async def get_atomic_node_schema(type_id: str):
    """
    Get property schema for a specific atomic node type.
    Returns the properties array that drives dynamic UI generation.
    """
    try:
        from nodes.registry import get_atomic_registry, init_atomic_nodes
        
        init_atomic_nodes()
        atomic_registry = get_atomic_registry()
        node_instance = atomic_registry.get_node_instance(type_id)
        
        if not node_instance:
            raise HTTPException(status_code=404, detail=f"Node type '{type_id}' not found")
        
        # Use get_description() which merges base properties + subclass properties
        description = node_instance.get_description()
        return {
            "type_id": type_id,
            "display_name": description.get("displayName", node_instance.display_name),
            "description": description.get("description", node_instance.description),
            "category": description.get("category", node_instance.category),
            "icon": description.get("icon", node_instance.icon),
            "properties": description.get("properties", []),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════════
# ARTIFACT DISCOVERY API (Universal Artifact System)
# ═══════════════════════════════════════════════════════════════

@app.get("/api/artifacts/types")
async def get_artifact_types():
    """
    Get available artifact categories.
    Used by UI to display artifact type filters.
    """
    from nodes.artifacts import ArtifactCategory
    return {
        "categories": [
            {"value": c.value, "label": c.value.title()} 
            for c in ArtifactCategory
        ]
    }


@app.get("/api/artifacts/{task_id}")
async def get_task_artifacts(task_id: str):
    """
    Get all artifacts for a task.
    Returns list of artifacts with metadata for UI display.
    
    Note: In production, this would query a database or cache.
    For now, returns empty list (artifacts are stored in workflow state).
    """
    # TODO: Implement persistent artifact storage
    # For now, artifacts are stored in-memory during workflow execution
    # and passed through state["artifacts"]
    return {
        "task_id": task_id,
        "artifacts": [],
        "message": "Artifacts are currently stored in workflow state. Use /api/langgraph/run sync to access."
    }


@app.post("/api/artifacts/store")
async def store_artifact(artifact_data: Dict[str, Any] = Body(...)):
    """
    Store an artifact externally.
    Used by nodes to persist artifacts beyond workflow execution.
    
    Body:
        key: str - Artifact key
        content: Any - Artifact content
        category: str - ArtifactCategory value
        task_id: str - Associated task
        project_id: str - Associated project
    """
    from nodes.artifacts import ArtifactStore, ArtifactCategory
    
    # Create a temporary store for validation
    store = ArtifactStore(
        workflow_run_id="external",
        task_id=artifact_data.get("task_id", ""),
        project_id=artifact_data.get("project_id", ""),
    )
    
    # Map category string to enum
    category_str = artifact_data.get("category", "custom")
    try:
        category = ArtifactCategory(category_str)
    except ValueError:
        category = ArtifactCategory.CUSTOM
    
    # Store artifact
    artifact = store.store_simple(
        key=artifact_data.get("key", "unnamed"),
        content=artifact_data.get("content", ""),
        name=artifact_data.get("name", ""),
        category=category,
        producer_node_type=artifact_data.get("producer", "external"),
    )
    
    return {
        "success": True,
        "artifact": artifact.to_dict()
    }


# ═══════════════════════════════════════════════════════════════
# ARTIFACT COMMENTS API (Inline commenting for review)
# ═══════════════════════════════════════════════════════════════

from nodes.artifacts.comments import comment_store


@app.get("/api/artifacts/{artifact_id}/comments")
async def get_artifact_comments(artifact_id: str):
    """
    Get all comments for an artifact.
    
    Returns comments sorted by line number, then creation time.
    Used by the ArtifactPanel to display inline comments.
    """
    comments = await comment_store.get_comments_async(artifact_id)
    return {
        "artifact_id": artifact_id,
        "comments": [c.to_dict() for c in comments],
        "count": len(comments),
        "is_persistent": comment_store.is_persistent,
    }


@app.post("/api/artifacts/{artifact_id}/comments")
async def add_artifact_comment(artifact_id: str, body: Dict[str, Any] = Body(...)):
    """
    Add an inline comment to an artifact.
    
    Body:
        line_number: int - 1-indexed line number (0 for file-level comment)
        content: str - Comment text (markdown supported)
        author: str - Author identifier (optional, defaults to "user")
    """
    comment = await comment_store.add_comment_async(
        artifact_id=artifact_id,
        line_number=body.get("line_number", 0),
        content=body.get("content", ""),
        author=body.get("author", "user"),
    )
    return {"success": True, "comment": comment.to_dict()}


@app.post("/api/comments/{comment_id}/resolve")
async def resolve_comment(comment_id: str):
    """
    Mark a comment thread as resolved.
    
    Resolved comments are typically hidden in the UI but kept for history.
    """
    success = await comment_store.resolve_comment_async(comment_id)
    if success:
        return {"success": True, "message": "Comment resolved"}
    return {"success": False, "error": "Comment not found"}


@app.post("/api/comments/{comment_id}/unresolve")
async def unresolve_comment(comment_id: str):
    """Re-open a resolved comment thread."""
    success = await comment_store.unresolve_comment_async(comment_id)
    if success:
        return {"success": True, "message": "Comment unresolved"}
    return {"success": False, "error": "Comment not found"}


@app.post("/api/comments/{comment_id}/reply")
async def reply_to_comment(comment_id: str, body: Dict[str, Any] = Body(...)):
    """
    Add a reply to an existing comment thread.
    
    Body:
        content: str - Reply text
        author: str - Author identifier (optional)
    """
    reply = await comment_store.add_reply_async(
        comment_id=comment_id,
        content=body.get("content", ""),
        author=body.get("author", "user"),
    )
    if reply:
        return {"success": True, "reply": reply.to_dict()}
    return {"success": False, "error": "Parent comment not found"}


@app.delete("/api/comments/{comment_id}")
async def delete_comment(comment_id: str):
    """Delete a comment and all its replies."""
    success = await comment_store.delete_comment_async(comment_id)
    if success:
        return {"success": True, "message": "Comment deleted"}
    return {"success": False, "error": "Comment not found"}


@app.get("/api/comments/stats")
async def get_comment_stats():
    """Get comment storage statistics (for debugging)."""
    return comment_store.get_stats()


# ═══════════════════════════════════════════════════════════════
# UNIFIED AGENTS API (Single source of truth for all nodes)
# ═══════════════════════════════════════════════════════════════

class AgentCreateRequest(BaseModel):
    """Request to create a new agent/node"""
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    category: Optional[str] = "agent"
    default_model: Optional[str] = ""
    system_prompt: Optional[str] = ""
    max_turns: Optional[int] = 10
    thinking_budget: Optional[int] = None
    parameters: Optional[Dict[str, Any]] = None

class AgentUpdateRequest(BaseModel):
    """Request to update an agent/node"""
    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    default_model: Optional[str] = None
    system_prompt: Optional[str] = None
    max_turns: Optional[int] = None
    thinking_budget: Optional[int] = None
    parameters: Optional[Dict[str, Any]] = None


@app.get("/agents")
async def get_all_agents():
    """
    Get all built-in atomic nodes.
    User-defined agents deprecated - new agents should be added as AtomicNode classes.
    """
    from nodes.registry import get_registry, init_atomic_nodes
    
    try:
        # Initialize built-in nodes
        init_atomic_nodes()
        registry = get_registry()
        
        # Get all atomic node descriptions
        all_nodes = registry.get_all_descriptions()
        
        # Convert to agents dict for frontend compatibility
        agents_dict = {}
        nodes_list = []
        for node in all_nodes:
            # Convert Pydantic model to dict if needed
            if hasattr(node, 'model_dump'):
                node_dict = node.model_dump()
            elif hasattr(node, 'dict'):
                node_dict = node.dict()
            else:
                node_dict = node
            
            nodes_list.append(node_dict)
            
            # base.py get_description() returns: type, displayName, description, category, icon, version, levels
            type_id = node_dict.get("type", node_dict.get("type_id", node_dict.get("typeId", "")))
            agents_dict[type_id] = {
                "id": type_id,
                "name": node_dict.get("displayName", node_dict.get("display_name", node_dict.get("name", ""))),
                "description": node_dict.get("description", ""),
                "category": node_dict.get("category", "agent"),
                "icon": node_dict.get("icon", "🤖"),
                "levels": node_dict.get("levels", []),
                "node_type": node_dict.get("node_type", "atomic"),
                "model": node_dict.get("model", ""),
                "isBuiltIn": True,
            }
        
        return {
            "agents": agents_dict,
            "nodes": nodes_list,
            "count": len(nodes_list)
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/agents/{agent_id}")
async def get_agent(agent_id: str):
    """Get a specific atomic node by ID."""
    from nodes.registry import get_registry, init_atomic_nodes
    
    init_atomic_nodes()
    registry = get_registry()
    
    # Get built-in node
    node = registry.get_node_instance(agent_id)
    if node:
        return node.get_description()
    
    raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")


# NOTE: POST/PUT/DELETE /agents endpoints removed - user-defined agents deprecated
# New agents should be added as AtomicNode classes via Praxis tasks



@app.get("/templates")
async def get_workflow_templates(level: str = None):
    """Get workflow templates from local JSON files.
    
    Args:
        level: Optional filter - 'dashboard', 'project', or 'task'
    """
    import json
    from pathlib import Path
    
    try:
        templates = []
        
        # Read from config/templates/workflows/*.json
        templates_dir = Path(__file__).parent.parent / "config" / "templates" / "workflows"
        
        if templates_dir.exists():
            for json_file in sorted(templates_dir.glob("*.json")):
                try:
                    with open(json_file, "r", encoding="utf-8") as f:
                        template = json.load(f)
                    
                    # Apply optional level filter
                    if level and template.get("level") != level:
                        continue
                    
                    templates.append({
                        "id": template.get("id", json_file.stem),
                        "name": template.get("name"),
                        "description": template.get("description"),
                        "category": template.get("level", "task"),
                        "level": template.get("level", "task"),
                        "workflow_type": template.get("workflow_type"),
                        "stages": template.get("stages", []),
                        "nodes": template.get("nodes", []),
                        "edges": template.get("edges", []),
                        "conditionalEdges": template.get("conditionalEdges", [])
                    })
                except (json.JSONDecodeError, IOError) as file_err:
                    print(f"[Templates] Skipping malformed template {json_file.name}: {file_err}")
        else:
            print(f"[Templates] Templates directory not found: {templates_dir}")
        
        return {"templates": templates}
    except Exception as e:
        print(f"[Templates] Error loading templates: {e}")
        import traceback
        traceback.print_exc()
        return {"templates": [], "error": str(e)}

@app.post("/templates")
async def save_workflow_template(request: TemplateSaveRequest):
    """Save a workflow as a new template JSON file."""
    import json
    import re
    from pathlib import Path
    
    try:
        # Slugify template name for filename
        slug = re.sub(r'[^a-z0-9]+', '-', request.name.lower()).strip('-')
        templates_dir = Path(__file__).parent.parent / "config" / "templates" / "workflows"
        templates_dir.mkdir(parents=True, exist_ok=True)
        
        target_file = templates_dir / f"{slug}.json"
        
        # Check for duplicate
        if target_file.exists() and not request.overwrite:
            raise HTTPException(status_code=409, detail="Template with this name already exists")
        
        # Build template data
        template_data = {
            "id": slug,
            "name": request.name,
            "description": request.description,
            "level": request.level,
            "workflow_type": "custom",
            "is_system": False,
            "nodes": [n.dict() for n in request.nodes],
            "edges": [e.dict() for e in request.edges],
            "stages": []
        }
        
        with open(target_file, "w", encoding="utf-8") as f:
            json.dump(template_data, f, indent=2)
        
        return {"success": True, "message": f"Template saved to {target_file.name}"}
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/templates/{template_id}")
async def delete_workflow_template(template_id: str):
    """Delete a workflow template JSON file by its internal ID."""
    import json
    import os
    from pathlib import Path
    
    try:
        templates_dir = Path(__file__).parent.parent / "config" / "templates" / "workflows"
        
        if not templates_dir.exists():
            raise HTTPException(status_code=404, detail="Templates directory not found")
            
        # Iterate to find the matching ID
        target_file = None
        for json_file in templates_dir.glob("*.json"):
            try:
                with open(json_file, "r", encoding="utf-8") as f:
                    template_data = json.load(f)
                    # Check internal ID, fallback to stem if missing
                    if template_data.get("id", json_file.stem) == template_id:
                        target_file = json_file
                        break
            except (json.JSONDecodeError, IOError):
                pass # skip invalid files
                
        if not target_file:
            raise HTTPException(status_code=404, detail=f"Template with ID '{template_id}' not found")
            
        os.remove(target_file)
        return {"success": True, "message": f"Template '{template_id}' deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════════
# AI TERMINAL INTERACTION (Approve/Reject paused plans)
# ═══════════════════════════════════════════════════════════════

@app.post("/api/terminal/interact")
async def terminal_interact(
    thread_id: str = Form(...),
    action: str = Form(...),
    comment: str = Form("")
):
    """
    Human feedback endpoint for paused Cortex Brain graphs.
    
    Called by the AI Terminal Approve/Critique buttons.
    Resumes the paused LangGraph orchestrator with the human decision.
    """
    try:
        from cortex.api.terminal_bridge import cortex_bridge

        # The bridge's process_request detects approval/rejection signals
        # from the user's message and resumes the paused graph
        feedback_text = f"{action}: {comment}" if comment else action

        artifacts = []
        final_response = ""

        async for artifact in cortex_bridge.process_request(
            user_request=feedback_text,
            session_id=thread_id.replace("terminal_", ""),  # Strip prefix — bridge re-adds it
            stream_artifacts=True
        ):
            artifacts.append(artifact)
            atype = artifact.get("artifact_type", "")
            if atype == "FINAL_RESPONSE":
                final_response = artifact["payload"].get("response", "")
            elif atype == "ERROR":
                final_response = f"Error: {artifact['payload'].get('error', 'Unknown')}"

        return {
            "success": True,
            "thread_id": thread_id,
            "action": action,
            "message": final_response or "Graph resumed and completed",
            "artifacts": artifacts
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# AI WORKFLOW BUILDER ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.post("/ai-builder/chat")
async def ai_builder_chat(request: AIBuilderRequest):
    """
    Chat with the AI Workflow Builder.
    
    Routes to either:
    - Cortex Brain (System 2): Architect → Council Review → Human Review → Compiler → Executor
    - Simple AI Builder: Supervisor → Discovery/Builder/Configurator/Responder
    """
    try:
        import uuid
        
        session_id = request.session_id or str(uuid.uuid4())
        
        # DEBUG: Log incoming request details
        print(f"\n🔍 [AI Builder] Incoming Request:")
        print(f"   • user_request: {request.user_request[:100]}...")
        print(f"   • session_id: {session_id}")
        print(f"   • project_id: {request.project_id}")
        print(f"   • files: {len(request.files) if request.files else 0} file(s)")
        print(f"   • use_cortex_brain: {request.use_cortex_brain}")
        
        # Build the file list for passing to handlers
        files_list = None
        if request.files:
            files_list = []
            for f in request.files:
                print(f"   • File '{f.name}': {len(f.content)} chars, type={f.type}")
                files_list.append({
                    "name": f.name,
                    "content": f.content,
                    "type": f.type
                })
        
        # Build the full user request with file contents
        full_request = request.user_request
        if files_list:
            file_contents = []
            for f in files_list:
                file_contents.append(f"\n--- FILE: {f['name']} ---\n{f['content']}\n--- END FILE ---")
            full_request = f"{request.user_request}\n\nATTACHED FILES:{''.join(file_contents)}"
            print(f"   • Full request length: {len(full_request)} chars")
        
        # ═══════════════════════════════════════════════════════════
        # CORTEX BRAIN ROUTE (System 2 Orchestrator)
        # Full pipeline: Chat Router → Architect → Council → Human Review → Compiler → Executor
        # ═══════════════════════════════════════════════════════════
        if request.use_cortex_brain:
            print(f"🧠 [AI Builder] Routing to Cortex Brain (System 2)...")
            try:
                from cortex.api.terminal_bridge import cortex_bridge
                
                artifacts = []
                final_response = ""
                
                async for artifact in cortex_bridge.process_request(
                    user_request=full_request,
                    session_id=session_id,
                    files=files_list,
                    stream_artifacts=True
                ):
                    artifacts.append(artifact)
                    
                    atype = artifact.get("artifact_type", "")
                    if atype == "FINAL_RESPONSE":
                        final_response = artifact["payload"].get("response", "")
                    elif atype == "CHAT_RESPONSE":
                        final_response = artifact["payload"].get("response", "")
                    elif atype == "AWAITING_HUMAN":
                        final_response = artifact["payload"].get("message", "Awaiting review...")
                    elif atype == "ERROR":
                        final_response = f"Error: {artifact['payload'].get('error', 'Unknown error')}"
                
                return {
                    "success": True,
                    "session_id": session_id,
                    "response": final_response,
                    "workflow": {},
                    "is_complete": False,
                    "messages": [],
                    "mode": "cortex_brain",
                    "artifacts": artifacts
                }
                
            except Exception as cortex_err:
                import traceback
                traceback.print_exc()
                print(f"❌ [AI Builder] Cortex Brain failed: {cortex_err}")
                return {
                    "success": False,
                    "session_id": session_id,
                    "response": f"Cortex Brain error: {str(cortex_err)}",
                    "workflow": {},
                    "is_complete": False,
                    "messages": [],
                    "mode": "cortex_brain_error",
                    "artifacts": []
                }
        
        # ═══════════════════════════════════════════════════════════
        # SIMPLE AI BUILDER ROUTE (Workflow Builder Graph)
        # Supervisor → Discovery/Builder/Configurator/Responder
        # ═══════════════════════════════════════════════════════════
        from ai_builder import handle_builder_request
        
        # Get stream manager from app state
        stream_manager = getattr(app.state, "stream_manager", None)
        
        result = await handle_builder_request(
            session_id=session_id,
            user_request=full_request,
            project_id=request.project_id,
            existing_workflow=request.existing_workflow,
            stream_manager=stream_manager
        )
        
        return {
            "success": True,
            "session_id": session_id,
            "response": result["response"],
            "workflow": result["workflow"],
            "is_complete": result["is_complete"],
            "messages": result["messages"],
            "mode": "simple_responder"
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/ai-builder/sessions")
async def list_builder_sessions(user_id: Optional[str] = None):
    """List active builder sessions"""
    try:
        from ai_builder import get_session_manager
        manager = get_session_manager()
        
        # Cleanup stale sessions first
        manager.cleanup_stale_sessions()
        
        if user_id:
            sessions = manager.get_user_sessions(user_id)
        else:
            # For now, just return count if no user_id (or all active IDs)
            # In production, we'd filter by authenticated user
            return {"active_sessions": manager.get_session_count()}
            
        return {"sessions": sessions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/ai-builder/sessions/{session_id}")
async def delete_builder_session(session_id: str):
    """Delete/Clear a builder session"""
    try:
        from ai_builder import get_session_manager
        manager = get_session_manager()
        
        success = await manager.delete_session(session_id)
        if not success:
            raise HTTPException(status_code=404, detail="Session not found")
            
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════════
# WORKFLOW MANAGEMENT ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.post("/workflows")
async def create_workflow(request: WorkflowCreateRequest):
    """Save a new workflow definition to the database"""
    engine: GraphEngine = app.state.engine
    
    try:
        workflow = await engine.save_workflow(
            name=request.name,
            description=request.description,
            graph_config=request.graph_config.model_dump(),
            is_template=request.is_template
        )
        return {"success": True, "workflow": workflow}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/workflows")
async def list_workflows(templates_only: bool = False):
    """List all saved workflows"""
    engine: GraphEngine = app.state.engine
    
    workflows = await engine.get_workflows(templates_only=templates_only)
    return {"workflows": workflows}

@app.get("/workflows/{workflow_id}")
async def get_workflow(workflow_id: str):
    """Get a specific workflow by ID"""
    engine: GraphEngine = app.state.engine
    
    workflow = await engine.get_workflow(workflow_id)
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow

# ═══════════════════════════════════════════════════════════════
# GRAPH COMPILATION & EXECUTION
# ═══════════════════════════════════════════════════════════════

@app.post("/graph/compile")
async def compile_graph(config: GraphConfig):
    """
    Validate and compile a graph configuration.
    This checks that the graph is valid without executing it.
    """
    from nodes.registry import get_registry
    engine: GraphEngine = app.state.engine
    registry = get_registry()
    
    try:
        # Validate all node types exist
        for node in config.nodes:
            if not registry.get_node_instance(node.type):
                raise ValueError(f"Unknown node type: {node.type}")
        
        # Validate graph structure (no orphans, has entry point, etc.)
        validation = engine.validate_graph(config.model_dump())
        
        if not validation["valid"]:
            raise ValueError(validation["error"])
        
        return {
            "success": True,
            "message": "Graph is valid and ready to execute",
            "node_count": len(config.nodes),
            "edge_count": len(config.edges),
            "entry_points": validation.get("entry_points", [])
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/graph/run")
async def run_workflow(request: WorkflowRunRequest, background_tasks: BackgroundTasks):
    """
    Execute a workflow. This starts the LangGraph execution
    and returns immediately with a run_id for tracking.
    """
    engine: GraphEngine = app.state.engine
    
    try:
        # Get graph config either from workflow_id or inline
        if request.workflow_id:
            workflow = await engine.get_workflow(request.workflow_id)
            if not workflow:
                raise HTTPException(status_code=404, detail="Workflow not found")
            graph_config = workflow["graph_config"]
        elif request.graph_config:
            graph_config = request.graph_config.model_dump()
        else:
            raise HTTPException(status_code=400, detail="Provide workflow_id or graph_config")
        
        # Create a new run
        run = await engine.create_run(
            workflow_id=request.workflow_id,
            project_id=request.project_id,
            task_id=request.task_id,
            graph_config=graph_config
        )
        
        # Execute in background
        from nodes.registry import get_registry
        registry = get_registry()
        background_tasks.add_task(
            engine.execute_graph,
            run_id=run["id"],
            graph_config=graph_config,
            input_data=request.input_data,
            registry=registry
        )
        
        return {
            "success": True,
            "run_id": run["id"],
            "status": "started",
            "message": "Workflow execution started"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/runs/{run_id}")
async def get_run_status(run_id: str):
    """Get the current status of a workflow run"""
    engine: GraphEngine = app.state.engine
    
    run = await engine.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    return run

@app.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    """Cancel a running workflow"""
    engine: GraphEngine = app.state.engine
    
    success = await engine.cancel_run(run_id)
    
    # Also check Nexus Prime runs (stored in _nexus_runs, not engine._runs)
    if not success and run_id in _nexus_runs:
        _nexus_runs[run_id]["status"] = "cancelled"
        _nexus_runs[run_id]["completed_at"] = __import__('datetime').datetime.utcnow().isoformat()
        await _sync_run_to_db(run_id)
        print(f"[Nexus] Run {run_id} cancelled via API")
        # Notify frontend
        stream_manager: StreamManager = app.state.stream_manager
        await stream_manager.broadcast_log(run_id, "Workflow cancelled by user", "warning")
        success = True
    
    if not success:
        raise HTTPException(status_code=404, detail="Run not found or already completed")
    
    return {"success": True, "message": "Run cancelled"}

@app.get("/runs/{run_id}/stream")
async def stream_run(run_id: str):
    """
    Unified SSE endpoint for real-time workflow visibility.
    Works for ALL workflow types (Nexus Prime, doc-writer, custom graphs).
    """
    stream_manager: StreamManager = app.state.stream_manager
    
    async def event_generator():
        queue = await stream_manager.subscribe(run_id)
        try:
            while True:
                data = await queue.get()
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            await stream_manager.unsubscribe(run_id, queue)
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/runs/{run_id}/history")
async def get_run_history(run_id: str):
    """
    Unified history endpoint for reconnecting to any workflow run.
    Works for both Nexus Prime and generic engine runs.
    """
    run = await _get_run_from_db_or_memory(run_id)
    
    # Also check generic engine runs directly
    if not run:
        engine: GraphEngine = app.state.engine
        run = await engine.get_run(run_id)
    
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    # Extract context — generic runs store it differently than Nexus Prime
    context = run.get("context", {})
    if not context:
        initial_state = run.get("initial_state", {})
        context = initial_state.get("context", {})
    
    return {
        "activity_log": run.get("activity_log", []),
        "context": context,
        "status": run.get("status"),
        "current_node": run.get("current_node"),
        "current_stage": run.get("current_stage"),
        "stages_completed": run.get("stages_completed", []),
        "error": run.get("error"),
        "outputs": run.get("outputs", run.get("artifacts", {})),
        "graph_config": run.get("graph_config"),
        "next": run.get("paused_at")
    }


class RunResumeRequest(BaseModel):
    """Request to resume a paused generic workflow run"""
    approval_action: str = "approve"  # 'approve' or 'reject'
    feedback: Optional[str] = None
    doc_changes: Optional[Dict[str, Any]] = None  # Per-hunk decisions


@app.post("/runs/{run_id}/resume")
async def resume_run(run_id: str, request: RunResumeRequest, background_tasks: BackgroundTasks):
    """
    Unified resume endpoint for ALL paused workflow runs.
    
    Handles both:
    - Nexus Prime / doc-writer workflows (LangGraph native interrupts via _nexus_runs)
    - Generic GraphEngine runs (custom asyncio.Event interrupts)
    """
    
    # ── 1. Check if this is a Nexus Prime / doc-writer run ──
    nexus_run = await _get_run_from_db_or_memory(run_id)
    if nexus_run and run_id in _nexus_runs:
        # Ensure activity_log exists (may be empty from DB restore)
        if "activity_log" not in _nexus_runs[run_id]:
            _nexus_runs[run_id]["activity_log"] = []
        
        # Log the approval action
        _nexus_runs[run_id]["activity_log"].append({
            "timestamp": __import__('datetime').datetime.now().isoformat(),
            "agent": "human",
            "type": "approval",
            "message": f"Human {request.approval_action}: {request.feedback or 'No feedback'}"
        })
        
        # Clear pending approval
        if "pending_approval" in nexus_run:
            del _nexus_runs[run_id]["pending_approval"]
        
        # Sync state to DB before resuming
        await _sync_run_to_db(run_id)
        
        # Build graph state updates
        updates = {}
        
        # Handle doc-writer hunk decisions
        if request.doc_changes:
            existing_outputs = nexus_run.get("outputs", {}) if isinstance(nexus_run, dict) else {}
            updates["outputs"] = {
                **existing_outputs,
                "doc_changes": request.doc_changes
            }
            updates["messages"] = [f"Human reviewed documentation changes: {request.approval_action}"]
        elif request.approval_action == "reject":
            updates["evaluator_decision"] = "human_in_loop"
            updates["messages"] = [f"Human Rejected: {request.feedback}"]
            updates["nexus_protocol_extensions"] = {"status_update": "REJECTED: Revising based on feedback"}
        else:
            updates["messages"] = [f"Human Approved: {request.feedback or 'Proceed'}"]
            updates["nexus_protocol_extensions"] = {"status_update": f"APPROVED: {request.approval_action}"}
        
        # Resume in background
        background_tasks.add_task(_resume_nexus_workflow, run_id, updates)
        
        return {
            "success": True,
            "run_id": run_id,
            "status": "resuming",
            "message": f"Workflow resuming after {request.approval_action}"
        }
    
    # ── 2. Fall back to generic GraphEngine resume ──
    engine: GraphEngine = app.state.engine
    
    run = engine._runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found in engine")
    
    # Build updates from the request
    updates = {
        "approval_action": request.approval_action,
        "feedback": request.feedback,
    }
    if request.doc_changes:
        updates["doc_changes"] = request.doc_changes
    
    success = await engine.resume_run(run_id, updates)
    if not success:
        raise HTTPException(status_code=409, detail="Run is not paused at an interrupt point")
    
    return {
        "success": True,
        "run_id": run_id,
        "status": "resuming",
        "message": f"Workflow resuming after {request.approval_action}"
    }

# ═══════════════════════════════════════════════════════════════
# NEXUS PRIME WORKFLOW (Adversarial Mesh)
# ═══════════════════════════════════════════════════════════════

class NexusRunRequest(BaseModel):
    """Request to run Nexus Prime workflow"""
    project_id: str
    task_id: str
    input_data: Dict[str, Any] = Field(default_factory=dict)

class NexusResumeRequest(BaseModel):
    """Request to resume a paused Nexus workflow"""
    approval_action: str = "approve"
    feedback: Optional[str] = None
    doc_changes: Optional[Dict[str, Any]] = None  # Hunk decisions for doc-writer workflow

class NexusStageUpdate(BaseModel):
    """Real-time stage update from Nexus workflow"""
    run_id: str
    stage: str
    status: str
    message: Optional[str] = None
    artifacts: Optional[Dict[str, Any]] = None

# Store for active Nexus run statuses (cached in memory, persisted to DB)
_nexus_runs: Dict[str, Dict[str, Any]] = {}


async def _load_active_runs_from_db():
    """
    Load active workflow runs from database into memory on startup.
    This restores state after server restart.
    """
    supabase = get_supabase()
    if not supabase.is_configured():
        print("[Nexus] Supabase not configured - skipping run restoration")
        return
    
    try:
        active_runs = await supabase.get_active_nexus_runs()
        for run in active_runs:
            run_id = run.pop("run_id")
            _nexus_runs[run_id] = run
            print(f"[Nexus] Restored run {run_id} from database (status: {run.get('status')})")
        
        if active_runs:
            print(f"[Nexus] Restored {len(active_runs)} active workflow runs from database")
        else:
            print("[Nexus] No active workflow runs to restore")
    except Exception as e:
        print(f"[Nexus] Warning: Failed to load active runs from DB: {e}")


async def _sync_run_to_db(run_id: str, project_id: str = None, task_id: str = None):
    """
    Persist the current run state to the database.
    Called after each stage update and on completion/failure.
    """
    if run_id not in _nexus_runs:
        return
    
    supabase = get_supabase()
    if not supabase.is_configured():
        return
    
    state = _nexus_runs[run_id]
    
    # Get project_id and task_id from state if not provided
    if not project_id:
        project_id = state.get("project_id")
    if not task_id:
        task_id = state.get("task_id")
    
    try:
        await supabase.upsert_nexus_run(run_id, project_id, task_id, state)
    except Exception as e:
        print(f"[Nexus] Warning: Failed to sync run {run_id} to DB: {e}")


async def _get_run_from_db_or_memory(run_id: str) -> Optional[Dict[str, Any]]:
    """
    Get run state from memory first, fallback to database.
    Checks both Nexus Prime runs and generic engine runs.
    Restores run to memory if found in DB.
    """
    # Check Nexus Prime memory first
    if run_id in _nexus_runs:
        return _nexus_runs[run_id]
    
    # Check generic engine runs
    engine: GraphEngine = app.state.engine
    if run_id in engine._runs:
        return engine._runs[run_id]
    
    # Try loading from database
    supabase = get_supabase()
    if not supabase.is_configured():
        return None
    
    try:
        db_state = await supabase.get_nexus_run(run_id)
        if db_state:
            # Restore to memory cache
            _nexus_runs[run_id] = db_state
            print(f"[Nexus] Restored run {run_id} from database")
            return db_state
    except Exception as e:
        print(f"[Nexus] Warning: Failed to load run {run_id} from DB: {e}")
    
    return None

async def _execute_nexus_workflow(run_id: str, initial_state: Dict[str, Any]):
    """Background task to execute Nexus workflow with stage updates and streaming"""
    stream_manager: StreamManager = app.state.stream_manager
    print(f"[Nexus] Starting workflow execution for run_id: {run_id}")
    
    try:
        # Determine which workflow graph to use based on workflow_type
        workflow_type = initial_state.get("context", {}).get("workflow_type", "nexus-prime")
        
        if workflow_type == "doc-writer":
            from doc_workflow import doc_graph as active_graph
            print(f"[Nexus] Using Documentation Writer workflow")
        else:
            from nexus_workflow import nexus_graph as active_graph
            print(f"[Nexus] Using Nexus Prime workflow")
    except Exception as import_err:
        print(f"[Nexus] IMPORT ERROR: {import_err}")
        _nexus_runs[run_id] = {
            "status": "failed",
            "error": str(import_err),
            "stages_completed": []
        }
        await stream_manager.broadcast_log(run_id, f"Import Error: {import_err}", "error")
        return
    
    # Extract context
    context = initial_state.get('context', {})
    project_id = context.get('project_id')
    task_id = context.get('task_id')
    
    # Phase 6.5: Initialize GlobalContextService for all nodes/agents to access
    try:
        from context.global_context_service import GlobalContextService
        GlobalContextService().initialize(
            project_id=project_id,
            task_id=task_id,
            project_path=context.get('project_path'),
            run_id=run_id,
            execution_id=run_id,
            task_title=context.get('task_title'),
            task_description=context.get('task_description')
        )
    except ImportError as e:
        print(f"[Nexus] Could not initialize GlobalContextService: {e}")
    
    # Initialize state
    _nexus_runs[run_id] = {
        "status": "running",
        "current_stage": workflow_type,
        "stages_completed": [],
        "artifacts": {},
        "activity_log": [],
        "error": None,
        "project_id": project_id,
        "task_id": task_id,
        "initial_state": initial_state,
        "workflow_type": workflow_type
    }
    await _sync_run_to_db(run_id, project_id, task_id)
    await stream_manager.broadcast_log(run_id, f"Workflow started ({workflow_type})", "info")
    
    try:
        config = {"configurable": {"thread_id": run_id}}
        
        # Helper to log activity events (persisted for reconnection)
        def _log_activity(event_type: str, name: str, content: str = "", **extra):
            if "activity_log" not in _nexus_runs[run_id]:
                _nexus_runs[run_id]["activity_log"] = []
            _nexus_runs[run_id]["activity_log"].append({
                "timestamp": __import__('datetime').datetime.now().isoformat(),
                "type": event_type,
                "stage": name,
                "message": content,
                **extra
            })
        
        # Track accumulated agent responses for persistence
        current_agent_response = {"name": "", "content": ""}
        
        # USE astream_events FOR GRANULAR VISIBILITY
        async for event in active_graph.astream_events(initial_state, config, version="v2"):
            # Check for cancellation before processing each event
            if _nexus_runs.get(run_id, {}).get("status") == "cancelled":
                await stream_manager.broadcast_log(run_id, "Workflow cancelled", "warning")
                break
            
            kind = event["event"]
            name = event.get("name", "")
            tags = event.get("tags", [])
            data = event.get("data", {})
            
            # 1. Stream raw event to frontend (for Glass Box UI)
            # We filter out some very verbose unrelated internal events if needed, 
            # but for now we stream most things that have a name.
            if name:
                await stream_manager.publish(run_id, {
                    "type": "graph_event",
                    "kind": kind,
                    "name": name,
                    "data": data if kind != "on_chat_model_stream" else {"chunk": {"content": data.get("chunk", {}).content}}, # Optimize chunk payload
                    "metadata": event.get("metadata", {}),
                    "tags": tags
                })
            
            # ═══════════════════════════════════════════════════════════════
            # 2. PERSIST GRANULAR EVENTS FOR RECONNECTION
            # ═══════════════════════════════════════════════════════════════
            
            # 2a. Accumulate streaming agent responses
            if kind == "on_chat_model_stream":
                chunk_content = ""
                raw_chunk = data.get("chunk", {})
                if hasattr(raw_chunk, 'content'):
                    chunk_content = str(raw_chunk.content)
                
                if current_agent_response["name"] == name:
                    current_agent_response["content"] += chunk_content
                else:
                    # New agent, save previous if exists
                    if current_agent_response["content"]:
                        _log_activity("agent", current_agent_response["name"], current_agent_response["content"][:2000])
                    current_agent_response = {"name": name, "content": chunk_content}
            
            # 2b. Persist tool calls
            elif kind == "on_tool_start":
                _log_activity("tool_start", name, f"Input: {str(data.get('input', ''))[:500]}")
            
            elif kind == "on_tool_end":
                _log_activity("tool_end", name, f"Output: {str(data.get('output', ''))[:500]}")
            
            # 2c. Persist stage completions and extract artifacts
            elif kind == "on_chain_end":
                # Flush any pending agent response
                if current_agent_response["content"]:
                    _log_activity("agent", current_agent_response["name"], current_agent_response["content"][:2000])
                    current_agent_response = {"name": "", "content": ""}
                
                # Check if this is a main node completing
                if name in ["research_fleet", "architect_fleet", "builder_fleet", "audit_fleet", "walkthrough_generator", "nexus_prime"]:
                    _nexus_runs[run_id]["current_stage"] = name
                    if name not in _nexus_runs[run_id]["stages_completed"]:
                        _nexus_runs[run_id]["stages_completed"].append(name)
                    
                    _log_activity("stage_complete", name, f"Completed {name}")
                        
                    # Extract Artifacts
                    output = data.get("output", {})
                    if isinstance(output, dict):
                        # Map artifact outputs to state
                        if "research_dossier" in output:
                            _nexus_runs[run_id]["artifacts"]["research_dossier"] = output["research_dossier"]
                        if "blueprint" in output:
                            _nexus_runs[run_id]["artifacts"]["blueprint"] = output["blueprint"]
                        if "audit_report" in output:
                            _nexus_runs[run_id]["artifacts"]["audit_report"] = output["audit_report"]
                        
                        # Sync to DB after major events
                        await _sync_run_to_db(run_id, project_id, task_id)
            
            # 3. Handle Interrupts
            # astream_events doesn't emit a specific "interrupt" event, but the loop will end if interrupted.
            # We can detect 'on_chain_end' of 'await_research_approval' etc.
            
        print(f"[Nexus] Workflow execution finished (completed or interrupted)")
        
        # Check if we finished due to completion or interrupt
        # We can check the graph state
        snapshot = await active_graph.aget_state(config)
        if snapshot.next:
            print(f"[Nexus] Workflow PAUSED at: {snapshot.next}")
            # Notify frontend of interrupt via stream
            await stream_manager.publish(run_id, {
                "type": "interrupt",
                "interrupts": snapshot.next,
                "values": snapshot.values
            })
            _nexus_runs[run_id]["status"] = "awaiting_input"
            _nexus_runs[run_id]["paused_at"] = list(snapshot.next)
        else:
            _nexus_runs[run_id]["status"] = "completed"
            await stream_manager.broadcast_log(run_id, "Workflow completed successfully", "success")
            # Notify frontend with explicit completion event
            await stream_manager.publish(run_id, {
                "type": "workflow_complete",
                "status": "completed",
                "run_id": run_id
            })
            # CRITICAL: Update the TASK status to "complete" in Node.js backend
            context = initial_state.get('context', {})
            task_id = context.get('task_id')
            if task_id:
                try:
                    import httpx
                    import json as json_mod
                    nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
                    service_key = os.getenv("SUPABASE_SERVICE_KEY")
                    headers = {"Authorization": f"Bearer {service_key}"} if service_key else {}
                    
                    # Extract walkthrough from final graph state (safety net)
                    walkthrough = ""
                    try:
                        run_outputs = snapshot.values.get("outputs", {})
                        walkthrough = run_outputs.get("walkthrough", "")
                        if not walkthrough:
                            sa = run_outputs.get("source_artifacts", {})
                            if isinstance(sa, dict):
                                walkthrough = sa.get("walkthrough", "")
                    except Exception:
                        pass
                    
                    patch_body = {
                        "status": "complete",
                        "status_message": "Workflow completed successfully"
                    }
                    if walkthrough:
                        patch_body["walkthrough"] = json_mod.dumps({
                            "content": walkthrough,
                            "generatedAt": __import__('datetime').datetime.now().isoformat()
                        })
                        print(f"[Nexus] Including walkthrough ({len(walkthrough)} chars) in completion PATCH")
                    else:
                        print(f"[Nexus] ⚠️ No walkthrough found in workflow state for task {task_id}")
                    
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        resp = await client.patch(
                            f"{nodejs_url}/api/tasks/{task_id}",
                            json=patch_body,
                            headers=headers
                        )
                    if resp.status_code == 200:
                        print(f"[Nexus] Task {task_id} marked as complete")
                    else:
                        print(f"[Nexus] Task completion PATCH failed: {resp.status_code}")
                except Exception as e:
                    print(f"[Nexus] Failed to update task status: {e}")

        await _sync_run_to_db(run_id, project_id, task_id)

    except Exception as e:
        import traceback
        print(f"[Nexus] Workflow FAILED: {e}")
        traceback.print_exc()
        _nexus_runs[run_id]["status"] = "failed"
        _nexus_runs[run_id]["error"] = str(e)
        await stream_manager.broadcast_log(run_id, f"Workflow Failed: {e}", "error")
        await _sync_run_to_db(run_id, project_id, task_id)

@app.get("/graph/nexus/{run_id}/stream")
async def stream_nexus_run(run_id: str):
    """
    SSE Endpoint for real-time workflow visibility.
    """
    stream_manager: StreamManager = app.state.stream_manager
    
    async def event_generator():
        queue = await stream_manager.subscribe(run_id)
        try:
            while True:
                # Wait for data
                data = await queue.get()
                # Format as SSE
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            await stream_manager.unsubscribe(run_id, queue)
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/graph/nexus")
async def run_nexus_workflow(request: NexusRunRequest, background_tasks: BackgroundTasks):
    """
    Execute the Nexus Prime workflow (Adversarial Mesh).
    This uses the Star Topology with dynamic routing through:
    - Research Fleet (Gemini Mesh)
    - Architect Fleet (Blueprint generation)
    - Builder Fleet (Implementation with negative constraints)
    - Audit Fleet (Zero-trust verification)
    """
    import uuid
    
    run_id = str(uuid.uuid4())
    
    # Build initial state for Nexus workflow
    initial_state = {
        "messages": [],
        "current_step": "start",
        "context": {
            "project_id": request.project_id,
            "task_id": request.task_id,
            "run_id": run_id,  # Include run_id for artifact sync context
            "task_title": request.input_data.get("task_title", "Untitled Task"),
            "task_description": request.input_data.get("task_description", ""),
            "project_path": request.input_data.get("project_path", ".")
        },
        "outputs": {},
        "evaluator_decision": None,
        "scratchpad": None,
        "artifacts": None,
        "retry_count": 0,
        "custom_fields": None,
        "output_schema": None,
        "negative_constraints": None,
        "nexus_protocol_extensions": None
    }
    
    # Start workflow in background
    background_tasks.add_task(_execute_nexus_workflow, run_id, initial_state)
    
    return {
        "success": True,
        "run_id": run_id,
        "status": "started",
        "message": "Nexus Prime workflow started"
    }

@app.get("/graph/nexus/{run_id}")
async def get_nexus_run_status(run_id: str):
    """Get the current status of a Nexus workflow run"""
    run = await _get_run_from_db_or_memory(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Nexus run not found")
    
    return run

@app.get("/graph/nexus/{run_id}/artifacts")
async def get_nexus_artifacts(run_id: str):
    """Get artifacts from a Nexus workflow run (for Task Modal display)"""
    run = await _get_run_from_db_or_memory(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Nexus run not found")
    
    artifacts = run.get("artifacts", {})
    
    # Map to Task artifact format
    return {
        "researchReport": artifacts.get("research_dossier"),  # Maps to Research Dossier
        "implementationPlan": artifacts.get("blueprint"),      # Maps to Blueprint
        "walkthrough": artifacts.get("audit_report"),          # Maps to Audit Report
        "raw": artifacts
    }

@app.get("/graph/nexus/{run_id}/history")
async def get_nexus_history(run_id: str):
    """Get historical activity log and context for a workflow (for reconnecting/viewing completed workflows)"""
    run = await _get_run_from_db_or_memory(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Nexus run not found")
    
    # Extract context from initial_state
    initial_state = run.get("initial_state", {})
    context = initial_state.get("context", {})
    
    return {
        "activity_log": run.get("activity_log", []),
        "context": context,
        "status": run.get("status"),
        "current_stage": run.get("current_stage"),
        "stages_completed": run.get("stages_completed", []),
        "error": run.get("error"),
        "outputs": run.get("artifacts", {}),
        "next": run.get("paused_at")
    }




async def _resume_nexus_workflow(run_id: str, updates: Optional[Dict[str, Any]] = None):
    """Background task to resume a paused Nexus workflow"""
    stream_manager: StreamManager = app.state.stream_manager
    print(f"[Nexus] Resuming workflow for run_id: {run_id}")
    
    try:
        # Determine which graph to resume based on stored workflow_type
        workflow_type = _nexus_runs.get(run_id, {}).get("workflow_type", "nexus-prime")
        
        if workflow_type == "doc-writer":
            from doc_workflow import doc_graph as active_graph
        else:
            from nexus_workflow import nexus_graph as active_graph
    except Exception as import_err:
        print(f"[Nexus] RESUME IMPORT ERROR: {import_err}")
        return
    
    _nexus_runs[run_id]["status"] = "running"
    await stream_manager.broadcast_log(run_id, "Resuming workflow...", "info")
    
    try:
        config = {"configurable": {"thread_id": run_id}}
        
        # Apply updates (Human Feedback) before resuming
        if updates:
            print(f"[Nexus] Applying state updates before resume: {updates}")
            await active_graph.aupdate_state(config, updates)
        
        # Resume with astream_events
        # Pass None to resume from interrupt
        async for event in active_graph.astream_events(None, config, version="v2"):
            # Check for cancellation before processing each event
            if _nexus_runs.get(run_id, {}).get("status") == "cancelled":
                await stream_manager.broadcast_log(run_id, "Workflow cancelled", "warning")
                break
            
            kind = event["event"]
            name = event.get("name", "")
            data = event.get("data", {})
            tags = event.get("tags", [])
            
            # Stream Event
            if name:
                 await stream_manager.publish(run_id, {
                    "type": "graph_event",
                    "kind": kind,
                    "name": name,
                    "data": data if kind != "on_chat_model_stream" else {"chunk": {"content": data.get("chunk", {}).content}},
                    "metadata": event.get("metadata", {}),
                    "tags": tags
                })
            
            # Persist State logic (simplified same as above)
            if kind == "on_chain_end" and name in ["research_fleet", "architect_fleet", "builder_fleet", "audit_fleet", "walkthrough_generator", "nexus_prime"]:
                _nexus_runs[run_id]["current_stage"] = name
                output = data.get("output", {})
                if isinstance(output, dict):
                    if "research_dossier" in output: _nexus_runs[run_id]["artifacts"]["research_dossier"] = output["research_dossier"]
                    if "blueprint" in output: _nexus_runs[run_id]["artifacts"]["blueprint"] = output["blueprint"]
                    if "audit_report" in output: _nexus_runs[run_id]["artifacts"]["audit_report"] = output["audit_report"]
                await _sync_run_to_db(run_id)

        # Check final status
        snapshot = await active_graph.aget_state(config)
        if snapshot.next:
            print(f"[Nexus] Workflow PAUSED at: {snapshot.next}")
            _nexus_runs[run_id]["status"] = "awaiting_input"
            _nexus_runs[run_id]["paused_at"] = list(snapshot.next)
            # Notify interrupt
            await stream_manager.publish(run_id, {
                "type": "interrupt",
                "interrupts": snapshot.next,
                "values": snapshot.values
            })
        else:
            _nexus_runs[run_id]["status"] = "completed"
            await stream_manager.broadcast_log(run_id, "Workflow completed successfully", "success")
            # Notify frontend with explicit completion event
            await stream_manager.publish(run_id, {
                "type": "workflow_complete",
                "status": "completed",
                "run_id": run_id
            })
            # CRITICAL: Update the TASK status to "complete" in Node.js backend
            task_id = _nexus_runs[run_id].get("task_id")
            if task_id:
                try:
                    import httpx
                    import json as json_mod
                    nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
                    service_key = os.getenv("SUPABASE_SERVICE_KEY")
                    headers = {"Authorization": f"Bearer {service_key}"} if service_key else {}
                    
                    # Extract walkthrough from final graph state (safety net)
                    walkthrough = ""
                    try:
                        run_outputs = snapshot.values.get("outputs", {})
                        walkthrough = run_outputs.get("walkthrough", "")
                        if not walkthrough:
                            sa = run_outputs.get("source_artifacts", {})
                            if isinstance(sa, dict):
                                walkthrough = sa.get("walkthrough", "")
                    except Exception:
                        pass
                    
                    patch_body = {
                        "status": "complete",
                        "status_message": "Workflow completed successfully"
                    }
                    if walkthrough:
                        patch_body["walkthrough"] = json_mod.dumps({
                            "content": walkthrough,
                            "generatedAt": __import__('datetime').datetime.now().isoformat()
                        })
                        print(f"[Nexus] Including walkthrough ({len(walkthrough)} chars) in completion PATCH")
                    else:
                        print(f"[Nexus] ⚠️ No walkthrough found in workflow state for task {task_id}")
                    
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        resp = await client.patch(
                            f"{nodejs_url}/api/tasks/{task_id}",
                            json=patch_body,
                            headers=headers
                        )
                    if resp.status_code == 200:
                        print(f"[Nexus] Task {task_id} marked as complete")
                    else:
                        print(f"[Nexus] Task completion PATCH failed: {resp.status_code}")
                except Exception as e:
                    print(f"[Nexus] Failed to update task status: {e}")
            
        await _sync_run_to_db(run_id)
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        _nexus_runs[run_id]["status"] = "failed"
        _nexus_runs[run_id]["error"] = str(e)
        await stream_manager.broadcast_log(run_id, f"Resume Failed: {e}", "error")
        await _sync_run_to_db(run_id)


@app.post("/graph/nexus/{run_id}/resume")
async def resume_nexus_workflow(run_id: str, request: RunResumeRequest, background_tasks: BackgroundTasks):
    """
    Legacy Nexus-specific resume endpoint. Delegates to unified /runs/{run_id}/resume.
    Kept for backward compatibility with any callers using this path.
    """
    return await resume_run(run_id, request, background_tasks)


# ═══════════════════════════════════════════════════════════════
# TIME TRAVEL / CHECKPOINTING
# ═══════════════════════════════════════════════════════════════

@app.get("/runs/{run_id}/checkpoints")
async def get_checkpoints(run_id: str):
    """Get all checkpoints for a run (for time-travel debugging)"""
    engine: GraphEngine = app.state.engine
    
    checkpoints = await engine.get_checkpoints(run_id)
    return {"checkpoints": checkpoints}

@app.post("/runs/{run_id}/rewind")
async def rewind_to_checkpoint(run_id: str, request: CheckpointRequest):
    """Rewind execution to a specific checkpoint"""
    engine: GraphEngine = app.state.engine
    
    try:
        new_run = await engine.rewind_to_checkpoint(run_id, request.checkpoint_id)
        return {
            "success": True,
            "new_run_id": new_run["id"],
            "message": f"Rewound to checkpoint {request.checkpoint_id}"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# CODEX DOCUMENTATION ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.get("/codex/docs")
async def get_codex_docs(category: Optional[str] = None):
    """Get all Codex documentation"""
    engine: GraphEngine = app.state.engine
    if not engine._connection:
       return {"docs": []}

    try:
        import psycopg
        # Access the connection from the engine (assuming it shares the pool or connection)
        # Note: GraphEngine uses a single connection for checkpointing, we should probably use a pool or cursor
        # For now, we'll reuse the connection if possible or create a new one cursor
        
        async with engine._connection.cursor(row_factory=psycopg.rows.dict_row) as cur:
            if category:
                await cur.execute(
                    "SELECT id, slug, title, content, category, tags, created_at, updated_at FROM codex_docs WHERE category = %s ORDER BY title ASC",
                    (category,)
                )
            else:
                await cur.execute(
                    "SELECT id, slug, title, content, category, tags, created_at, updated_at FROM codex_docs ORDER BY category, title ASC"
                )
            rows = await cur.fetchall()
            return {"docs": rows}
    except Exception as e:
        print(f"[Codex] Error fetching docs: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/codex/docs/{slug}")
async def get_codex_doc(slug: str):
    """Get a specific documentation article by slug"""
    engine: GraphEngine = app.state.engine
    if not engine._connection:
       raise HTTPException(status_code=503, detail="Database not connected")

    try:
        import psycopg
        async with engine._connection.cursor(row_factory=psycopg.rows.dict_row) as cur:
            await cur.execute(
                "SELECT * FROM codex_docs WHERE slug = %s",
                (slug,)
            )
            doc = await cur.fetchone()
            
            if not doc:
                raise HTTPException(status_code=404, detail="Document not found")
            return doc
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Codex] Error fetching doc {slug}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ═══════════════════════════════════════════════════════════════
# PROXY TO NODE.JS BACKEND
# ═══════════════════════════════════════════════════════════════

NODEJS_BACKEND = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")

@app.get("/proxy/projects")
async def proxy_projects():
    """Proxy request to get projects from Node.js backend"""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{NODEJS_BACKEND}/api/projects")
        return response.json()

@app.get("/proxy/projects/{project_id}")
async def proxy_project(project_id: str):
    """Proxy request to get a specific project"""
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{NODEJS_BACKEND}/api/projects/{project_id}")
        return response.json()


if __name__ == "__main__":
    import uvicorn
    # Use loop_factory to ensure SelectorEventLoop is used (required for psycopg on Windows)
    uvicorn.run("main:app", host="0.0.0.0", port=8000, loop="asyncio", access_log=False)
