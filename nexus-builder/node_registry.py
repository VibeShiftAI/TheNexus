"""
Node Registry - Agent node types for LangGraph workflows

This registry defines all available node types that can be used
in the visual workflow builder. Each node type corresponds to a
specific agent function with its own prompt and capabilities.
"""

import os
from typing import Dict, Any, Callable, List, Optional
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

# Import AI providers
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI

# Import Builder Agent
from builder.agent import compile_builder_graph
# Import Auditor Agent
from auditor.agent import compile_auditor_graph
# Import Architect and Researcher Agents
from architect.agent import compile_architect_graph
from researcher.agent import compile_researcher_graph
# Import Nexus Prime (Supervisor) - from the consolidated workflow file
from nexus_workflow import build_nexus_graph


def extract_text_content(content) -> str:
    """
    Extract text from LLM response content.
    Handles both string content and Gemini 3's list of parts format:
    [{'type': 'text', 'text': 'Hello!', ...}]
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Gemini 3 returns list of parts: [{'type': 'text', 'text': '...'}]
        texts = []
        for part in content:
            if isinstance(part, dict) and 'text' in part:
                texts.append(part['text'])
            elif isinstance(part, str):
                texts.append(part)
        return '\n'.join(texts)
    return str(content)


class NodeRegistry:
    """
    Registry of available node types for workflow graphs.
    Each node type defines:
    - A unique type ID
    - Display metadata (name, description, icon)
    - An execution handler function
    - Configuration schema
    """
    
    def __init__(self):
        self._nodes: Dict[str, Dict[str, Any]] = {}
        self._handlers: Dict[str, Callable] = {}
        self._register_default_nodes()
    
    def _register_default_nodes(self):
        """Register the built-in node types"""
        
        # ═══════════════════════════════════════════════════════════════
        # DASHBOARD-LEVEL NODES
        # These nodes are only available for dashboard-level workflows
        # ═══════════════════════════════════════════════════════════════
        
        self.register(
            type_id="project_iterator",
            name="Project Iterator",
            description="Iterates over target projects and runs child workflow for each",
            category="dashboard",
            icon="🔄",
            levels=["dashboard"],
            node_type="utility",
            config_schema={
                "parallel": {"type": "boolean", "default": False},
                "max_concurrent": {"type": "number", "default": 3}
            }
        )
        
        self.register(
            type_id="aggregate_results",
            name="Aggregate Results",
            description="Collects and summarizes results from all project runs",
            category="dashboard",
            icon="📊",
            levels=["dashboard"],
            node_type="utility",
            config_schema={
                "summary_format": {"type": "select", "options": ["brief", "detailed", "metrics"], "default": "detailed"}
            }
        )
        
        self.register(
            type_id="dashboard_supervisor",
            name="Dashboard Supervisor",
            description="Routes decisions across projects in a dashboard workflow",
            category="dashboard",
            icon="🎯",
            levels=["dashboard"],
            node_type="orchestrator",
            config_schema={
                "model": {"type": "string", "default": "gemini-3-flash-preview"}
            }
        )
        
        # ═══════════════════════════════════════════════════════════════
        # PROJECT-LEVEL NODES
        # These nodes are only available for project-level workflows
        # ═══════════════════════════════════════════════════════════════
        
        self.register(
            type_id="feature_spawner",
            name="Feature Spawner",
            description="Creates features for the current workflow stage",
            category="project",
            icon="✨",
            levels=["project"],
            node_type="utility",
            config_schema={
                "auto_start": {"type": "boolean", "default": False}
            }
        )
        
        self.register(
            type_id="stage_manager",
            name="Stage Manager",
            description="Manages workflow stages and advancement",
            category="project",
            icon="📈",
            levels=["project"],
            node_type="utility",
            config_schema={
                "require_all_complete": {"type": "boolean", "default": True}
            }
        )
        
        self.register(
            type_id="project_supervisor",
            name="Project Supervisor",
            description="Routes decisions within a project workflow",
            category="project",
            icon="👔",
            levels=["project"],
            node_type="orchestrator",
            config_schema={
                "model": {"type": "string", "default": "gemini-3-flash-preview"}
            }
        )
        
        # ═══════════════════════════════════════════════════════════════
        # FEATURE-LEVEL NODES (Research, Planning, Implementation)
        # These are the standard workflow nodes for feature development
        # ═══════════════════════════════════════════════════════════════
        
        self.register(
            type_id="researcher",
            name="Researcher",
            description="Researches a topic and produces a report (Gemini Mesh)",
            category="research",
            icon="🔬",
            levels=["feature"],
            node_type="fleet",
            config_schema={
                "request": {"type": "string"}
            }
        )
        
        self.register(
            type_id="architect",
            name="The Architect",
            description="Gemini Mesh Planner (Pro + Flash)",
            category="planning",
            icon="map",
            levels=["feature"],
            node_type="fleet",
            config_schema={
                "project_root": {"type": "string"}
            }
        )

        self.register(
            type_id="builder",
            name="The Builder",
            description="High-velocity implementation agent (Scout -> Build -> Syntax Check)",
            category="implementation",
            icon="hammer",
            levels=["feature"],
            node_type="fleet",
            config_schema={
                "spec": {"type": "string", "default": ""},
                "project_root": {"type": "string"}
            }
        )

        self.register(
            type_id="auditor",
            name="The Auditor",
            description="Zero-Trust verification agent (Forensics -> Verdict)",
            category="review",
            icon="shield",
            levels=["feature"],
            node_type="fleet",
            config_schema={
                "spec": {"type": "string", "default": ""},
                "project_root": {"type": "string"}
            }
        )

        self.register(
            type_id="nexus_prime",
            name="Nexus Prime (Supervisor)",
            description="The CEO Agent. Orchestrates Research -> Architect -> Builder -> Auditor.",
            category="orchestration",
            icon="🧠",
            levels=["project", "feature"],
            node_type="orchestrator",
            config_schema={
                "task_id": {"type": "string"}
            }
        )
        
        # ═══════════════════════════════════════════════════════════════
        # ORCHESTRATION NODES (Available at multiple levels)
        # ═══════════════════════════════════════════════════════════════
        
        self.register(
            type_id="human_in_loop",
            name="Human Approval",
            description="Pauses execution for human review",
            category="orchestration",
            icon="🙋",
            levels=["dashboard", "project", "feature"],  # Available at all levels
            node_type="utility",
            config_schema={
                "approval_message": {"type": "string", "default": "Please review and approve to continue"}
            }
        )
        
        # ═══════════════════════════════════════════════════════════════
        # UTILITY NODES (Available at multiple levels)
        # ═══════════════════════════════════════════════════════════════
        
        self.register(
            type_id="summarizer",
            name="Summarizer",
            description="Summarizes content from previous nodes",
            category="utility",
            icon="📄",
            levels=["dashboard", "project", "feature"],  # Available at all levels
            node_type="utility",
            config_schema={
                "model": {"type": "string", "default": "gemini-3-flash-preview"},
                "max_length": {"type": "number", "default": 500}
            }
        )
        
        self.register(
            type_id="git_commit",
            name="Git Commit",
            description="Commits changes to git",
            category="utility",
            icon="📦",
            levels=["project", "feature"],  # Git operations are project/feature level
            node_type="utility",
            config_schema={
                "auto_push": {"type": "boolean", "default": False}
            }
        )
        
        # ═══════════════════════════════════════════════════════════════
        # CLAUDE-STYLE SUB-AGENTS (Specialized atomic agents)
        # ═══════════════════════════════════════════════════════════════
        
        self.register(
            type_id="bash_executor",
            name="Bash Executor",
            description="Command execution specialist for git, builds, and terminal tasks",
            category="utility",
            icon="💻",
            levels=["project", "feature"],
            node_type="atomic",
            config_schema={
                "command": {"type": "string", "default": ""},
                "cwd": {"type": "string", "default": ""},
                "timeout": {"type": "number", "default": 60}
            }
        )
        
        self.register(
            type_id="codebase_explorer",
            name="Codebase Explorer",
            description="Fast codebase exploration - find files, search code, map structure",
            category="research",
            icon="🔍",
            levels=["project", "feature"],
            node_type="atomic",
            config_schema={
                "query": {"type": "string", "default": ""},
                "search_type": {"type": "select", "options": ["auto", "glob", "grep", "structure"], "default": "auto"},
                "thoroughness": {"type": "select", "options": ["quick", "medium", "very_thorough"], "default": "medium"}
            }
        )
        
        self.register(
            type_id="plan_architect",
            name="Plan Architect",
            description="Designs step-by-step implementation plans with file targets and trade-offs",
            category="planning",
            icon="📋",
            levels=["project", "feature"],
            node_type="atomic",
            config_schema={
                "goal": {"type": "string", "default": ""},
                "depth": {"type": "select", "options": ["high_level", "detailed", "exhaustive"], "default": "detailed"}
            }
        )
        
        self.register(
            type_id="general_agent",
            name="General Agent",
            description="Multi-step task execution with full tool access",
            category="orchestration",
            icon="🤖",
            levels=["dashboard", "project", "feature"],
            node_type="atomic",
            config_schema={
                "task": {"type": "string", "default": ""},
                "max_turns": {"type": "number", "default": 10},
                "model": {"type": "string", "default": "gemini-2.5-flash"}
            }
        )
    
    def register(
        self,
        type_id: str,
        name: str,
        description: str,
        category: str = "custom",
        icon: str = "⚙️",
        levels: list = None,  # Which workflow levels can use this node: ['dashboard', 'project', 'feature']
        node_type: str = "atomic",  # Node type: 'fleet', 'atomic', 'orchestrator', 'utility'
        config_schema: Dict = None
    ):
        """Register a new node type"""
        # Default to all levels if not specified
        if levels is None:
            levels = ["dashboard", "project", "feature"]
        
        self._nodes[type_id] = {
            "type": type_id,
            "name": name,
            "description": description,
            "category": category,
            "icon": icon,
            "levels": levels,
            "node_type": node_type,
            "config_schema": config_schema or {}
        }
    
    def has_type(self, type_id: str) -> bool:
        """Check if a node type exists"""
        return type_id in self._nodes
    
    def get_available_types(self) -> List[str]:
        """Get list of all available node type IDs"""
        return list(self._nodes.keys())
    
    def get_node_definitions(self) -> Dict[str, Dict]:
        """Get all node definitions for the visual builder"""
        return self._nodes
    
    def get_nodes_for_level(self, level: str) -> Dict[str, Dict]:
        """Get node definitions filtered by workflow level"""
        return {
            type_id: node_def 
            for type_id, node_def in self._nodes.items() 
            if level in node_def.get("levels", [])
        }

    
    # ═══════════════════════════════════════════════════════════════
    # AGENT SYNC FROM NODE.JS BACKEND
    # ═══════════════════════════════════════════════════════════════
    
    async def sync_from_backend(self):
        """
        Fetch agent configurations from Node.js backend and register
        each agent as a LangGraph node type. This enables agents created
        in the Agent Manager to be used as workflow nodes.
        
        Retries with exponential backoff to handle startup timing.
        """
        import httpx
        import asyncio
        
        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
        
        # Retry settings: 5 attempts with exponential backoff (2s, 4s, 8s, 16s)
        max_retries = 5
        delay = 2.0
        
        for attempt in range(1, max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.get(f"{nodejs_url}/api/agents")
                    
                    if response.status_code != 200:
                        raise Exception(f"Status {response.status_code}")
                    
                    config = response.json()
                    agents = config.get("agents", {})
                    
                    synced_count = 0
                    for agent_id, agent in agents.items():
                        # Register all agents - we've removed conflicting built-ins
                        self.register_agent_node(agent)
                        synced_count += 1
                    
                    print(f"[NodeRegistry] Synced {synced_count} agents from Node.js backend")
                    return  # Success
                    
            except Exception as e:
                if attempt < max_retries:
                    print(f"[NodeRegistry] Node.js not ready, retry {attempt}/{max_retries} in {delay}s...")
                    await asyncio.sleep(delay)
                    delay *= 2  # Exponential backoff
                else:
                    print(f"[NodeRegistry] ERROR: Failed to sync agents after {max_retries} attempts: {e}")
                    print(f"[NodeRegistry] User-defined agents will NOT be available in workflows!")
    
    def register_agent_node(self, agent: Dict):
        """
        Register an agent configuration as a LangGraph node type.
        This allows agents defined in Agent Manager to be used in workflows.
        """
        agent_id = agent.get("id")
        if not agent_id:
            return
        
        # Determine category based on agent type
        category = "agent"
        if "research" in agent_id.lower():
            category = "research"
        elif "plan" in agent_id.lower():
            category = "planning"
        elif "implement" in agent_id.lower() or "coder" in agent_id.lower():
            category = "implementation"
        elif "review" in agent_id.lower() or "critic" in agent_id.lower():
            category = "review"
        
        self.register(
            type_id=agent_id,
            name=agent.get("name", agent_id),
            description=agent.get("description", "Custom agent from Agent Manager"),
            category=category,
            icon="🤖",
            config_schema={
                "model": {"type": "string", "default": agent.get("defaultModel", "gemini-3-flash-preview")},
                "system_prompt": {"type": "string", "default": agent.get("systemPrompt", "")},
                "max_turns": {"type": "number", "default": agent.get("maxTurns", 50)}
            }
        )
        
        # Store the full agent config for runtime use
        self._agent_configs = getattr(self, '_agent_configs', {})
        self._agent_configs[agent_id] = agent
    
    def create_node(self, type_id: str, config: Dict = None) -> Callable:
        """
        Create a node handler function for use in LangGraph.
        Returns a function that takes state and returns updated state.
        
        DEPRECATION NOTICE (2026-01-09):
        This method is being replaced by the atomic node system.
        New code should use: from nodes.registry import get_atomic_registry
        
        During migration, this method will try the atomic system first,
        then fall back to legacy handlers.
        """
        import warnings
        config = config or {}
        
        # Get node definition
        node_def = self._nodes.get(type_id)
        if not node_def:
            raise ValueError(f"Unknown node type: {type_id}")
        
        # ═══════════════════════════════════════════════════════════════
        # TRY ATOMIC NODE SYSTEM FIRST (New architecture)
        # ═══════════════════════════════════════════════════════════════
        try:
            from nodes.registry import get_atomic_registry
            atomic_registry = get_atomic_registry()
            atomic_node = atomic_registry.get_node_instance(type_id)
            
            if atomic_node:
                # Wrap atomic node in legacy handler interface
                async def atomic_wrapper(state: Dict) -> Dict:
                    from nodes.core import NodeExecutionContext, NodeExecutionData, WorkflowInfo, NodeInfo
                    
                    # Create execution context from state
                    ctx = NodeExecutionContext(
                        workflow=WorkflowInfo(id="legacy", name="legacy_workflow"),
                        node=NodeInfo(
                            id=type_id,
                            name=type_id,
                            type=type_id,
                            type_version=1.0,
                            parameters=config
                        ),
                        project_id=state.get("context", {}).get("project_id"),
                        task_id=state.get("context", {}).get("task_id"),
                    )
                    
                    # Convert state to NodeExecutionData
                    items = [NodeExecutionData(json=state.get("outputs", {}))]
                    
                    # Execute atomic node
                    results = await atomic_node.execute(ctx, items)
                    
                    # Convert results back to legacy state format
                    if results and results[0]:
                        output_data = results[0][0].json
                        return {
                            "messages": state.get("messages", []),
                            "context": state.get("context", {}),
                            "outputs": {
                                **state.get("outputs", {}),
                                **output_data
                            }
                        }
                    return state
                
                print(f"[NodeRegistry] Using ATOMIC node for: {type_id}")
                return atomic_wrapper
                
        except ImportError:
            pass  # Atomic system not available yet
        except Exception as e:
            print(f"[NodeRegistry] Atomic node error for {type_id}, falling back to legacy: {e}")
        
        # ═══════════════════════════════════════════════════════════════
        # LEGACY HANDLERS (DEPRECATED - Will be removed after testing)
        # ═══════════════════════════════════════════════════════════════
        warnings.warn(
            f"Legacy node handler for '{type_id}' is deprecated. "
            "Use atomic nodes from nodes.registry instead.",
            DeprecationWarning,
            stacklevel=2
        )
        
        # Create handler based on node type (LEGACY - kept for rollback)
        if type_id == "researcher":
            return self._create_researcher(config)
        elif type_id == "summarizer":
            return self._create_summarizer(config)
        elif type_id == "human_in_loop":
            return self._create_human_in_loop(config)
        # Dashboard-level nodes
        elif type_id == "project_iterator":
            return self._create_project_iterator(config)
        elif type_id == "aggregate_results":
            return self._create_aggregate_results(config)
        elif type_id == "dashboard_supervisor":
            return self._create_dashboard_supervisor(config)
        # Project-level nodes
        elif type_id == "feature_spawner":
            return self._create_feature_spawner(config)
        elif type_id == "stage_manager":
            return self._create_stage_manager(config)
        elif type_id == "project_supervisor":
            return self._create_project_supervisor(config)
        
        # Special Builder Agent
        elif type_id == "builder":
            return self._create_builder(config)
            
        # Special Auditor Agent
        elif type_id == "auditor":
            return self._create_auditor(config)

        # Special Architect Agent
        elif type_id == "architect":
            return self._create_architect(config)

        # Nexus Prime Supervisor
        elif type_id == "nexus_prime":
            return self._create_nexus_prime(config)

        else:
            # Check if this is a dynamically registered agent node
            agent_configs = getattr(self, '_agent_configs', {})
            if type_id in agent_configs:
                return self._create_agent_handler(type_id, config, agent_configs[type_id])
            
            # Generic passthrough for unimplemented nodes
            return self._create_passthrough(type_id, config)
    
    # ═══════════════════════════════════════════════════════════════
    # NODE HANDLERS
    # ═══════════════════════════════════════════════════════════════
    
    def _get_llm(self, model: str):
        """Get an LLM instance based on model name"""
        if model.startswith("gemini"):
            return ChatGoogleGenerativeAI(
                model=model,
                google_api_key=os.getenv("GOOGLE_API_KEY")
            )
        elif model.startswith("claude"):
            return ChatAnthropic(
                model=model,
                anthropic_api_key=os.getenv("ANTHROPIC_API_KEY")
            )
        elif model.startswith("gpt"):
            return ChatOpenAI(
                model=model,
                openai_api_key=os.getenv("OPENAI_API_KEY")
            )
        else:
            # Default to Gemini
            return ChatGoogleGenerativeAI(
                model="gemini-3-flash-preview",
                google_api_key=os.getenv("GOOGLE_API_KEY")
            )
    
    def _create_researcher(self, config: Dict) -> Callable:
        """Creates the Researcher Agent subgraph handler."""
        researcher_graph = compile_researcher_graph()
        
        async def handler(state: Dict) -> Dict:
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            
            request = context.get("task_description") or config.get("request", "Research task")
            
            initial_state = {
                "messages": [],
                "user_request": request,
                "proposed_queries": [],
                "is_plan_approved": False,
                "critique": "",
                "final_dossier": ""
            }
            
            print(f"[Researcher] Starting Deep Research on: {request[:50]}...")
            final_state = await researcher_graph.ainvoke(initial_state)
            
            dossier = final_state.get("final_dossier", "Research failed")
            
            return {
                "messages": [AIMessage(content="Research Completed")],
                "context": context,
                "outputs": {
                    **outputs,
                    "research_dossier": dossier
                }
            }
        return handler

    def _create_builder(self, config: Dict) -> Callable:
        """
        Creates the Builder Agent subgraph handler.
        This wraps the compiled LangGraph runnable.
        """
        async def handler(state: Dict) -> Dict:
            # Extract inputs from global state for the builder subgraph
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            
            # Use plan from outputs or spec from config
            implementation_spec = outputs.get("plan") or config.get("spec", "No spec provided")
            project_root = context.get("project_path", ".")
            
            # Compile with project_root so tools use correct directory
            builder_graph = compile_builder_graph(project_root=project_root)
            
            # Initialize BuilderState
            builder_initial_state = {
                "messages": [],
                "repo_skeleton": "", # Will be generated by scout
                "implementation_spec": implementation_spec,
                "project_root": project_root,
                "modified_files": [],
                "syntax_error": None,
                "thought_signature": ""
            }
            
            print(f"[Builder] Starting Builder Agent for spec: {implementation_spec[:50]}...")
            
            # Invoke the subgraph
            # Note: We await the result since it's an async graph execution
            final_builder_state = await builder_graph.ainvoke(builder_initial_state)
            
            # Extract results
            modified = final_builder_state.get("modified_files", [])
            messages = final_builder_state.get("messages", [])
            
            # Summarize result
            summary = f"Builder Agent completed. Modified {len(modified)} files: {', '.join(modified)}."
            if messages:
                summary += f"\nLast Message: {messages[-1].content}"
            
            return {
                "messages": [AIMessage(content=summary)],
                "context": state.get("context", {}),
                "outputs": {
                    **state.get("outputs", {}),
                    "builder_result": summary,
                    "modified_files": modified
                }
            }
            
        return handler

    def _create_auditor(self, config: Dict) -> Callable:
        """
        Creates the Auditor Agent subgraph handler.
        """
        auditor_graph = compile_auditor_graph()
        
        async def handler(state: Dict) -> Dict:
            # Extract inputs
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            
            project_root = context.get("project_path", ".")
            spec = outputs.get("plan") or config.get("spec", "")
            
            # Initialize AuditorState
            auditor_initial_state = {
                "messages": [],
                "task_title": context.get("task_title", "Audit Task"),
                "task_description": spec[:500] if spec else "Verify implementation",
                "project_context": "",
                "definition_of_done": {},
                "modified_files": outputs.get("modified_files", []),
                "project_root": project_root,
                "diff_context": outputs.get("diff", "No diff info available"), 
                "blast_radius": outputs.get("blast_radius", "No blast radius info available"), 
                "linter_report": outputs.get("linter_report", "No linter report"),
                "implementation_spec": spec,
                "test_logs": [],
                "final_verdict": {}
            }
            
            print(f"[Auditor] Starting Zero-Trust Audit...")
            
            # Invoke
            final_state = await auditor_graph.ainvoke(auditor_initial_state)
            
            # Extract
            verdict = final_state.get("final_verdict", {})
            messages = final_state.get("messages", [])
            
            summary = f"Auditor Verdict: {verdict.get('status')} (Score: {verdict.get('security_score')})"
            if verdict.get("reasoning"):
                summary += f"\nReasoning: {verdict.get('reasoning')}"
            
            return {
                "messages": [AIMessage(content=summary)],
                "context": state.get("context", {}),
                "outputs": {
                    **state.get("outputs", {}),
                    "auditor_verdict": verdict,
                    "auditor_summary": summary
                }
            }
            
        return handler

    def _create_architect(self, config: Dict) -> Callable:
        """Creates the Architect Agent subgraph handler."""
        architect_graph = compile_architect_graph()
        
        async def handler(state: Dict) -> Dict:
            from architect.tools import ArchitectTools
            
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            
            project_root = context.get("project_path", ".")
            user_request = outputs.get("research_dossier") or config.get("request", "Plan implementation")
            
            # Pre-load repo structure for the Grounder
            print(f"[Architect] Scan repo structure at {project_root}...")
            repo_structure = ArchitectTools.get_repo_structure(project_root)
            
            initial_state = {
                "messages": [],
                "user_request": user_request,
                "repo_structure": repo_structure,
                "thought_signature": "",
                "draft_spec": None,
                "draft_manifest": None,
                "final_spec": None,
                "final_manifest": None,
                "definition_of_done": None,
                "grounding_errors": [],
                "loop_count": 0
            }
            
            print(f"[Architect] Starting Gemini Mesh planning...")
            final_state = await architect_graph.ainvoke(initial_state)
            
            spec = final_state.get("final_spec", "Plan failed")
            manifest = final_state.get("final_manifest", [])
            
            summary = f"Architect Plan Completed. Spec length: {len(spec)}. Target files: {len(manifest)}"
            
            return {
                "messages": [AIMessage(content=summary)],
                "context": context,
                "outputs": {
                    **outputs,
                    "plan": spec,
                    "target_files": manifest,
                    "architect_summary": summary
                }
            }
        return handler

    def _create_nexus_prime(self, config: Dict) -> Callable:
        """Creates the Nexus Prime Supervisor handler."""
        nexus_graph = build_nexus_graph()
        
        async def handler(state: Dict) -> Dict:
            # Pass through existing state as-is, assuming it matches WorkflowState
            return await nexus_graph.ainvoke(state)
            
        return handler

    def _create_summarizer(self, config: Dict) -> Callable:
        """Create a summarizer node handler"""
        async def handler(state: Dict) -> Dict:
            model = config.get("model", "gemini-3-flash-preview")
            llm = self._get_llm(model)
            
            outputs = state.get("outputs", {})
            
            prompt = f"""Summarize the following workflow outputs:

