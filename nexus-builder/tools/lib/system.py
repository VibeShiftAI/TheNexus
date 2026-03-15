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
        import os
        
        # Resolve relative paths using project_root
        project_root = context.get("project_root", ".")
        if not os.path.isabs(path):
            path = os.path.join(project_root, path)
        
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
        import os
        
        # Resolve relative paths using project_root
        project_root = context.get("project_root", ".")
        if not os.path.isabs(path):
            path = os.path.join(project_root, path)
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{NODEJS_URL}/api/tools/list-dir",
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
        import os
        
        base_path = path or context.get("project_root", ".")
        if not os.path.isabs(base_path):
            base_path = os.path.join(context.get("project_root", "."), base_path)
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{NODEJS_URL}/api/tools/search",
                    json={"pattern": query, "directory": base_path}
                )
                return resp.json()
        except Exception as e:
            return {"success": False, "error": str(e)}


class GetProjectContextTool(NexusTool):
    """Get all .context/ documentation for a project."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="get_project_context",
            description="Get all existing .context/ documentation files for the project (product vision, tech-stack, guidelines, architecture, etc.). Returns the full content of all context documents concatenated together. Use this FIRST to understand what documentation already exists. No arguments needed.",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["context", "documentation", "project"],
        )
    
    async def execute(
        self, context: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Fetch all context documents for a project.
        Uses project_root from injected context (no args needed from LLM).
        """
        import httpx
        
        project_root = context.get("project_root", "")
        if not project_root:
            return {"success": False, "error": "No project_root in context"}
        
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{NODEJS_URL}/api/tools/project-context",
                    params={"projectPath": project_root}
                )
                
                if resp.status_code != 200:
                    return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
                
                data = resp.json()
                
                # Format the response into readable text
                parts = []
                
                # The endpoint returns structured data, format it
                for key, value in data.items():
                    if key == "error":
                        continue
                    if isinstance(value, str) and value.strip():
                        parts.append(f"## {key}\n{value}")
                    elif isinstance(value, dict) and value:
                        parts.append(f"## {key}\n{_format_dict(value)}")
                    elif isinstance(value, list) and value:
                        parts.append(f"## {key}\n" + "\n".join(f"- {item}" for item in value))
                
                if not parts:
                    return {"success": True, "result": "No .context/ documentation found."}
                
                return {"success": True, "result": "\n\n".join(parts)}
                
        except Exception as e:
            return {"success": False, "error": str(e)}


class ReadMultipleFilesTool(NexusTool):
    """Read multiple files in a single tool call to reduce round-trips."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="read_multiple_files",
            description="Read multiple files at once. Pass a comma-separated list of paths. Returns all contents with clear delimiters. Much more efficient than reading files one at a time.",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=True,
            requires_permission=False,
            tags=["file", "read", "batch", "filesystem"],
        )
    
    async def execute(
        self, context: Dict[str, Any], paths: str
    ) -> Dict[str, Any]:
        """
        Read multiple files in one call.
        
        Args:
            context: Execution context (project_root, etc.)
            paths: Comma-separated list of file paths to read
            
        Returns:
            Dict with success/result containing all file contents
        """
        import httpx
        import os
        
        project_root = context.get("project_root", ".")
        path_list = [p.strip() for p in paths.split(",") if p.strip()]
        
        if not path_list:
            return {"success": False, "error": "No paths provided"}
        
        if len(path_list) > 10:
            return {"success": False, "error": "Maximum 10 files per batch"}
        
        results = []
        total_chars = 0
        max_chars = 50000  # Prevent context explosion
        
        for file_path in path_list:
            if not os.path.isabs(file_path):
                file_path = os.path.join(project_root, file_path)
            
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    resp = await client.get(
                        f"{NODEJS_URL}/api/tools/read-file",
                        params={"path": file_path}
                    )
                    data = resp.json()
                    
                    if data.get("success"):
                        content = data.get("content", "")
                        remaining = max_chars - total_chars
                        if remaining <= 0:
                            results.append(f"\n--- FILE: {file_path} ---\n[SKIPPED: output limit reached]\n")
                            continue
                        if len(content) > remaining:
                            content = content[:remaining] + "\n... [TRUNCATED]"
                        total_chars += len(content)
                        results.append(f"\n--- FILE: {file_path} ---\n{content}\n--- END FILE ---")
                    else:
                        results.append(f"\n--- FILE: {file_path} ---\n[ERROR: {data.get('error', 'Could not read')}]\n--- END FILE ---")
            except Exception as e:
                results.append(f"\n--- FILE: {file_path} ---\n[ERROR: {e}]\n--- END FILE ---")
        
        return {"success": True, "result": "\n".join(results)}


def _format_dict(d, indent=0):
    """Helper to format nested dicts for readability."""
    lines = []
    prefix = "  " * indent
    for k, v in d.items():
        if isinstance(v, dict):
            lines.append(f"{prefix}{k}:")
            lines.append(_format_dict(v, indent + 1))
        elif isinstance(v, list):
            lines.append(f"{prefix}{k}: {', '.join(str(item) for item in v)}")
        else:
            lines.append(f"{prefix}{k}: {v}")
    return "\n".join(lines)


def register_tools(registry) -> None:
    """Register all system tools with the registry."""
    registry.register(ReadFileTool())
    registry.register(WriteFileTool())
    registry.register(RunCommandTool())
    registry.register(ListDirectoryTool())
    registry.register(SearchFilesTool())
    registry.register(GetProjectContextTool())
    registry.register(ReadMultipleFilesTool())
