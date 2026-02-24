"""
Research Tools - Web search and documentation scraping.

Migrated from: python/researcher/tools.py

These tools enable agents to:
- Search the web for documentation and code examples
- Scrape text content from URLs
- Verify library/package existence on PyPI/NPM
"""

from typing import Dict, Any
import os

from ..interface import NexusTool, ToolMetadata, ToolCategory


class WebSearchTool(NexusTool):
    """Search the web using Google Custom Search API."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="web_search",
            description="Search the web for documentation, tutorials, and code examples.",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            estimated_cost="low",
            tags=["search", "web", "google"],
        )
    
    async def execute(
        self, context: Dict[str, Any], query: str
    ) -> Dict[str, Any]:
        """
        Search the web.
        
        Args:
            context: Execution context
            query: Search query
            
        Returns:
            Dict with success and list of results
        """
        import requests
        
        api_key = os.environ.get("GOOGLE_API_KEY")
        cse_id = os.environ.get("GOOGLE_CSE_ID")
        
        if not api_key or not cse_id:
            return {
                "success": False,
                "error": "GOOGLE_API_KEY or GOOGLE_CSE_ID not configured"
            }
        
        try:
            resp = requests.get(
                "https://www.googleapis.com/customsearch/v1",
                params={"key": api_key, "cx": cse_id, "q": query, "num": 5},
                timeout=10
            )
            
            if resp.status_code != 200:
                return {"success": False, "error": f"HTTP {resp.status_code}"}
            
            items = resp.json().get("items", [])
            results = [
                {
                    "title": item["title"],
                    "url": item["link"],
                    "snippet": item.get("snippet", "")
                }
                for item in items
            ]
            return {"success": True, "result": results}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class ScrapeDocumentationTool(NexusTool):
    """Scrape text content from a documentation URL."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="scrape_documentation",
            description="Scrape and extract text content from a documentation URL.",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["scrape", "documentation", "web"],
        )
    
    async def execute(
        self, context: Dict[str, Any], url: str
    ) -> Dict[str, Any]:
        """
        Scrape documentation from URL.
        
        Args:
            context: Execution context
            url: URL to scrape
            
        Returns:
            Dict with success and extracted text
        """
        import requests
        from bs4 import BeautifulSoup
        
        try:
            resp = requests.get(
                url,
                headers={"User-Agent": "Nexus-Bot/1.0"},
                timeout=15
            )
            resp.raise_for_status()
            
            soup = BeautifulSoup(resp.content, 'html.parser')
            
            # Remove non-content elements
            for tag in soup(["script", "style", "nav", "footer", "aside", "header"]):
                tag.extract()
            
            # Extract text
            text = "\n".join(
                line.strip()
                for line in soup.get_text().splitlines()
                if line.strip()
            )
            
            # Limit to 50KB
            return {"success": True, "result": text[:50000]}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class VerifyLibraryTool(NexusTool):
    """Verify that a library/package exists on PyPI or NPM."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="verify_library",
            description="Verify that a library exists on PyPI (Python) or NPM (JavaScript).",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["library", "package", "pypi", "npm"],
        )
    
    async def execute(
        self, context: Dict[str, Any], library_name: str, language: str = "python"
    ) -> Dict[str, Any]:
        """
        Verify library existence.
        
        Args:
            context: Execution context
            library_name: Name of the library to verify
            language: "python" or "javascript"
            
        Returns:
            Dict with success and verification result
        """
        import requests
        
        try:
            if language.lower() == "python":
                url = f"https://pypi.org/pypi/{library_name}/json"
                resp = requests.get(url, timeout=10)
                
                if resp.status_code == 200:
                    data = resp.json()
                    version = data.get("info", {}).get("version", "unknown")
                    return {
                        "success": True,
                        "result": {
                            "exists": True,
                            "name": library_name,
                            "version": version,
                            "source": "PyPI"
                        }
                    }
                else:
                    return {
                        "success": True,
                        "result": {"exists": False, "name": library_name}
                    }
                    
            elif language.lower() in ["javascript", "js", "node"]:
                url = f"https://registry.npmjs.org/{library_name}"
                resp = requests.get(url, timeout=10)
                
                if resp.status_code == 200:
                    data = resp.json()
                    version = data.get("dist-tags", {}).get("latest", "unknown")
                    return {
                        "success": True,
                        "result": {
                            "exists": True,
                            "name": library_name,
                            "version": version,
                            "source": "NPM"
                        }
                    }
                else:
                    return {
                        "success": True,
                        "result": {"exists": False, "name": library_name}
                    }
            else:
                return {
                    "success": False,
                    "error": f"Unsupported language: {language}"
                }
                
        except Exception as e:
            return {"success": False, "error": str(e)}


def register_tools(registry) -> None:
    """Register all research tools with the registry."""
    registry.register(WebSearchTool())
    registry.register(ScrapeDocumentationTool())
    registry.register(VerifyLibraryTool())