Research: {outputs.get('research', 'N/A')[:500]}...
Plan: {outputs.get('plan', 'N/A')[:500]}...
Implementation: {outputs.get('implementation', 'N/A')[:500]}...
Review: {outputs.get('review', 'N/A')[:500]}...

Provide a brief summary of what was accomplished.
"""
            
            response = await llm.ainvoke([HumanMessage(content=prompt)])
            
            return {
                "messages": [AIMessage(content=response.content)],
                "context": state.get("context", {}),
                "outputs": {
                    **outputs,
                    "summary": response.content
                }
            }
        
        return handler
    
    def _create_human_in_loop(self, config: Dict) -> Callable:
        """Create a human-in-the-loop pause node"""
        async def handler(state: Dict) -> Dict:
            message = config.get("approval_message", "Waiting for human approval...")
            
            # This node pauses execution - LangGraph's interrupt functionality
            # would be used here in a real implementation
            
            return {
                "messages": [AIMessage(content=f"⏸️ PAUSED: {message}")],
                "context": state.get("context", {}),
                "outputs": {
                    **state.get("outputs", {}),
                    "awaiting_approval": True,
                    "approval_message": message
                }
            }
        
        return handler
    
    def _create_passthrough(self, type_id: str, config: Dict) -> Callable:
        """Create a passthrough node for unimplemented types"""
        async def handler(state: Dict) -> Dict:
            return {
                "messages": [AIMessage(content=f"Node '{type_id}' executed (passthrough)")],
                "context": state.get("context", {}),
                "outputs": state.get("outputs", {})
            }
        
        return handler
    
    def _create_agent_handler(self, type_id: str, config: Dict, agent_config: Dict) -> Callable:
        """
        Create a handler for dynamically registered agent nodes.
        Uses the agent's system prompt and model from Agent Manager config.
        """
        async def handler(state: Dict) -> Dict:
            import traceback
            
            print(f"\n{'='*60}")
            print(f"[AgentHandler] Starting execution: {type_id}")
            print(f"[AgentHandler] Agent config: {agent_config.get('name', 'Unknown')}")
            
            try:
                # Get model from config override or agent default
                model = config.get("model") or agent_config.get("defaultModel", "gemini-3-flash-preview")
                print(f"[AgentHandler] Using model: {model}")
                
                llm = self._get_llm(model)
                
                # Get system prompt from agent config
                system_prompt = agent_config.get("systemPrompt", "You are a helpful AI assistant.")
                print(f"[AgentHandler] System prompt length: {len(system_prompt)} chars")
                
                # Get context from state
                context = state.get("context", {})
                outputs = state.get("outputs", {})
                
                print(f"[AgentHandler] Context keys: {list(context.keys())}")
                print(f"[AgentHandler] Output keys: {list(outputs.keys())}")
                
                # Build input for the agent based on what's available
                input_parts = []
                if context.get("task_title"):
                    input_parts.append(f"Task: {context.get('task_title')}")
                if context.get("task_description"):
                    input_parts.append(f"Description: {context.get('task_description')}")
                if outputs.get("research"):
                    input_parts.append(f"Research:\n{outputs.get('research')[:2000]}")
                if outputs.get("plan"):
                    input_parts.append(f"Plan:\n{outputs.get('plan')[:2000]}")
                if outputs.get("quick_research"):
                    input_parts.append(f"Research:\n{outputs.get('quick_research')[:2000]}")
                if outputs.get("plan_generator"):
                    input_parts.append(f"Plan:\n{outputs.get('plan_generator')[:2000]}")
                
                user_input = "\n\n".join(input_parts) if input_parts else "Please proceed with your task."
                print(f"[AgentHandler] User input length: {len(user_input)} chars")
                
                # Invoke LLM with system prompt
                messages = [
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_input)
                ]
                
                print(f"[AgentHandler] Invoking LLM...")
                response = await llm.ainvoke(messages)
                response_text = extract_text_content(response.content)
                print(f"[AgentHandler] LLM response received: {len(response_text)} chars")
                
                # Determine output key based on agent type
                output_key = type_id.replace("-", "_")
                print(f"[AgentHandler] Saving output to key: {output_key}")
                
                result = {
                    "messages": [AIMessage(content=response_text)],
                    "context": state.get("context", {}),
                    "outputs": {
                        **outputs,
                        output_key: response_text
                    }
                }
                
                print(f"[AgentHandler] ✓ {type_id} completed successfully")
                print(f"{'='*60}\n")
                
                return result
                
            except Exception as e:
                print(f"\n{'!'*60}")
                print(f"[AgentHandler] ✗ ERROR in {type_id}")
                print(f"[AgentHandler] Error type: {type(e).__name__}")
                print(f"[AgentHandler] Error message: {str(e)}")
                print(f"[AgentHandler] Traceback:")
                traceback.print_exc()
                print(f"{'!'*60}\n")
                raise  # Re-raise to let execute_graph handle it
        
        return handler

    # ═══════════════════════════════════════════════════════════════
    # DASHBOARD-LEVEL NODE HANDLERS
    # ═══════════════════════════════════════════════════════════════
    
    def _create_project_iterator(self, config: Dict) -> Callable:
        """Create a project iterator node that loops over target projects and performs workflow actions"""
        async def handler(state: Dict) -> Dict:
            import httpx
            
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            input_data = state.get("input_data", {})
            
            # Get target projects and workflow type
            target_projects = input_data.get("target_projects", context.get("target_projects", []))
            workflow_type = input_data.get("workflow_type", "unknown")
            
            print(f"[ProjectIterator] Processing {len(target_projects)} projects for {workflow_type}")
            
            project_results = []
            features_created = []
            nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
            
            async with httpx.AsyncClient(timeout=300.0) as client:
                for project_id in target_projects:
                    try:
                        # Get project details
                        resp = await client.get(f"{nodejs_url}/api/projects/{project_id}")
                        if resp.status_code != 200:
                            project_results.append({
                                "project_id": project_id,
                                "status": "error",
                                "error": f"Project not found (HTTP {resp.status_code})"
                            })
                            continue
                            
                        project = resp.json()
                        project_path = project.get("path", "")
                        project_name = project.get("name", "Unknown")
                        
                        print(f"[ProjectIterator] Scanning: {project_name}")
                        
                        # Perform workflow-specific action
                        if workflow_type == "security-sweep":
                            result = await self._scan_security(client, nodejs_url, project_id, project_name, project_path)
                        elif workflow_type == "dependency-audit":
                            result = await self._audit_dependencies(client, nodejs_url, project_id, project_name, project_path)
                        else:
                            result = {
                                "status": "processed",
                                "summary": f"No specific action for {workflow_type}"
                            }
                        
                        result["project_id"] = project_id
                        result["project_name"] = project_name
                        project_results.append(result)
                        
                        if result.get("task_id"):
                            features_created.append(result["task_id"])
                            
                    except Exception as e:
                        print(f"[ProjectIterator] Error for {project_id}: {e}")
                        project_results.append({
                            "project_id": project_id,
                            "status": "error",
                            "error": str(e)
                        })
            
            return {
                "messages": state.get("messages", []),
                "context": context,
                "input_data": input_data,
                "outputs": {
                    **outputs,
                    "project_results": project_results,
                    "features_created": features_created,
                    "projects_processed": len([r for r in project_results if r.get("status") == "processed"])
                }
            }
        
        return handler
    
    async def _scan_security(self, client, nodejs_url: str, project_id: str, project_name: str, project_path: str) -> Dict:
        """Scan a project for security vulnerabilities and create fix feature if issues found"""
        try:
            # Call the dependency check endpoint
            dep_resp = await client.get(
                f"{nodejs_url}/api/projects/{project_id}/dependencies",
                timeout=60.0
            )
            
            vulnerabilities = []
            if dep_resp.status_code == 200:
                dep_data = dep_resp.json()
                security = dep_data.get("security", {})
                vulnerabilities = security.get("vulnerabilities", [])
            
            critical_vulns = [v for v in vulnerabilities if v.get("severity") in ["critical", "high"]]
            
            result = {
                "status": "processed",
                "vulnerabilities_found": len(vulnerabilities),
                "critical_high": len(critical_vulns)
            }
            
            # Create feature if critical vulnerabilities found
            if len(critical_vulns) > 0:
                vuln_list = "\n".join([
                    f"- **[{v.get('severity', 'unknown').upper()}]** {v.get('package', 'unknown')}: {v.get('title', 'Security issue')}"
                    for v in critical_vulns[:10]
                ])
                
                feature_resp = await client.post(
                    f"{nodejs_url}/api/features",
                    json={
                        "project_id": project_id,
                        "name": f"[Security Sweep] Fix {len(critical_vulns)} Vulnerabilities",
                        "description": f"A security sweep detected {len(critical_vulns)} critical/high vulnerabilities:\n\n{vuln_list}",
                        "status": "idea",
                        "priority": 2,
                        "metadata": {
                            "source": "workflow",
                            "workflow_type": "security-sweep",
                            "vulnerability_count": len(critical_vulns)
                        }
                    },
                    timeout=30.0
                )
                
                if feature_resp.status_code in [200, 201]:
                    feature = feature_resp.json()
                    result["task_id"] = feature.get("id")
                    result["task_created"] = True
                    print(f"[ProjectIterator] Created security fix task for {project_name}")
            
            return result
            
        except Exception as e:
            print(f"[ProjectIterator] Security scan error for {project_name}: {e}")
            return {
                "status": "processed",
                "vulnerabilities_found": 0,
                "error": str(e),
                "note": "Could not scan dependencies - project may not have package.json"
            }
    
    async def _audit_dependencies(self, client, nodejs_url: str, project_id: str, project_name: str, project_path: str) -> Dict:
        """Audit a project for outdated dependencies and create update feature"""
        try:
            dep_resp = await client.get(
                f"{nodejs_url}/api/projects/{project_id}/dependencies",
                timeout=60.0
            )
            
            outdated = []
            if dep_resp.status_code == 200:
                dep_data = dep_resp.json()
                outdated = dep_data.get("outdated", {}).get("packages", [])
            
            result = {
                "status": "processed",
                "outdated_count": len(outdated)
            }
            
            # Create feature if outdated packages found
            if len(outdated) > 0:
                pkg_list = "\n".join([
                    f"- **{p.get('name')}**: {p.get('current')} → {p.get('latest')} ({p.get('updateType', 'update')})"
                    for p in outdated[:15]
                ])
                
                feature_resp = await client.post(
                    f"{nodejs_url}/api/features",
                    json={
                        "project_id": project_id,
                        "name": f"[Dependency Audit] Update {len(outdated)} Packages",
                        "description": f"Dependency audit found {len(outdated)} outdated packages:\n\n{pkg_list}",
                        "status": "idea",
                        "priority": 3,
                        "metadata": {
                            "source": "workflow",
                            "workflow_type": "dependency-audit",
                            "outdated_count": len(outdated)
                        }
                    },
                    timeout=30.0
                )
                
                if feature_resp.status_code in [200, 201]:
                    feature = feature_resp.json()
                    result["task_id"] = feature.get("id")
                    result["task_created"] = True
            
            return result
            
        except Exception as e:
            return {
                "status": "processed",
                "outdated_count": 0,
                "error": str(e)
            }
    
    def _create_aggregate_results(self, config: Dict) -> Callable:
        """Create an aggregate results node that summarizes project results"""
        async def handler(state: Dict) -> Dict:
            from langchain_core.messages import AIMessage
            
            outputs = state.get("outputs", {})
            project_results = outputs.get("project_results", [])
            summary_format = config.get("summary_format", "detailed")
            
            print(f"[AggregateResults] Summarizing {len(project_results)} project results")
            
            # Build summary based on format
            successful = [r for r in project_results if r.get("status") == "processed"]
            failed = [r for r in project_results if r.get("status") == "error"]
            
            if summary_format == "brief":
                summary = f"Processed {len(successful)}/{len(project_results)} projects successfully."
            elif summary_format == "metrics":
                summary = {
                    "total": len(project_results),
                    "successful": len(successful),
                    "failed": len(failed),
                    "success_rate": f"{len(successful)/len(project_results)*100:.1f}%" if project_results else "N/A"
                }
            else:  # detailed
                summary = f"""## Initiative Summary

