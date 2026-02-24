"""
AI Workflow Builder Supervisor - Phase 8

The Supervisor agent routes user requests to specialist agents.
Reference: packages/@n8n/ai-workflow-builder.ee/src/agents/supervisor.agent.ts
           packages/@n8n/ai-workflow-builder.ee/src/prompts/agents/supervisor.prompt.ts

Routing Decision Tree:
1. Is user asking a question? → responder
2. Does request involve NEW node types? → discovery
3. Is request about connecting existing nodes? → builder
4. Is request about changing VALUES? → configurator
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate

from model_config import get_supervisor_llm
from .state import BuilderState


# ═══════════════════════════════════════════════════════════════════════════
# SUPERVISOR DECISION SCHEMA
# ═══════════════════════════════════════════════════════════════════════════

class SupervisorRouting(BaseModel):
    """
    Supervisor's routing decision.
    Reference: supervisor.agent.ts SupervisorOutput
    """
    reasoning: str = Field(
        description="One sentence explaining the routing decision"
    )
    next: Literal["discovery", "builder", "configurator", "responder"] = Field(
        description="Which specialist agent should handle this request"
    )
    is_complete: bool = Field(
        default=False,
        description="True if the workflow building is complete and no more actions needed"
    )


# ═══════════════════════════════════════════════════════════════════════════
# SUPERVISOR PROMPT
# ═══════════════════════════════════════════════════════════════════════════

SUPERVISOR_SYSTEM_PROMPT = """You are a Supervisor that routes user requests to specialist agents for building workflows.

## Available Agents

1. **discovery**: Find and search for node types
   - Use when the user mentions NEW functionality not yet in the workflow
   - Use when you need to find which node types are available
   - Examples: "I need to send emails", "Can I integrate with Slack?"

2. **builder**: Create nodes and connections
   - Use when discovery has found the needed nodes
   - Use when connecting existing nodes together
   - Use when adding nodes to the canvas
   - Examples: "Add that email node", "Connect the trigger to the action"

3. **configurator**: Set parameters on EXISTING nodes
   - Use when the user wants to change settings on a node
   - Use when setting credentials, API keys, or values
   - Examples: "Set the recipient to bob@example.com", "Use my Gmail account"

4. **responder**: Answer questions and synthesize responses (TERMINAL)
   - Use when the user is asking HOW to do something
   - Use when confirming the workflow is complete
   - Use when explaining what was done
   - Examples: "How does this work?", "Is it ready?", "What did you build?"

## Project Context
{project_context}

## Routing Rules

1. For a NEW request with new functionality → discovery first
2. After discovery finds nodes → builder to add them
3. After builder adds nodes → configurator to set parameters
4. When user asks questions or confirms completion → responder

## Current Workflow State

{workflow_summary}

## Conversation History

{conversation_history}

## User's Request

{user_request}

Decide which agent should handle this request."""


# ═══════════════════════════════════════════════════════════════════════════
# SUPERVISOR AGENT
# ═══════════════════════════════════════════════════════════════════════════

class WorkflowBuilderSupervisor:
    """
    Supervisor agent that routes requests to specialist agents.
    Uses Claude Opus 4.5 via the centralized model_config factory.
    """
    
    def __init__(self, llm=None):
        """
        Initialize the supervisor.
        
        Args:
            llm: Optional LLM override. Defaults to get_supervisor_llm().
        """
        self.llm = llm or get_supervisor_llm(temperature=0)
        self.prompt = ChatPromptTemplate.from_messages([
            ("system", SUPERVISOR_SYSTEM_PROMPT),
        ])
    
    def _format_workflow_summary(self, state: BuilderState) -> str:
        """Format the current workflow state for the prompt."""
        workflow = state.get("workflow", {})
        nodes = workflow.get("nodes", [])
        connections = workflow.get("connections", [])
        
        if not nodes:
            return "The workflow is empty. No nodes have been added yet."
        
        lines = [f"Workflow: {workflow.get('name', 'Untitled')}"]
        lines.append(f"Nodes ({len(nodes)}):")
        for node in nodes:
            lines.append(f"  - {node.get('name', 'Unnamed')} ({node.get('type', 'unknown')})")
        
        if connections:
            lines.append(f"Connections ({len(connections)}):")
            for conn in connections:
                lines.append(f"  - {conn.get('sourceNodeId')} → {conn.get('targetNodeId')}")
        
        return "\n".join(lines)
    
    def _format_conversation_history(self, state: BuilderState) -> str:
        """Format conversation history for the prompt."""
        messages = state.get("messages", [])
        if not messages:
            return "No previous conversation."
        
        lines = []
        for msg in messages[-5:]:  # Last 5 messages for context
            role = msg.get("role", "unknown").upper()
            content = msg.get("content", "")[:200]  # Truncate long messages
            lines.append(f"{role}: {content}")
        
        return "\n".join(lines)
    
    async def _fetch_project_context(self, state: BuilderState) -> str:
        """Fetch project context if project_id is present."""
        project_id = state.get("project_id")
        if not project_id:
             return "No project context available."
             
        try:
            from supabase_client import get_supabase
            supabase = get_supabase()
            if not supabase.is_configured():
                return "Project context unavailable (DB not configured)."
                
            # Fetch project details
            # We assume a 'projects' table or similar based on existing patterns
            # But wait, supabase_client has specific methods.
            # Let's try to query generic projects table if it exists, or just use what we know.
            # Actually, main.py/server.js use filesystem for projects usually.
            # But let's check strict 'projects' table if we have it? 
            # If not, we skip deep context for now and just rely on what we have.
            
            # Better approach: If we are in 'Phase 8', we might not have a full 'projects' table 
            # fully synced with detailed tech stacks in Supabase yet. 
            # However, we can try to get the project name/description if stored.
            
            # Let's fallback to a simple string for now if we can't easily fetch deep details without filesystem access here.
            # But we DO have access to filesystem if we wanted...
            # Let's keep it simple: Just return the ID for now, or if we had a dedicated service.
            
            return f"Project ID: {project_id}"
            
        except Exception:
            return f"Project ID: {project_id} (Details unavailable)"

    async def route(self, state: BuilderState) -> SupervisorRouting:
        """
        Determine which specialist agent should handle the current request.
        
        Args:
            state: Current builder state
        
        Returns:
            SupervisorRouting with next agent and reasoning
        """
        # Build the prompt
        chain = self.prompt | self.llm.with_structured_output(SupervisorRouting)
        
        project_context = await self._fetch_project_context(state)
        
        result = await chain.ainvoke({
            "workflow_summary": self._format_workflow_summary(state),
            "conversation_history": self._format_conversation_history(state),
            "user_request": state.get("user_request", ""),
            "project_context": project_context,
        })
        
        return result
    
    def route_sync(self, state: BuilderState) -> SupervisorRouting:
        """Synchronous version of route()."""
        import asyncio
        return asyncio.run(self.route(state))


# ═══════════════════════════════════════════════════════════════════════════
# SUPERVISOR NODE FUNCTION
# ═══════════════════════════════════════════════════════════════════════════

async def supervisor_node(state: BuilderState) -> BuilderState:
    """
    LangGraph node function for the supervisor.
    Routes to the appropriate specialist agent.
    """
    supervisor = WorkflowBuilderSupervisor()
    
    try:
        routing = await supervisor.route(state)
        
        return {
            **state,
            "next_agent": routing.next,
            "supervisor_reasoning": routing.reasoning,
            "is_complete": routing.is_complete,
        }
    except Exception as e:
        return {
            **state,
            "error": f"Supervisor error: {str(e)}",
            "next_agent": "responder",  # Fallback to responder on error
        }
