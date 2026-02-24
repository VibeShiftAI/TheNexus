import pytest
import sys
# Ensure imports work regardless of where pytest is run from
if '.' not in sys.path:
    sys.path.append('.')

from cortex.interface.nexus_bridge import mcp

@pytest.mark.asyncio
async def test_nexus_tools_load():
    """Verify all MCP tools are registered correctly."""
    # FastMCP v0.4+ uses _tool_manager store
    if hasattr(mcp, "_tool_manager"):
        # This returns sync list of tool objects/definitions
        tools = mcp._tool_manager.list_tools()
        # They might be dictionaries or objects
        tool_names = []
        for t in tools:
            # Check for name in object or dict
            if hasattr(t, "name"):
                tool_names.append(t.name)
            elif isinstance(t, dict) and "name" in t:
                 tool_names.append(t["name"])
    else:
        # Fallback for older versions
        tools = await mcp.get_tools()
        tool_names = [t.name for t in tools]
    
    print(f"Loaded Tools: {tool_names}")
    
    assert "search_memory" in tool_names
    assert "start_debate" in tool_names
    assert "intervene" in tool_names
    assert "get_debate_status" in tool_names
