"""
Nexus Agent Configuration Schema

Defines the nexus_agent.json configuration format per The Nexus Protocol.
This schema bridges visual intent from the Agent Designer to executable
LangGraph code with MCP tool bindings.
"""

from typing import TypedDict, List, Dict, Any, Optional
from enum import Enum
from dataclasses import dataclass, field
import json
from pathlib import Path


class CheckpointerType(str, Enum):
    """Storage backend types for state persistence."""
    MEMORY = "memory"      # In-memory (dev/testing)
    SQLITE = "sqlite"      # Local SQLite file
    POSTGRES = "postgres"  # PostgreSQL for production


class MCPTransport(str, Enum):
    """MCP server transport protocols."""
    STDIO = "stdio"  # Standard I/O (local processes)
    SSE = "sse"      # Server-Sent Events (remote servers)


class AgentDomain(str, Enum):
    """Domain categories for agent templates."""
    BUSINESS = "business"
    CREATIVE = "creative"
    PRODUCTIVITY = "productivity"
    CODING = "coding"
    HR = "hr"
    LEGAL = "legal"
    FINANCE = "finance"
    TRAVEL = "travel"


class AutonomyLevel(str, Enum):
    """Agent autonomy calibration levels."""
    COPILOT = "copilot"          # Always ask before action
    SUPERVISED = "supervised"    # Ask for important decisions
    AUTONOMOUS = "autonomous"    # Act then inform
    AUTOPILOT = "autopilot"      # Full autonomy


# === Type Definitions ===

class NodeConfig(TypedDict):
    """Configuration for a single workflow node."""
    id: str
    type: str  # 'agent' (LLM) or 'tool' (deterministic function)
    name: str
    system_prompt: Optional[str]
    model: Optional[str]
    tools: List[str]  # MCP tool names enabled for this node
    config: Optional[Dict[str, Any]]


class EdgeConfig(TypedDict):
    """Configuration for graph edge transitions."""
    source: str
    target: str
    condition: Optional[str]  # e.g., "state.retry_count < 3"
    label: Optional[str]      # Display label for visual editor


class MCPServerConfig(TypedDict):
    """MCP server connection configuration."""
    transport: str  # 'stdio' or 'sse'
    command: Optional[str]  # For stdio: command to run
    args: Optional[List[str]]  # Command arguments
    url: Optional[str]  # For sse: server URL
    env: Optional[Dict[str, str]]  # Environment variables (use ${secrets.VAR})


class OutputSchemaConfig(TypedDict):
    """Structured output format specification."""
    format: str  # 'json', 'markdown', 'csv', 'pdf', 'slack'
    schema: Optional[Dict[str, Any]]  # JSON Schema for structured outputs
    template: Optional[str]  # Template string for formatting


class NexusAgentConfig(TypedDict):
    """
    Complete agent configuration per The Nexus Protocol.
    
    This is the structure of nexus_agent.json files that define
    agents created in the Agent Designer.
    """
    # === Metadata ===
    agent_id: str
    name: str
    description: str
    domain: str  # AgentDomain value
    version: str
    
    # === Runtime Configuration ===
    recursion_limit: int        # Safety valve to prevent infinite loops (default: 25)
    checkpointer: str           # CheckpointerType value
    autonomy_level: str         # AutonomyLevel value
    interrupt_config: List[str] # Node IDs requiring human approval
    
    # === State Schema ===
    state_schema: Dict[str, str]  # Field name -> type mapping for custom fields
    output_schema: Optional[OutputSchemaConfig]  # Expected output format
    negative_constraints: List[str]  # "Do not..." guardrails
    
    # === Graph Topology ===
    nodes: List[NodeConfig]
    edges: List[EdgeConfig]
    entry_point: str  # Starting node ID
    
    # === MCP Resources ===
    mcp_servers: Dict[str, MCPServerConfig]


# === Helper Functions ===

def create_default_config(
    agent_id: str,
    name: str,
    domain: AgentDomain = AgentDomain.PRODUCTIVITY
) -> NexusAgentConfig:
    """Create a minimal default configuration for a new agent."""
    return {
        "agent_id": agent_id,
        "name": name,
        "description": "",
        "domain": domain.value,
        "version": "1.0.0",
        
        "recursion_limit": 25,
        "checkpointer": CheckpointerType.MEMORY.value,
        "autonomy_level": AutonomyLevel.SUPERVISED.value,
        "interrupt_config": [],
        
        "state_schema": {},
        "output_schema": None,
        "negative_constraints": [],
        
        "nodes": [],
        "edges": [],
        "entry_point": "",
        
        "mcp_servers": {}
    }


