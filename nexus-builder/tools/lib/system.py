"""
System Tools - Node.js Bridge tools for file operations and commands.

Migrated from: python/tools.py (ToolBridge class)

These tools proxy to the Node.js backend for filesystem operations,
providing a secure bridge between Python agents and the filesystem.
"""

from typing import Dict, Any
import os

from ..interface import NexusTool, ToolMetadata, ToolCategory

# Node.js backend URL from environment
NODEJS_URL = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")


class ReadFileTool(NexusTool):
    """Read file contents via Node.js backend."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="read_file",
            description="Read the contents of a file at the given path.",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=True,
            requires_permission=False,
            tags=["file", "read", "filesystem"],
        )
    
    async def execute(self, context: Dict[str, Any], path: str) -> Dict[str, Any]:
        """
        Read file contents.
        
        Args:
            context: Execution context (project_root, etc.)
            path: Path to file to read
            
        Returns:
            Dict with success/result or error
        """
        import httpx
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{NODEJS_URL}/api/tools/read-file",
                    params={"path": path}
                )
                return resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}


class WriteFileTool(NexusTool):
    """Write content to a file via Node.js backend."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="write_file",
            description="Write content to a file, creating parent directories if needed.",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=False,  # Destructive
            requires_permission=True,
            tags=["file", "write", "filesystem"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str, content: str
    ) -> Dict[str, Any]:
        """
        Write content to file.
        
        Args:
            context: Execution context
            path: Path to file to write
            content: Content to write
            
        Returns:
            Dict with success/result or error
        """
        import httpx
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{NODEJS_URL}/api/tools/write-file",
                    json={"path": path, "content": content, "createDirs": True}
                )
                return resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}


class RunCommandTool(NexusTool):
    """Run a shell command via Node.js backend."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="run_command",
            description="Run a shell command in the project directory.",
            category=ToolCategory.COMMAND,
            can_auto_execute=False,  # Dangerous
            requires_permission=True,
            estimated_cost="low",
            tags=["command", "shell", "bash"],
        )
    
    async def execute(
        self, context: Dict[str, Any], command: str, cwd: str = None
    ) -> Dict[str, Any]:
        """
        Execute shell command.
        
        Args:
            context: Execution context with project_root
            command: Command to run
            cwd: Working directory (defaults to project_root from context)
            
        Returns:
            Dict with success/result or error
        """
        import httpx
        
        work_dir = cwd or context.get("project_root")
        
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{NODEJS_URL}/api/tools/run-command",
                    json={"command": command, "cwd": work_dir}
                )
                return resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}


class ListDirectoryTool(NexusTool):
    """List directory contents via Node.js backend."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="list_directory",
            description="List files and subdirectories in a directory.",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=True,
            requires_permission=False,
            tags=["file", "directory", "filesystem"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str
    ) -> Dict[str, Any]:
        """
        List directory contents.
        
        Args:
            context: Execution context
            path: Path to directory
            
        Returns:
            Dict with success/result or error
        """
        import httpx
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{NODEJS_URL}/api/tools/list-directory",
                    params={"path": path}
                )
                return resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}


class SearchFilesTool(NexusTool):
    """Search for files matching a pattern."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="search_files",
            description="Search for files matching a glob pattern or containing text.",
            category=ToolCategory.SEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["search", "grep", "find"],
        )
    
    async def execute(
        self, context: Dict[str, Any], query: str, path: str = None
    ) -> Dict[str, Any]:
        """
        Search for files.
        
        Args:
            context: Execution context with project_root
            query: Search query (glob or text)
            path: Base path (defaults to project_root)
            
        Returns:
            Dict with success/result or error
        """
        import httpx
        
        base_path = path or context.get("project_root", ".")
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{NODEJS_URL}/api/tools/search-files",
                    params={"query": query, "path": base_path}
                )
                return resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}


def register_tools(registry) -> None:
    """Register all system tools with the registry."""
    registry.register(ReadFileTool())
    registry.register(WriteFileTool())
    registry.register(RunCommandTool())
    registry.register(ListDirectoryTool())
    registry.register(SearchFilesTool())
