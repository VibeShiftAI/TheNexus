"""
System 2 Orchestrator — Vibe Coding OS.

Simplified from the original 23-node Praxis DAG to a clean 8-node cyclical graph:

  Chat Router -> Architect -> Council Review -> Plan Revision -> Human Review -> Compiler -> Executor

The graph uses LangGraph's interrupt_before for human-in-the-loop approval.
"""

import logging
from typing import Literal

from langgraph.graph import StateGraph, END

# Core schemas
from cortex.schemas.state import (
    System2State,
    MarkdownPlan,
    VoteReceipt,
    LineComment,
    ProjectPlan,
)

# Agent logic
from cortex.agents.planner import draft_plan
from cortex.agents.council import run_council_review, summarize_council_feedback
from cortex.agents.compiler import compiler_node as run_compiler
from cortex.interface.nexus_client import nexus
from cortex.llm_factory import LLMFactory, ModelRole
from cortex.llm_utils import extract_text

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# Blackboard Helper
# ═══════════════════════════════════════════════════════════════════════════

def _get_blackboard(session_id: str):
    """Lazy-import and return a Blackboard instance for the given session."""
    if not session_id:
        raise ValueError("session_id is required for Blackboard")
    from cortex.blackboard import Blackboard
    return Blackboard.get_or_create(session_id)


# ═══════════════════════════════════════════════════════════════════════════
# Node 1: Chat Router
# ═══════════════════════════════════════════════════════════════════════════

async def chat_router_node(state: System2State) -> dict:
    """
    Semantic intent detection: is this a 'chat' or 'build' request?
    
    - 'chat': General questions, greetings, clarifications → direct LLM response
    - 'build': Project planning requests → trigger Architect workflow
    """
    messages = state.get("messages", [])
    if not messages:
        return {"route": "chat"}

    user_msg = messages[-1].get("content", "") if isinstance(messages[-1], dict) else str(messages[-1])

    factory = LLMFactory.get_instance()
    model = factory.get_model(ModelRole.ROUTER)

    from langchain_core.messages import SystemMessage, HumanMessage

    router_prompt = (
        "You are a router for a web development AI assistant. "
        "Classify the user's message as either 'chat' or 'build'.\n\n"
        "- 'build': The user wants to create, plan, or build something "
        "(a website, app, feature, component, API, database, etc.)\n"
        "- 'chat': Everything else (questions, greetings, clarifications, off-topic)\n\n"
        "Respond with ONLY the word 'chat' or 'build'."
    )

    try:
        response = await model.ainvoke([
            SystemMessage(content=router_prompt),
            HumanMessage(content=user_msg),
        ])
        route = extract_text(response).strip().lower()
        if route not in ("chat", "build"):
            route = "chat"  # Default to chat if unclear
    except Exception as e:
        logger.warning(f"Router failed, defaulting to chat: {e}")
        route = "chat"

    logger.info(f"🔀 [Router] Classified as: {route}")
    return {"route": route}


# ═══════════════════════════════════════════════════════════════════════════
# Node 2: Chat Response
# ═══════════════════════════════════════════════════════════════════════════

async def chat_response_node(state: System2State) -> dict:
    """
    Standard LLM chat response for non-build requests.
    Bypasses the entire Architect → Council → Compiler pipeline.
    """
    messages = state.get("messages", [])
    factory = LLMFactory.get_instance()
    model = factory.get_model(ModelRole.PROPOSER)

    from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

    system = (
        "You are the Nexus AI assistant, a friendly and knowledgeable web development expert. "
        "Answer questions helpfully and concisely. If the user seems to want to build something, "
        "suggest they describe their project so you can create a plan."
    )

    try:
        response = await model.ainvoke([
            SystemMessage(content=system),
            *messages
        ])
        return {"messages": [AIMessage(content=extract_text(response))]}
    except Exception as e:
        logger.error(f"Chat response failed: {e}")
        return {"messages": [AIMessage(content=f"I encountered an error: {str(e)}")]}


