"""
Browser Tools - Playwright-based web search and page reading.

Phase 15: Recursive Browser Agent utilities.

These are pure utility functions (no LLM calls):
- web_search(): Google Custom Search API → list of results
- fetch_page(): Playwright headless Chromium → clean Markdown
- extract_links(): DOM query → list of follow-up links
"""

import os
import re
import logging
from typing import List, Dict, Optional
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    """A single search result from Google CSE."""
    title: str
    url: str
    snippet: str


@dataclass
class PageLink:
    """A link extracted from a rendered page."""
    text: str
    href: str


async def web_search(query: str, num_results: int = 5) -> List[SearchResult]:
    """
    Search the web using Google Custom Search API.

    Args:
        query: The search query
        num_results: Number of results to return (max 10)

    Returns:
        List of SearchResult objects

    Raises:
        ValueError: If GOOGLE_API_KEY or GOOGLE_CSE_ID is not set
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    cse_id = os.environ.get("GOOGLE_CSE_ID")

    if not api_key or not cse_id:
        raise ValueError(
            "GOOGLE_API_KEY and GOOGLE_CSE_ID must be set in environment"
        )

    logger.info(f"🔍 [Browser] Searching: {query}")

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            "https://www.googleapis.com/customsearch/v1",
            params={
                "key": api_key,
                "cx": cse_id,
                "q": query,
                "num": min(num_results, 10),
            },
        )
        response.raise_for_status()
        data = response.json()

    items = data.get("items", [])
    results = [
        SearchResult(
            title=item.get("title", ""),
            url=item.get("link", ""),
            snippet=item.get("snippet", ""),
        )
        for item in items
    ]

    logger.info(f"🔍 [Browser] Found {len(results)} results")
    return results


async def fetch_page(url: str, timeout_ms: int = 30000) -> str:
    """
    Fetch a web page using Playwright headless Chromium and return clean Markdown.

    Renders JavaScript, waits for network idle, strips boilerplate
    (nav, footer, ads, scripts), and returns readable text with
    heading structure preserved.

    Args:
        url: The URL to fetch
        timeout_ms: Page load timeout in milliseconds

    Returns:
        Clean Markdown text (capped at 50KB)
    """
    from playwright.async_api import async_playwright

    logger.info(f"📖 [Browser] Fetching: {url}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )

        try:
            await page.goto(url, wait_until="networkidle", timeout=timeout_ms)

            # Strip boilerplate elements
            await page.evaluate("""
                () => {
                    const selectors = [
                        'script', 'style', 'nav', 'footer', 'aside', 'header',
                        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
                        '.ad', '.ads', '.advertisement', '.cookie-banner',
                        '.popup', '.modal', '#cookie-consent',
                        'iframe', 'noscript'
                    ];
                    for (const sel of selectors) {
                        document.querySelectorAll(sel).forEach(el => el.remove());
                    }
                }
            """)

            # Extract content as structured Markdown
            content = await page.evaluate("""
                () => {
                    function nodeToMarkdown(node) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            const text = node.textContent.trim();
                            return text ? text + ' ' : '';
                        }
                        if (node.nodeType !== Node.ELEMENT_NODE) return '';

                        const tag = node.tagName.toLowerCase();
                        const children = Array.from(node.childNodes)
                            .map(nodeToMarkdown)
                            .join('');

                        switch (tag) {
                            case 'h1': return '\\n# ' + children.trim() + '\\n';
                            case 'h2': return '\\n## ' + children.trim() + '\\n';
                            case 'h3': return '\\n### ' + children.trim() + '\\n';
                            case 'h4': return '\\n#### ' + children.trim() + '\\n';
                            case 'h5': return '\\n##### ' + children.trim() + '\\n';
                            case 'h6': return '\\n###### ' + children.trim() + '\\n';
                            case 'p': return '\\n' + children.trim() + '\\n';
                            case 'br': return '\\n';
                            case 'li': return '- ' + children.trim() + '\\n';
                            case 'ul': case 'ol': return '\\n' + children;
                            case 'blockquote': return '\\n> ' + children.trim() + '\\n';
                            case 'pre': case 'code': return '`' + children.trim() + '`';
                            case 'strong': case 'b': return '**' + children.trim() + '**';
                            case 'em': case 'i': return '*' + children.trim() + '*';
                            case 'a': {
                                const href = node.getAttribute('href');
                                const text = children.trim();
                                if (href && text) return '[' + text + '](' + href + ')';
                                return text;
                            }
                            default: return children;
                        }
                    }

                    const main = document.querySelector('main, article, [role="main"], .content, #content');
                    const root = main || document.body;
                    return nodeToMarkdown(root);
                }
            """)

            # Clean up: collapse whitespace, limit size
            content = re.sub(r'\n{3,}', '\n\n', content)
            content = content.strip()

            # Cap at 50KB
            if len(content) > 50000:
                content = content[:50000] + "\n\n[... content truncated at 50KB ...]"

            logger.info(f"📖 [Browser] Fetched {len(content)} chars from {url}")
            return content

        finally:
            await browser.close()


async def extract_links(url: str, timeout_ms: int = 30000) -> List[PageLink]:
    """
    Extract all meaningful links from a rendered page.

    Args:
        url: The URL to extract links from
        timeout_ms: Page load timeout in milliseconds

    Returns:
        List of PageLink objects (deduplicated, filtered)
    """
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=timeout_ms)

            raw_links = await page.evaluate("""
                () => {
                    return Array.from(document.querySelectorAll('a[href]'))
                        .map(a => ({
                            text: a.textContent.trim().substring(0, 200),
                            href: a.href
                        }))
                        .filter(l => l.text && l.href.startsWith('http'));
                }
            """)

            # Deduplicate by href
            seen = set()
            links = []
            for link in raw_links:
                if link["href"] not in seen and len(link["text"]) > 2:
                    seen.add(link["href"])
                    links.append(PageLink(text=link["text"], href=link["href"]))

            logger.info(f"🔗 [Browser] Extracted {len(links)} links from {url}")
            return links

        finally:
            await browser.close()
