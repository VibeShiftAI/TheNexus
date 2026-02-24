"""
Plan Architect Node - Implementation planning specialist

Designs step-by-step implementation plans, identifies critical files, considers trade-offs.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class PlanArchitectNode(AtomicNode):
    """
    Software architect agent for designing implementation plans.
    
    Returns step-by-step plans, identifies critical files, considers architectural trade-offs.
    Inspired by Claude Code's Plan sub-agent.
    """
    
    type_id = "plan_architect"
    display_name = "Plan Architect"
    description = "Designs step-by-step implementation plans with file targets and trade-offs"
    category = "planning"
    icon = "📋"
    version = 1.0
    levels = ["project", "feature"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Goal",
                "name": "goal",
                "type": "string",
                "default": "",
                "description": "What needs to be implemented or changed",
                "required": True,
            },
            {
                "displayName": "Context",
                "name": "context",
                "type": "string",
                "default": "",
                "description": "Additional context about the codebase or requirements",
            },
            {
                "displayName": "Plan Depth",
                "name": "depth",
                "type": "options",
                "default": "detailed",
                "options": [
                    {"name": "High-Level", "value": "high_level"},
                    {"name": "Detailed", "value": "detailed"},
                    {"name": "Exhaustive", "value": "exhaustive"},
                ],
                "description": "How detailed the plan should be",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Generate implementation plan."""
        from model_config import get_gemini_flash
        from langchain_core.messages import HumanMessage, SystemMessage
        
        goal = ctx.get_node_parameter("goal", "")
        context = ctx.get_node_parameter("context", "")
        depth = ctx.get_node_parameter("depth", "detailed")
        
        # Allow goal from input
        if not goal and items:
            goal = items[0].json.get("goal", "") or items[0].json.get("task", "")
        
        if not goal:
            return [[NodeExecutionData(
                json={"error": "No goal specified"},
                error=Exception("No goal specified")
            )]]
        
        # Get codebase context if available
        codebase_info = ""
        if items:
            for item in items:
                if "results" in item.json:  # From explorer
                    codebase_info = f"\nCodebase structure: {item.json['results'][:10]}"
                if "research_dossier" in item.json:  # From researcher
                    codebase_info += f"\nResearch: {item.json['research_dossier'][:500]}"
        
        # Depth-specific instructions
        depth_instructions = {
            "high_level": "Provide a brief 3-5 step overview, focusing on major milestones.",
            "detailed": "Provide a detailed 5-10 step plan with specific file targets and code changes.",
            "exhaustive": "Provide an exhaustive plan covering all edge cases, testing requirements, and rollback strategies.",
        }
        
        system_prompt = """You are a software architect agent. Your job is to create clear, actionable implementation plans.

For each plan, you must provide:
1. **Steps**: Numbered, actionable steps
2. **Files**: Specific files to create or modify (with paths)
3. **Trade-offs**: Architectural decisions and alternatives considered
4. **Risks**: Potential issues and mitigation strategies

Format your response as structured Markdown."""

        user_prompt = f"""Create an implementation plan for this goal:

**Goal**: {goal}

**Additional Context**: {context or "None provided"}
{codebase_info}

**Depth**: {depth_instructions.get(depth, depth_instructions["detailed"])}

Provide a clear, actionable plan."""

        try:
            llm = get_gemini_flash(temperature=0.2)
            response = await llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt),
            ])
            
            plan_content = response.content
            
            # Parse file targets from the plan
            file_targets = self._extract_file_targets(plan_content)
            
            return [[NodeExecutionData(
                json={
                    "goal": goal,
                    "depth": depth,
                    "plan": plan_content,
                    "file_targets": file_targets,
                    "step_count": plan_content.count("\n1.") + plan_content.count("\n- "),
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e), "goal": goal},
                error=e
            )]]
    
    def _extract_file_targets(self, plan: str) -> List[str]:
        """Extract mentioned file paths from the plan."""
        import re
        
        # Match common file patterns
        patterns = [
            r'`([a-zA-Z0-9_/\-\.]+\.(py|js|ts|tsx|jsx|json|md|yaml|yml))`',
            r'([a-zA-Z0-9_/\-]+\.(py|js|ts|tsx|jsx|json|md|yaml|yml))',
        ]
        
        files = set()
        for pattern in patterns:
            matches = re.findall(pattern, plan)
            for match in matches:
                if isinstance(match, tuple):
                    files.add(match[0])
                else:
                    files.add(match)
        
        return list(files)[:20]  # Limit to 20 files


__all__ = ["PlanArchitectNode"]
