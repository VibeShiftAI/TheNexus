"""
Memory Tools - Context Pull Utilities

Provides tools for agents to query project memory on demand.

The key insight:
- OLD WAY: Inject last 15 memories into system prompt (expensive, wastes tokens)
- NEW WAY: Agent calls search_project_memory when needed (efficient)

NOTE: Vector similarity search is not available in this release.
      Memory search uses simple text matching as a fallback.
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass


# ═══════════════════════════════════════════════════════════════════════════
# MEMORY SEARCH RESULT
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class MemorySearchResult:
    """A single memory search result."""
    content: str
    memory_type: str
    relevance_score: float
    created_at: str
    metadata: Dict[str, Any]


# ═══════════════════════════════════════════════════════════════════════════
# SEARCH PROJECT MEMORY TOOL
# ═══════════════════════════════════════════════════════════════════════════

class SearchProjectMemoryTool:
    """
    Memory search tool for LangChain agents.
    
    Allows agents to query project memories using text search.
    Instead of injecting all memories into the prompt, agents call this
    when they need to remember something.
    
    Usage with LangChain:
        from langchain.tools import Tool
        
        memory_tool = SearchProjectMemoryTool(supabase_client)
        tool = Tool(
            name="search_project_memory",
            description="Search project memories for relevant context",
            func=memory_tool.search
        )
    """
    
    name = "search_project_memory"
    description = (
        "Search project memories for relevant context. "
        "Use this when you need to recall previous decisions, "
        "observations, user feedback, or insights about the project. "
        "Input should be a search query describing what you want to remember."
    )
    
    def __init__(self, supabase_client=None, project_id: Optional[str] = None):
        """
        Initialize the memory search tool.
        
        Args:
            supabase_client: Supabase client for database access
            project_id: Optional project ID to scope search
        """
        self.supabase = supabase_client
        self.project_id = project_id
    
    async def asearch(
        self,
        query: str,
        limit: int = 5,
        memory_types: Optional[List[str]] = None
    ) -> str:
        """
        Async search for relevant memories.
        
        Args:
            query: Search query describing what to remember
            limit: Maximum number of results
            memory_types: Filter by memory types (decision, observation, etc.)
        
        Returns:
            Formatted string of relevant memories
        """
        results = await self._search_memories(query, limit, memory_types)
        
        if not results:
            return "No relevant memories found for this query."
        
        return self._format_results(results)
    
    def search(
        self,
        query: str,
        limit: int = 5,
        memory_types: Optional[List[str]] = None
    ) -> str:
        """
        Synchronous wrapper for search (for LangChain compatibility).
        """
        import asyncio
        
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        return loop.run_until_complete(self.asearch(query, limit, memory_types))
    
    async def _search_memories(
        self,
        query: str,
        limit: int,
        memory_types: Optional[List[str]]
    ) -> List[MemorySearchResult]:
        """
        Search memories in database using text matching.
        """
        if not self.supabase:
            return []
        
        try:
            # Build query
            db_query = self.supabase.client.table("agent_memories").select("*")
            
            # Filter by project if specified
            if self.project_id:
                db_query = db_query.eq("project_id", self.project_id)
            
            # Filter by memory types
            if memory_types:
                db_query = db_query.in_("memory_type", memory_types)
            
            # Text search in content
            db_query = db_query.ilike("content", f"%{query}%")
            
            # Order by recency and limit
            db_query = db_query.order("created_at", desc=True).limit(limit)
            
            result = db_query.execute()
            
            return [
                MemorySearchResult(
                    content=row.get("content", ""),
                    memory_type=row.get("memory_type", "observation"),
                    relevance_score=1.0,
                    created_at=row.get("created_at", ""),
                    metadata=row.get("metadata", {})
                )
                for row in (result.data or [])
            ]
        
        except Exception as e:
            print(f"[SearchProjectMemoryTool] Error: {e}")
            return []
    
    def _format_results(self, results: List[MemorySearchResult]) -> str:
        """Format search results for agent consumption."""
        if not results:
            return "No memories found."
        
        lines = ["## Relevant Project Memories\n"]
        
        type_icons = {
            "decision": "🎯",
            "observation": "👁️",
            "user_feedback": "💬",
            "error": "❌",
            "insight": "💡"
        }
        
        for i, result in enumerate(results, 1):
            icon = type_icons.get(result.memory_type, "📝")
            date = result.created_at[:10] if result.created_at else "Unknown"
            
            lines.append(f"### {icon} Memory {i} ({result.memory_type})")
            lines.append(f"*Date: {date}*")
            lines.append("")
            lines.append(result.content)
            lines.append("")
        
        return "\n".join(lines)
