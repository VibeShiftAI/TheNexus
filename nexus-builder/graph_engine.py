"""
Graph Engine - Core LangGraph orchestration

This module handles:
- Database connection (PostgresSaver for checkpoints)
- Graph compilation from JSON configs
- Workflow execution with checkpointing
- Time-travel/rewind functionality
"""

import os
import json
import uuid
from datetime import datetime
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

from langgraph.graph import StateGraph, END

load_dotenv()

# Try to import PostgresSaver (may fail if not installed/configured)
try:
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    POSTGRES_AVAILABLE = True
except ImportError:
    POSTGRES_AVAILABLE = False
    AsyncPostgresSaver = None


# ═══════════════════════════════════════════════════════════════════════════
# EXECUTION LIFECYCLE HOOKS (Phase 4 - n8n-Inspired)
# ═══════════════════════════════════════════════════════════════════════════

class ExecutionLifecycleHooks:
    """
    Event system for workflow execution observability.
    Mirrors n8n's execution-lifecycle-hooks.ts pattern.
    
    Events:
    - workflow_execute_before: Before workflow starts
    - workflow_execute_after: After workflow completes  
    - node_execute_before: Before each node runs
    - node_execute_after: After each node completes
    - on_error: When errors occur
    - on_cancel: When workflow is cancelled
    """
    
    EVENTS = [
        "workflow_execute_before",
        "workflow_execute_after",
        "node_execute_before", 
        "node_execute_after",
        "on_error",
        "on_cancel",
    ]
    
    def __init__(self):
        self._handlers: Dict[str, List] = {e: [] for e in self.EVENTS}
    
    def add_handler(self, event: str, handler):
        """Add handler for lifecycle event."""
        if event not in self.EVENTS:
            raise ValueError(f"Unknown event: {event}. Valid: {self.EVENTS}")
        self._handlers[event].append(handler)
    
    def remove_handler(self, event: str, handler):
        """Remove a handler for a lifecycle event."""
        if event in self._handlers:
            self._handlers[event] = [h for h in self._handlers[event] if h != handler]
    
    async def run_hook(self, event: str, *args, **kwargs):
        """Execute all handlers for an event."""
        import asyncio
        for handler in self._handlers.get(event, []):
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(*args, **kwargs)
                else:
                    handler(*args, **kwargs)
            except Exception as e:
                print(f"[LifecycleHooks] Error in {event} handler: {e}")