def load_config(path: Path) -> NexusAgentConfig:
    """Load a nexus_agent.json configuration file."""
    with open(path, 'r') as f:
        return json.load(f)


def save_config(config: NexusAgentConfig, path: Path) -> None:
    """Save a nexus_agent.json configuration file."""
    with open(path, 'w') as f:
        json.dump(config, f, indent=2)


def validate_config(config: NexusAgentConfig) -> List[str]:
    """
    Validate a configuration and return list of errors.
    Returns empty list if valid.
    """
    errors = []
    
    # Required fields
    if not config.get("agent_id"):
        errors.append("agent_id is required")
    if not config.get("name"):
        errors.append("name is required")
    
    # Recursion limit bounds
    limit = config.get("recursion_limit", 25)
    if limit < 1 or limit > 100:
        errors.append("recursion_limit must be between 1 and 100")
    
    # Checkpointer validation
    checkpointer = config.get("checkpointer", "memory")
    if checkpointer not in [e.value for e in CheckpointerType]:
        errors.append(f"Invalid checkpointer: {checkpointer}")
    
    # Node validation
    nodes = config.get("nodes", [])
    node_ids = set()
    for node in nodes:
        if not node.get("id"):
            errors.append("All nodes must have an id")
        elif node["id"] in node_ids:
            errors.append(f"Duplicate node id: {node['id']}")
        else:
            node_ids.add(node["id"])
    
    # Edge validation
    for edge in config.get("edges", []):
        if edge.get("source") not in node_ids:
            errors.append(f"Edge source '{edge.get('source')}' not found in nodes")
        if edge.get("target") not in node_ids:
            errors.append(f"Edge target '{edge.get('target')}' not found in nodes")
    
    # Entry point validation
    entry = config.get("entry_point", "")
    if entry and entry not in node_ids:
        errors.append(f"Entry point '{entry}' not found in nodes")
    
    # Interrupt config validation
    for node_id in config.get("interrupt_config", []):
        if node_id not in node_ids:
            errors.append(f"Interrupt node '{node_id}' not found in nodes")
    
    return errors


def get_checkpointer(config: NexusAgentConfig):
    """
    Get the appropriate LangGraph checkpointer based on configuration.
    
    Returns a checkpointer instance for graph compilation.
    """
    from langgraph.checkpoint.memory import MemorySaver
    
    checkpointer_type = config.get("checkpointer", "memory")
    
    if checkpointer_type == CheckpointerType.MEMORY.value:
        return MemorySaver()
    
    elif checkpointer_type == CheckpointerType.SQLITE.value:
        from langgraph.checkpoint.sqlite import SqliteSaver
        import os
        sqlite_path = os.environ.get("NEXUS_SQLITE_PATH", "./nexus_checkpoints.db")
        return SqliteSaver.from_conn_string(sqlite_path)
    
    elif checkpointer_type == CheckpointerType.POSTGRES.value:
        from langgraph.checkpoint.postgres import PostgresSaver
        import os
        postgres_url = os.environ.get("DATABASE_URL")
        if not postgres_url:
            raise ValueError("DATABASE_URL environment variable required for Postgres checkpointer")
        return PostgresSaver.from_conn_string(postgres_url)
    
    else:
        # Default to memory
        return MemorySaver()


def resolve_secrets(config: NexusAgentConfig) -> NexusAgentConfig:
    """
    Resolve ${secrets.VAR} placeholders in MCP server configurations.
    
    Reads from environment variables or a secure vault.
    """
    import os
    import re
    import copy
    
    resolved = copy.deepcopy(config)
    secret_pattern = re.compile(r'\$\{secrets\.(\w+)\}')
    
    def resolve_value(value: str) -> str:
        if not isinstance(value, str):
            return value
        
        def replacer(match):
            secret_name = match.group(1)
            # First try environment variable
            env_value = os.environ.get(secret_name)
            if env_value:
                return env_value
            # Could extend to support vault lookups here
            return match.group(0)  # Leave unresolved if not found
        
        return secret_pattern.sub(replacer, value)
    
    # Resolve secrets in MCP server configs
    for server_name, server_config in resolved.get("mcp_servers", {}).items():
        if "env" in server_config and server_config["env"]:
            for key, value in server_config["env"].items():
                server_config["env"][key] = resolve_value(value)
    
    return resolved
