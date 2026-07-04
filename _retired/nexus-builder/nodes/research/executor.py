"""
Research Executor Node - Web search and documentation agent.

Extracted from researcher/agent.py::execution_node
Executes approved research queries using web search and scraping tools.
"""

from ..core.fleet import FleetAgentNode
from researcher.agent import execution_node
from researcher.tools import web_search, scrape_documentation, verify_library_existence


class ResearchExecutorNode(FleetAgentNode):
    """
    Phase 3 of Research Fleet: Query Execution.
    
    Executes approved research queries using:
    - verify_library_existence: Validates packages exist before searching
    - web_search: Finds relevant documentation URLs
    - scrape_documentation: Reads full API references
    
    Uses execute_with_tools() for the ReAct loop.
    """
    
    type_id = "research_executor"
    display_name = "Research Executor"
    description = "Executes web searches and documentation scraping"
    category = "research"
    icon = "🌐"
    fleet_origin = "research"
    levels = ["project", "task"]
    
    # Bind the legacy function
    legacy_function = staticmethod(execution_node)
    
    # Tools this agent uses
    agent_tools = [verify_library_existence, web_search, scrape_documentation]
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Approved Queries",
                "name": "proposed_queries",
                "type": "json",
                "default": [],
                "description": "List of approved queries to execute"
            },
            {
                "displayName": "Max Iterations",
                "name": "max_iterations",
                "type": "number",
                "default": 3,
                "description": "Maximum search iterations before synthesis"
            }
        ]
