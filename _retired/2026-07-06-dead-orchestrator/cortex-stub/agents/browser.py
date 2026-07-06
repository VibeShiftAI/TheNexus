"""
Browser Agent - Recursive Web Research.

Phase 15: Recursive Browser Agent
- Search: Google CSE → list of URLs
- Select: LLM picks most promising URL (structured output)
- Read: Playwright renders page → clean Markdown
- Evaluate: LLM decides if content answers the question

The loop continues until the LLM is satisfied or max iterations reached.

Phase 25: B2 ↔ B6 Visual Integration
- Detects <img> tags in fetched page content
- Sends qualifying images to B6 Visual Interpreter
- Injects [!VISUAL_INSIGHT] blocks into content for downstream synthesis
"""

import re
import json
import logging
from typing import Optional, List

from pydantic import BaseModel
from langchain_core.messages import SystemMessage, HumanMessage

from cortex.llm_factory import LLMFactory, ModelRole
from cortex.schemas.state import (
    System2State,
    BrowseSession,
    BrowserResult,
    VisualRequest,
)
from cortex.tools.browser_tools import (
    web_search,
    fetch_page,
    extract_links,
    SearchResult,
)

logger = logging.getLogger(__name__)

llm_factory = LLMFactory()


# ═══════════════════════════════════════════════════════════════════════════
# Structured LLM Outputs
# ═══════════════════════════════════════════════════════════════════════════


class SelectAction(BaseModel):
    """LLM output: which URL to visit."""
    chosen_url: str
    reasoning: str


class EvaluateAction(BaseModel):
    """LLM output: whether content answers the question."""
    is_sufficient: bool
    answer: Optional[str] = None          # Populated when is_sufficient=True
    next_action: Optional[str] = None     # "refine_search" | "follow_link"
    refined_query: Optional[str] = None   # Used when next_action="refine_search"
    follow_url: Optional[str] = None      # Used when next_action="follow_link"
    reasoning: str = ""


# ═══════════════════════════════════════════════════════════════════════════
# System Prompts
# ═══════════════════════════════════════════════════════════════════════════

SELECT_SYSTEM = """You are a web research assistant. Given a list of search results,
pick the single most promising URL that is likely to contain the answer.

Prefer: official documentation, authoritative sources, recent content.
Avoid: forums with unanswered questions, paywalled sites, PDF-heavy academic papers.

Output valid JSON matching the SelectAction schema."""

EVALUATE_SYSTEM = """You are a web research evaluator. You have just read a web page.
Decide whether the content sufficiently answers the original question.

If YES: provide a concise, factual answer synthesized from the page content.
If NO: decide your next action:
  - "refine_search": the page was irrelevant, try a different search query
  - "follow_link": the page has a promising link, follow it

Output valid JSON matching the EvaluateAction schema."""


# ═══════════════════════════════════════════════════════════════════════════
# Recursive Browse Loop
# ═══════════════════════════════════════════════════════════════════════════

