"""
Standalone Council Spawner — On-demand deliberation for external agents.

Allows Praxis (GravityClaw) or other agents to spin up an ad-hoc
Council of 4 on any topic. Unlike the orchestrator's council (which
reviews MarkdownPlans), this council performs open-ended analysis.

Architecture:
  1. Creates a Blackboard session for the topic
  2. Runs 4 domain analysts in parallel (all Gemini Flash)
  3. Each analyst writes structured findings to the Blackboard
  4. A synthesis step compiles all perspectives into a final report
  5. Returns session ID + synthesis for immediate consumption

Members:
  1. Strategic Analyst   — Big-picture implications, opportunity mapping
  2. Technical Analyst   — Architecture, feasibility, implementation paths
  3. Risk Analyst        — Risks, failure modes, mitigations
  4. Devil's Advocate    — Contrarian view, hidden assumptions, blind spots
"""

import asyncio
import logging
import uuid
from typing import List, Optional

from langchain_core.messages import HumanMessage, SystemMessage

from cortex.llm_factory import LLMFactory, ModelRole
from cortex.llm_utils import extract_text
from cortex.blackboard import Blackboard

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# Analyst Definitions
# ═══════════════════════════════════════════════════════════════════════════

COUNCIL_ANALYSTS = {
    "strategic_analyst": {
        "name": "Strategic Analyst",
        "system_prompt": (
            "You are a Strategic Analyst on a Council of 4 deliberation panel.\n\n"
            "Your role is to analyze the topic from a HIGH-LEVEL STRATEGIC perspective:\n"
            "- What are the big-picture implications?\n"
            "- What opportunities does this create or close off?\n"
            "- How does this fit into the broader landscape?\n"
            "- What are the long-term consequences?\n"
            "- What adjacent areas should be considered?\n\n"
            "Be concise but thorough. Structure your analysis with clear headers.\n"
            "Focus on strategic insights that the other analysts might miss."
        ),
    },
    "technical_analyst": {
        "name": "Technical Analyst",
        "system_prompt": (
            "You are a Technical Analyst on a Council of 4 deliberation panel.\n\n"
            "Your role is to analyze the topic from a TECHNICAL perspective:\n"
            "- What are the concrete implementation paths?\n"
            "- What technologies, tools, or approaches are relevant?\n"
            "- What are the architectural considerations?\n"
            "- What are the technical trade-offs?\n"
            "- What technical debt or complexity might arise?\n\n"
            "Be specific and actionable. Provide concrete recommendations.\n"
            "If code or architecture is relevant, sketch it out."
        ),
    },
    "risk_analyst": {
        "name": "Risk Analyst",
        "system_prompt": (
            "You are a Risk Analyst on a Council of 4 deliberation panel.\n\n"
            "Your role is to analyze the topic from a RISK perspective:\n"
            "- What could go wrong?\n"
            "- What are the failure modes and their severity?\n"
            "- What dependencies could break?\n"
            "- What are the security, privacy, or compliance implications?\n"
            "- What mitigations should be in place?\n\n"
            "Be direct about risks without being alarmist.\n"
            "Rate each risk as LOW / MEDIUM / HIGH / CRITICAL.\n"
            "Always provide a mitigation strategy for each risk."
        ),
    },
    "devils_advocate": {
        "name": "Devil's Advocate",
        "system_prompt": (
            "You are the Devil's Advocate on a Council of 4 deliberation panel.\n\n"
            "Your role is to CHALLENGE assumptions and find blind spots:\n"
            "- What assumptions are being made that might be wrong?\n"
            "- What's the strongest argument AGAINST this approach?\n"
            "- What are we not seeing or not considering?\n"
            "- Is there a simpler/better alternative everyone is overlooking?\n"
            "- What would a skeptic say about this?\n\n"
            "Be constructively contrarian. Don't just criticize — offer\n"
            "alternative perspectives and reframes.\n"
            "Your job is to make the final decision BETTER by stress-testing it."
        ),
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# Standalone Council Runner
# ═══════════════════════════════════════════════════════════════════════════

async def _run_analyst(
    analyst_id: str,
    topic: str,
    context: str,
    model,
) -> dict:
    """Run a single analyst's deliberation on the topic."""
    analyst = COUNCIL_ANALYSTS[analyst_id]

    prompt = f"## Topic for Deliberation\n\n{topic}"
    if context:
        prompt += f"\n\n## Additional Context\n\n{context}"

    messages = [
        SystemMessage(content=analyst["system_prompt"]),
        HumanMessage(content=prompt),
    ]

    try:
        response = await model.ainvoke(messages)
        analysis = extract_text(response)

        logger.info(f"[Council] {analyst['name']} completed analysis ({len(analysis)} chars)")
        return {
            "analyst_id": analyst_id,
            "name": analyst["name"],
            "analysis": analysis,
            "status": "complete",
        }

    except Exception as e:
        logger.error(f"[Council] {analyst['name']} failed: {e}")
        return {
            "analyst_id": analyst_id,
            "name": analyst["name"],
            "analysis": f"Analysis failed: {str(e)}",
            "status": "error",
        }


async def _synthesize(
    topic: str,
    analyses: List[dict],
    model,
) -> str:
    """Synthesize all 4 analyses into a unified council report."""

    analyses_text = "\n\n---\n\n".join(
        f"## {a['name']}\n\n{a['analysis']}" for a in analyses if a["status"] == "complete"
    )

    prompt = (
        f"You are the Council Synthesizer. Four analysts have independently "
        f"deliberated on a topic. Your job is to:\n\n"
        f"1. **Identify consensus** — Where do the analysts agree?\n"
        f"2. **Surface key tensions** — Where do they disagree, and why?\n"
        f"3. **Extract actionable insights** — What are the top 3-5 recommendations?\n"
        f"4. **Final verdict** — Given all perspectives, what is the council's recommendation?\n\n"
        f"Be concise but comprehensive. Use clear structure.\n\n"
        f"## Original Topic\n\n{topic}\n\n"
        f"## Analyst Reports\n\n{analyses_text}"
    )

    messages = [
        SystemMessage(content="You are a synthesis expert that combines multiple analytical perspectives into a unified, actionable report."),
        HumanMessage(content=prompt),
    ]

    try:
        response = await model.ainvoke(messages)
        return extract_text(response)
    except Exception as e:
        logger.error(f"[Council] Synthesis failed: {e}")
        return f"Synthesis failed: {str(e)}"


async def spawn_council(
    topic: str,
    context: str = "",
    session_id: Optional[str] = None,
) -> dict:
    """
    Spawn a Council of 4 deliberation on any topic.

    Args:
        topic: The topic/question for the council to deliberate on
        context: Optional additional context to inform the deliberation
        session_id: Optional session ID (auto-generated if not provided)

    Returns:
        dict with session_id, individual analyses, and synthesized report
    """
    # Create session
    if not session_id:
        session_id = f"council-{uuid.uuid4().hex[:8]}"

    logger.info(f"🏛️ [Council] Spawning deliberation: '{topic[:80]}...' (session: {session_id})")

    # Initialize Blackboard
    bb = Blackboard.get_or_create(session_id, topic=topic[:200])
    bb.write_plan(f"# Council Deliberation\n\n**Topic:** {topic}\n\n**Context:** {context or 'None provided'}")

    # Get Gemini Flash model (all 4 analysts + synthesizer use the same model)
    factory = LLMFactory.get_instance()
    model = factory.get_model(ModelRole.ROUTER)  # Fixed to Gemini Flash

    # Run all 4 analysts in parallel
    analyst_ids = list(COUNCIL_ANALYSTS.keys())
    tasks = [
        _run_analyst(analyst_id, topic, context, model)
        for analyst_id in analyst_ids
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Process results and write to Blackboard
    analyses = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            analyst = COUNCIL_ANALYSTS[analyst_ids[i]]
            entry = {
                "analyst_id": analyst_ids[i],
                "name": analyst["name"],
                "analysis": f"Exception: {str(result)}",
                "status": "error",
            }
        else:
            entry = result

        analyses.append(entry)

        # Write each analysis to the Blackboard
        bb.append_step(
            agent_id=entry["analyst_id"],
            content=f"## {entry['name']} Analysis\n\n{entry['analysis']}",
        )

    # Synthesize all perspectives
    synthesis = await _synthesize(topic, analyses, model)

    # Write synthesis to Blackboard
    bb.write_synthesis(synthesis)
    bb.append_step(agent_id="synthesizer", content=f"## Council Synthesis\n\n{synthesis}")

    success_count = sum(1 for a in analyses if a["status"] == "complete")
    logger.info(f"🏛️ [Council] Deliberation complete: {success_count}/4 analysts succeeded")

    return {
        "session_id": session_id,
        "topic": topic,
        "analyses": analyses,
        "synthesis": synthesis,
        "stats": {
            "analysts_succeeded": success_count,
            "analysts_failed": 4 - success_count,
        },
    }
