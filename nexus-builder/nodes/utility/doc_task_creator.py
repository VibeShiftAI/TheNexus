"""
Documentation Task Creator Node - Creates documentation update tasks under a project.

Takes analysis results from upstream nodes (structured list of documentation gaps)
and creates tasks using the NexusClient.add_task() pattern from the Cortex executor.
"""

import json
import re
from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class DocumentationTaskCreatorNode(AtomicNode):
    """
    Creates documentation update tasks under a project.
    
    Parses structured gap analysis from upstream nodes and calls
    NexusClient.add_task() for each gap — the same pattern used by
    the Cortex execution_node after plan approval.
    """
    
    type_id = "doc_task_creator"
    display_name = "Documentation Task Creator"
    description = "Creates documentation update tasks from analysis results"
    category = "utility"
    icon = "📝"
    version = 1.0
    levels = ["project"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Source Field",
                "name": "source_field",
                "type": "string",
                "default": "result",
                "description": "Which field from the upstream node output contains the gap analysis JSON",
            },
            {
                "displayName": "Max Tasks",
                "name": "max_tasks",
                "type": "number",
                "default": 10,
                "description": "Maximum number of tasks to create",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Parse gap analysis and create tasks via NexusClient."""
        
        source_field = ctx.get_node_parameter("source_field", "result")
        max_tasks = ctx.get_node_parameter("max_tasks", 10)
        
        # Get project_id from execution context
        project_id = ctx.project_id
        if not project_id and items:
            project_id = items[0].json.get("context", {}).get("project_id")
        
        print(f"[DocTaskCreator] project_id: {project_id}")
        print(f"[DocTaskCreator] source_field: {source_field}")
        
        if not project_id:
            print("[DocTaskCreator] ERROR: No project_id available")
            return [[NodeExecutionData(
                json={"error": "No project_id available in context"},
                error=Exception("No project_id available")
            )]]
        
        # Extract gap analysis from upstream node output
        raw_analysis = ""
        if items:
            for item in items:
                # Log what keys are available at each level
                top_keys = list(item.json.keys()) if isinstance(item.json, dict) else "not a dict"
                print(f"[DocTaskCreator] item.json top-level keys: {top_keys}")
                
                outputs = item.json.get("outputs", {})
                if outputs:
                    print(f"[DocTaskCreator] outputs keys: {list(outputs.keys())}")
                
                # Check multiple possible locations for the analysis
                outputs = item.json.get("outputs", {})
                
                # Check namespaced node outputs first (e.g. outputs.general_agent.result)
                for node_key in ["general_agent", "analyze"]:
                    node_output = outputs.get(node_key, {})
                    if isinstance(node_output, dict) and node_output.get(source_field):
                        raw_analysis = node_output[source_field]
                        print(f"[DocTaskCreator] Found analysis in outputs.{node_key}.{source_field}")
                        break
                
                # Fallback: check flat keys
                if not raw_analysis:
                    raw_analysis = (
                        item.json.get(source_field, "") or
                        item.json.get("result", "") or
                        outputs.get(source_field, "") or
                        outputs.get("result", "")
                    )
                
                if raw_analysis:
                    print(f"[DocTaskCreator] Found analysis ({len(raw_analysis)} chars)")
                    print(f"[DocTaskCreator] Analysis preview: {raw_analysis[:200]}...")
                    break
        
        if not raw_analysis:
            # Log what general_agent actually returned so we can debug
            if items:
                outputs = items[0].json.get("outputs", {})
                ga_output = outputs.get("general_agent", {})
                print(f"[DocTaskCreator] general_agent output: {ga_output}")
            print("[DocTaskCreator] ERROR: No gap analysis found in upstream output")
            return [[NodeExecutionData(
                json={
                    "error": "No gap analysis found in upstream output",
                    "project_id": project_id,
                    "tasks_created": 0
                }
            )]]
        
        # Parse the JSON array from the analysis text
        gaps = self._extract_gaps(raw_analysis)
        print(f"[DocTaskCreator] Parsed {len(gaps)} gaps from analysis")
        
        if not gaps:
            print(f"[DocTaskCreator] WARNING: No parseable gaps. Raw text: {raw_analysis[:300]}")
            return [[NodeExecutionData(
                json={
                    "message": "No documentation gaps identified",
                    "project_id": project_id,
                    "tasks_created": 0,
                    "raw_analysis": raw_analysis[:500]
                }
            )]]
        
        # Limit number of tasks
        gaps = gaps[:max_tasks]
        
        # Create tasks via Node.js backend API (httpx)
        import httpx
        import os
        
        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
        created_tasks = []
        errors = []
        
        async with httpx.AsyncClient(timeout=15.0) as client:
            for gap in gaps:
                title = gap.get("title", "Documentation Update")
                description = self._format_task_description(gap)
                
                try:
                    response = await client.post(
                        f"{nodejs_url}/api/tools/create-task",
                        json={
                            "project_id": project_id,
                            "title": title,
                            "description": description,
                            "status": "idea",
                            "source": "workflow:documentation"
                        }
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        task = result.get("task", {})
                        task_id = task.get("id", "unknown")
                        created_tasks.append({
                            "task_id": task_id,
                            "title": title,
                            "action": gap.get("action", "update"),
                            "file": gap.get("file", "unknown"),
                            "priority": gap.get("priority", "medium")
                        })
                        print(f"[DocTaskCreator] Created task: {title} (ID: {task_id})")
                    else:
                        error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                        errors.append({"title": title, "error": error_msg})
                        print(f"[DocTaskCreator] Failed to create task '{title}': {error_msg}")
                except Exception as e:
                    errors.append({
                        "title": title,
                        "error": str(e)
                    })
                    print(f"[DocTaskCreator] Failed to create task '{title}': {e}")
        
        return [[NodeExecutionData(
            json={
                "project_id": project_id,
                "tasks_created": len(created_tasks),
                "tasks": created_tasks,
                "errors": errors,
                "gaps_analyzed": len(gaps),
                "source": "workflow:documentation"
            }
        )]]
    
    def _extract_gaps(self, text: str) -> List[Dict]:
        """Extract JSON array of gaps from LLM output text."""
        # Try direct JSON parse first
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict) and "gaps" in parsed:
                return parsed["gaps"]
        except (json.JSONDecodeError, TypeError):
            pass
        
        # Try to find JSON array in the text (LLM may wrap in markdown)
        json_match = re.search(r'\[[\s\S]*?\]', text)
        if json_match:
            try:
                return json.loads(json_match.group())
            except json.JSONDecodeError:
                pass
        
        # Last resort: try to find individual JSON objects
        objects = re.findall(r'\{[^{}]+\}', text)
        gaps = []
        for obj_str in objects:
            try:
                obj = json.loads(obj_str)
                if "title" in obj or "file" in obj:
                    gaps.append(obj)
            except json.JSONDecodeError:
                continue
        
        return gaps
    
    def _format_task_description(self, gap: Dict) -> str:
        """Format a gap into a rich task description."""
        parts = []
        
        action = gap.get("action", "update").title()
        file = gap.get("file", "unknown")
        parts.append(f"**Action:** {action} `.context/{file}`")
        
        if gap.get("description"):
            parts.append(f"\n**Details:**\n{gap['description']}")
        
        if gap.get("priority"):
            parts.append(f"\n**Priority:** {gap['priority'].title()}")
        
        parts.append(f"\n**Source:** Documentation Workflow (automated)")
        
        return "\n".join(parts)


__all__ = ["DocumentationTaskCreatorNode"]