**Total Projects:** {len(project_results)}
**Successful:** {len(successful)}
**Failed:** {len(failed)}

### Successful Projects
{chr(10).join([f"- {r.get('project_name', r['project_id'])}" for r in successful]) or "None"}

### Failed Projects
{chr(10).join([f"- {r.get('project_id')}: {r.get('error')}" for r in failed]) or "None"}
"""
            
            return {
                "messages": [AIMessage(content=str(summary))],
                "context": state.get("context", {}),
                "outputs": {
                    **outputs,
                    "aggregate_summary": summary,
                    "success_count": len(successful),
                    "failure_count": len(failed)
                }
            }
        
        return handler
    
    def _create_dashboard_supervisor(self, config: Dict) -> Callable:
        """Create a dashboard supervisor that routes decisions across projects"""
        async def handler(state: Dict) -> Dict:
            from langchain_core.messages import AIMessage
            
            model = config.get("model", "gemini-3-flash-preview")
            llm = self._get_llm(model)
            
            outputs = state.get("outputs", {})
            project_results = outputs.get("project_results", [])
            
            # Use LLM to decide next steps based on results
            prompt = f"""You are a dashboard supervisor overseeing a multi-project initiative.

Current Results:
{project_results}

Decide the next action. Output one of:
- CONTINUE: All projects are progressing well
- PAUSE: Some issues need attention
- COMPLETE: Initiative is finished

