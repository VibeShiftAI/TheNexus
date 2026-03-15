"""
Graph Engine - Core LangGraph orchestration

This module handles:
- Database connection (SqliteSaver for checkpoints)
- Graph compilation from JSON configs
- Workflow execution with checkpointing
- Time-travel/rewind functionality
"""

import os
import json
import uuid
import asyncio
from datetime import datetime
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

from langgraph.graph import StateGraph, END

load_dotenv()

# Use SQLite for checkpoint persistence (local, no remote DB)
try:
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    SQLITE_CHECKPOINTER_AVAILABLE = True
except ImportError:
    SQLITE_CHECKPOINTER_AVAILABLE = False
    AsyncSqliteSaver = None


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
    
    def __init__(self, hooks: Optional[ExecutionLifecycleHooks] = None, stream_manager=None):
        self.checkpointer = None
        self._db_conn = None  # aiosqlite connection for checkpointer
        self._runs: Dict[str, Dict] = {}  # In-memory run tracking
        self.hooks = hooks or ExecutionLifecycleHooks()  # Phase 4: Lifecycle hooks
        self.stream_manager = stream_manager  # SSE event broadcasting
        self._resume_events: Dict[str, asyncio.Event] = {}  # Interrupt pause/resume
        self._resume_data: Dict[str, Dict] = {}  # Data from resume calls
        self.on_run_complete = None  # Callback: fn(run_id, project_id) for cleanup
    
    async def initialize(self):
        """Initialize SQLite checkpoint persistence"""
        if not SQLITE_CHECKPOINTER_AVAILABLE:
            print("[GraphEngine] langgraph-checkpoint-sqlite not installed, running without persistence")
            return
            
        try:
            import aiosqlite
            from pathlib import Path
            # Use a separate checkpoints.db alongside nexus.db to avoid WAL contention
            db_path = os.getenv("NEXUS_CHECKPOINT_DB_PATH") or str(
                Path(__file__).parent.parent / "checkpoints.db"
            )
            print(f"[GraphEngine] Initializing SQLite checkpointer at {db_path}...")
            
            # Open the aiosqlite connection manually — AsyncSqliteSaver.from_conn_string()
            # returns an async context manager in recent LangGraph versions, so calling
            # .setup() on it directly fails with '_AsyncGeneratorContextManager' error.
            self._db_conn = await aiosqlite.connect(db_path)
            self.checkpointer = AsyncSqliteSaver(self._db_conn)
            await self.checkpointer.setup()
            
            print("[GraphEngine] Connected to SQLite with checkpointing enabled")
        except Exception as e:
            print(f"[GraphEngine] SQLite checkpointer setup failed: {e}")
            print("[GraphEngine] WARNING: Running without checkpointing (DB unavailable)")
            self.checkpointer = None
            self._db_conn = None
    
    async def close(self):
        """Cleanup connections"""
        if self.checkpointer:
            try:
                if self._db_conn:
                    await self._db_conn.close()
                    self._db_conn = None
                print("[GraphEngine] SQLite checkpointer closed")
            except Exception as e:
                print(f"[GraphEngine] Error closing checkpointer: {e}")
    
    async def _ensure_connection(self):
        """Verify the SQLite checkpointer is available.
        
        SQLite doesn't have idle connection timeouts like PostgreSQL/PgBouncer,
        so this is mostly a no-op availability check.
        """
        if not self.checkpointer and SQLITE_CHECKPOINTER_AVAILABLE:
            # Try to re-initialize if checkpointer was lost
            await self.initialize()
    
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
            "run_id": run_id,
            "workflow_id": workflow_id,
            "project_id": project_id,
            "task_id": task_id,
            "status": "pending",
            "current_node": None,
            "context": {},
            "activity_log": [],
            "started_at": datetime.utcnow().isoformat(),
            "completed_at": None,
            "graph_config": graph_config
        }
        
        # Store in memory for quick access (keeps all fields)
        self._runs[run_id] = run
        
        # Persist to Supabase — only send columns that exist in the 'runs' table
        # Table columns: id, workflow_id, project_id, task_id, status, current_node,
        #                context (JSONB), error_message, started_at, completed_at
        supabase = get_supabase()
        if supabase.is_configured():
            try:
                supabase_payload = {
                    "id": run_id,
                    "workflow_id": workflow_id,
                    "project_id": project_id,
                    "task_id": task_id,
                    "status": "pending",
                    "current_node": None,
                    "context": {
                        "activity_log": []
                    },
                    "started_at": datetime.utcnow().isoformat(),
                }
                await supabase.insert_run(supabase_payload)
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
                node_data = node.get("data", {})
                # Merge data.config into top-level so node parameters are flat
                # Template format: {label: "...", config: {task: "...", model: "..."}}
                # Node expects:    {label: "...", task: "...", model: "..."}
                node_config = {**node_data, **node_data.get("config", {})}
                
                # Get and configure the node handler
                handler = registry.create_node(node_type, node_config)
                builder.add_node(node_id, handler)
                
                print(f"[GraphEngine] Added node: {node_id} ({node_type})")
            
            # Collect nodes that have conditional edges — their routing is handled
            # exclusively by the conditional edges, so regular edges must be skipped
            # to avoid LangGraph's InvalidUpdateError (concurrent writes to same channel).
            conditional_edge_sources = set()
            conditional_edges = graph_config.get("conditionalEdges") or []
            for cond_edge in conditional_edges:
                source_node = cond_edge.get("source")
                if source_node:
                    conditional_edge_sources.add(source_node)
            
            # Add edges (skip sources that have conditional routing)
            for edge in edges:
                source = edge.get("source")
                target = edge.get("target")
                
                if source in conditional_edge_sources:
                    print(f"[GraphEngine] Skipped regular edge {source} -> {target} (has conditional routing)")
                    continue
                
                if target == "END" or target == "end":
                    builder.add_edge(source, END)
                else:
                    builder.add_edge(source, target)
                
                print(f"[GraphEngine] Added edge: {source} -> {target}")
            
            # Add conditional edges (for evaluator/review routing)
            print(f"[GraphEngine] Conditional edges received: {len(conditional_edges)} entries")
            if conditional_edges:
                print(f"[GraphEngine] conditionalEdges data: {conditional_edges}")
            for cond_edge in conditional_edges:
                source_node = cond_edge.get("source")
                # Support both "routes" (legacy) and "targets" (template format)
                routes = cond_edge.get("routes") or cond_edge.get("targets", {})
                # The state key to read the routing decision from
                routing_field = cond_edge.get("routingField", "evaluator_decision")
                
                if source_node and routes:
                    # Create a routing function for this conditional edge
                    # IMPORTANT: LangGraph expects the router to return a KEY from path_map,
                    # not the resolved node name. LangGraph maps key→node internally.
                    def make_router(route_map, field):
                        def router(state):
                            decision = state.get(field, "complete")
                            # Return the decision key directly if it exists in the route map
                            if decision in route_map:
                                print(f"[GraphEngine] Conditional routing: {field}={decision} -> {route_map[decision]}")
                                return decision
                            # Fallback to "complete" key
                            if "complete" in route_map:
                                print(f"[GraphEngine] Conditional routing: {field}={decision} (fallback) -> {route_map['complete']}")
                                return "complete"
                            # Last resort: return first key
                            first_key = next(iter(route_map))
                            print(f"[GraphEngine] Conditional routing: {field}={decision} (default) -> {route_map[first_key]}")
                            return first_key
                        return router
                    
                    # Convert route values to proper LangGraph targets
                    path_map = {}
                    for decision, target in routes.items():
                        if target == "END" or target == "end":
                            path_map[decision] = END
                        else:
                            path_map[decision] = target
                    
                    builder.add_conditional_edges(source_node, make_router(path_map, routing_field), path_map)
                    print(f"[GraphEngine] Added conditional edge from {source_node}: {routes} (field: {routing_field})")
            
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
            
            # Compile the graph — always use a checkpointer so update_state() works
            # (needed for injecting user decisions after interrupt/resume)
            compile_kwargs = {}
            
            if self.checkpointer:
                compile_kwargs["checkpointer"] = self.checkpointer
            else:
                # Fallback: in-memory checkpointer for state updates
                from langgraph.checkpoint.memory import MemorySaver
                compile_kwargs["checkpointer"] = MemorySaver()
            
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
            
            # Broadcast SSE: workflow started
            if self.stream_manager:
                await self.stream_manager.broadcast_log(run_id, "Workflow execution started", "info")
            
            previous_node = None
            interrupt_handled = False  # Once an interrupt is handled, skip all future ones
            stream_input = initial_state  # First iteration uses initial_state; after interrupt uses None
            
            while True:  # Outer loop: restarts astream after interrupt resume
                needs_restart = False
                async for event in graph.astream(stream_input, thread_config):
                    # Update run with current progress
                    current_node = list(event.keys())[0] if event else None
                    node_output = event.get(current_node, {}) if current_node else {}
                    
                    # Broadcast SSE: node completed (astream yields AFTER node finishes)
                    if self.stream_manager and current_node and current_node not in ('__start__', '__end__'):
                        
                        # ── Node START event (detect transitions) ──
                        if current_node != previous_node:
                            # Broadcast start of this node 
                            await self.stream_manager.broadcast_log(
                                run_id, f"▶ Starting {current_node}...", "info"
                            )
                            await self.stream_manager.publish(run_id, {
                                "type": "graph_event",
                                "kind": "on_chain_start",
                                "name": current_node,
                                "data": {"input": {"status": "running"}}
                            })
                        
                        # ── Extract detail summary from node output ──
                        detail_parts = []
                        if node_output.get("outputs"):
                            out = node_output["outputs"]
                            # Doc exploration details
                            if "doc_exploration" in out:
                                exp = out["doc_exploration"]
                                file_count = len(exp.get("existing_files", {}))
                                detail_parts.append(f"Found {file_count} existing doc files")
                                if exp.get("summary"):
                                    # First 100 chars of summary
                                    detail_parts.append(exp["summary"][:120])
                            # Doc changes details
                            if "doc_changes" in out:
                                dc = out["doc_changes"]
                                files = dc.get("files", [])
                                hunks = sum(len(f.get("hunks", [])) for f in files)
                                detail_parts.append(f"Generated {len(files)} file(s) with {hunks} hunk(s)")
                            # Doc result details
                            if "doc_result" in out:
                                dr = out["doc_result"]
                                written = dr.get("written", [])
                                skipped = dr.get("skipped", [])
                                detail_parts.append(f"Wrote {len(written)} file(s)")
                                if skipped:
                                    detail_parts.append(f"Skipped {len(skipped)} file(s)")
                        
                        # Get last message if available
                        msgs = node_output.get("messages", [])
                        if msgs:
                            last_msg = msgs[-1] if isinstance(msgs, list) else msgs
                            if isinstance(last_msg, dict):
                                content = last_msg.get("content", "")
                                if content and len(content) > 10:
                                    # Trim to first line or 120 chars
                                    summary = content.split("\n")[0][:120]
                                    detail_parts.append(summary)
                        
                        # Broadcast detail if available
                        if detail_parts:
                            detail = " · ".join(detail_parts)
                            await self.stream_manager.broadcast_log(
                                run_id, f"  ↳ {detail}", "info"
                            )
                        
                        # ── Node COMPLETION event ──
                        await self.stream_manager.broadcast_log(
                            run_id, f"✓ Completed {current_node}", "info"
                        )
                        # Emit graph_event for node highlighting
                        await self.stream_manager.publish(run_id, {
                            "type": "graph_event",
                            "kind": "on_chain_end",
                            "name": current_node,
                            "data": {"output": {"status": "completed"}}
                        })
                        # Log to activity_log for history
                        run_data = self._runs.get(run_id, {})
                        if "activity_log" not in run_data:
                            run_data["activity_log"] = []
                        run_data["activity_log"].append({
                            "type": "agent",
                            "stage": current_node,
                            "message": f"Completed {current_node}",
                            "timestamp": datetime.utcnow().isoformat()
                        })
                        
                        previous_node = current_node
                    
                    # Phase 4: Fire node execution hook
                    await self.hooks.run_hook("node_execute_after", run_id, current_node, node_output)
                    
                    await self.update_run(run_id, {
                        "current_node": current_node,
                        "context": node_output
                    })
                    print(f"[GraphEngine] Executed node: {current_node}")
                    
                    # ── Interrupt check: detect pending_approval in node output ──
                    # Skip if we already handled an interrupt (pending_approval persists in state)
                    pending = node_output.get("pending_approval")
                    if pending and self.stream_manager and not interrupt_handled:
                        print(f"[GraphEngine] Interrupt detected at {current_node}: {pending.get('gate', 'unknown')}")
                        
                        # Update run status
                        await self.update_run(run_id, {"status": "interrupted", "current_node": current_node})
                        
                        # Emit SSE interrupt event with the pending_approval payload
                        await self.stream_manager.publish(run_id, {
                            "type": "interrupt",
                            "interrupts": [current_node],
                            "values": node_output
                        })
                        await self.stream_manager.broadcast_log(
                            run_id, f"⏸ Waiting for review at {current_node}", "warning"
                        )
                        
                        # Create an asyncio.Event and wait for resume
                        event = asyncio.Event()
                        self._resume_events[run_id] = event
                        print(f"[GraphEngine] Paused execution for run {run_id}, waiting for resume...")
                        await event.wait()  # Blocks until resume_run() is called
                        
                        # Resume: merge user decisions back into graph state
                        resume_data = self._resume_data.pop(run_id, {})
                        self._resume_events.pop(run_id, None)
                        interrupt_handled = True  # Skip all further interrupt checks
                        print(f"[GraphEngine] Resumed execution for run {run_id}")
                        
                        # Reconnect PostgreSQL if connection dropped during pause
                        await self._ensure_connection()
                        
                        # Recompile graph with fresh checkpointer if connection was refreshed
                        # The old graph object captured the dead checkpointer at compile time
                        if self.checkpointer:
                            compile_kwargs["checkpointer"] = self.checkpointer
                            graph = builder.compile(**compile_kwargs)
                            print(f"[GraphEngine] Recompiled graph with fresh checkpointer")
                        
                        # ── CRITICAL: Update LangGraph's actual state with user decision ──
                        # The conditional router reads from LangGraph's internal state, NOT
                        # from our _runs dict. We must inject evaluator_decision into the
                        # graph checkpoint, then restart astream from the updated state.
                        approval_action = resume_data.get("approval_action", "approve")
                        new_decision = "complete" if approval_action == "approve" else "revise"
                        
                        state_update = {"evaluator_decision": new_decision, "pending_approval": None}
                        
                        try:
                            await graph.aupdate_state(thread_config, state_update)
                            print(f"[GraphEngine] Updated graph state: evaluator_decision={new_decision}")
                        except Exception as state_err:
                            print(f"[GraphEngine] Warning: Could not update graph state: {state_err}")
                            try:
                                graph.update_state(thread_config, state_update)
                                print(f"[GraphEngine] Updated graph state (sync fallback): evaluator_decision={new_decision}")
                            except Exception as sync_err:
                                print(f"[GraphEngine] Warning: Sync state update also failed: {sync_err}")
                        
                        # Merge user's hunk decisions into the run's context
                        # so that write_docs can read approved/rejected statuses
                        if "doc_changes" in resume_data:
                            from shared_state import set_hunk_decisions
                            set_hunk_decisions(run_id, resume_data["doc_changes"])
                            run_ctx = self._runs.get(run_id, {}).get("context", {})
                            if "outputs" not in run_ctx:
                                run_ctx["outputs"] = {}
                            run_ctx["outputs"]["doc_changes"] = resume_data["doc_changes"]
                            # Clear pending_approval since review is done
                            run_ctx.pop("pending_approval", None)
                        
                        await self.update_run(run_id, {"status": "running"})
                        await self.stream_manager.broadcast_log(run_id, "▶ Workflow resumed", "info")
                        
                        # Break out of current astream — we'll restart from updated checkpoint
                        # The astream generator has already committed its routing decision,
                        # so we must create a fresh one that reads the updated state.
                        stream_input = None  # Resume from checkpoint (not initial_state)
                        needs_restart = True
                        # Reset interrupt flag so the NEXT review_docs pass can
                        # pause for human review again (revision loops)
                        interrupt_handled = False
                        break
                    
                    # Sync outputs to Node.js backend (which updates Supabase)
                    if current_node and node_output.get("outputs"):
                        await self._sync_outputs_to_backend(
                            run_id=run_id,
                            node_id=current_node,
                            outputs=node_output.get("outputs", {}),
                            context=input_data
                        )
                
                # If we broke out for restart, continue outer loop; otherwise we're done
                if not needs_restart:
                    break
            
            # Mark as completed
            await self.update_run(run_id, {
                "status": "completed",
                "completed_at": datetime.utcnow().isoformat()
            })
            
            # Broadcast SSE: workflow complete
            if self.stream_manager:
                await self.stream_manager.publish(run_id, {
                    "type": "workflow_complete",
                    "status": "completed",
                    "run_id": run_id
                })
            
            # Phase 4: Fire workflow complete hook
            await self.hooks.run_hook("workflow_execute_after", run_id, "completed")
            print(f"[GraphEngine][{run_id[:8]}] Run {run_id} completed successfully")
            
            # Release concurrency lock via callback
            if self.on_run_complete:
                project_id = input_data.get("project_id")
                self.on_run_complete(run_id, project_id)
            
            # Notify Node.js backend that workflow run is complete
            await self._notify_workflow_complete(run_id, input_data, "completed")
            
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
            
            # Release concurrency lock via callback
            if self.on_run_complete:
                project_id = input_data.get("project_id")
                self.on_run_complete(run_id, project_id)
            
            # Notify Node.js backend that workflow run failed
            await self._notify_workflow_complete(run_id, input_data, "failed", str(e))
            raise
    
    async def resume_run(self, run_id: str, updates: Dict[str, Any] = None):
        """Resume a paused workflow execution after user review."""
        event = self._resume_events.get(run_id)
        if not event:
            print(f"[GraphEngine] No pending interrupt for run {run_id}")
            return False
        
        # Store the user's decisions for the execute_graph loop to pick up
        self._resume_data[run_id] = updates or {}
        
        # Update the run state with user decisions (e.g., doc_changes with hunk statuses)
        run = self._runs.get(run_id, {})
        if updates:
            # Merge doc_changes decisions into the run's context
            if "doc_changes" in updates:
                context = run.get("context", {})
                outputs = context.get("outputs", {})
                outputs["doc_changes"] = updates["doc_changes"]
                # Clear pending_approval since user has reviewed
                if "pending_approval" in context:
                    del context["pending_approval"]
                run["context"] = {**context, "outputs": outputs}
            
            # Set evaluator_decision based on approval action
            if "approval_action" in updates:
                action = updates["approval_action"]
                context = run.get("context", {})
                context["evaluator_decision"] = "complete" if action == "approve" else "revise"
                run["context"] = context
        
        print(f"[GraphEngine] Signaling resume for run {run_id}")
        event.set()  # Unblock the execute_graph loop
        return True
    
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
    
    async def _notify_workflow_complete(
        self,
        run_id: str,
        input_data: Dict[str, Any],
        status: str,
        error: str = None
    ):
        """
        Notify Node.js backend that a workflow run has completed.
        This allows the backend to mark project_workflows as complete.
        """
        import httpx
        
        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
        workflow_id = input_data.get("workflow_id")
        
        if not workflow_id:
            return  # Not a project workflow run, skip
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{nodejs_url}/api/langgraph/workflow-complete",
                    json={
                        "run_id": run_id,
                        "workflow_id": workflow_id,
                        "project_id": input_data.get("project_id"),
                        "status": status,
                        "error": error
                    }
                )
                if response.status_code == 200:
                    print(f"[GraphEngine] Notified backend: workflow {workflow_id} {status}")
                else:
                    print(f"[GraphEngine] Failed to notify backend: {response.status_code}")
        except Exception as e:
            print(f"[GraphEngine] Warning: Could not notify workflow completion: {e}")
    
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
