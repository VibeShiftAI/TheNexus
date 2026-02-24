"""
Bash Executor Node - Command execution specialist

Runs shell commands for git operations, builds, and terminal tasks.
"""

import subprocess
import os
from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class BashExecutorNode(AtomicNode):
    """
    Command execution specialist for git, builds, and terminal operations.
    
    Inspired by Claude Code's Bash sub-agent.
    """
    
    type_id = "bash_executor"
    display_name = "Bash Executor"
    description = "Command execution specialist for git, builds, and terminal tasks"
    category = "utility"
    icon = "💻"
    version = 1.0
    levels = ["project", "feature"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Command",
                "name": "command",
                "type": "string",
                "default": "",
                "description": "Shell command to execute",
                "required": True,
            },
            {
                "displayName": "Working Directory",
                "name": "cwd",
                "type": "string",
                "default": "",
                "description": "Working directory for command execution (empty = project root)",
            },
            {
                "displayName": "Timeout (seconds)",
                "name": "timeout",
                "type": "number",
                "default": 60,
                "description": "Maximum execution time in seconds",
            },
            {
                "displayName": "Capture Output",
                "name": "capture_output",
                "type": "boolean",
                "default": True,
                "description": "Capture stdout/stderr for downstream nodes",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute shell command."""
        
        command = ctx.get_node_parameter("command", "")
        cwd = ctx.get_node_parameter("cwd", "")
        timeout = ctx.get_node_parameter("timeout", 60)
        capture_output = ctx.get_node_parameter("capture_output", True)
        
        # Allow command from input if not set in parameters
        if not command and items:
            command = items[0].json.get("command", "")
        
        if not command:
            return [[NodeExecutionData(
                json={"error": "No command specified"},
                error=Exception("No command specified")
            )]]
        
        # Resolve working directory
        if not cwd:
            # Try to get from global context
            try:
                global_ctx = ctx.get_global_context()
                cwd = global_ctx.get_project_path() or os.getcwd()
            except:
                cwd = os.getcwd()
        
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=cwd,
                capture_output=capture_output,
                text=True,
                timeout=timeout
            )
            
            return [[NodeExecutionData(
                json={
                    "command": command,
                    "exit_code": result.returncode,
                    "stdout": result.stdout if capture_output else "",
                    "stderr": result.stderr if capture_output else "",
                    "success": result.returncode == 0,
                    "cwd": cwd,
                }
            )]]
            
        except subprocess.TimeoutExpired:
            return [[NodeExecutionData(
                json={
                    "command": command,
                    "error": f"Command timed out after {timeout}s",
                    "success": False,
                },
                error=Exception(f"Timeout after {timeout}s")
            )]]
        except Exception as e:
            return [[NodeExecutionData(
                json={
                    "command": command,
                    "error": str(e),
                    "success": False,
                },
                error=e
            )]]


__all__ = ["BashExecutorNode"]