async def browse(
    query: str,
    max_iterations: int = 5,
    session_id: Optional[str] = None,
) -> BrowseSession:
    """
    Recursive browser agent. Searches the web, reads pages, and evaluates
    content until an answer is found or max iterations are hit.

    Args:
        query: The question to answer
        max_iterations: Safety cap on recursive iterations
        session_id: Optional Blackboard session ID for audit trail

    Returns:
        BrowseSession with results and optional final_answer
    """
    session = BrowseSession(query=query)
    model = llm_factory.get_model(ModelRole.BROWSER)

    logger.info(f"🌐 [Browser Agent] Starting browse: '{query}'")

    current_query = query

    for iteration in range(max_iterations):
        session.iterations = iteration + 1
        logger.info(f"🌐 [Browser Agent] Iteration {session.iterations}/{max_iterations}")

        # ── Action 1: Search ──────────────────────────────────────
        try:
            search_results = await web_search(current_query)
        except Exception as e:
            logger.error(f"❌ [Browser Agent] Search failed: {e}")
            break

        if not search_results:
            logger.warning("⚠️ [Browser Agent] No search results, stopping")
            break

        # Filter out already-visited URLs
        fresh_results = [
            r for r in search_results
            if r.url not in session.urls_visited
        ]
        if not fresh_results:
            logger.warning("⚠️ [Browser Agent] All results already visited, stopping")
            break

        # ── Action 2: Select ──────────────────────────────────────
        results_text = "\n".join(
            f"[{i+1}] {r.title}\n    URL: {r.url}\n    {r.snippet}"
            for i, r in enumerate(fresh_results)
        )

        try:
            select_model = model.with_structured_output(SelectAction)
            select_result = await select_model.ainvoke([
                SystemMessage(content=SELECT_SYSTEM),
                HumanMessage(content=(
                    f"ORIGINAL QUESTION:\n{query}\n\n"
                    f"SEARCH RESULTS:\n{results_text}\n\n"
                    f"Pick the best URL and explain your reasoning."
                )),
            ])
            chosen_url = select_result.chosen_url
            logger.info(
                f"🎯 [Browser Agent] Selected: {chosen_url} "
                f"({select_result.reasoning[:80]})"
            )
        except Exception as e:
            logger.error(f"❌ [Browser Agent] Select failed: {e}")
            # Fallback: pick first result
            chosen_url = fresh_results[0].url

        session.urls_visited.append(chosen_url)

        # ── Action 3: Read ────────────────────────────────────────
        try:
            page_content = await fetch_page(chosen_url)
        except Exception as e:
            logger.error(f"❌ [Browser Agent] Read failed for {chosen_url}: {e}")
            session.results.append(BrowserResult(
                url=chosen_url,
                title="(fetch failed)",
                content=f"Error: {e}",
                relevance="irrelevant",
            ))
            continue

        # ── B6 Visual Integration ─────────────────────────────────
        page_content = await _process_visuals(page_content, chosen_url, session_id or "")

        # Truncate for LLM context
        content_for_llm = page_content[:15000]

        # ── Action 4: Evaluate ────────────────────────────────────
        visited_list = "\n".join(f"- {u}" for u in session.urls_visited)

        try:
            eval_model = model.with_structured_output(EvaluateAction)
            eval_result = await eval_model.ainvoke([
                SystemMessage(content=EVALUATE_SYSTEM),
                HumanMessage(content=(
                    f"ORIGINAL QUESTION:\n{query}\n\n"
                    f"PAGES VISITED SO FAR:\n{visited_list}\n\n"
                    f"CURRENT PAGE URL: {chosen_url}\n"
                    f"CURRENT PAGE CONTENT (truncated):\n{content_for_llm}"
                )),
            ])
        except Exception as e:
            logger.error(f"❌ [Browser Agent] Evaluate failed: {e}")
            session.results.append(BrowserResult(
                url=chosen_url,
                title="(evaluation failed)",
                content=page_content[:2000],
                relevance="partial",
            ))
            continue

        # Store result
        relevance = "relevant" if eval_result.is_sufficient else (
            "partial" if "follow_link" == eval_result.next_action else "irrelevant"
        )
        session.results.append(BrowserResult(
            url=chosen_url,
            title=page_content.split("\n")[0][:100] if page_content else chosen_url,
            content=page_content[:5000],
            relevance=relevance,
        ))

        # ── Decision ──────────────────────────────────────────────
        if eval_result.is_sufficient:
            session.final_answer = eval_result.answer
            logger.info(
                f"✅ [Browser Agent] Answer found after {session.iterations} iterations: "
                f"{(session.final_answer or '')[:100]}"
            )
            break

        # Decide next action
        if eval_result.next_action == "refine_search" and eval_result.refined_query:
            current_query = eval_result.refined_query
            logger.info(f"🔄 [Browser Agent] Refining search: '{current_query}'")

        elif eval_result.next_action == "follow_link" and eval_result.follow_url:
            # Direct fetch of a follow-up URL (skip search)
            logger.info(f"🔗 [Browser Agent] Following link: {eval_result.follow_url}")
            session.urls_visited.append(eval_result.follow_url)
            try:
                follow_content = await fetch_page(eval_result.follow_url)
                session.results.append(BrowserResult(
                    url=eval_result.follow_url,
                    title=follow_content.split("\n")[0][:100] if follow_content else eval_result.follow_url,
                    content=follow_content[:5000],
                    relevance="partial",
                ))
                # Re-evaluate the followed link
                content_for_llm = follow_content[:15000]
                visited_list = "\n".join(f"- {u}" for u in session.urls_visited)
                try:
                    reeval = await eval_model.ainvoke([
                        SystemMessage(content=EVALUATE_SYSTEM),
                        HumanMessage(content=(
                            f"ORIGINAL QUESTION:\n{query}\n\n"
                            f"PAGES VISITED SO FAR:\n{visited_list}\n\n"
                            f"CURRENT PAGE URL: {eval_result.follow_url}\n"
                            f"CURRENT PAGE CONTENT (truncated):\n{content_for_llm}"
                        )),
                    ])
                    if reeval.is_sufficient:
                        session.final_answer = reeval.answer
                        session.results[-1].relevance = "relevant"
                        logger.info(f"✅ [Browser Agent] Answer found via follow link")
                        break
                except Exception:
                    pass  # Continue loop
            except Exception as e:
                logger.error(f"❌ [Browser Agent] Follow link failed: {e}")
        else:
            # Default: keep the original query, results will change as URLs are visited
            logger.info("🔄 [Browser Agent] Continuing with same query")

    # ── Write to Blackboard ───────────────────────────────────────
    if session_id:
        _write_to_blackboard(session, session_id)

    if not session.final_answer:
        logger.warning(
            f"⚠️ [Browser Agent] No definitive answer after {session.iterations} iterations"
        )

    return session


