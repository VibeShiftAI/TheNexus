"""
Nexus Bridge — MCP server for Cortex-to-Nexus integration.

Stripped down from the original Praxis bridge to only expose
Nexus project management tools. Memory, debate, hivemind, and
autopilot tools have been removed as part of the Vibe Coding OS refactor.
"""

from fastmcp import FastMCP
from cortex.interface.nexus_client import nexus

# Initialize
mcp = FastMCP("Cortex Nexus")


# --- NEXUS INTEGRATION TOOLS ---

@mcp.tool()
async def create_strategic_project(name: str, goal: str, project_type: str = "tool") -> str:
    """
    Creates a new Project in The Nexus.
    project_type must be one of: 'web-app', 'game', 'tool'.
    """
    try:
        pid = await nexus.create_project(name, goal, type=project_type)
        return f"✅ Project Created. ID: {pid}"
    except Exception as e:
        return f"❌ Failed to create project: {e}"

@mcp.tool()
async def add_project_task(project_id: str, task_description: str) -> str:
    """
    Adds a high-priority task to an existing project.
    """
    try:
        tid = await nexus.add_task(project_id, task_description)
        return f"✅ Task Added. ID: {tid}"
    except Exception as e:
        return f"❌ Failed to add task: {e}"

@mcp.tool()
async def list_active_projects() -> str:
    """
    Lists active projects to check for existence before creating new ones.
    """
    try:
        projects = await nexus.list_projects()
        if not projects:
            return "No active projects found."
        
        lines = [f"- [{p.get('id')}] {p.get('name')} (Type: {p.get('type')})" for p in projects]
        return "Active Projects:\n" + "\n".join(lines)
    except Exception as e:
        return f"❌ Failed to list projects: {e}"


if __name__ == "__main__":
    mcp.run()
