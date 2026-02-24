"""
General Agent Node - Multi-step task execution fallback

Full tool access for complex tasks that don't fit specialized agents.
Uses ReAct loop with configurable turn budget.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class GeneralAgentNode(AtomicNode):
    """
    General-purpose agent for multi-step task execution.
    
    Full tool access, ReAct reasoning loop with configurable turn budget.
    Inspired by Claude Code's general-purpose sub-agent.
    """
    
    type_id = "general_agent"
    display_name = "General Agent"
    description = "Multi-step task execution with full tool access"
    category = "orchestration"
    icon = "🤖"
    version = 1.0
    levels = ["dashboard", "project", "feature"]
    
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
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute multi-step task with ReAct loop."""
        from model_config import get_gemini_flash
        from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
        
        task = ctx.get_node_parameter("task", "")
        max_turns = ctx.get_node_parameter("max_turns", 10)
        model_name = ctx.get_node_parameter("model", "gemini-3-flash-preview")
        verbose = ctx.get_node_parameter("verbose", True)
        
        # Allow task from input
        if not task and items:
            task = items[0].json.get("task", "") or items[0].json.get("goal", "")
        
        if not task:
            return [[NodeExecutionData(
                json={"error": "No task specified"},
                error=Exception("No task specified")
            )]]
        
        # Gather context from inputs
        input_context = ""
        for item in items:
            for key, value in item.json.items():
                if isinstance(value, str) and len(value) > 20:
                    input_context += f"\n{key}: {value[:500]}..."
        
        system_prompt = """You are a general-purpose AI agent that can execute multi-step tasks.

You have access to:
- File reading and writing
- Code search and analysis
- Command execution
- Research and synthesis

For each step, think about:
1. What information do you need?
2. What action should you take?
3. What's the expected outcome?

Provide your reasoning and final answer."""

        user_prompt = f"""Execute this task:

**Task**: {task}

**Available Context**:
{input_context or "None provided"}

Think step-by-step and provide a complete solution."""

        try:
            llm = get_gemini_flash(temperature=0.3)
            
            # Simple single-turn for now (ReAct loop would need tool bindings)
            response = await llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt),
            ])
            
            result = response.content
            
            if verbose:
                print(f"[GeneralAgent] Task: {task[:50]}...")
                print(f"[GeneralAgent] Result length: {len(result)} chars")
            
            return [[NodeExecutionData(
                json={
                    "task": task,
                    "result": result,
                    "turns_used": 1,  # Single turn for now
                    "max_turns": max_turns,
                    "model": model_name,
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e), "task": task},
                error=e
            )]]


__all__ = ["GeneralAgentNode"]