Provide your decision and brief reasoning."""

            response = await llm.ainvoke([{"role": "user", "content": prompt}])
            decision_text = extract_text_content(response.content)
            
            # Parse decision
            decision = "continue"
            if "PAUSE" in decision_text.upper():
                decision = "pause"
            elif "COMPLETE" in decision_text.upper():
                decision = "complete"
            
            return {
                "messages": [AIMessage(content=decision_text)],
                "context": state.get("context", {}),
                "outputs": {
                    **outputs,
                    "supervisor_decision": decision,
                    "supervisor_reasoning": decision_text
                },
                "dashboard_supervisor_decision": decision
            }
        
        return handler
    
    # ═══════════════════════════════════════════════════════════════
    # PROJECT-LEVEL NODE HANDLERS
    # ═══════════════════════════════════════════════════════════════
    
    def _create_feature_spawner(self, config: Dict) -> Callable:
        """Create a feature spawner that creates features for workflow stages"""
        async def handler(state: Dict) -> Dict:
            import httpx
            from langchain_core.messages import AIMessage
            
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            project_id = context.get("project_id")
            auto_start = config.get("auto_start", False)
            
            # Get current stage info
            current_stage = context.get("current_stage", {})
            stage_name = current_stage.get("name", "Unknown Stage")
            
            print(f"[FeatureSpawner] Creating features for stage: {stage_name}")
            
            features_created = []
            nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
            
            if project_id:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    # Create a feature for this stage
                    feature_data = {
                        "project_id": project_id,
                        "name": f"[{stage_name}] Stage Work",
                        "description": f"Auto-generated feature for workflow stage: {stage_name}",
                        "status": "building" if auto_start else "idea",
                        "metadata": {
                            "source": "workflow",
                            "stage": stage_name
                        }
                    }
                    
                    try:
                        resp = await client.post(
                            f"{nodejs_url}/api/features",
                            json=feature_data
                        )
                        if resp.status_code in [200, 201]:
                            feature = resp.json()
                            features_created.append(feature.get("id"))
                            print(f"[FeatureSpawner] Created feature: {feature.get('id')}")
                    except Exception as e:
                        print(f"[FeatureSpawner] Error: {e}")
            
            return {
                "messages": [AIMessage(content=f"Created {len(features_created)} features for stage: {stage_name}")],
                "context": context,
                "outputs": {
                    **outputs,
                    "features_created": features_created,
                    "current_stage": stage_name
                }
            }
        
        return handler
    
    def _create_stage_manager(self, config: Dict) -> Callable:
        """Create a stage manager that tracks and advances workflow stages"""
        async def handler(state: Dict) -> Dict:
            from langchain_core.messages import AIMessage
            
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            require_all_complete = config.get("require_all_complete", True)
            
            # Get workflow stages from context
            stages = context.get("stages", [])
            current_stage_index = context.get("current_stage_index", 0)
            
            print(f"[StageManager] Current stage: {current_stage_index + 1}/{len(stages)}")
            
            # Check if current stage is complete
            features_created = outputs.get("features_created", [])
            stage_complete = len(features_created) > 0  # Simplified check
            
            next_stage_index = current_stage_index
            if stage_complete and current_stage_index < len(stages) - 1:
                next_stage_index = current_stage_index + 1
            
            is_workflow_complete = next_stage_index >= len(stages) - 1 and stage_complete
            
            return {
                "messages": [AIMessage(content=f"Stage {current_stage_index + 1} complete. Moving to stage {next_stage_index + 1}.")],
                "context": {
                    **context,
                    "current_stage_index": next_stage_index,
                    "current_stage": stages[next_stage_index] if next_stage_index < len(stages) else None
                },
                "outputs": {
                    **outputs,
                    "stage_advanced": next_stage_index > current_stage_index,
                    "workflow_complete": is_workflow_complete
                },
                "stage_manager_complete": is_workflow_complete
            }
        
        return handler
    
    def _create_project_supervisor(self, config: Dict) -> Callable:
        """Create a project supervisor that routes decisions within a project"""
        async def handler(state: Dict) -> Dict:
            from langchain_core.messages import AIMessage
            
            model = config.get("model", "gemini-2.5-flash")
            llm = self._get_llm(model)
            
            context = state.get("context", {})
            outputs = state.get("outputs", {})
            
            # Gather project state
            features_created = outputs.get("features_created", [])
            current_stage = context.get("current_stage", {})
            
            prompt = f"""You are a project workflow supervisor.

Current Stage: {current_stage.get('name', 'Unknown')}
Features Created: {len(features_created)}
Stage Description: {current_stage.get('description', 'N/A')}

Decide the next action:
- ADVANCE: Move to next stage
- WAIT: Wait for features to complete
- REVIEW: Manual review needed

Provide your decision and reasoning."""

            response = await llm.ainvoke([{"role": "user", "content": prompt}])
            decision_text = extract_text_content(response.content)
            
            decision = "wait"
            if "ADVANCE" in decision_text.upper():
                decision = "advance"
            elif "REVIEW" in decision_text.upper():
                decision = "review"
            
            return {
                "messages": [AIMessage(content=decision_text)],
                "context": context,
                "outputs": {
                    **outputs,
                    "project_supervisor_decision": decision,
                    "project_supervisor_reasoning": decision_text
                },
                "project_supervisor_decision": decision
            }
        
        return handler

