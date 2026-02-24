"""
Tool Bridge - Python wrappers for Node.js tools

This module provides Python functions that call the Node.js tool endpoints,
allowing LangGraph nodes to use the same tools as the JavaScript agents.
"""

import os
import httpx
from typing import Optional, Dict, Any, List

# Node.js backend URL
NODEJS_URL = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")


class ToolBridge:
    """
    Bridge to Node.js tool endpoints.
    Provides async methods for file operations, commands, and search.
    """
    
    def __init__(self, base_url: str = None):
        self.base_url = base_url or NODEJS_URL
        self._client = None
    
    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client
    
    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
    
    # ═══════════════════════════════════════════════════════════════
    # FILE OPERATIONS
    # ═══════════════════════════════════════════════════════════════
    
    async def read_file(self, path: str) -> Dict[str, Any]:
        """
        Read a file's contents.
        
        Args:
            path: Absolute or relative path to the file
            
        Returns:
            Dict with 'success', 'content', 'path', 'size'
        """
        response = await self.client.get(
            f"{self.base_url}/api/tools/read-file",
            params={"path": path}
        )
        return response.json()
    
    async def write_file(
        self, 
        path: str, 
        content: str, 
        create_dirs: bool = True
    ) -> Dict[str, Any]:
        """
        Write content to a file.
        
        Args:
            path: Absolute or relative path to the file
            content: File content to write
            create_dirs: Whether to create parent directories
            
        Returns:
            Dict with 'success', 'path', 'size'
        """
        response = await self.client.post(
            f"{self.base_url}/api/tools/write-file",
            json={"path": path, "content": content, "createDirs": create_dirs}
        )
        return response.json()
    
    async def list_directory(
        self, 
        path: str, 
        recursive: bool = False
    ) -> Dict[str, Any]:
        """
        List contents of a directory.
        
        Args:
            path: Path to the directory
            recursive: Whether to list recursively
            
        Returns:
            Dict with 'success', 'path', 'items' (list of files/dirs)
        """
        response = await self.client.get(
            f"{self.base_url}/api/tools/list-dir",
            params={"path": path, "recursive": str(recursive).lower()}
        )
        return response.json()
    
    # ═══════════════════════════════════════════════════════════════
    # COMMAND EXECUTION
    # ═══════════════════════════════════════════════════════════════
    
    async def run_command(
        self, 
        command: str, 
        cwd: Optional[str] = None,
        timeout: int = 30000
    ) -> Dict[str, Any]:
        """
        Run a shell command.
        
        Args:
            command: The command to execute
            cwd: Working directory (optional)
            timeout: Timeout in milliseconds
            
        Returns:
            Dict with 'success', 'command', 'output', 'stderr', 'error'
        """
        response = await self.client.post(
            f"{self.base_url}/api/tools/run-command",
            json={"command": command, "cwd": cwd, "timeout": timeout}
        )
        return response.json()
    
    # ═══════════════════════════════════════════════════════════════
    # SEARCH
    # ═══════════════════════════════════════════════════════════════
    
    async def search(
        self, 
        pattern: str, 
        directory: str,
        case_sensitive: bool = False
    ) -> Dict[str, Any]:
        """
        Search for a pattern in files.
        
        Args:
            pattern: Regex pattern to search for
            directory: Directory to search in
            case_sensitive: Whether search is case-sensitive
            
        Returns:
            Dict with 'success', 'matches' (list of {file, line, content})
        """
        response = await self.client.post(
            f"{self.base_url}/api/tools/search",
            json={
                "pattern": pattern, 
                "directory": directory, 
                "caseSensitive": case_sensitive
            }
        )
        return response.json()
    
    # ═══════════════════════════════════════════════════════════════
    # PROJECT CONTEXT
    # ═══════════════════════════════════════════════════════════════
    
    async def get_project_context(self, project_path: str) -> Dict[str, Any]:
        """
        Get AI-ready context for a project.
        
        Args:
            project_path: Path to the project
            
        Returns:
            Dict with project structure, tech stack, etc.
        """
        response = await self.client.get(
            f"{self.base_url}/api/tools/project-context",
            params={"projectPath": project_path}
        )
        return response.json()
    
    # ═══════════════════════════════════════════════════════════════
    # GIT OPERATIONS (via existing endpoints)
    # ═══════════════════════════════════════════════════════════════
    
    async def git_status(self, project_id: str) -> Dict[str, Any]:
        """
        Get git status for a project.
        
        Args:
            project_id: The project ID
            
        Returns:
            Dict with git status info
        """
        response = await self.client.get(
            f"{self.base_url}/api/projects/{project_id}/status"
        )
        return response.json()
    
    async def git_commit(
        self, 
        project_id: str, 
        message: str
    ) -> Dict[str, Any]:
        """
        Commit changes in a project.
        
        Args:
            project_id: The project ID
            message: Commit message
            
        Returns:
            Dict with commit result
        """
        response = await self.client.post(
            f"{self.base_url}/api/projects/{project_id}/commit",
            json={"message": message}
        )
        return response.json()
    
    # ═══════════════════════════════════════════════════════════════
    # SURGICAL TOOLS (Adversarial Mesh Architecture)
    # ═══════════════════════════════════════════════════════════════
    
    async def generate_ast_map(self, path: str) -> Dict[str, Any]:
        """
        Generate an AST map with class/method definitions (bodies stripped).
        Used by Architect Fleet to ingest entire project structure in one context window.
        
        Args:
            path: Path to a file or directory to analyze
            
        Returns:
            Dict with 'success', 'ast_map' (list of definitions with signatures only)
        """
        import ast
        import os
        
        try:
            ast_entries = []
            
            # Handle single file or directory
            if os.path.isfile(path):
                files_to_process = [path]
            else:
                files_to_process = []
                for root, dirs, files in os.walk(path):
                    # Skip common non-source directories
                    dirs[:] = [d for d in dirs if d not in ['node_modules', 'venv', '.git', '__pycache__', '.next', 'dist', 'build']]
                    for f in files:
                        if f.endswith(('.py', '.js', '.ts', '.tsx', '.jsx')):
                            files_to_process.append(os.path.join(root, f))
            
            for file_path in files_to_process[:100]:  # Limit to 100 files
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                    
                    if file_path.endswith('.py'):
                        # Python AST parsing
                        tree = ast.parse(content)
                        for node in ast.walk(tree):
                            if isinstance(node, ast.ClassDef):
                                methods = []
                                for item in node.body:
                                    if isinstance(item, ast.FunctionDef):
                                        args = ', '.join(arg.arg for arg in item.args.args)
                                        methods.append(f"  def {item.name}({args})")
                                ast_entries.append({
                                    "file": file_path,
                                    "type": "class",
                                    "name": node.name,
                                    "line": node.lineno,
                                    "signature": f"class {node.name}:",
                                    "methods": methods
                                })
                            elif isinstance(node, ast.FunctionDef) and not isinstance(getattr(node, 'parent', None), ast.ClassDef):
                                # Top-level function
                                args = ', '.join(arg.arg for arg in node.args.args)
                                ast_entries.append({
                                    "file": file_path,
                                    "type": "function",
                                    "name": node.name,
                                    "line": node.lineno,
                                    "signature": f"def {node.name}({args}):"
                                })
                    else:
                        # For JS/TS, use regex-based extraction (simplified)
                        import re
                        # Match class definitions
                        for match in re.finditer(r'(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?', content):
                            ast_entries.append({
                                "file": file_path,
                                "type": "class",
                                "name": match.group(1),
                                "line": content[:match.start()].count('\n') + 1,
                                "signature": match.group(0)
                            })
                        # Match function definitions
                        for match in re.finditer(r'(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)', content):
                            ast_entries.append({
                                "file": file_path,
                                "type": "function",
                                "name": match.group(1),
                                "line": content[:match.start()].count('\n') + 1,
                                "signature": match.group(0)
                            })
                except Exception as e:
                    # Skip files that can't be parsed
                    continue
            
            return {
                "success": True,
                "ast_map": ast_entries,
                "files_analyzed": len(files_to_process)
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def read_file_window(
        self, 
        path: str, 
        start_line: int, 
        end_line: int
    ) -> Dict[str, Any]:
        """
        Read a specific window of lines from a file.
        Used by Builder Fleet to prevent context pollution on large files.
        
        Args:
            path: Path to the file
            start_line: First line to read (1-indexed)
            end_line: Last line to read (1-indexed, inclusive)
            
        Returns:
            Dict with 'success', 'content', 'lines_read', 'total_lines'
        """
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                all_lines = f.readlines()
            
            total_lines = len(all_lines)
            
            # Clamp to valid range
            start_idx = max(0, start_line - 1)
            end_idx = min(total_lines, end_line)
            
            selected_lines = all_lines[start_idx:end_idx]
            
            # Add line numbers for context
            numbered_content = ""
            for i, line in enumerate(selected_lines, start=start_idx + 1):
                numbered_content += f"{i}: {line}"
            
            return {
                "success": True,
                "content": numbered_content,
                "lines_read": len(selected_lines),
                "total_lines": total_lines,
                "range": f"{start_idx + 1}-{end_idx}"
            }
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def generate_blast_radius(
        self, 
        diff: str, 
        project_path: str
    ) -> Dict[str, Any]:
        """
        Analyze a diff to find dependent files that might be affected.
        Used by Auditor Fleet to assess impact of changes.
        
        Args:
            diff: Git diff or patch content
            project_path: Root path of the project for import analysis
            
        Returns:
            Dict with 'success', 'changed_files', 'dependent_files', 'risk_level'
        """
        import re
        import os
        
        try:
            # 1. Extract changed files and symbols from diff
            changed_files = set()
            changed_symbols = set()
            
            # Parse diff for file names
            for match in re.finditer(r'^(?:\+\+\+|---)\s+[ab]/(.+)$', diff, re.MULTILINE):
                changed_files.add(match.group(1))
            
            # Parse diff for changed function/class names
            for match in re.finditer(r'^[+-]\s*(?:def|class|function|const|let|var|export)\s+(\w+)', diff, re.MULTILINE):
                changed_symbols.add(match.group(1))
            
            # 2. Find files that import/reference the changed files or symbols
            dependent_files = set()
            
            if project_path and os.path.isdir(project_path):
                for root, dirs, files in os.walk(project_path):
                    dirs[:] = [d for d in dirs if d not in ['node_modules', 'venv', '.git', '__pycache__', '.next', 'dist', 'build']]
                    for f in files:
                        if f.endswith(('.py', '.js', '.ts', '.tsx', '.jsx')):
                            file_path = os.path.join(root, f)
                            rel_path = os.path.relpath(file_path, project_path)
                            
                            # Skip if this is one of the changed files
                            if rel_path in changed_files:
                                continue
                                
                            try:
                                with open(file_path, 'r', encoding='utf-8', errors='ignore') as handle:
                                    content = handle.read()
                                
                                # Check for imports of changed files
                                for cf in changed_files:
                                    module_name = os.path.splitext(os.path.basename(cf))[0]
                                    if module_name in content:
                                        dependent_files.add(rel_path)
                                        break
                                
                                # Check for usage of changed symbols
                                for symbol in changed_symbols:
                                    if re.search(rf'\b{re.escape(symbol)}\b', content):
                                        dependent_files.add(rel_path)
                                        break
                            except:
                                continue
            
            # 3. Calculate risk level
            total_impact = len(changed_files) + len(dependent_files)
            if total_impact <= 3:
                risk_level = "low"
            elif total_impact <= 10:
                risk_level = "medium"
            else:
                risk_level = "high"
            
            return {
                "success": True,
                "changed_files": list(changed_files),
                "changed_symbols": list(changed_symbols),
                "dependent_files": list(dependent_files)[:50],  # Limit output
                "risk_level": risk_level,
                "total_blast_radius": total_impact
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


# Global instance for convenience
_bridge: Optional[ToolBridge] = None


def get_tool_bridge() -> ToolBridge:
    """Get the global ToolBridge instance."""
    global _bridge
    if _bridge is None:
        _bridge = ToolBridge()
    return _bridge


# ═══════════════════════════════════════════════════════════════
# LANGCHAIN TOOL WRAPPERS
# These can be used directly as LangChain tools
# ═══════════════════════════════════════════════════════════════

from langchain_core.tools import tool


@tool
async def read_file(path: str) -> str:
    """Read the contents of a file at the given path."""
    bridge = get_tool_bridge()
    result = await bridge.read_file(path)
    if result.get("success"):
        return result["content"]
    else:
        return f"Error reading file: {result.get('error', 'Unknown error')}"


@tool
async def write_file(path: str, content: str) -> str:
    """Write content to a file at the given path."""
    bridge = get_tool_bridge()
    result = await bridge.write_file(path, content)
    if result.get("success"):
        return f"Successfully wrote {result['size']} characters to {result['path']}"
    else:
        return f"Error writing file: {result.get('error', 'Unknown error')}"


@tool
async def list_directory(path: str) -> str:
    """List the contents of a directory."""
    bridge = get_tool_bridge()
    result = await bridge.list_directory(path)
    if result.get("success"):
        items = result.get("items", [])
        lines = [f"{'[D]' if i['type'] == 'directory' else '[F]'} {i['name']}" for i in items]
        return "\n".join(lines) if lines else "Directory is empty"
    else:
        return f"Error listing directory: {result.get('error', 'Unknown error')}"


@tool
async def run_command(command: str, cwd: str = None) -> str:
    """Run a shell command. Use cwd to specify working directory."""
    bridge = get_tool_bridge()
    result = await bridge.run_command(command, cwd)
    if result.get("success"):
        return result.get("output", "Command completed with no output")
    else:
        error_msg = result.get("error", "Unknown error")
        stderr = result.get("stderr", "")
        return f"Command failed: {error_msg}\n{stderr}"


@tool
async def search_files(pattern: str, directory: str) -> str:
    """Search for a pattern in files within a directory."""
    bridge = get_tool_bridge()
    result = await bridge.search(pattern, directory)
    if result.get("success"):
        matches = result.get("matches", [])
        if not matches:
            return "No matches found"
        lines = [f"{m['file']}:{m['line']}: {m['content']}" for m in matches[:20]]
        return "\n".join(lines)
    else:
        return f"Error searching: {result.get('error', 'Unknown error')}"


# ═══════════════════════════════════════════════════════════════
# SURGICAL TOOLS - LangChain Wrappers (Adversarial Mesh)
# ═══════════════════════════════════════════════════════════════

@tool
async def ast_map(path: str) -> str:
    """
    Generate an AST map showing class/method definitions with signatures only (bodies stripped).
    Ideal for understanding project structure without context pollution.
    """
    bridge = get_tool_bridge()
    result = await bridge.generate_ast_map(path)
    if result.get("success"):
        entries = result.get("ast_map", [])
        if not entries:
            return "No classes or functions found"
        lines = []
        for entry in entries[:50]:  # Limit output
            if entry.get("methods"):
                methods_str = "\n".join(entry["methods"])
                lines.append(f"{entry['file']}:{entry['line']} {entry['signature']}\n{methods_str}")
            else:
                lines.append(f"{entry['file']}:{entry['line']} {entry['signature']}")
        return f"Analyzed {result.get('files_analyzed', 0)} files:\n\n" + "\n\n".join(lines)
    else:
        return f"Error generating AST map: {result.get('error', 'Unknown error')}"


@tool
async def file_window(path: str, start_line: int, end_line: int) -> str:
    """
    Read a specific window of lines from a file.
    Prevents context pollution when working with large files.
    """
    bridge = get_tool_bridge()
    result = await bridge.read_file_window(path, start_line, end_line)
    if result.get("success"):
        return f"Lines {result['range']} of {result['total_lines']}:\n{result['content']}"
    else:
        return f"Error reading file window: {result.get('error', 'Unknown error')}"


@tool
async def blast_radius(diff: str, project_path: str) -> str:
    """
    Analyze a diff to find dependent files that might be affected by the changes.
    Returns changed files, impacted symbols, and risk assessment.
    """
    bridge = get_tool_bridge()
    result = await bridge.generate_blast_radius(diff, project_path)
    if result.get("success"):
        output = f"Risk Level: {result['risk_level'].upper()}\n"
        output += f"Total Blast Radius: {result['total_blast_radius']} files\n\n"
        output += f"Changed Files: {', '.join(result['changed_files']) or 'None detected'}\n"
        output += f"Changed Symbols: {', '.join(result['changed_symbols']) or 'None detected'}\n"
        output += f"Dependent Files: {', '.join(result['dependent_files'][:10]) or 'None found'}"
        if len(result['dependent_files']) > 10:
            output += f" ... and {len(result['dependent_files']) - 10} more"
        return output
    else:
        return f"Error analyzing blast radius: {result.get('error', 'Unknown error')}"


# Export all tools as a list for easy integration
LANGGRAPH_TOOLS = [read_file, write_file, list_directory, run_command, search_files]

# Surgical tools for Adversarial Mesh architecture
SURGICAL_TOOLS = [ast_map, file_window, blast_radius]

# Combined tools list
ALL_TOOLS = LANGGRAPH_TOOLS + SURGICAL_TOOLS

