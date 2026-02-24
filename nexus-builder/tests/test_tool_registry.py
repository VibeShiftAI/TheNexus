"""
Test Tool Registry - Verification tests for unified tool interface.

Run with: pytest tests/test_tool_registry.py -v
"""

import pytest
import asyncio
from typing import Dict, Any

# Import from new unified interface
from tools import get_registry, NexusTool, ToolMetadata, ToolCategory


class TestToolRegistry:
    """Test ToolRegistry functionality."""
    
    def test_singleton_pattern(self):
        """Registry should be a singleton."""
        r1 = get_registry()
        r2 = get_registry()
        assert r1 is r2
    
    def test_registry_initialized(self):
        """Registry should initialize with default tools."""
        registry = get_registry()
        assert len(registry) > 0
    
    def test_expected_tool_count(self):
        """Should have 24 tools from 6 libraries."""
        registry = get_registry()
        assert len(registry) == 24
    
    def test_get_tool_by_name(self):
        """Should retrieve tool by name."""
        registry = get_registry()
        tool = registry.get("read_file")
        assert tool is not None
        assert tool.metadata.name == "read_file"
    
    def test_unknown_tool_returns_none(self):
        """Unknown tool should return None."""
        registry = get_registry()
        assert registry.get("nonexistent_tool") is None
    
    def test_list_tools(self):
        """list_tools should return ToolMetadata."""
        registry = get_registry()
        tools = registry.list_tools()
        assert len(tools) == 24
        assert all(isinstance(t, ToolMetadata) for t in tools)
    
    def test_filter_by_category(self):
        """Should filter tools by category."""
        registry = get_registry()
        research_tools = registry.list_tools(category=ToolCategory.RESEARCH)
        assert len(research_tools) == 3
        assert all(t.category == ToolCategory.RESEARCH for t in research_tools)
    
    def test_get_langchain_tools_all(self):
        """Should convert all tools to LangChain format."""
        registry = get_registry()
        lc_tools = registry.get_langchain_tools()
        assert len(lc_tools) == 24
        # LangChain tools should have name attribute
        assert all(hasattr(t, 'name') for t in lc_tools)
    
    def test_get_langchain_tools_subset(self):
        """Should convert subset of tools to LangChain format."""
        registry = get_registry()
        lc_tools = registry.get_langchain_tools(["read_file", "web_search"])
        assert len(lc_tools) == 2
        names = {t.name for t in lc_tools}
        assert names == {"read_file", "web_search"}


class TestNexusToolInterface:
    """Test NexusTool ABC implementation."""
    
    def test_tool_has_metadata(self):
        """Every tool should have valid metadata."""
        registry = get_registry()
        for name in ["read_file", "web_search", "search_codebase"]:
            tool = registry.get(name)
            meta = tool.metadata
            assert isinstance(meta, ToolMetadata)
            assert meta.name == name
            assert meta.description
            assert isinstance(meta.category, ToolCategory)
    
    def test_tool_to_langchain(self):
        """Tools should convert to LangChain format."""
        registry = get_registry()
        tool = registry.get("read_file")
        lc_tool = tool.to_langchain_tool()
        assert lc_tool.name == "read_file"
        assert lc_tool.description


class TestToolCategories:
    """Test tool categorization."""
    
    def test_filesystem_tools(self):
        """Should have filesystem tools."""
        registry = get_registry()
        fs_tools = registry.list_tools(category=ToolCategory.FILESYSTEM)
        names = {t.name for t in fs_tools}
        assert "read_file" in names
        assert "write_file" in names
    
    def test_research_tools(self):
        """Should have research tools."""
        registry = get_registry()
        research_tools = registry.list_tools(category=ToolCategory.RESEARCH)
        names = {t.name for t in research_tools}
        assert "web_search" in names
        assert "scrape_documentation" in names
    
    def test_workflow_tools(self):
        """Should have workflow tools."""
        registry = get_registry()
        workflow_tools = registry.list_tools(category=ToolCategory.WORKFLOW)
        names = {t.name for t in workflow_tools}
        assert "add_node" in names
        assert "connect_nodes" in names


class TestToolExecution:
    """Test tool execution (basic smoke tests)."""
    
    @pytest.mark.asyncio
    async def test_create_subplan_executes(self):
        """create_subplan should execute without error."""
        registry = get_registry()
        tool = registry.get("create_subplan")
        result = await tool.execute(
            {"project_root": "."},
            task_description="Test task"
        )
        assert result["success"] is True
        assert "result" in result
    
    @pytest.mark.asyncio
    async def test_search_nodes_executes(self):
        """search_nodes should execute without error."""
        registry = get_registry()
        tool = registry.get("search_nodes")
        result = await tool.execute({}, query="researcher")
        assert result["success"] is True
        assert "result" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