# ═══════════════════════════════════════════════════════════════════════════
# Node 3: Architect (Lead Planner)
# ═══════════════════════════════════════════════════════════════════════════

async def architect_node(state: System2State) -> dict:
    """
    The Lead Architect drafts or revises a project plan.
    Writes plan to Blackboard for persistent versioning.
    """
    logger.info("🧠 [Architect] Drafting plan...")
    result = await draft_plan(state)

    # Persist plan to Blackboard
    bb = _get_blackboard(state["session_id"])
    if result.get("markdown_plan"):
        plan = result["markdown_plan"]
        bb.append_step(
            agent_id="architect",
            content=f"# Plan: {plan.title} (v{plan.version})\n\n{plan.content}",
        )
        logger.info(f"💾 [Blackboard] Plan v{plan.version} written")

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Node 4: Council Review (4 reviewers in parallel)
# ═══════════════════════════════════════════════════════════════════════════

async def council_review_node(state: System2State) -> dict:
    """
    Run all 4 council reviewers in parallel on the Architect's plan.
    Returns votes and aggregated line comments.
    """
    plan = state.get("markdown_plan")
    if not plan:
        logger.warning("No plan to review!")
        return {}

    # Skip council review for error/fallback plans — don't waste API calls
    if plan.title.startswith("Error:"):
        logger.warning(f"⚠️ [Council] Skipping review of error plan: {plan.title}")
        # Return a unanimous "reject" so the routing sends it back to architect
        from cortex.schemas.state import VoteReceipt
        error_vote = VoteReceipt(
            voter="System",
            decision="reject",
            reasoning=f"Automatic rejection: {plan.title}. The architect encountered an error and needs to retry.",
            line_comments=[]
        )
        return {
            "votes": [error_vote],
            "council_feedback": [error_vote],
            "prior_comments": [],
        }

    prior_comments = state.get("prior_comments", [])
    logger.info(f"🗳️ [Council] Reviewing plan v{plan.version}...")

    votes = await run_council_review(plan, prior_comments)

    # Aggregate all line comments for the next revision cycle
    all_comments = []
    for vote in votes:
        if vote.line_comments:
            all_comments.extend(vote.line_comments)

    # Persist council feedback to Blackboard
    bb = _get_blackboard(state["session_id"])
    feedback_summary = summarize_council_feedback(votes)
    bb.append_step(agent_id="council", content=f"## Council Review\n\n{feedback_summary}")

    return {
        "votes": votes,
        "council_feedback": votes,
        "prior_comments": all_comments,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Node 4b: Plan Revision (post-council polish)
# ═══════════════════════════════════════════════════════════════════════════

async def plan_revision_node(state: System2State) -> dict:
    """
    Post-council revision: Architect applies worthy line comments.
    Runs even when council approves -- quality polish before human sees it.
    Skips (pass-through) if there are zero line comments to apply.
    """
    prior_comments = state.get("prior_comments", [])
    if not prior_comments:
        logger.info("[PlanRevision] No line comments to apply, passing through")
        return {}

    logger.info(f"[PlanRevision] Applying {len(prior_comments)} line comments...")
    result = await draft_plan(state)  # Reuses existing revision mechanism

    # Persist revised plan to Blackboard
    bb = _get_blackboard(state["session_id"])
    if result.get("markdown_plan"):
        plan = result["markdown_plan"]
        bb.append_step(
            agent_id="plan_revision",
            content=f"# Revised Plan: {plan.title} (v{plan.version})\n\nApplied council line comments.",
        )
        logger.info(f"[PlanRevision] Revised plan: {plan.title} (v{plan.version})")

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Node 5: Human Review
# ═══════════════════════════════════════════════════════════════════════════

async def human_review_node(state: System2State) -> dict:
    """
    Human Review Checkpoint.
    
    Pass-through node — the graph interrupts BEFORE entering this node.
    When the human resumes, they provide 'approve' or 'reject' + feedback.
    """
    logger.info("🚦 [Human Review] Checkpoint reached — awaiting human decision")

    bb = _get_blackboard(state["session_id"])
    plan = state.get("markdown_plan")
    revision = state.get("revision_count", 0)
    plan_label = f"**{plan.title}** (v{plan.version})" if plan else "Unknown plan"

    halt_note = (
        f"## ⏸️ Awaiting Human Approval\n\n"
        f"- **Plan**: {plan_label}\n"
        f"- **Revision cycle**: {revision}\n"
        f"- **Status**: Council review complete. Awaiting human approval.\n"
    )
    bb.append_step(agent_id="human_review", content=halt_note)

    return {}


# ═══════════════════════════════════════════════════════════════════════════
# Node 6: Compiler
# ═══════════════════════════════════════════════════════════════════════════

async def compiler_wrapper_node(state: System2State) -> dict:
    """
    Converts approved MarkdownPlan to executable ProjectPlan (JSON).
    """
    logger.info("🔧 [Compiler] Converting Markdown → executable JSON...")
    return await run_compiler(state)


# ═══════════════════════════════════════════════════════════════════════════
# Node 7: Executor
# ═══════════════════════════════════════════════════════════════════════════

async def execution_node(state: System2State) -> dict:
    """
    Execute the approved plan by creating projects/tasks in Nexus.
    Writes execution results to Blackboard for audit trail.
    """
    plan = state.get("compiled_plan") or state.get("final_plan")
    if not plan:
        logger.warning("⚠️ No compiled plan to execute!")
        return {"compiled_plan": plan}

    logger.info(f"🚀 [Executor] Executing Plan: {plan.title}")
    bb = _get_blackboard(state["session_id"])

    try:
        import re
        safe_name = re.sub(r'[^a-zA-Z0-9-_\s]', '', plan.title).strip()[:80]

        project_id = await nexus.create_project(
            name=safe_name,
            goal=plan.goal,
            type="tool"
        )

        if project_id:
            # Create tasks in reverse order so the first plan item ends up
            # at the top of the UI (which sorts newest-first by created_at)
            for node in reversed(plan.nodes):
                # Build a rich description from the compiled plan's fields
                desc_parts = []
                if hasattr(node, 'workflow') and node.workflow:
                    desc_parts.append(f"**Workflow:** {node.workflow}")
                if node.goal:
                    desc_parts.append(f"**Goal:** {node.goal}")
                if node.context:
                    desc_parts.append(f"\n**Context & Execution:**\n{node.context}")
                if node.acceptance_criteria:
                    criteria = "\n".join(f"- {c}" for c in node.acceptance_criteria)
                    desc_parts.append(f"\n**Acceptance Criteria:**\n{criteria}")

                task_description = "\n".join(desc_parts) if desc_parts else ""
                template_id = getattr(node, 'template_id', None)
                await nexus.add_task(project_id, node.description, task_description, template_id=template_id)

            logger.info(f"✅ Project {project_id} created with {len(plan.nodes)} tasks")

            exec_summary = (
                f"## Execution Result\n\n"
                f"- **Project ID**: {project_id}\n"
                f"- **Tasks Created**: {len(plan.nodes)}\n"
                f"- **Status**: ✅ Success\n"
            )
            bb.append_step(agent_id="executor", content=exec_summary)
        else:
            logger.error("Project creation returned no ID")
            bb.append_step(
                agent_id="executor",
                content="## Execution Result\n\n- **Status**: ❌ Failed — no project ID returned",
            )

    except Exception as e:
        logger.error(f"❌ Execution failed: {e}")
        import traceback
        traceback.print_exc()
        bb.append_step(
            agent_id="executor",
            content=f"## Execution Result\n\n- **Status**: ❌ Failed\n- **Error**: {str(e)[:200]}",
        )

    return {"compiled_plan": plan}


# ═══════════════════════════════════════════════════════════════════════════
# Routing Functions
# ═══════════════════════════════════════════════════════════════════════════

def route_after_chat_router(state: System2State) -> str:
    """Route based on chat/build classification."""
    route = state.get("route", "chat")
    if route == "build":
        return "architect"
    return "chat_response"


def route_after_council(state: System2State) -> str:
    """
    After council review: if strong majority approves → human review; else → architect revision.
    
    Threshold: >75% must approve (e.g., 3/4 or 4/4).
    If 2/4 approve with 2 request_info, the plan gets revised and re-reviewed.
    Max 5 revisions safety valve → send to human review anyway.
    """
    votes = state.get("votes", [])
    revision_count = state.get("revision_count", 0)

    # Safety: Max 5 revisions
    if revision_count >= 5:
        logger.warning("⚠️ Max revisions (5) reached. Sending to human review.")
        return "human_review"

    if votes:
        approvals = sum(1 for v in votes if v.decision == "approve")
        rejections = sum(1 for v in votes if v.decision == "reject")
        concerns = sum(1 for v in votes if v.decision == "request_info")
        total = len(votes)

        # Supermajority required: >=75% must approve (3/4 passes)
        if approvals >= (total * 0.75):
            logger.info(f"✅ [Council] Strong majority ({approvals}/{total}) — proceeding to plan revision & human review")
            return "plan_revision"
        
        # Any rejections or too many concerns → revise
        logger.info(f"🔄 [Council] Insufficient approval ({approvals}/{total}, {concerns} concerns) — sending back to architect for revision (round {revision_count + 1})")
        return "architect"

    # Default: send back for revision
    return "architect"


def route_after_human(state: System2State) -> str:
    """Route based on human decision: approve → compiler; reject → architect."""
    decision = state.get("human_decision", "")

    if decision == "approve":
        return "compiler"
    elif decision == "reject":
        return "architect"
    else:
        # Default to compiler if no explicit decision (legacy compat)
        return "compiler"


# ═══════════════════════════════════════════════════════════════════════════
# Graph Builder
# ═══════════════════════════════════════════════════════════════════════════

def build_system2_graph(checkpointer=None):
    """
    Build the Vibe Coding OS LangGraph.

    8-node cyclical graph:
      1. chat_router      -- Semantic intent detection
      2. chat_response    -- Standard LLM response (bypass)
      3. architect        -- Lead Architect drafts/revises plan
      4. council_review   -- 4 reviewers critique in parallel
      4b. plan_revision   -- Architect applies council line comments
      5. human_review     -- LangGraph interrupt for human approval
      6. compiler         -- Markdown -> JSON conversion
      7. executor         -- Creates project + tasks in Nexus
    """
    workflow = StateGraph(System2State)

    # Add nodes
    workflow.add_node("chat_router", chat_router_node)
    workflow.add_node("chat_response", chat_response_node)
    workflow.add_node("architect", architect_node)
    workflow.add_node("council_review", council_review_node)
    workflow.add_node("plan_revision", plan_revision_node)
    workflow.add_node("human_review", human_review_node)
    workflow.add_node("compiler", compiler_wrapper_node)
    workflow.add_node("executor", execution_node)

    # Define edges
    workflow.set_entry_point("chat_router")
    workflow.add_conditional_edges("chat_router", route_after_chat_router)

    # Chat path → END
    workflow.add_edge("chat_response", END)

    # Build path: Architect -> Council -> (approve? Plan Revision : Architect loop)
    workflow.add_edge("architect", "council_review")
    workflow.add_conditional_edges("council_review", route_after_council)

    # Plan Revision -> Human Review (revised plan presented for approval)
    workflow.add_edge("plan_revision", "human_review")

    # Human Review -> (approve? Compiler : Architect loop)
    workflow.add_conditional_edges("human_review", route_after_human)

    # Compile → Execute → END
    workflow.add_edge("compiler", "executor")
    workflow.add_edge("executor", END)

    # Compile with interrupt for Human-in-the-Loop
    return workflow.compile(
        checkpointer=checkpointer,
        interrupt_before=["human_review"]
    )
