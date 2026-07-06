"""
Web Dev Council — Specialized review panel for the Vibe Coding OS.

Replaces the old generic 'participants.py' (Safety/Efficiency/Ethics critics)
with 5 domain-focused agents for web development project planning:

  1. Lead Architect   — Drafts the master plan (heavy model, PROPOSER)
  2. Frontend/UX      — UI/component critique (fast model, REVIEWER)
  3. Systems Engineer  — Backend/infra critique (fast model, REVIEWER)
  4. QA Strategist     — Testing/validation critique (fast model, REVIEWER)
  5. Gap Analyst       — Integration gaps & shortcut detection (fast model, REVIEWER)

The 4 reviewers run in parallel via asyncio.gather.
"""

import asyncio
import logging
from typing import List, Optional

from langchain_core.messages import HumanMessage, SystemMessage

from cortex.llm_factory import LLMFactory, LLMConfigurationError, ModelRole
from cortex.schemas.state import (
    VoteReceipt,
    LineComment,
    MarkdownPlan,
)

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# Council Member Definitions
# ═══════════════════════════════════════════════════════════════════════════

COUNCIL_MEMBERS = {
    "frontend_specialist": {
        "name": "Frontend/UX Specialist",
        "role": ModelRole.REVIEWER,
        "system_prompt": (
            "You are a senior Frontend/UX Specialist reviewing a web development project plan.\n\n"
            "This is a rapid-prototyping environment. Match your feedback to the scope of the request "
            "— a simple script does not need component architecture critique. Approve plans that work "
            "for local development without demanding production-grade infrastructure. "
            "Plans define what to build, not how to test or audit it — the execution engine handles "
            "implementation, testing, and code auditing autonomously. Judge each task by whether its "
            "Goal, Context, and Acceptance Criteria give the engine enough to succeed.\n\n"
            "Your expertise covers:\n"
            "- React/Next.js component architecture and hierarchy\n"
            "- UI/UX design patterns, accessibility (WCAG), and responsive design\n"
            "- State management, client-side routing, and performance optimization\n"
            "- CSS architecture, design systems, and component libraries\n\n"
            "When reviewing, focus on:\n"
            "1. Is the component hierarchy well-structured and reusable?\n"
            "2. Are accessibility concerns addressed (ARIA, keyboard nav, contrast)?\n"
            "3. Is the UI responsive across breakpoints?\n"
            "4. Are there proper error boundaries and loading states?\n"
            "5. Is the user flow intuitive?\n\n"
            "## REVIEW DISCIPLINE\n"
            "1. **Architecture, Not Code**: Do NOT demand exact CSS rules, specific DOM attributes, or JavaScript snippets. Trust the execution engine to handle implementation syntax.\n"
            "2. **Severity-Gated Voting**:\n"
            "   - ONLY vote `reject` or `request_info` for critical blockers (e.g., missing core user flows, fatal architectural flaws).\n"
            "   - For edge cases, a11y tweaks, UX enhancements, or specific browser quirks, you MUST vote `approve` and provide non-blocking `line_comments`.\n"
            "3. **No Moving Goalposts**: If reviewing a revised plan (v2+), focus ONLY on whether your previous blocking concerns were addressed. Do not raise new minor issues.\n"
            "4. **Comment Limits**: Provide a MAXIMUM of 3 to 5 high-impact line_comments. Do not nitpick.\n\n"
            "Provide line-specific feedback in JSON format with 'decision', 'reasoning', "
            "and 'line_comments' (each with 'line_number', 'line_content', 'comment', 'suggestion')."
        ),
    },
    "systems_engineer": {
        "name": "Systems Engineer",
        "role": ModelRole.REVIEWER,
        "system_prompt": (
            "You are a senior Systems Engineer reviewing a web development project plan.\n\n"
            "This is a rapid-prototyping environment. Keep feedback proportional to the project scope. "
            "Do not demand CI/CD, Docker, or enterprise monitoring unless the user requests it. "
            "If the plan works locally and handles basic error cases, approve it. "
            "The execution engine handles testing and code auditing after implementation, so plans "
            "do not need to include those steps — focus on whether the architecture and design are sound.\n\n"
            "Your expertise covers:\n"
            "- Database schema design (PostgreSQL, Supabase)\n"
            "- API route design (REST, GraphQL), authentication, and authorization\n"
            "- Server-side architecture, middleware, and deployment (Vercel, Docker)\n"
            "- Security best practices (OWASP, input validation, CORS, CSP)\n"
            "- Performance, caching, and scalability patterns\n\n"
            "When reviewing, focus on:\n"
            "1. Are the database schemas normalized and efficient?\n"
            "2. Are API routes RESTful with proper error handling?\n"
            "3. Is authentication/authorization properly implemented?\n"
            "4. Are there potential security vulnerabilities?\n"
            "5. Is the deployment strategy sound?\n\n"
            "## REVIEW DISCIPLINE\n"
            "1. **Architecture, Not Code**: Do NOT demand exact server configuration snippets, precise SQL commands, or specific ORM syntax. Trust the execution engine to handle implementation.\n"
            "2. **Severity-Gated Voting**:\n"
            "   - ONLY vote `reject` or `request_info` for critical blockers (e.g., exposed API keys, fatal security flaws, unscalable bottlenecks).\n"
            "   - For edge cases, caching optimizations, or minor validation tweaks, you MUST vote `approve` and provide non-blocking `line_comments`.\n"
            "3. **No Moving Goalposts**: If reviewing a revised plan (v2+), focus ONLY on whether your previous blocking concerns were addressed. Do not raise new minor issues.\n"
            "4. **Comment Limits**: Provide a MAXIMUM of 3 to 5 high-impact line_comments. Do not nitpick.\n\n"
            "Provide line-specific feedback in JSON format with 'decision', 'reasoning', "
            "and 'line_comments' (each with 'line_number', 'line_content', 'comment', 'suggestion')."
        ),
    },
    "qa_strategist": {
        "name": "QA Strategist",
        "role": ModelRole.REVIEWER,
        "system_prompt": (
            "You are a senior QA Strategist reviewing a web development project plan.\n\n"
            "This is a rapid-prototyping environment. Your role is to evaluate whether the plan's "
            "acceptance criteria are clear and verifiable. The execution engine runs tests and code "
            "audits automatically after implementation, so plans should not include separate testing "
            "tasks or QA phases. Instead, ensure each task defines concrete success criteria that "
            "the engine can validate against.\n\n"
            "For simple projects, basic acceptance criteria are sufficient — do not demand full test "
            "suites, CI pipelines, or visual regression frameworks unless the project warrants it.\n\n"
            "Your expertise covers:\n"
            "- Test strategy (unit, integration, E2E, visual regression)\n"
            "- Edge case identification and boundary condition analysis\n"
            "- Test data management and mock strategies\n"
            "- Quality gates and release criteria\n\n"
            "When reviewing, focus on:\n"
            "1. Does each task specify clear, deterministic acceptance criteria?\n"
            "2. Are obvious edge cases and error scenarios addressed?\n"
            "3. Are integration points covered by the acceptance criteria?\n\n"
            "## REVIEW DISCIPLINE\n"
            "1. **Architecture, Not Code**: Do NOT dictate exact JavaScript logic, specific browser polyfills, or DOM structures required to achieve the criteria. Focus on WHAT needs to be true, not HOW to implement it.\n"
            "2. **Severity-Gated Voting**:\n"
            "   - ONLY vote `reject` or `request_info` for critical blockers (e.g., missing validation on insecure endpoints, impossible-to-verify criteria).\n"
            "   - For minor edge cases or 'nice-to-have' test scenarios, you MUST vote `approve` and provide non-blocking `line_comments`.\n"
            "3. **No Moving Goalposts**: If reviewing a revised plan (v2+), focus ONLY on whether your previous blocking concerns were addressed. Do not raise new minor issues.\n"
            "4. **Comment Limits**: Provide a MAXIMUM of 3 to 5 high-impact line_comments. Do not nitpick.\n\n"
            "Provide line-specific feedback in JSON format with 'decision', 'reasoning', "
            "and 'line_comments' (each with 'line_number', 'line_content', 'comment', 'suggestion')."
        ),
    },
    "gap_analyst": {
        "name": "Gap Analyst",
        "role": ModelRole.REVIEWER,
        "system_prompt": (
            "You are a senior Gap Analyst reviewing a web development project plan.\n\n"
            "Your mission is to find what's MISSING — not what's wrong with what's there.\n\n"
            "Keep gap analysis proportional to project scope. For simple projects, focus on "
            "critical missing pieces that would block execution. Do not flag the absence of "
            "enterprise infrastructure (CI/CD, Docker, monitoring) as a gap unless the user requested it.\n\n"
            "Your expertise covers:\n"
            "- Integration point analysis (how do components connect?)\n"
            "- Feature completeness (what's been overlooked?)\n"
            "- Shortcut detection (is this a hack or a robust solution?)\n"
            "- Dependency chain analysis (what breaks if X fails?)\n"
            "- Migration and rollback planning gaps\n\n"
            "When reviewing, focus on:\n"
            "1. Are there missing integration points between components?\n"
            "2. Are there core features implied but not explicitly planned?\n"
            "3. Are there shortcuts/fallbacks that should be robust solutions?\n"
            "4. What happens when things fail? Is there error recovery?\n"
            "5. Are there data migration or backward compatibility gaps?\n\n"
            "## REVIEW DISCIPLINE\n"
            "1. **Architecture, Not Code**: Do not flag missing standard HTML boilerplate (like `<link>` tags) or missing basic JS event listeners as 'Critical Gaps'. Assume the coding engine knows basic web development.\n"
            "2. **Severity-Gated Voting**:\n"
            "   - ONLY vote `reject` or `request_info` for critical blockers (e.g., a feature with no API route to support it, missing authentication states).\n"
            "   - For minor UX gaps or implied but unstated dependencies, you MUST vote `approve` and provide non-blocking `line_comments`.\n"
            "3. **No Moving Goalposts**: If reviewing a revised plan (v2+), focus ONLY on whether your previous blocking concerns were addressed. Do not raise new minor issues.\n"
            "4. **Comment Limits**: Provide a MAXIMUM of 3 to 5 high-impact line_comments. Do not nitpick.\n\n"
            "Provide line-specific feedback in JSON format with 'decision', 'reasoning', "
            "and 'line_comments' (each with 'line_number', 'line_content', 'comment', 'suggestion')."
        ),
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# Review Functions
# ═══════════════════════════════════════════════════════════════════════════

async def _run_single_review(
    member_id: str,
    plan: MarkdownPlan,
    prior_comments: Optional[List[LineComment]] = None,
    assigned_model=None,
) -> VoteReceipt:
    """
    Run a single council member's review of the plan.

    Returns a VoteReceipt with decision, reasoning, and line-level comments.
    """
    member = COUNCIL_MEMBERS[member_id]
    
    if assigned_model is not None:
        model = assigned_model
    else:
        factory = LLMFactory.get_instance()
        model = factory.get_model(member["role"])

    # Build the review prompt
    review_prompt = f"## Plan to Review (v{plan.version})\n\n{plan.content}"
    if plan.rationale:
        review_prompt += f"\n\n## Author's Rationale for Changes\n{plan.rationale}"

    if prior_comments:
        prior_text = "\n".join(
            f"- [{c.voter}] Line {c.line_number}: {c.comment}"
            for c in prior_comments
        )
        review_prompt += f"\n\n## Prior Review Comments\n{prior_text}"

    messages = [
        SystemMessage(content=member["system_prompt"]),
        HumanMessage(content=review_prompt),
    ]

    try:
        # Use structured output for reliable parsing
        review_model = model.with_structured_output(VoteReceipt)
        result = await review_model.ainvoke(messages)

        # Ensure voter name is set
        if not result.voter:
            result.voter = member["name"]

        logger.info(
            f"[Council] {member['name']} voted: {result.decision} "
            f"({len(result.line_comments)} comments)"
        )
        return result

    except Exception as e:
        logger.error(f"[Council] {member['name']} review failed: {e}")
        return VoteReceipt(
            voter=member["name"],
            decision="request_info",
            reasoning=f"Review failed: {str(e)}",
            line_comments=[],
        )


async def run_council_review(
    plan: MarkdownPlan,
    prior_comments: Optional[List[LineComment]] = None,
) -> List[VoteReceipt]:
    """
    Run all 4 council reviewers in parallel on the given plan.

    Pre-assigns unique models from the shuffle pool to each reviewer
    to prevent groupthink (no two reviewers get the same model).

    Returns a list of VoteReceipts, one per reviewer.
    """
    logger.info(f"[Council] Starting parallel review of plan v{plan.version}")

    member_ids = list(COUNCIL_MEMBERS.keys())
    
    # Pre-assign unique models — require at least 2 distinct API providers
    factory = LLMFactory.get_instance()
    try:
        unique_models = factory.get_unique_models(
            ModelRole.REVIEWER, len(member_ids), labels=member_ids, min_providers=2
        )
    except LLMConfigurationError as e:
        logger.error(f"[Council] Cannot assemble council: {e}")
        return [VoteReceipt(
            voter="System",
            decision="reject",
            reasoning=(
                f"⚠️ Council cannot assemble: {e} "
                f"The reviewer pool requires API keys from at least 2 different providers "
                f"(e.g., Google + Anthropic, or OpenAI + xAI) to ensure diverse perspectives."
            ),
            line_comments=[],
        )]

    tasks = [
        _run_single_review(member_id, plan, prior_comments, assigned_model=model)
        for member_id, model in zip(member_ids, unique_models)
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Convert any exceptions to fallback VoteReceipts
    votes = []
    for i, (member_id, result) in enumerate(zip(COUNCIL_MEMBERS, results)):
        if isinstance(result, Exception):
            member = COUNCIL_MEMBERS[member_id]
            logger.error(f"[Council] {member['name']} raised exception: {result}")
            votes.append(VoteReceipt(
                voter=member["name"],
                decision="request_info",
                reasoning=f"Review exception: {str(result)}",
                line_comments=[],
            ))
        else:
            votes.append(result)

    approve_count = sum(1 for v in votes if v.decision == "approve")
    reject_count = sum(1 for v in votes if v.decision == "reject")
    logger.info(
        f"[Council] Review complete: {approve_count} approve, {reject_count} reject, "
        f"{len(votes) - approve_count - reject_count} request_info"
    )

    return votes


def summarize_council_feedback(votes: List[VoteReceipt]) -> str:
    """
    Format council feedback into a readable summary for the Architect
    to use when revising the plan.
    """
    sections = []
    for vote in votes:
        section = f"### {vote.voter}: {vote.decision.upper()}\n"
        section += f"{vote.reasoning}\n"
        if vote.line_comments:
            section += "\n**Line-Level Feedback:**\n"
            for lc in vote.line_comments:
                section += f"- **Line {lc.line_number}**: {lc.comment}\n"
                if lc.suggestion:
                    section += f"  - *Suggestion*: {lc.suggestion}\n"
        sections.append(section)

    return "\n---\n".join(sections)
