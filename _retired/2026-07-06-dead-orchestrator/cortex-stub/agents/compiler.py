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


def _load_task_template_catalog() -> str:
    """
    Dynamically build the template catalog from config/templates/workflows/*.json.
    Only includes task-level templates. Falls back to a static catalog on error.
    """
    import json
    from pathlib import Path

    templates_dir = Path(__file__).resolve().parents[2] / "config" / "templates" / "workflows"
    
    try:
        rows = []
        for f in sorted(templates_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if data.get("level") == "task":
                    desc = data.get("description", data.get("name", f.stem))
                    rows.append(f"| {data['id']:<20} | {desc[:55]:<55} |")
            except Exception:
                continue

        if rows:
            header = (
                "| template_id          | Best for                                                  |\n"
                "|----------------------|-----------------------------------------------------------|"
            )
            return header + "\n" + "\n".join(rows)
    except Exception as e:
        logger.warning(f"Could not load dynamic template catalog: {e}")

    # Static fallback
    return (
        "| template_id          | Best for                                           |\n"
        "|----------------------|----------------------------------------------------|\n"
        "| nexus-prime          | General AI-driven implementation (code changes)     |\n"
        "| refactor             | Code refactoring and cleanup tasks                  |\n"
        "| code-review-loop     | Code review tasks                                   |\n"
        "| research-report      | Pure research and analysis (no code output)         |\n"
        "| supervised-pipeline  | Complex multi-stage tasks needing supervision       |\n"
        "| doc-writer           | Documentation writing (.context/, README, .md)      |"
    )


COMPILER_SYSTEM_PROMPT_TEMPLATE = """You are the Plan Compiler for a web development AI assistant.

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
  - **template_id**: (Optional) A LangGraph workflow template ID from the catalog below.
    ONLY set this when you can UNAMBIGUOUSLY identify the correct template.
    If unsure, leave it as null — the user will assign one manually later.
  - **goal**: The task's goal (from **Goal** field)
  - **context**: The task's context (from **Context & Execution** field)
  - **acceptance_criteria**: List of strings (from **Acceptance Criteria** bullets)
- **status**: Always "approved" (compiling after council approval)

## Available Workflow Templates (task-level)
Use these IDs for the template_id field when the match is clear:

{TEMPLATE_CATALOG}

## Rules
1. Extract EVERY distinct task from the Markdown — don't skip any
2. Preserve task ordering and dependencies
3. Map workflow types correctly (Nexus Prime → tool, Human Action → human, Custom → reasoning)
4. Keep goal, context, and acceptance_criteria faithful to the original plan
5. If a task lacks explicit workflow type, default to "nexus_prime" / "tool"
6. Only assign template_id when the task CLEARLY matches one template. When in doubt, leave null """


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

    # Build the prompt with a dynamic template catalog
    template_catalog = _load_task_template_catalog()
    system_prompt = COMPILER_SYSTEM_PROMPT_TEMPLATE.replace("{TEMPLATE_CATALOG}", template_catalog)

    try:
        factory = LLMFactory.get_instance()
        base_model = factory.get_model(ModelRole.PROPOSER)
        model = base_model.with_structured_output(ProjectPlan)

        response = await model.ainvoke([
            SystemMessage(content=system_prompt),
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
