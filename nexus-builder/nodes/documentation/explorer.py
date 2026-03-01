"""
Doc Explorer Node - Explores existing documentation and codebase.

Reads .context/ files, READMEs, git history, and uses tools for
deeper exploration to understand what documentation exists and
what needs updating.
"""

import os
from typing import Any, Dict, List

from ..core.base import AtomicNode, NodeExecutionContext, NodeExecutionData


class DocExplorerNode(AtomicNode):
    """Explore codebase documentation before drafting changes."""

    type_id = "doc_explorer"
    display_name = "Doc Explorer"
    description = "Explores existing documentation and codebase structure to prepare for documentation updates"
    category = "documentation"
    icon = "🔍"
    version = 1.0
    levels = ["project", "task"]
    node_type = "atomic"
    default_model = "gemini-2.5-flash"

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "File Patterns",
                "name": "file_patterns",
                "type": "string",
                "default": ".context/,*.md",
                "description": "Comma-separated glob patterns to search for documentation files",
            },
            {
                "displayName": "Include Git Log",
                "name": "include_git_log",
                "type": "boolean",
                "default": True,
                "description": "Include recent git history to identify undocumented changes",
            },
            {
                "displayName": "Max Depth",
                "name": "max_depth",
                "type": "number",
                "default": 3,
                "description": "Maximum directory depth to search for documentation",
            },
        ]

    async def execute(
        self, ctx: NodeExecutionContext, items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        from langchain_core.messages import HumanMessage
        from model_config import get_gemini_flash

        input_payload = items[0].json if items else {}
        context = input_payload.get("context", {})
        project_path = ctx.get_node_parameter(
            "project_root",
            context.get("project_path", context.get("project_root", ".")),
        )
        task_description = context.get("task_description", "Update documentation")

        # ── Gather existing documentation ──────────────────────
        doc_files: Dict[str, str] = {}
        context_dir = os.path.join(project_path, ".context")

        if os.path.isdir(context_dir):
            for filename in os.listdir(context_dir):
                if filename.endswith((".md", ".txt")):
                    filepath = os.path.join(context_dir, filename)
                    try:
                        with open(filepath, "r", encoding="utf-8") as f:
                            doc_files[filepath] = f.read()
                    except Exception as e:
                        print(f"[DocExplorer] Could not read {filepath}: {e}")

        # Top-level markdown files
        for doc_name in ["README.md", "CHANGELOG.md", "CONTRIBUTING.md"]:
            doc_path = os.path.join(project_path, doc_name)
            if os.path.isfile(doc_path):
                try:
                    with open(doc_path, "r", encoding="utf-8") as f:
                        doc_files[doc_path] = f.read()
                except Exception:
                    pass

        # ── LLM-driven exploration ─────────────────────────────
        try:
            from tools import get_registry
            registry = get_registry()
            doc_tools = registry.get_langchain_tools([
                "read_file", "list_directory", "get_project_context",
                "git_log", "search_codebase",
            ])
        except Exception:
            doc_tools = []

        exploration_prompt = f"""You are exploring a codebase to prepare for a documentation task.

TASK: {task_description}
PROJECT ROOT: {project_path}

EXISTING DOCUMENTATION FILES FOUND:
{chr(10).join(f'- {path} ({len(content)} chars)' for path, content in doc_files.items())}

Use your tools to:
1. Call get_project_context to see the full .context/ documentation
2. Call git_log to see recent changes that might need documenting
3. Call search_codebase if you need to find specific patterns

Reply with a summary of what you found and what documentation changes are needed.
"""
        llm = get_gemini_flash(temperature=0)
        model = llm.bind_tools(doc_tools) if doc_tools else llm
        messages = [HumanMessage(content=exploration_prompt)]

        from token_tracker import TRACKING_HANDLER
        callbacks = [TRACKING_HANDLER] if TRACKING_HANDLER else []
        invoke_config = {"callbacks": callbacks}

        for _ in range(5):
            response = await model.ainvoke(messages, config=invoke_config)
            messages.append(response)
            if not getattr(response, "tool_calls", None):
                break
            from langgraph.prebuilt import ToolNode
            tool_node = ToolNode(doc_tools)
            tool_results = await tool_node.ainvoke({"messages": messages})
            messages.extend(tool_results.get("messages", []))

        exploration_summary = response.content if hasattr(response, "content") else str(response)

        return [[NodeExecutionData(json={
            **input_payload,
            "outputs": {
                **input_payload.get("outputs", {}),
                "doc_exploration": {
                    "existing_files": doc_files,
                    "summary": exploration_summary,
                },
            },
            "messages": input_payload.get("messages", []) + [
                {"role": "assistant", "content": f"[Doc Explorer] {exploration_summary[:500]}"}
            ],
        })]]
