"""
Subagent Tools - Meta-tools that may spawn sub-LLM calls.

Migrated from:
- python/builder/agent.py inline tools (run_bash_command, explore_codebase)

These are "meta-tools" that may invoke additional LLM reasoning
or spawn external processes.
"""

from typing import Dict, Any
import subprocess
import os

from ..interface import NexusTool, ToolMetadata, ToolCategory


class RunBashCommandTool(NexusTool):
    """Run a bash command with timeout and working directory."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="run_bash_command",
            description="Run a shell command with timeout. Use for builds, tests, etc.",
            category=ToolCategory.COMMAND,
            can_auto_execute=False,  # Dangerous
            requires_permission=True,
            tags=["bash", "shell", "command"],
        )
    
    async def execute(
        self, context: Dict[str, Any], 
        command: str, 
        cwd: str = None, 
        timeout: int = 60
    ) -> Dict[str, Any]:
        """
        Execute bash command.
        
        Args:
            context: Execution context with project_root
            command: Command to run
            cwd: Working directory (defaults to project_root)
            timeout: Timeout in seconds
            
        Returns:
            Dict with success and output/error
        """
        work_dir = cwd or context.get("project_root", ".")
        
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            
            output = result.stdout
            if result.returncode != 0:
                output += f"\n[STDERR]: {result.stderr}"
            
            return {
                "success": result.returncode == 0,
                "result": output[:10000],  # Limit output
                "return_code": result.returncode
            }
            
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": f"Command timed out after {timeout}s"
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


class ExploreCodebaseTool(NexusTool):
    """Explore the codebase structure with configurable thoroughness."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="explore_codebase",
            description="Explore codebase structure. Returns file tree and key signatures.",
            category=ToolCategory.SUBAGENT,
            can_auto_execute=True,
            requires_permission=False,
            tags=["explore", "structure", "tree"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        query: str = None,
        search_type: str = "auto",
        thoroughness: str = "medium"
    ) -> Dict[str, Any]:
        """
        Explore codebase.
        
        Args:
            context: Execution context with project_root
            query: Optional search query
            search_type: "tree", "search", or "auto"
            thoroughness: "minimal", "medium", "thorough"
            
        Returns:
            Dict with success and exploration results
        """
        root = context.get("project_root", ".")
        output = []
        
        try:
            # Get directory tree
            if search_type in ("tree", "auto"):
                depth_map = {"minimal": 1, "medium": 2, "thorough": 4}
                max_depth = depth_map.get(thoroughness, 2)
                
                output.append("## Directory Structure\n")
                for root_dir, dirs, files in os.walk(root):
                    # Calculate depth
                    depth = root_dir.replace(root, '').count(os.sep)
                    if depth > max_depth:
                        continue
                    
                    # Skip common non-source dirs
                    dirs[:] = [d for d in dirs if d not in [
                        ".git", "__pycache__", "node_modules", "venv", ".next"
                    ]]
                    
                    indent = "  " * depth
                    rel_path = os.path.relpath(root_dir, root)
                    output.append(f"{indent}{rel_path}/")
                    
                    for file in files[:10]:  # Limit files per dir
                        output.append(f"{indent}  {file}")
            
            # Search if query provided
            if query and search_type in ("search", "auto"):
                output.append(f"\n## Search Results for '{query}'\n")
                for root_dir, _, files in os.walk(root):
                    if any(skip in root_dir for skip in [".git", "__pycache__", "node_modules"]):
                        continue
                    for file in files:
                        if query.lower() in file.lower():
                            output.append(f"- {os.path.relpath(os.path.join(root_dir, file), root)}")
            
            return {"success": True, "result": "\n".join(output[:200])}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class CreateSubplanTool(NexusTool):
    """Create a detailed execution plan for a sub-task."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="create_subplan",
            description="Create a structured execution plan for a complex sub-task.",
            category=ToolCategory.SUBAGENT,
            can_auto_execute=True,
            requires_permission=False,
            tags=["plan", "task", "subtask"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        task_description: str,
        constraints: str = None
    ) -> Dict[str, Any]:
        """
        Create execution subplan.
        
        Args:
            context: Execution context
            task_description: Description of the sub-task
            constraints: Optional constraints/requirements
            
        Returns:
            Dict with success and plan structure
        """
        # This is a placeholder - in real usage this would invoke an LLM
        # to generate a detailed plan based on context
        plan = {
            "task": task_description,
            "constraints": constraints or "None specified",
            "steps": [
                "1. Analyze requirements",
                "2. Identify affected files",
                "3. Implement changes",
                "4. Verify syntax",
                "5. Test changes"
            ],
            "estimated_complexity": "medium"
        }
        
        return {"success": True, "result": plan}


def register_tools(registry) -> None:
    """Register all subagent tools with the registry."""
    registry.register(RunBashCommandTool())
    registry.register(ExploreCodebaseTool())
    registry.register(CreateSubplanTool())
