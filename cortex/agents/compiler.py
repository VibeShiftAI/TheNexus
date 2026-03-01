"""
Compiler Node — Converts approved Markdown plans to executable JSON.

Vibe Coding OS version:
- Parses flexible Markdown plan format from the Lead Architect
- Detects workflow type per task (Nexus Prime or "For Human Action")
- Outputs ProjectPlan JSON for Nexus API task creation
"""

import logging
from typing import Optional
from langchain_core.messages import SystemMessage, HumanMessage

from cortex.llm_factory import LLMFactory, ModelRole
from cortex.schemas.state import (
    System2State,
    ProjectPlan,
    WorkflowNode,
    MarkdownPlan,
)

logger = logging.getLogger(__name__)


COMPILER_SYSTEM_PROMPT = """You are the Plan Compiler for a web development AI assistant.

Your job: convert a Markdown project plan into a structured, executable format.

## Input
You will receive a Markdown plan using the Ticket Generation format. Each task follows this structure:
- `### Task [Number]: [Task Name]` — The task header
- `**Workflow:**` — One of: Nexus Prime, Human Action, Custom
- `**Goal:**` — 1-2 sentence goal
- `#### Context & Execution` — Architecture details, file paths, or step-by-step instructions (may also appear as `**Context & Execution**:`)
- `#### Acceptance Criteria` — Bullet list of success conditions (may also appear as `**Acceptance Criteria**:`)

## Output Rules
Convert to a ProjectPlan with:
- **title**: The project/plan title
- **goal**: The overall project goal
- **nodes**: A list of WorkflowNode objects, one per task:
  - **id**: A unique slug identifier (e.g., "auth_system", "api_routes", "setup_env")
  - **type**: One of:
    - "tool" = automatable tasks (Nexus Prime workflow)
    - "reasoning" = research/analysis tasks (Custom workflow)
    - "human" = tasks requiring manual steps (Human Action workflow)
  - **description**: Clear, actionable task description (from the task name)
  - **workflow**: Map from the Markdown:
    - "Nexus Prime" → "nexus_prime"
    - "Human Action" → "human_action"
    - "Custom" or "Custom / Direct" → "custom"
  - **goal**: The task's goal (from **Goal** field)
  - **context**: The task's context (from **Context & Execution** field)
  - **acceptance_criteria**: List of strings (from **Acceptance Criteria** bullets)
- **status**: Always "approved" (compiling after council approval)

## Rules
1. Extract EVERY distinct task from the Markdown — don't skip any
2. Preserve task ordering and dependencies
3. Map workflow types correctly (Nexus Prime → tool, Human Action → human, Custom → reasoning)
4. Keep goal, context, and acceptance_criteria faithful to the original plan
5. If a task lacks explicit workflow type, default to "nexus_prime" / "tool" """


async def compile_plan(state: System2State) -> dict:
    """
    Compiler Node: Converts approved MarkdownPlan to executable ProjectPlan.
    
    Uses LLM for flexible parsing (handles varied Markdown structures).
    Writes compiled summary to Blackboard for audit trail.
    """
    md_plan = state.get("markdown_plan")

    if not md_plan:
        logger.warning("No markdown plan to compile")
        return {"compiled_plan": None}

    logger.info(f"🔧 Compiling plan: {md_plan.title} (v{md_plan.version})")

    # Use the plan content directly (no Blackboard read dependency)
    plan_content = md_plan.content

    try:
        factory = LLMFactory.get_instance()
        base_model = factory.get_model(ModelRole.PROPOSER)
        model = base_model.with_structured_output(ProjectPlan)

        response = await model.ainvoke([
            SystemMessage(content=COMPILER_SYSTEM_PROMPT),
            HumanMessage(content=f"Convert this Markdown plan to executable JSON:\n\n{plan_content}")
        ])

        # Override status to approved
        compiled = ProjectPlan(
            title=response.title,
            goal=response.goal,
            nodes=response.nodes,
            status="approved"
        )

        logger.info(f"✅ Plan compiled: {compiled.title} ({len(compiled.nodes)} nodes)")

        # Write compiled summary to Blackboard
        session_id = state.get("session_id", "")
        if session_id:
            try:
                from cortex.blackboard import Blackboard

                bb = Blackboard.get_or_create(session_id)
                compile_summary = f"## Compiled Plan\n\n"
                compile_summary += f"- **Title**: {compiled.title}\n"
                compile_summary += f"- **Goal**: {compiled.goal}\n"
                compile_summary += f"- **Nodes**: {len(compiled.nodes)}\n"
                for i, node in enumerate(compiled.nodes, 1):
                    workflow_tag = f"[{node.workflow}]" if hasattr(node, 'workflow') else ""
                    compile_summary += f"  {i}. [{node.type}] {workflow_tag} {node.description[:80]}\n"
                compile_summary += f"- **Status**: {compiled.status}\n"
                bb.append_step(agent_id="compiler", content=compile_summary)
                logger.info(f"💾 [Blackboard] Compiled plan written")
            except Exception as bb_err:
                logger.warning(f"Blackboard write failed (non-blocking): {bb_err}")

        return {"compiled_plan": compiled, "final_plan": compiled}

    except Exception as e:
        logger.error(f"❌ Compiler error: {e}")
        import traceback
        traceback.print_exc()

        # Return a fallback requiring human intervention
        fallback = ProjectPlan(
            title=md_plan.title,
            goal="Compilation failed - manual intervention required",
            nodes=[WorkflowNode(
                id="error",
                type="human",
                description=f"Manual compilation required: {str(e)}",
                workflow="human_action",
            )],
            status="draft"
        )
        return {"compiled_plan": fallback}


async def compiler_node(state: System2State) -> dict:
    """LangGraph node wrapper for the Compiler."""
    return await compile_plan(state)