def _write_to_blackboard(session: BrowseSession, session_id: str):
    """Write browse session audit trail to Blackboard."""
    try:
        try:
            from cortex.blackboard import Blackboard
        except ImportError:
            from cortex.blackboard import Blackboard

        bb = Blackboard.get_or_create(session_id)

        md = f"## Browser Agent Session\n\n"
        md += f"- **Query**: {session.query}\n"
        md += f"- **Iterations**: {session.iterations}\n"
        md += f"- **URLs Visited**: {len(session.urls_visited)}\n"
        md += f"- **Answer Found**: {'Yes' if session.final_answer else 'No'}\n\n"

        if session.final_answer:
            md += f"### Answer\n\n{session.final_answer}\n\n"

        md += "### Pages Visited\n\n"
        for result in session.results:
            md += f"- [{result.relevance}] {result.url}\n"

        bb.append_step(agent_id="browser", content=md)
        logger.info("💾 [Blackboard] Browser session written to state.md")
    except Exception as e:
        logger.warning(f"Blackboard write failed (non-blocking): {e}")


# ═══════════════════════════════════════════════════════════════════════════
# B2 ↔ B6 Visual Integration
# ═══════════════════════════════════════════════════════════════════════════

# Regex to find <img> tags in Markdown/HTML content
_IMG_PATTERN = re.compile(
    r'!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["\']([^"\'>]+)["\'][^>]*(?:alt=["\']([^"\'>]*)["\'])?[^>]*/?>',
    re.IGNORECASE,
)


def _extract_images_from_content(content: str, base_url: str = "") -> List[VisualRequest]:
    """
    Extract image references from page content (Markdown or HTML).

    Returns a list of VisualRequests for B6 processing.
    """
    requests = []
    for match in _IMG_PATTERN.finditer(content):
        # Markdown: ![alt](url) or HTML: <img src="url" alt="alt">
        md_alt, md_url, html_src, html_alt = match.groups()

        url = md_url or html_src
        alt = md_alt or html_alt or ""

        if not url:
            continue

        # Get surrounding context (200 chars before and after)
        start = max(0, match.start() - 200)
        end = min(len(content), match.end() + 200)
        surrounding = content[start:end]

        requests.append(VisualRequest(
            image_source=url,
            directive="Analyze this image found on a web page during research.",
            surrounding_context=surrounding[:500],
            alt_text=alt if alt else None,
        ))

    return requests


async def _process_visuals(content: str, page_url: str, session_id: str = "") -> str:
    """
    Scan page content for images, run B6 on qualifying ones,
    and inject [!VISUAL_INSIGHT] blocks into the content.

    This is the B2 ↔ B6 async placeholder pattern.
    """
    image_requests = _extract_images_from_content(content, page_url)

    if not image_requests:
        return content

    logger.info(f"[B2>B6] Found {len(image_requests)} images on {page_url[:60]}")

    try:
        from cortex.agents.visual_interpreter import interpret_batch, _write_to_blackboard as _write_visuals_to_bb
    except ImportError:
        from cortex.agents.visual_interpreter import interpret_batch, _write_to_blackboard as _write_visuals_to_bb

    try:
        results = await interpret_batch(image_requests)
        # Write audit trail to Blackboard (non-blocking, best-effort)
        _write_visuals_to_bb(results, session_id=session_id)
    except Exception as e:
        logger.warning(f"[B2>B6] Visual processing failed: {e}")
        return content

    # Inject insights into content
    insight_blocks = []
    for req, result in zip(image_requests, results):
        if result.modality == "decorative":
            continue  # Don't pollute content with decorative skips

        block = f"\n\n[!VISUAL_INSIGHT: {result.modality}]\n"
        block += f"{result.description}\n"
        if result.entities:
            block += "Entities: "
            block += "; ".join(
                f"{e.source_node} -> {e.relationship} -> {e.target_node}"
                for e in result.entities
            )
            block += "\n"
        block += f"(confidence: {result.confidence:.2f})\n"
        insight_blocks.append(block)

    if insight_blocks:
        content += "\n\n--- Visual Analysis ---" + "".join(insight_blocks)
        logger.info(f"[B2>B6] Injected {len(insight_blocks)} visual insights")

    return content


# ═══════════════════════════════════════════════════════════════════════════
# Graph Node Wrapper
# ═══════════════════════════════════════════════════════════════════════════

async def browser_node(state: System2State) -> dict:
    """
    LangGraph node wrapper for the Browser Agent.

    Invoked by the orchestrator when deep web research is needed.
    Reads the query from state messages and writes results to browse_session.
    """
    messages = state.get("messages", [])
    if not messages:
        logger.warning("No messages in state, cannot browse")
        return {"browse_session": None}

    # Extract query from latest message
    last_msg = messages[-1]
    query = last_msg.get("content", "") if isinstance(last_msg, dict) else str(last_msg)

    session_id = state.get("session_id", "")

    session = await browse(
        query=query,
        max_iterations=5,
        session_id=session_id,
    )

    # Also inject the answer into research_context for downstream consumption
    research_ctx = None
    if session.final_answer:
        research_ctx = f"[Browser Agent] {session.final_answer}"

    return {
        "browse_session": session,
        "research_context": research_ctx or state.get("research_context"),
    }
