"""
Security Task Creator Node - Creates security remediation tasks under a project.

Takes security analysis results from upstream nodes (structured list of findings)
and creates tasks using the same NexusClient pattern as DocumentationTaskCreatorNode.
"""

import json
import re
from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class SecurityTaskCreatorNode(AtomicNode):
    """
    Creates security remediation tasks under a project.
    
    Parses structured security findings from upstream general_agent
    and calls the Node.js backend API to create tasks. Each task is
    assigned the nexus-prime template for full remediation workflow.
    """
    
    type_id = "security_task_creator"
    display_name = "Security Task Creator"
    description = "Creates security remediation tasks from analysis results"
    category = "utility"
    icon = "🛡️"
    version = 1.0
    levels = ["project"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Source Field",
                "name": "source_field",
                "type": "string",
                "default": "result",
                "description": "Which field from the upstream node output contains the security analysis JSON",
            },
            {
                "displayName": "Max Tasks",
                "name": "max_tasks",
                "type": "number",
                "default": 15,
                "description": "Maximum number of tasks to create",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Parse security findings and create remediation tasks."""
        
        source_field = ctx.get_node_parameter("source_field", "result")
        max_tasks = ctx.get_node_parameter("max_tasks", 15)
        
        # Get project_id from execution context
        project_id = ctx.project_id
        if not project_id and items:
            project_id = items[0].json.get("context", {}).get("project_id")
        
        print(f"[SecurityTaskCreator] project_id: {project_id}")
        
        if not project_id:
            print("[SecurityTaskCreator] ERROR: No project_id available")
            return [[NodeExecutionData(
                json={"error": "No project_id available in context"},
                error=Exception("No project_id available")
            )]]
        
        # Extract security analysis from upstream node output
        raw_analysis = ""
        if items:
            for item in items:
                top_keys = list(item.json.keys()) if isinstance(item.json, dict) else "not a dict"
                print(f"[SecurityTaskCreator] item.json top-level keys: {top_keys}")
                
                outputs = item.json.get("outputs", {})
                if outputs:
                    print(f"[SecurityTaskCreator] outputs keys: {list(outputs.keys())}")
                
                # Check namespaced node outputs first (e.g. outputs.general_agent.result)
                for node_key in ["general_agent", "analyze"]:
                    node_output = outputs.get(node_key, {})
                    if isinstance(node_output, dict) and node_output.get(source_field):
                        raw_analysis = node_output[source_field]
                        print(f"[SecurityTaskCreator] Found analysis in outputs.{node_key}.{source_field}")
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
                    print(f"[SecurityTaskCreator] Found analysis ({len(raw_analysis)} chars)")
                    break
        
        if not raw_analysis:
            if items:
                outputs = items[0].json.get("outputs", {})
                ga_output = outputs.get("general_agent", {})
                print(f"[SecurityTaskCreator] general_agent output: {ga_output}")
            print("[SecurityTaskCreator] ERROR: No security analysis found in upstream output")
            return [[NodeExecutionData(
                json={
                    "error": "No security analysis found in upstream output",
                    "project_id": project_id,
                    "tasks_created": 0
                }
            )]]
        
        # Parse the JSON array of findings from the analysis text
        findings = self._extract_findings(raw_analysis)
        print(f"[SecurityTaskCreator] Parsed {len(findings)} findings from analysis")
        
        if not findings:
            print(f"[SecurityTaskCreator] No actionable findings. Raw text preview: {raw_analysis[:300]}")
            return [[NodeExecutionData(
                json={
                    "message": "No security concerns identified — clean bill of health",
                    "project_id": project_id,
                    "tasks_created": 0,
                    "raw_analysis": raw_analysis[:500]
                }
            )]]
        
        # Limit number of tasks
        findings = findings[:max_tasks]
        
        # Create tasks via Node.js backend API
        import httpx
        import os
        
        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
        created_tasks = []
        errors = []
        skipped_duplicates = 0
        
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Fetch existing tasks for this project to prevent duplicates
            existing_titles = set()
            try:
                resp = await client.get(
                    f"{nodejs_url}/api/projects/{project_id}/tasks"
                )
                if resp.status_code == 200:
                    existing = resp.json()
                    task_list = existing.get("tasks", existing) if isinstance(existing, dict) else existing
                    if isinstance(task_list, list):
                        existing_titles = {
                            t.get("title", "").strip().lower()
                            for t in task_list
                            if isinstance(t, dict) and t.get("title")
                        }
                    print(f"[SecurityTaskCreator] Found {len(existing_titles)} existing tasks for dedup")
            except Exception as e:
                print(f"[SecurityTaskCreator] Warning: Could not fetch existing tasks for dedup: {e}")
            
            for finding in findings:
                title = finding.get("title", "Security Fix Required")
                description = self._format_task_description(finding)
                
                # Skip if a task with this title already exists (case-insensitive)
                if title.strip().lower() in existing_titles:
                    skipped_duplicates += 1
                    print(f"[SecurityTaskCreator] Skipped duplicate: {title}")
                    continue
                
                try:
                    response = await client.post(
                        f"{nodejs_url}/api/tools/create-task",
                        json={
                            "project_id": project_id,
                            "title": title,
                            "description": description,
                            "status": "idea",
                            "source": "workflow:security-sweep",
                            "templateId": "nexus-prime"
                        }
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        task = result.get("task", {})
                        task_id = task.get("id", "unknown")
                        created_tasks.append({
                            "task_id": task_id,
                            "title": title,
                            "severity": finding.get("severity", "medium"),
                            "category": finding.get("category", "general"),
                            "files": finding.get("files", []),
                        })
                        # Track locally to prevent intra-run duplicates
                        existing_titles.add(title.strip().lower())
                        print(f"[SecurityTaskCreator] Created task: {title} (ID: {task_id})")
                    else:
                        error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                        errors.append({"title": title, "error": error_msg})
                        print(f"[SecurityTaskCreator] Failed to create task '{title}': {error_msg}")
                except Exception as e:
                    errors.append({
                        "title": title,
                        "error": str(e)
                    })
                    print(f"[SecurityTaskCreator] Failed to create task '{title}': {e}")
        
        if skipped_duplicates:
            print(f"[SecurityTaskCreator] Skipped {skipped_duplicates} duplicate task(s)")
        
        return [[NodeExecutionData(
            json={
                "project_id": project_id,
                "tasks_created": len(created_tasks),
                "tasks": created_tasks,
                "errors": errors,
                "findings_analyzed": len(findings),
                "duplicates_skipped": skipped_duplicates,
                "source": "workflow:security-sweep"
            }
        )]]
    
    def _extract_findings(self, text: str) -> List[Dict]:
        """Extract JSON array of security findings from LLM output text."""
        # Try direct JSON parse first
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict):
                # Check common wrapper keys
                for key in ["findings", "vulnerabilities", "issues", "security_issues"]:
                    if key in parsed and isinstance(parsed[key], list):
                        return parsed[key]
        except (json.JSONDecodeError, TypeError):
            pass
        
        # Try to find JSON array in the text (LLM may wrap in markdown code blocks)
        json_match = re.search(r'\[[\s\S]*?\]', text)
        if json_match:
            try:
                return json.loads(json_match.group())
            except json.JSONDecodeError:
                pass
        
        # Last resort: try to find individual JSON objects
        objects = re.findall(r'\{[^{}]+\}', text)
        findings = []
        for obj_str in objects:
            try:
                obj = json.loads(obj_str)
                if "title" in obj or "severity" in obj or "category" in obj:
                    findings.append(obj)
            except json.JSONDecodeError:
                continue
        
        return findings
    
    def _format_task_description(self, finding: Dict) -> str:
        """Format a security finding into a rich task description."""
        parts = []
        
        severity = finding.get("severity", "medium").upper()
        category = finding.get("category", "General")
        parts.append(f"**Severity:** {severity}")
        parts.append(f"**Category:** {category}")
        
        files = finding.get("files", [])
        if files:
            file_list = ", ".join(f"`{f}`" for f in files[:10])
            parts.append(f"**Affected Files:** {file_list}")
        
        if finding.get("description"):
            parts.append(f"\n**Details:**\n{finding['description']}")
        
        if finding.get("evidence"):
            parts.append(f"\n**Evidence:**\n```\n{finding['evidence']}\n```")
        
        if finding.get("remediation"):
            parts.append(f"\n**Recommended Fix:**\n{finding['remediation']}")
        
        parts.append(f"\n**Source:** Security Sweep Workflow (automated)")
        
        return "\n".join(parts)


__all__ = ["SecurityTaskCreatorNode"]
