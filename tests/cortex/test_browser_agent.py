"""
Tests for Browser Agent (Phase 15).

Tests cover:
1. browser_tools: web_search, fetch_page, extract_links
2. browser agent: recursive loop, max iterations, Blackboard integration
3. orchestrator: browser_node wiring
"""

import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch
from pydantic import BaseModel

from cortex.agents.browser import (
    browse,
    browser_node,
    SelectAction,
    EvaluateAction,
)
from cortex.tools.browser_tools import (
    SearchResult,
    PageLink,
)
from cortex.schemas.state import (
    BrowseSession,
    BrowserResult,
)


# ═══════════════════════════════════════════════════════════════════════════
# Browser Tools Tests
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_web_search_returns_results():
    """web_search should return SearchResult list from Google CSE."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {
        "items": [
            {
                "title": "Python Official",
                "link": "https://python.org",
                "snippet": "The official Python site",
            },
            {
                "title": "Python Wikipedia",
                "link": "https://en.wikipedia.org/wiki/Python",
                "snippet": "Python is a programming language",
            },
        ]
    }

    with patch("cortex.tools.browser_tools.httpx.AsyncClient") as mock_client:
        mock_instance = AsyncMock()
        mock_instance.get = AsyncMock(return_value=mock_response)
        mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_instance.__aexit__ = AsyncMock(return_value=False)
        mock_client.return_value = mock_instance

        with patch.dict("os.environ", {"GOOGLE_API_KEY": "test", "GOOGLE_CSE_ID": "test"}):
            from cortex.tools.browser_tools import web_search
            results = await web_search("python programming")

    assert len(results) == 2
    assert results[0].title == "Python Official"
    assert results[0].url == "https://python.org"


@pytest.mark.asyncio
async def test_web_search_raises_without_keys():
    """web_search should raise ValueError if env vars not set."""
    with patch.dict("os.environ", {}, clear=True):
        from cortex.tools.browser_tools import web_search
        with pytest.raises(ValueError, match="GOOGLE_API_KEY"):
            await web_search("test query")


@pytest.mark.asyncio
async def test_fetch_page_strips_boilerplate():
    """fetch_page should remove nav/script/footer elements and return clean text."""
    mock_page = AsyncMock()
    mock_page.goto = AsyncMock()
    mock_page.evaluate = AsyncMock(side_effect=[
        None,  # First call: strip boilerplate
        "# Main Content\n\nThis is the actual article content.",  # Second call: extract markdown
    ])
    mock_page.close = AsyncMock()

    mock_browser = AsyncMock()
    mock_browser.new_page = AsyncMock(return_value=mock_page)
    mock_browser.close = AsyncMock()

    mock_playwright = AsyncMock()
    mock_playwright.chromium.launch = AsyncMock(return_value=mock_browser)

    # Mock async context manager
    mock_pw_ctx = AsyncMock()
    mock_pw_ctx.__aenter__ = AsyncMock(return_value=mock_playwright)
    mock_pw_ctx.__aexit__ = AsyncMock(return_value=False)

    with patch("playwright.async_api.async_playwright", return_value=mock_pw_ctx):
        from cortex.tools.browser_tools import fetch_page
        content = await fetch_page("https://example.com")

    assert "Main Content" in content
    assert "actual article content" in content


@pytest.mark.asyncio
async def test_extract_links_returns_deduplicated():
    """extract_links should return unique links with text."""
    mock_page = AsyncMock()
    mock_page.goto = AsyncMock()
    mock_page.evaluate = AsyncMock(return_value=[
        {"text": "Link 1", "href": "https://example.com/1"},
        {"text": "Link 2", "href": "https://example.com/2"},
        {"text": "Link 1 Again", "href": "https://example.com/1"},  # Duplicate
    ])

    mock_browser = AsyncMock()
    mock_browser.new_page = AsyncMock(return_value=mock_page)
    mock_browser.close = AsyncMock()

    mock_playwright = AsyncMock()
    mock_playwright.chromium.launch = AsyncMock(return_value=mock_browser)

    mock_pw_ctx = AsyncMock()
    mock_pw_ctx.__aenter__ = AsyncMock(return_value=mock_playwright)
    mock_pw_ctx.__aexit__ = AsyncMock(return_value=False)

    with patch("playwright.async_api.async_playwright", return_value=mock_pw_ctx):
        from cortex.tools.browser_tools import extract_links
        links = await extract_links("https://example.com")

    assert len(links) == 2  # Deduplicated


# ═══════════════════════════════════════════════════════════════════════════
# Browser Agent Tests
# ═══════════════════════════════════════════════════════════════════════════


def _make_structured_model(responses):
    """
    Create a mock model that handles with_structured_output().ainvoke() calls.
    Returns Pydantic objects from the responses list in order.
    """
    response_iter = iter(responses)

    async def mock_ainvoke(*args, **kwargs):
        return next(response_iter)

    mock_structured = MagicMock()
    mock_structured.ainvoke = AsyncMock(side_effect=mock_ainvoke)

    mock_model = MagicMock()
    mock_model.with_structured_output = MagicMock(return_value=mock_structured)

    return mock_model


@pytest.mark.asyncio
async def test_browse_loop_finds_answer():
    """Full browse loop should terminate when LLM reports sufficient answer."""
    mock_model = _make_structured_model([
        SelectAction(
            chosen_url="https://python.org/downloads",
            reasoning="Official source for version info",
        ),
        EvaluateAction(
            is_sufficient=True,
            answer="Python 3.13 is the latest version.",
            reasoning="Found on official downloads page",
        ),
    ])

    with patch("cortex.agents.browser.llm_factory") as mock_factory, \
         patch("cortex.agents.browser.web_search") as mock_search, \
         patch("cortex.agents.browser.fetch_page") as mock_fetch:

        mock_factory.get_model.return_value = mock_model
        mock_search.return_value = [
            SearchResult(title="Python Downloads", url="https://python.org/downloads", snippet="Download Python"),
        ]
        mock_fetch.return_value = "# Python Downloads\n\nLatest version: Python 3.13"

        session = await browse("What is the latest version of Python?")

    assert session.final_answer is not None
    assert "3.13" in session.final_answer
    assert session.iterations == 1
    assert len(session.urls_visited) == 1


@pytest.mark.asyncio
async def test_browse_loop_max_iterations():
    """Browse loop should stop at max_iterations even if no answer found."""
    # 3 iterations: each needs a select + evaluate response
    mock_model = _make_structured_model([
        SelectAction(chosen_url="https://example.com/1", reasoning="test"),
        EvaluateAction(is_sufficient=False, next_action="refine_search", refined_query="q2", reasoning="no"),
        SelectAction(chosen_url="https://example.com/2", reasoning="test"),
        EvaluateAction(is_sufficient=False, next_action="refine_search", refined_query="q3", reasoning="no"),
        SelectAction(chosen_url="https://example.com/3", reasoning="test"),
        EvaluateAction(is_sufficient=False, next_action="refine_search", refined_query="q4", reasoning="no"),
    ])

    with patch("cortex.agents.browser.llm_factory") as mock_factory, \
         patch("cortex.agents.browser.web_search") as mock_search, \
         patch("cortex.agents.browser.fetch_page") as mock_fetch:

        mock_factory.get_model.return_value = mock_model

        call_count = 0
        async def varying_search(q, num_results=5):
            nonlocal call_count
            call_count += 1
            return [SearchResult(
                title=f"Result {call_count}",
                url=f"https://example.com/{call_count}",
                snippet="test",
            )]
        mock_search.side_effect = varying_search
        mock_fetch.return_value = "# Some Page\n\nNot helpful content."

        session = await browse("impossible question", max_iterations=3)

    assert session.final_answer is None
    assert session.iterations == 3


@pytest.mark.asyncio
async def test_browse_writes_to_blackboard():
    """Browse session should write audit trail to Blackboard."""
    mock_model = _make_structured_model([
        SelectAction(chosen_url="https://example.com", reasoning="test"),
        EvaluateAction(is_sufficient=True, answer="Test answer", reasoning="found"),
    ])

    with patch("cortex.agents.browser.llm_factory") as mock_factory, \
         patch("cortex.agents.browser.web_search") as mock_search, \
         patch("cortex.agents.browser.fetch_page") as mock_fetch, \
         patch("cortex.agents.browser._write_to_blackboard") as mock_bb:

        mock_factory.get_model.return_value = mock_model
        mock_search.return_value = [
            SearchResult(title="Test", url="https://example.com", snippet="test"),
        ]
        mock_fetch.return_value = "# Test\n\nAnswer content."

        session = await browse("test query", session_id="test-session-123")

    mock_bb.assert_called_once()
    args = mock_bb.call_args
    assert args[0][1] == "test-session-123"


# ═══════════════════════════════════════════════════════════════════════════
# Graph Node Integration Test
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_browser_node_reads_messages():
    """browser_node should extract query from state messages."""
    mock_model = _make_structured_model([
        SelectAction(chosen_url="https://example.com", reasoning="test"),
        EvaluateAction(is_sufficient=True, answer="Node-level answer", reasoning="found"),
    ])

    with patch("cortex.agents.browser.llm_factory") as mock_factory, \
         patch("cortex.agents.browser.web_search") as mock_search, \
         patch("cortex.agents.browser.fetch_page") as mock_fetch:

        mock_factory.get_model.return_value = mock_model
        mock_search.return_value = [
            SearchResult(title="Test", url="https://example.com", snippet="test"),
        ]
        mock_fetch.return_value = "# Test\n\nContent."

        state = {
            "messages": [{"role": "user", "content": "What is React?"}],
            "session_id": "test-session",
        }
        result = await browser_node(state)

    assert result["browse_session"] is not None
    assert result["browse_session"].final_answer == "Node-level answer"
    assert result["research_context"] is not None
