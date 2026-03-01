"""
Utility Nodes Package - Summarizers, Git Operations, Aggregators

Contains atomic nodes for utility operations.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class SummarizerNode(AtomicNode):
    """
    Summarizes content from previous nodes.
    
    Uses LLM to create concise summaries of workflow outputs.
    """
    
    type_id = "summarizer"
    display_name = "Summarizer"
    description = "Summarizes content from previous nodes"
    category = "utility"
    icon = "📄"
    version = 1.0
    levels = ["dashboard", "project", "feature"]
    node_type = "utility"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Model",
                "name": "model",
                "type": "string",
                "default": "gemini-3-flash-preview",
                "description": "LLM model to use for summarization",
            },
            {
                "displayName": "Max Length",
                "name": "max_length",
                "type": "number",
                "default": 500,
                "description": "Maximum summary length in words",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Summarize input content using LLM."""
        from model_config import get_gemini_flash
        from langchain_core.messages import HumanMessage
        
        model_name = ctx.get_node_parameter("model", "gemini-3-flash-preview")
        max_length = ctx.get_node_parameter("max_length", 500)
        
        # Collect all input data
        content_parts = []
        for item in items:
            for key, value in item.json.items():
                if isinstance(value, str) and len(value) > 50:
                    content_parts.append(f"{key}: {value[:1000]}...")
        
        if not content_parts:
            return [[NodeExecutionData(json={"summary": "No content to summarize"})]]
        
        prompt = f"""Summarize the following workflow outputs in {max_length} words or less:

{chr(10).join(content_parts)}

Provide a brief summary of what was accomplished."""
        
        try:
            llm = get_gemini_flash(temperature=0)
            response = await llm.ainvoke([HumanMessage(content=prompt)])
            
            return [[NodeExecutionData(
                json={"summary": response.content}
            )]]
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e), "summary": "Summarization failed"},
                error=e
            )]]


class GitCommitNode(AtomicNode):
    """
    Commits changes to git.
    
    Optionally pushes to remote.
    """
    
    type_id = "git_commit"
    display_name = "Git Commit"
    description = "Commits changes to git"
    category = "utility"
    icon = "📦"
    version = 1.0
    levels = ["project", "feature"]
    node_type = "utility"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Auto Push",
                "name": "auto_push",
                "type": "boolean",
                "default": False,
                "description": "Automatically push after commit",
            },
            {
                "displayName": "Commit Message Template",
                "name": "message_template",
                "type": "string",
                "default": "feat: {{ task_title }}",
                "description": "Commit message template",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute git commit."""
        import subprocess
        
        auto_push = ctx.get_node_parameter("auto_push", False)
        message_template = ctx.get_node_parameter("message_template", "feat: automated commit")
        
        # Get modified files from input
        modified_files = []
        if items:
            modified_files = items[0].json.get("modified_files", [])
        
        try:
            # Stage files
            for file_path in modified_files:
                subprocess.run(["git", "add", file_path], check=True, capture_output=True)
            
            # Commit
            result = subprocess.run(
                ["git", "commit", "-m", message_template],
                capture_output=True,
                text=True
            )
            
            commit_output = result.stdout or result.stderr
            
            # Optional push
            push_output = ""
            if auto_push:
                push_result = subprocess.run(
                    ["git", "push"],
                    capture_output=True,
                    text=True
                )
                push_output = push_result.stdout or push_result.stderr
            
            return [[NodeExecutionData(
                json={
                    "commit_output": commit_output,
                    "push_output": push_output,
                    "files_committed": modified_files,
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e)},
                error=e
            )]]


class AggregateResultsNode(AtomicNode):
    """
    Collects and summarizes results from multiple runs.
    
    Dashboard-level node for aggregating project results.
    """
    
    type_id = "aggregate_results"
    display_name = "Aggregate Results"
    description = "Collects and summarizes results from all project runs"
    category = "dashboard"
    icon = "📊"
    version = 1.0
    levels = ["dashboard"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Summary Format",
                "name": "summary_format",
                "type": "options",
                "default": "detailed",
                "options": [
                    {"name": "Brief", "value": "brief"},
                    {"name": "Detailed", "value": "detailed"},
                    {"name": "Metrics Only", "value": "metrics"},
                ],
                "description": "Output format for the summary",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Aggregate results from multiple inputs."""
        
        summary_format = ctx.get_node_parameter("summary_format", "detailed")
        
        # Collect all results
        all_results = [item.json for item in items]
        
        if summary_format == "brief":
            summary = f"Aggregated {len(all_results)} results"
        elif summary_format == "metrics":
            summary = {
                "total_items": len(all_results),
                "success_count": sum(1 for r in all_results if not r.get("error")),
                "error_count": sum(1 for r in all_results if r.get("error")),
            }
        else:
            summary = {
                "total_items": len(all_results),
                "results": all_results,
            }
        
        return [[NodeExecutionData(
            json={"aggregated": summary}
        )]]


# Import sub-agents from separate files
from .bash_executor import BashExecutorNode
from .codebase_explorer import CodebaseExplorerNode
from .plan_architect import PlanArchitectNode
from .general_agent import GeneralAgentNode
from .doc_task_creator import DocumentationTaskCreatorNode


__all__ = [
    "SummarizerNode",
    "GitCommitNode",
    "AggregateResultsNode",
    # Claude-style sub-agents
    "BashExecutorNode",
    "CodebaseExplorerNode",
    "PlanArchitectNode",
    "GeneralAgentNode",
    # Documentation workflow
    "DocumentationTaskCreatorNode",
]

