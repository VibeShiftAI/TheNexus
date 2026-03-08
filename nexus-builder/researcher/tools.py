"""
Research Fleet Tools - Real implementations for web research.

[DEPRECATED] This module is deprecated. Use the unified tool registry:
    from tools import get_registry
    registry = get_registry()
    research_tools = registry.get_langchain_tools(["web_search", "scrape_documentation", "verify_library"])

Legacy Tools:
- web_search: DuckDuckGo (legacy — unified registry preferred)
- scrape_documentation: BeautifulSoup scraping with Gemini's large context advantage
- verify_library_existence: PyPI/NPM registry checks to prevent hallucinations
"""
import warnings
warnings.warn(
    "researcher.tools is deprecated. Use 'from tools import get_registry' instead.",
    DeprecationWarning,
    stacklevel=2
)

import os
import requests
from bs4 import BeautifulSoup
from langchain_core.tools import tool


# ═══════════════════════════════════════════════════════════════
# WEB SEARCH - Google Custom Search API
# ═══════════════════════════════════════════════════════════════

@tool
def web_search(query: str) -> str:
    """
    Performs a broad web search to find documentation, libraries, or code examples.
    Use this to find the 'Official Documentation' URL for a specific technology.
    
    Args:
        query (str): The search string (e.g. "FastAPI OAuth2 implementation docs").
    """
    print(f"[WebSearch] Searching for: {query}")
    
    try:
        api_key = os.environ.get("GOOGLE_API_KEY")
        search_engine_id = os.environ.get("GOOGLE_CSE_ID")
        
        if not api_key or not search_engine_id:
            return f"Error: GOOGLE_API_KEY or GOOGLE_CSE_ID not configured"
        
        # Google Custom Search API
        url = "https://www.googleapis.com/customsearch/v1"
        params = {
            "key": api_key,
            "cx": search_engine_id,
            "q": query,
            "num": 5  # Top 5 results
        }
        
        response = requests.get(url, params=params, timeout=10)
        
        if response.status_code != 200:
            return f"Search failed with status {response.status_code}: {response.text[:200]}"
        
        data = response.json()
        items = data.get("items", [])
        
        if not items:
            return f"No results found for: {query}"
        
        # Format results for the LLM
        formatted = []
        for item in items:
            formatted.append(
                f"Title: {item.get('title', 'N/A')}\n"
                f"URL: {item.get('link', 'N/A')}\n"
                f"Snippet: {item.get('snippet', 'N/A')}\n"
            )
        
        return "\n---\n".join(formatted)
        
    except Exception as e:
        return f"Search failed: {str(e)}"


# ═══════════════════════════════════════════════════════════════
# SCRAPE DOCUMENTATION - BeautifulSoup with large context advantage
# ═══════════════════════════════════════════════════════════════

@tool
def scrape_documentation(url: str) -> str:
    """
    Scrapes the text content from a specific documentation URL.
    Use this AFTER web_search identifies the correct URL.
    Leverages Gemini's 1M+ context window to read full API references.
    
    Args:
        url (str): The full URL to scrape.
    """
    print(f"[Scrape] Reading: {url}")
    
    try:
        # 1. Fetch with proper headers
        headers = {
            'User-Agent': 'Nexus-Research-Bot/1.0 (Documentation Scraper)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        }
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        
        # 2. Parse & Clean with BeautifulSoup
        soup = BeautifulSoup(response.content, 'html.parser')
        
        # Remove noise elements to save tokens
        for element in soup(["script", "style", "nav", "footer", "aside", "header", 
                            "noscript", "iframe", "svg", "img", "button", "form"]):
            element.extract()
        
        # Also remove common navigation/sidebar classes
        for selector in ['.sidebar', '.nav', '.menu', '.footer', '.header', 
                        '.advertisement', '.ad', '.cookie', '.popup']:
            for element in soup.select(selector):
                element.extract()
        
        # 3. Extract text with proper spacing
        text = soup.get_text(separator="\n")
        
        # 4. Compact whitespace - remove empty lines and trim
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        clean_text = "\n".join(lines)
        
        # 5. Limit to 50k chars to prevent absolute context overflow
        # (Gemini can handle much more, but this keeps things reasonable)
        if len(clean_text) > 50000:
            clean_text = clean_text[:50000] + "\n\n[...TRUNCATED - Content exceeded 50k chars...]"
        
        return f"URL: {url}\n\nCONTENT:\n{clean_text}"
        
    except requests.exceptions.Timeout:
        return f"Error scraping {url}: Request timed out after 15 seconds"
    except requests.exceptions.RequestException as e:
        return f"Error scraping {url}: {str(e)}"
    except Exception as e:
        return f"Error scraping {url}: {str(e)}"


# ═══════════════════════════════════════════════════════════════
# VERIFY LIBRARY EXISTENCE - Hallucination prevention gate
# ═══════════════════════════════════════════════════════════════

@tool
def verify_library_existence(library_name: str, language: str = "python") -> str:
    """
    Checks if a software library actually exists in the public package registry.
    Run this BEFORE recommending a specific library in the Dossier.
    This prevents the "package-does-not-exist" error loop.
    
    Args:
        library_name (str): Exact name of the package (e.g. "pandas").
        language (str): 'python' (PyPI) or 'javascript' (NPM).
    """
    print(f"[Verify] Checking {language} registry for: {library_name}")
    
    try:
        if language.lower() == "python":
            resp = requests.get(
                f"https://pypi.org/pypi/{library_name}/json",
                timeout=5
            )
            if resp.status_code == 200:
                data = resp.json()
                info = data.get('info', {})
                return (
                    f"CONFIRMED: '{library_name}' exists on PyPI.\n"
                    f"Version: {info.get('version', 'unknown')}\n"
                    f"Summary: {info.get('summary', 'N/A')[:200]}"
                )
            elif resp.status_code == 404:
                return f"WARNING: '{library_name}' was NOT found on PyPI. It might be hallucinated or a built-in module."
        
        elif language.lower() in ["javascript", "js", "node", "npm"]:
            resp = requests.get(
                f"https://registry.npmjs.org/{library_name}",
                timeout=5
            )
            if resp.status_code == 200:
                data = resp.json()
                latest = data.get("dist-tags", {}).get("latest", "unknown")
                description = data.get("description", "N/A")[:200]
                return (
                    f"CONFIRMED: '{library_name}' exists on NPM.\n"
                    f"Version: {latest}\n"
                    f"Description: {description}"
                )
            elif resp.status_code == 404:
                return f"WARNING: '{library_name}' was NOT found on NPM. It might be hallucinated or a built-in module."
        
        else:
            return f"Unsupported language: {language}. Use 'python' or 'javascript'."
        
        return f"WARNING: Could not verify '{library_name}' - registry returned status {resp.status_code}"
        
    except requests.exceptions.Timeout:
        return f"Error: Package registry timed out while checking '{library_name}'"
    except Exception as e:
        return f"Error connecting to package registry: {str(e)}"


# ═══════════════════════════════════════════════════════════════
# LEGACY CLASS (for backwards compatibility if referenced elsewhere)
# ═══════════════════════════════════════════════════════════════

class ResearcherTools:
    """
    Static method wrappers for the research tools.
    Prefer using the @tool decorated functions directly.
    """
    
    @staticmethod
    def web_search(query: str) -> str:
        return web_search.invoke(query)
    
    @staticmethod
    def scrape_documentation(url: str) -> str:
        return scrape_documentation.invoke(url)
    
    @staticmethod
    def verify_library_existence(name: str, language: str = "python") -> str:
        return verify_library_existence.invoke({"library_name": name, "language": language})
