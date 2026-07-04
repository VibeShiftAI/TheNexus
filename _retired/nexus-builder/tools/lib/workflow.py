"""
Workflow Tools - AI Workflow Builder tools for node manipulation.

Migrated from:
- python/ai_builder/tools.py

These tools are used by the AI Workflow Builder subgraphs to
add nodes, connect them, and configure parameters.
"""

from typing import Dict, Any, List, Optional
import uuid

from ..interface import NexusTool, ToolMetadata, ToolCategory


# Internal registry of available node types
AVAILABLE_NODES = {
    "researcher": {
        "type_id": "researcher",
        "display_name": "Researcher Node",
        "description": "Performs deep research using web search and documentation",
        "category": "ai"
    },
    "builder": {
        "type_id": "builder", 
        "display_name": "Builder Node",
        "description": "Writes and edits code files",
        "category": "ai"
    },
    "architect": {
        "type_id": "architect",
        "display_name": "Architect Node",
        "description": "Designs system structure and creates plans",
        "category": "ai"
    },
    "bash_executor": {
        "type_id": "bash_executor",
        "display_name": "Bash Executor",
        "description": "Runs shell commands",
        "category": "utility"
    },
    "http_request": {
        "type_id": "http_request",
        "display_name": "HTTP Request",
        "description": "Makes HTTP requests to APIs",
        "category": "integration"
    }
}


class SearchNodesTool(NexusTool):
    """Search for available workflow node types."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="search_nodes",
            description="Search for available node types to add to a workflow.",
            category=ToolCategory.WORKFLOW,
            can_auto_execute=True,
            requires_permission=False,
            tags=["workflow", "node", "search"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        query: str,
        category: str = None
    ) -> Dict[str, Any]:
        """
        Search available nodes.
        
        Args:
            context: Execution context
            query: Search query
            category: Optional category filter
            
        Returns:
            Dict with success and list of matching nodes
        """
        query_lower = query.lower()
        results = []
        
        for node_id, node in AVAILABLE_NODES.items():
            # Match on name, description, or category
            if (query_lower in node_id.lower() or
                query_lower in node["display_name"].lower() or
                query_lower in node["description"].lower()):
                
                if category and node["category"] != category:
                    continue
                    
                results.append(node)
        
        return {"success": True, "result": results}


class GetNodeDetailsTool(NexusTool):
    """Get detailed information about a node type."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="get_node_details",
            description="Get detailed information about a specific node type.",
            category=ToolCategory.WORKFLOW,
            can_auto_execute=True,
            requires_permission=False,
            tags=["workflow", "node", "details"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        node_type: str
    ) -> Dict[str, Any]:
        """
        Get node details.
        
        Args:
            context: Execution context
            node_type: Type ID of the node
            
        Returns:
            Dict with success and node details
        """
        node = AVAILABLE_NODES.get(node_type)
        if node:
            return {"success": True, "result": node}
        return {
            "success": False,
            "error": f"Node type '{node_type}' not found"
        }


class AddNodeTool(NexusTool):
    """Add a node to the workflow."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="add_node",
            description="Add a node to the workflow being built.",
            category=ToolCategory.WORKFLOW,
            can_auto_execute=True,
            requires_permission=False,
            tags=["workflow", "node", "add"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        node_type: str,
        name: str,
        position_x: int = 0,
        position_y: int = 0
    ) -> Dict[str, Any]:
        """
        Add node to workflow.
        
        Args:
            context: Execution context
            node_type: Type ID of the node
            name: Human-readable name
            position_x: X position on canvas
            position_y: Y position on canvas
            
        Returns:
            Dict with success and operation details
        """
        if node_type not in AVAILABLE_NODES:
            return {
                "success": False,
                "error": f"Unknown node type: {node_type}"
            }
        
        node_id = f"node_{uuid.uuid4().hex[:8]}"
        
        operation = {
            "operation": "add_node",
            "node_id": node_id,
            "node_type": node_type,
            "name": name,
            "position": {"x": position_x, "y": position_y}
        }
        
        return {"success": True, "result": operation, "operation": operation}


class ConnectNodesTool(NexusTool):
    """Connect two nodes in the workflow."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="connect_nodes",
            description="Connect the output of one node to the input of another.",
            category=ToolCategory.WORKFLOW,
            can_auto_execute=True,
            requires_permission=False,
            tags=["workflow", "node", "connect"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        source_node_id: str,
        target_node_id: str,
        source_output: int = 0,
        target_input: int = 0
    ) -> Dict[str, Any]:
        """
        Connect nodes.
        
        Args:
            context: Execution context
            source_node_id: ID of source node
            target_node_id: ID of target node
            source_output: Output index (usually 0)
            target_input: Input index (usually 0)
            
        Returns:
            Dict with success and operation details
        """
        operation = {
            "operation": "connect_nodes",
            "source_node_id": source_node_id,
            "target_node_id": target_node_id,
            "source_output": source_output,
            "target_input": target_input
        }
        
        return {"success": True, "result": operation, "operation": operation}


class SetNodeParametersTool(NexusTool):
    """Set parameters on a node."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="set_node_parameters",
            description="Set configuration parameters on an existing node.",
            category=ToolCategory.WORKFLOW,
            can_auto_execute=True,
            requires_permission=False,
            tags=["workflow", "node", "configure"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        node_id: str,
        parameters: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Set node parameters.
        
        Args:
            context: Execution context
            node_id: ID of the node
            parameters: Dict of parameter values
            
        Returns:
            Dict with success and operation details
        """
        operation = {
            "operation": "set_parameters",
            "node_id": node_id,
            "parameters": parameters
        }
        
        return {"success": True, "result": operation, "operation": operation}


def register_tools(registry) -> None:
    """Register all workflow tools with the registry."""
    registry.register(SearchNodesTool())
    registry.register(GetNodeDetailsTool())
    registry.register(AddNodeTool())
    registry.register(ConnectNodesTool())
    registry.register(SetNodeParametersTool())