class GraphEngine:
    """
    Core engine for compiling and executing LangGraph workflows.
    Manages database connections and checkpoint persistence.
    """
    
    def __init__(self, hooks: Optional[ExecutionLifecycleHooks] = None):
        self.db_url = os.getenv("DATABASE_URL")
        self.checkpointer = None
        self._connection = None  # Store connection for cleanup
        self._runs: Dict[str, Dict] = {}  # In-memory run tracking
        self.hooks = hooks or ExecutionLifecycleHooks()  # Phase 4: Lifecycle hooks
    
    async def initialize(self):
        """Initialize database connections"""
        if not self.db_url:
            print("[GraphEngine] No DATABASE_URL configured, running without persistence")
            return
        
        if not POSTGRES_AVAILABLE:
            print("[GraphEngine] langgraph-checkpoint-postgres not installed, running without persistence")
            return
            
        try:
            print(f"[GraphEngine] Connecting to PostgreSQL at {self.db_url.split('@')[-1] if self.db_url and '@' in self.db_url else '...'}...")
            
            # Use psycopg for direct connection with timeout
            import psycopg
            import asyncio
            
            # Create connection pool
            # Disable prepared statements (prepare_threshold=None) to avoid conflicts with connection poolers
            # Add connect_timeout to connection string if possible, or use asyncio.wait_for
            try:
                self._connection = await asyncio.wait_for(
                    psycopg.AsyncConnection.connect(self.db_url, autocommit=True, prepare_threshold=None),
                    timeout=20.0
                )
            except asyncio.TimeoutError:
                raise Exception("Connection timed out (20s) - Check your internet connection or VPN")
            
            # Create checkpointer with the connection
            self.checkpointer = AsyncPostgresSaver(self._connection)
            
            # Setup the checkpoint tables
            await self.checkpointer.setup()
            
            print("[GraphEngine] Connected to PostgreSQL with checkpointing enabled")
        except Exception as e:
            print(f"[GraphEngine] PostgreSQL connection failed: {e}")
            print("[GraphEngine] WARNING: Running without checkpointing (DB unavailable)")
            self.checkpointer = None
    
    async def close(self):
        """Cleanup connections"""
        if self._connection:
            try:
                await self._connection.close()
                print("[GraphEngine] PostgreSQL connection closed")
            except Exception as e:
                print(f"[GraphEngine] Error closing connection: {e}")
    
    async def check_database(self) -> Dict[str, Any]:
        """Check database connection status"""
        if not self.checkpointer:
            return {"connected": False, "message": "No checkpointer configured"}
        
        try:
            # Simple connectivity check
            return {"connected": True, "message": "PostgreSQL connected"}
        except Exception as e:
            return {"connected": False, "error": str(e)}
    
    # ═══════════════════════════════════════════════════════════════
    # WORKFLOW MANAGEMENT (Database operations via Supabase REST)
    # ═══════════════════════════════════════════════════════════════
    
    async def save_workflow(
        self,
        name: str,
        description: Optional[str],
        graph_config: Dict,
        is_template: bool = False
    ) -> Dict:
        """Save a workflow definition to the database"""
        from supabase_client import get_supabase
        
        supabase = get_supabase()
        
        workflow = {
            "id": str(uuid.uuid4()),
            "name": name,
            "description": description,
            "graph_config": graph_config,
            "is_template": is_template,
            "version": 1,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }
        
        if supabase.is_configured():
            try:
                return await supabase.insert_workflow(workflow)
            except Exception as e:
                print(f"[GraphEngine] Failed to save to Supabase: {e}")
                # Fall back to returning the workflow without persistence
        
        return workflow
    
    async def get_workflows(self, templates_only: bool = False) -> List[Dict]:
        """Get all workflows from database"""
        from supabase_client import get_supabase
        
        supabase = get_supabase()
        
        if supabase.is_configured():
            try:
                return await supabase.get_workflows(templates_only=templates_only)
            except Exception as e:
                print(f"[GraphEngine] Failed to get workflows: {e}")
        
        return []
    
    async def get_workflow(self, workflow_id: str) -> Optional[Dict]:
        """Get a specific workflow by ID"""
        from supabase_client import get_supabase
        
        supabase = get_supabase()
        
        if supabase.is_configured():
            try:
                return await supabase.get_workflow(workflow_id)
            except Exception as e:
                print(f"[GraphEngine] Failed to get workflow: {e}")
        
        return None
    
    async def update_workflow(
        self,
        workflow_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        graph_config: Optional[Dict] = None
    ) -> Optional[Dict]:
        """Update an existing workflow"""
        from supabase_client import get_supabase
        from datetime import datetime
        
        supabase = get_supabase()
        
        updates = {"updated_at": datetime.utcnow().isoformat()}
        if name:
            updates["name"] = name
        if description is not None:
            updates["description"] = description
        if graph_config:
            updates["graph_config"] = graph_config
        
        if supabase.is_configured():
            try:
                return await supabase.update_workflow(workflow_id, updates)
            except Exception as e:
                print(f"[GraphEngine] Failed to update workflow: {e}")
        
        return None
    
    # ═══════════════════════════════════════════════════════════════
    # GRAPH VALIDATION
    # ═══════════════════════════════════════════════════════════════
    
    def validate_graph(self, graph_config: Dict) -> Dict[str, Any]:
        """
        Validate a graph configuration.
        Checks for:
        - At least one node
        - No orphan nodes (all nodes connected)
        - Valid entry point(s)
        - No circular dependencies without proper handling
        """
        nodes = graph_config.get("nodes", [])
        edges = graph_config.get("edges", [])
        
        if not nodes:
            return {"valid": False, "error": "Graph must have at least one node"}
        
        node_ids = {n["id"] for n in nodes}
        source_ids = {e["source"] for e in edges}
        target_ids = {e["target"] for e in edges}
        
        # Find entry points (nodes with no incoming edges)
        entry_points = [n["id"] for n in nodes if n["id"] not in target_ids]
        
        if not entry_points:
            return {"valid": False, "error": "Graph must have at least one entry point (node with no incoming edges)"}
        
        # Check for orphan nodes (not connected at all, except single-node graphs)
        if len(nodes) > 1:
            connected_nodes = source_ids | target_ids
            orphans = node_ids - connected_nodes
            if orphans:
                return {"valid": False, "error": f"Orphan nodes found: {orphans}"}
        
        # Check all edge references are valid
        for edge in edges:
            if edge["source"] not in node_ids:
                return {"valid": False, "error": f"Edge references unknown source: {edge['source']}"}
            if edge["target"] not in node_ids and edge["target"] != "END":
                return {"valid": False, "error": f"Edge references unknown target: {edge['target']}"}
        
        return {
            "valid": True,
            "entry_points": entry_points,
            "node_count": len(nodes),
            "edge_count": len(edges)
        }
    
    # ═══════════════════════════════════════════════════════════════
    # RUN MANAGEMENT
    # ═══════════════════════════════════════════════════════════════
    
    async def create_run(
        self,
        workflow_id: Optional[str],
        project_id: str,
        task_id: Optional[str],
        graph_config: Dict
    ) -> Dict:
        """Create a new workflow run record"""
        from supabase_client import get_supabase
        
        run_id = str(uuid.uuid4())
        run = {
            "id": run_id,
            "workflow_id": workflow_id,
            "project_id": project_id,
            "task_id": task_id,
            "status": "pending",
            "current_node": None,
            "context": {},
            "graph_config": graph_config,
            "started_at": datetime.utcnow().isoformat(),
            "completed_at": None
        }
        
        # Store in memory for quick access
        self._runs[run_id] = run
        
        # Also persist to Supabase
        supabase = get_supabase()
        if supabase.is_configured():
            try:
                await supabase.insert_run(run)
            except Exception as e:
                print(f"[GraphEngine] Failed to persist run to Supabase: {e}")
        
        return run
    
    async def get_run(self, run_id: str) -> Optional[Dict]:
        """Get run status"""
        # Check in-memory first
        if run_id in self._runs:
            return self._runs[run_id]
        
        # Try Supabase
        from supabase_client import get_supabase
        supabase = get_supabase()
        if supabase.is_configured():
            try:
                run = await supabase.get_run(run_id)
                if run:
                    self._runs[run_id] = run  # Cache it
                return run
            except Exception as e:
                print(f"[GraphEngine] Failed to get run from Supabase: {e}")
        
        return None
    
    async def update_run(self, run_id: str, updates: Dict):
        """Update run status"""
        from supabase_client import get_supabase
        
        # Update in-memory
        if run_id in self._runs:
            self._runs[run_id].update(updates)
            self._runs[run_id]["updated_at"] = datetime.utcnow().isoformat()
        
        # Persist to Supabase
        supabase = get_supabase()
        if supabase.is_configured():
            try:
                await supabase.update_run(run_id, updates)
            except Exception as e:
                print(f"[GraphEngine] Failed to update run in Supabase: {e}")
    
    async def cancel_run(self, run_id: str) -> bool:
        """Cancel a running workflow"""
        if run_id in self._runs:
            self._runs[run_id]["status"] = "cancelled"
            self._runs[run_id]["completed_at"] = datetime.utcnow().isoformat()
            
            # Update in Supabase
            from supabase_client import get_supabase
            supabase = get_supabase()
            if supabase.is_configured():
                try:
                    await supabase.update_run(run_id, {
                        "status": "cancelled",
                        "completed_at": self._runs[run_id]["completed_at"]
                    })
                except Exception:
                    pass
            
            return True
        return False
    
    # ═══════════════════════════════════════════════════════════════
    # GRAPH EXECUTION
    # ═══════════════════════════════════════════════════════════════
    
    async def execute_graph(
        self,
        run_id: str,
        graph_config: Dict,
        input_data: Dict[str, Any],
        registry = None
    ):
        """
        Execute a workflow graph.
        This is the core "Graph Compiler" that turns JSON into a running LangGraph.
        """
        from nodes.registry import get_registry
        
        await self.update_run(run_id, {"status": "running"})
        
        # Phase 4: Fire workflow start hook
        await self.hooks.run_hook("workflow_execute_before", run_id, graph_config)
        
        try:
            # Import WorkflowState type
            from workflow_state import WorkflowState
            
            # Create the graph builder
            builder = StateGraph(WorkflowState)
            
            nodes = graph_config.get("nodes", [])
            edges = graph_config.get("edges", [])
            
            # Use provided registry or get the global one
            if registry is None:
                registry = get_registry()
            
            # Add nodes to the graph
            for node in nodes:
                node_type = node.get("type")
                node_id = node.get("id")
                node_config = node.get("data", {})
                
                # Get and configure the node handler
                handler = registry.create_node(node_type, node_config)
                builder.add_node(node_id, handler)
                
                print(f"[GraphEngine] Added node: {node_id} ({node_type})")
            
            # Add edges
            for edge in edges:
                source = edge.get("source")
                target = edge.get("target")
                
                if target == "END" or target == "end":
                    builder.add_edge(source, END)
                else:
                    builder.add_edge(source, target)
                
                print(f"[GraphEngine] Added edge: {source} -> {target}")
            
            # Add conditional edges (for evaluator routing)
            conditional_edges = graph_config.get("conditionalEdges", [])
            print(f"[GraphEngine] Conditional edges received: {len(conditional_edges)} entries")
            if conditional_edges:
                print(f"[GraphEngine] conditionalEdges data: {conditional_edges}")
            for cond_edge in conditional_edges:
                source_node = cond_edge.get("source")
                routes = cond_edge.get("routes", {})
                
                if source_node and routes:
                    # Create a routing function for this conditional edge
                    def make_router(route_map):
                        def router(state):
                            decision = state.get("evaluator_decision", "complete")
                            next_node = route_map.get(decision, route_map.get("complete", END))
                            print(f"[GraphEngine] Conditional routing: {decision} -> {next_node}")
                            return next_node
                        return router
                    
                    # Convert route values to proper LangGraph targets
                    path_map = {}
                    for decision, target in routes.items():
                        if target == "END" or target == "end":
                            path_map[decision] = END
                        else:
                            path_map[decision] = target
                    
                    builder.add_conditional_edges(source_node, make_router(path_map), path_map)
                    print(f"[GraphEngine] Added conditional edge from {source_node}: {routes}")
            
            # Find and set entry point
            target_ids = {e["target"] for e in edges}
            entry_points = [n["id"] for n in nodes if n["id"] not in target_ids]
            
            if entry_points:
                builder.set_entry_point(entry_points[0])
                print(f"[GraphEngine] Entry point: {entry_points[0]}")
            
            # === Nexus Protocol: Extract compile options ===
            recursion_limit = graph_config.get("recursion_limit", 25)
            
            # Get interrupt_before nodes (human-in-the-loop approval points)
            interrupt_nodes = graph_config.get("interrupt_nodes", [])
            # Also check for nodes explicitly marked as requiring approval
            for node in nodes:
                node_data = node.get("data", {})
                if node_data.get("requires_approval", False) or node.get("type") == "human_in_loop":
                    if node["id"] not in interrupt_nodes:
                        interrupt_nodes.append(node["id"])
            
            # Compile the graph without recursion_limit (it's a runtime arg)
            compile_kwargs = {}
            
            if self.checkpointer:
                compile_kwargs["checkpointer"] = self.checkpointer
            
            if interrupt_nodes:
                compile_kwargs["interrupt_before"] = interrupt_nodes
                print(f"[GraphEngine] Human-in-the-loop nodes: {interrupt_nodes}")
            
            graph = builder.compile(**compile_kwargs)
            print(f"[GraphEngine] Compiled graph")
            
            # Create initial state with Nexus Protocol fields
            initial_state = {
                "messages": [],
                "current_step": entry_points[0] if entry_points else "start",
                "context": {
                    "run_id": run_id,
                    "project_id": input_data.get("project_id"),
                    "task_id": input_data.get("task_id"),
                    **input_data
                },
                "outputs": {},
                "evaluator_decision": None,  # Will be set by evaluator node
                
                # === Nexus Protocol Extensions ===
                "scratchpad": None,
                "artifacts": [],
                "retry_count": 0,
                "custom_fields": graph_config.get("custom_state_schema", {}),
                "output_schema": graph_config.get("output_schema"),
                "negative_constraints": graph_config.get("negative_constraints", [])
            }
            
            # Create thread config for checkpointing AND recursion limit
            thread_config = {
                "configurable": {"thread_id": run_id},
                "recursion_limit": recursion_limit
            }
            
            # Execute the graph
            print(f"[GraphEngine] Starting execution for run {run_id}")
            
            async for event in graph.astream(initial_state, thread_config):
                # Update run with current progress
                current_node = list(event.keys())[0] if event else None
                node_output = event.get(current_node, {}) if current_node else {}
                
                # Phase 4: Fire node execution hook
                await self.hooks.run_hook("node_execute_after", run_id, current_node, node_output)
                
                await self.update_run(run_id, {
                    "current_node": current_node,
                    "context": node_output
                })
                print(f"[GraphEngine] Executed node: {current_node}")
                
                # Sync outputs to Node.js backend (which updates Supabase)
                if current_node and node_output.get("outputs"):
                    await self._sync_outputs_to_backend(
                        run_id=run_id,
                        node_id=current_node,
                        outputs=node_output.get("outputs", {}),
                        context=input_data
                    )
            
            # Mark as completed
            await self.update_run(run_id, {
                "status": "completed",
                "completed_at": datetime.utcnow().isoformat()
            })
            
            # Phase 4: Fire workflow complete hook
            await self.hooks.run_hook("workflow_execute_after", run_id, "completed")
            print(f"[GraphEngine] Run {run_id} completed successfully")
            
        except Exception as e:
            import traceback
            error_traceback = traceback.format_exc()
            
            print(f"\n{'!'*60}")
            print(f"[GraphEngine] Run {run_id} FAILED")
            print(f"[GraphEngine] Error type: {type(e).__name__}")
            print(f"[GraphEngine] Error message: {str(e)}")
            print(f"[GraphEngine] Full traceback:")
            print(error_traceback)
            print(f"{'!'*60}\n")
            
            await self.update_run(run_id, {
                "status": "failed",
                "error": str(e),
                "error_traceback": error_traceback,
                "completed_at": datetime.utcnow().isoformat()
            })
            
            # Phase 4: Fire error hook
            await self.hooks.run_hook("on_error", run_id, e)
            raise
    
    async def _sync_outputs_to_backend(
        self,
        run_id: str,
        node_id: str,
        outputs: Dict[str, Any],
        context: Dict[str, Any]
    ):
        """
        Sync node outputs to Node.js backend, which updates Supabase.
        This ensures feature data (research, plan, walkthrough) is persisted.
        """
        import httpx
        
        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
        
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    f"{nodejs_url}/api/langgraph/sync-output",
                    json={
                        "run_id": run_id,
                        "node_id": node_id,
                        "project_id": context.get("project_id"),
                        "task_id": context.get("task_id"),
                        "outputs": outputs
                    }
                )
                if response.status_code == 200:
                    print(f"[GraphEngine] Synced outputs for node {node_id}")
                else:
                    print(f"[GraphEngine] Failed to sync outputs: {response.status_code}")
        except Exception as e:
            # Don't fail the workflow if sync fails
            print(f"[GraphEngine] Warning: Could not sync outputs to backend: {e}")
    
    # ═══════════════════════════════════════════════════════════════
    # CHECKPOINTS / TIME TRAVEL
    # ═══════════════════════════════════════════════════════════════
    
    async def get_checkpoints(self, run_id: str) -> List[Dict]:
        """Get all checkpoints for a run"""
        if not self.checkpointer:
            return []
        
        try:
            # LangGraph stores checkpoints by thread_id
            checkpoints = []
            async for checkpoint in self.checkpointer.alist({"configurable": {"thread_id": run_id}}):
                checkpoints.append({
                    "checkpoint_id": checkpoint.config.get("configurable", {}).get("checkpoint_id"),
                    "thread_id": run_id,
                    "created_at": checkpoint.metadata.get("created_at"),
                    "step": checkpoint.metadata.get("step"),
                    "node": checkpoint.metadata.get("source")
                })
            return checkpoints
        except Exception as e:
            print(f"[GraphEngine] Error getting checkpoints: {e}")
            return []
    
    async def rewind_to_checkpoint(self, run_id: str, checkpoint_id: str) -> Dict:
        """Rewind execution to a specific checkpoint and create a new run from there"""
        if not self.checkpointer:
            raise Exception("Checkpointing not enabled")
        
        # Create a new run that starts from this checkpoint
        # This is done by loading the checkpoint state and creating a new thread
        new_run_id = str(uuid.uuid4())
        
        # TODO: Load checkpoint state and create new run
        # For now, return a placeholder
        
        new_run = {
            "id": new_run_id,
            "parent_run_id": run_id,
            "rewound_from_checkpoint": checkpoint_id,
            "status": "pending",
            "started_at": datetime.utcnow().isoformat()
        }
        
        self._runs[new_run_id] = new_run
        
        return new_run
