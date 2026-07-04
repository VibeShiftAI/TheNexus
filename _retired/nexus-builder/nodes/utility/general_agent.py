"""
General Agent Node - Multi-step task execution with tools

Full tool access for complex tasks. Uses LangGraph's create_react_agent
for a multi-turn ReAct loop with configurable turn budget.
"""

import json
from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class GeneralAgentNode(AtomicNode):
    """
    General-purpose agent for multi-step task execution.
    
    Uses LangGraph's create_react_agent with bound tools from the
    tool registry. Has access to file reading, code search, git history,
    and more.
    """
    
    type_id = "general_agent"
    display_name = "General Agent"
    description = "Multi-step task execution with full tool access"
    category = "orchestration"
    icon = "🤖"
    version = 2.0
    levels = ["dashboard", "project", "feature"]
    
    # Tools the general agent gets access to
    DEFAULT_TOOLS = [
        "get_project_context",
        "read_file",
        "read_multiple_files",
        "list_directory",
        "explore_codebase",
        "search_files",
        "search_codebase",
        "git_log",
        "git_diff",
        "git_show",
    ]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Task",
                "name": "task",
                "type": "string",
                "default": "",
                "description": "Task description for the agent to execute",
                "required": True,
            },
            {
                "displayName": "Max Turns",
                "name": "max_turns",
                "type": "number",
                "default": 10,
                "description": "Maximum reasoning/action turns before stopping",
            },
            {
                "displayName": "Model",
                "name": "model",
                "type": "string",
                "default": "gemini-3-flash-preview",
                "description": "LLM model to use for reasoning",
            },
            {
                "displayName": "Verbose",
                "name": "verbose",
                "type": "boolean",
                "default": True,
                "description": "Log each reasoning step",
            },
            {
                "displayName": "Tools",
                "name": "tools",
                "type": "string",
                "default": "",
                "description": "Comma-separated list of tool names (empty = defaults)",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute multi-step task with ReAct loop and tools."""
        from model_config import get_gemini_flash
        from langchain_core.messages import HumanMessage, SystemMessage
        
        task = ctx.get_node_parameter("task", "")
        max_turns = ctx.get_node_parameter("max_turns", 10)
        model_name = ctx.get_node_parameter("model", "gemini-3-flash-preview")
        verbose = ctx.get_node_parameter("verbose", True)
        tools_param = ctx.get_node_parameter("tools", "")
        
        # Allow task from input
        if not task and items:
            task = items[0].json.get("task", "") or items[0].json.get("goal", "")
        
        if not task:
            return [[NodeExecutionData(
                json={"error": "No task specified"},
                error=Exception("No task specified")
            )]]
        
        # Build rich context from upstream node outputs
        upstream_context = self._build_upstream_context(items)
        
        # Get project_root for tool context — supervisor sends 'project_path' 
        project_root = (
            ctx.get_node_parameter("project_root", "") or
            ctx.get_node_parameter("project_path", "") or
            "."
        )
        
        # Build a run-scoped log tag for observability
        run_id = ctx.get_node_parameter("run_id", "") or ""
        if not run_id:
            # Try to get from upstream context
            if items:
                run_id = items[0].json.get("context", {}).get("run_id", "")
        log_tag = f"[GeneralAgent][{run_id[:8]}]" if run_id else "[GeneralAgent]"
        
        if verbose:
            print(f"{log_tag} Task: {task[:80]}...")
            print(f"{log_tag} Project root: {project_root}")
            print(f"{log_tag} Upstream context: {len(upstream_context)} chars")
        
        # Get tools from registry
        tool_names = [t.strip() for t in tools_param.split(",") if t.strip()] if tools_param else self.DEFAULT_TOOLS
        
        # Get project_id for tools that need it
        project_id = ctx.project_id or ""
        tools = self._get_tools(tool_names, project_root, project_id)
        
        if verbose:
            print(f"{log_tag} Tools loaded: {[t.name for t in tools]}")
            print(f"{log_tag} Project ID: {project_id}")
        
        system_prompt = f"""You are an expert code analyst with access to tools for exploring a codebase.

You have access to these tools:
- get_project_context: Get ALL existing .context/ documentation — USE THIS FIRST
- read_file: Read a specific file's contents
- read_multiple_files: Read multiple files at once (comma-separated paths) — MORE EFFICIENT than reading one at a time
- list_directory: List files in a directory
- explore_codebase: Get file tree and structure overview — USE THIS INSTEAD of calling list_directory repeatedly
- search_files: Search for files by name/pattern
- search_codebase: Search code content (grep)
- git_log: View recent commit history
- git_diff: View recently changed files
- git_show: View specific commit details

The project is located at: {project_root}

**Strategy:**
1. FIRST call get_project_context to see what documentation already exists
2. Call explore_codebase to get the full file tree in ONE call (do NOT use list_directory repeatedly)
3. Use read_multiple_files to batch-read key files (package.json, README.md, etc.) in one call
4. Use git_log/git_diff to see what changed recently
5. Compare what you found against the existing documentation
6. Produce your analysis

When using file tools, use paths relative to the project root.
Be thorough but efficient — minimize tool calls by batching reads and using explore_codebase for structure."""

        user_prompt = f"""Execute this task:

**Task**: {task}

**Context from previous analysis**:
{upstream_context or "None available — use tools to explore the codebase."}

Use the available tools to gather information, then provide your complete analysis."""

        try:
            llm = get_gemini_flash(temperature=0.3)
            
            if tools:
                # Use ReAct agent with tools
                result = await self._run_react_agent(
                    llm, tools, system_prompt, user_prompt, 
                    max_turns, verbose, log_tag
                )
            else:
                # Fallback: single-turn without tools
                result = await self._run_single_turn(
                    llm, system_prompt, user_prompt, verbose
                )
            
            if verbose:
                print(f"{log_tag} Result length: {len(result)} chars")
            
            return [[NodeExecutionData(
                json={
                    "task": task,
                    "result": result,
                    "turns_used": max_turns,
                    "max_turns": max_turns,
                    "model": model_name,
                }
            )]]
            
        except Exception as e:
            print(f"{log_tag} ERROR: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            return [[NodeExecutionData(
                json={"error": str(e), "task": task},
                error=e
            )]]
    
    async def _run_react_agent(self, llm, tools, system_prompt, user_prompt, max_turns, verbose, log_tag="[GeneralAgent]"):
        """Run a ReAct agent loop with tool calling."""
        from langgraph.prebuilt import create_react_agent
        
        # Create the ReAct agent graph
        agent = create_react_agent(
            model=llm,
            tools=tools,
            prompt=system_prompt,
        )
        
        # Stream for verbose logging
        final_content = ""
        tool_call_count = 0
        
        async for event in agent.astream(
            {"messages": [HumanMessage(content=user_prompt)]},
            config={"recursion_limit": max_turns * 4 + 10},
            stream_mode="updates",
        ):
            for node_name, node_output in event.items():
                messages = node_output.get("messages", [])
                for msg in messages:
                    if verbose:
                        if msg.type == "ai":
                            # Log tool calls the agent wants to make
                            if hasattr(msg, 'tool_calls') and msg.tool_calls:
                                for tc in msg.tool_calls:
                                    tool_call_count += 1
                                    args_preview = str(tc.get('args', {}))[:100]
                                    print(f"{log_tag} 🔧 Tool call #{tool_call_count}: {tc.get('name')} ({args_preview})")
                            elif msg.content:
                                # Final answer
                                content = msg.content
                                if isinstance(content, list):
                                    content = "\n".join(
                                        block.get("text", str(block)) if isinstance(block, dict) else str(block)
                                        for block in content
                                    )
                                final_content = content
                                print(f"{log_tag} ✅ Final answer: {len(content)} chars")
                        elif msg.type == "tool":
                            result_preview = str(msg.content)[:150]
                            print(f"{log_tag} 📋 Tool result: {result_preview}...")
        
        if verbose:
            print(f"{log_tag} Agent completed: {tool_call_count} tool calls")
        
        return final_content
    
    async def _run_single_turn(self, llm, system_prompt, user_prompt, verbose):
        """Fallback: single-turn LLM call without tools."""
        from langchain_core.messages import HumanMessage, SystemMessage
        
        response = await llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ])
        
        result = response.content
        if isinstance(result, list):
            result = "\n".join(
                block.get("text", str(block)) if isinstance(block, dict) else str(block)
                for block in result
            )
        return result
    
    def _get_tools(self, tool_names: List[str], project_root: str, project_id: str = ""):
        """Get LangChain tools from the tool registry with project context injected."""
        try:
            from tools import get_registry
            from langchain_core.tools import StructuredTool
            from pydantic import create_model
            import inspect
            from typing import Any as TypingAny
            
            registry = get_registry()
            
            tools = []
            for name in tool_names:
                nexus_tool = registry.get(name)
                if nexus_tool:
                    lc_tool = self._make_context_tool(
                        nexus_tool, project_root, project_id, create_model, inspect, TypingAny
                    )
                    tools.append(lc_tool)
                else:
                    print(f"[GeneralAgent] Warning: Tool '{name}' not found in registry")
            
            return tools
        except Exception as e:
            print(f"[GeneralAgent] Warning: Could not load tools: {e}")
            import traceback
            traceback.print_exc()
            return []
    
    @staticmethod
    def _make_context_tool(nexus_tool, project_root, project_id, create_model, inspect, TypingAny):
        """Create a LangChain tool with project_root context injected."""
        from langchain_core.tools import StructuredTool
        
        context = {"project_root": project_root, "project_id": project_id}
        
        # Build args schema from execute() signature
        sig = inspect.signature(nexus_tool.execute)
        fields = {}
        for pname, param in sig.parameters.items():
            if pname in ("self", "context") or param.kind == inspect.Parameter.VAR_KEYWORD:
                continue
            annotation = param.annotation
            if annotation == inspect.Parameter.empty or isinstance(annotation, str):
                annotation = TypingAny
            if param.default == inspect.Parameter.empty:
                fields[pname] = (annotation, ...)
            else:
                fields[pname] = (annotation, param.default)
        
        args_schema = create_model(f"{nexus_tool.__class__.__name__}Schema", **fields)
        
        # Factory-created coroutine — no closure issues
        async def tool_coroutine(**kwargs):
            result = await nexus_tool.execute(context, **kwargs)
            if isinstance(result, dict):
                if result.get("success"):
                    # Node.js endpoints use different keys: result, content, items, results
                    # Use explicit None checks — empty lists [] are falsy but valid
                    data = None
                    for key in ("result", "content", "items", "results"):
                        val = result.get(key)
                        if val is not None:
                            data = val
                            break
                    
                    if data is None:
                        return "OK (no data returned)"
                    
                    # Format lists/dicts for readability
                    if isinstance(data, list):
                        if not data:
                            return "No results found."
                        return "\n".join(str(item) for item in data[:50])
                    return str(data)[:10000]
                return f"Error: {result.get('error', 'Unknown error')}"
            return str(result)
        
        return StructuredTool.from_function(
            coroutine=tool_coroutine,
            name=nexus_tool.metadata.name,
            description=nexus_tool.metadata.description,
            args_schema=args_schema,
        )
    
    def _build_upstream_context(self, items: List[NodeExecutionData]) -> str:
        """Build rich context string from upstream node outputs."""
        if not items:
            return ""
        
        context_parts = []
        
        for item in items:
            state = item.json
            outputs = state.get("outputs", {})
            
            # Extract codebase_explorer results (handles all output formats)
            explorer_output = outputs.get("codebase_explorer", {})
            if explorer_output and isinstance(explorer_output, dict):
                project_root = explorer_output.get("project_root", "")
                results = explorer_output.get("results", [])
                query = explorer_output.get("query", "")
                search_type = explorer_output.get("search_type", "")
                
                context_parts.append(f"## Codebase Exploration ({search_type}: {query})")
                context_parts.append(f"Project: {project_root}")
                context_parts.append(f"Found {len(results)} items:\n")
                
                for r in results[:80]:
                    if isinstance(r, dict):
                        # Structure map format
                        if "depth" in r:
                            path = r.get("path", "")
                            depth = r.get("depth", 0)
                            code_files = r.get("code_files", 0)
                            file_count = r.get("file_count", 0)
                            indent = "  " * depth
                            context_parts.append(f"{indent}{path}/ ({code_files} code, {file_count} total)")
                        # Grep result format  
                        elif "file" in r:
                            context_parts.append(f"  {r.get('file')}:{r.get('line', '')} {r.get('content', '')}")
                        # Glob result format
                        elif "path" in r:
                            context_parts.append(f"  {r.get('path')} ({r.get('type', 'file')})")
                context_parts.append("")
            
            # Also include any other upstream outputs as context
            for key, value in outputs.items():
                if key in ("codebase_explorer", "error"):
                    continue
                if isinstance(value, str) and len(value) > 50:
                    context_parts.append(f"## {key}")
                    context_parts.append(value[:2000])
                    context_parts.append("")
            
            # Project info from context
            context_data = state.get("context", {})
            project_path = context_data.get("project_path") or context_data.get("project_root")
            if project_path:
                context_parts.append(f"Project path: {project_path}")
        
        return "\n".join(context_parts)


# Import needed for _run_react_agent
from langchain_core.messages import HumanMessage

__all__ = ["GeneralAgentNode"]
