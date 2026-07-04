"""
File Editing Tools - Safe file creation and surgical editing.

Migrated from:
- python/builder/tools.py (BuilderTools class)
- python/builder/agent.py inline tools

These tools enable agents to safely edit files with
uniqueness checks and syntax validation.
"""

from typing import Dict, Any
import ast
import os

from ..interface import NexusTool, ToolMetadata, ToolCategory


class ReadFileWindowTool(NexusTool):
    """Read a specific window of lines from a file."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="read_file_window",
            description="Read a specific range of lines from a file (1-indexed).",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=True,
            requires_permission=False,
            tags=["file", "read", "lines"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str, start: int, end: int
    ) -> Dict[str, Any]:
        """
        Read lines from file.
        
        Args:
            context: Execution context
            path: Path to file
            start: Start line (1-indexed)
            end: End line (1-indexed, inclusive)
            
        Returns:
            Dict with success and line content
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            start_idx = max(0, start - 1)
            end_idx = min(len(lines), end)
            
            target_lines = lines[start_idx:end_idx]
            numbered = [f"{start + i}: {line}" for i, line in enumerate(target_lines)]
            
            return {"success": True, "result": "".join(numbered)}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class FindSymbolTool(NexusTool):
    """Find the line number of a class or function definition."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="find_symbol",
            description="Find the line number where a class or function is defined.",
            category=ToolCategory.CODE_ANALYSIS,
            can_auto_execute=True,
            requires_permission=False,
            tags=["ast", "symbol", "find"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str, symbol_name: str
    ) -> Dict[str, Any]:
        """
        Find symbol definition.
        
        Args:
            context: Execution context
            path: Path to file
            symbol_name: Name of class/function to find
            
        Returns:
            Dict with success and line number
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                tree = ast.parse(f.read())
            
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)):
                    if node.name == symbol_name:
                        return {
                            "success": True,
                            "result": f"Found '{symbol_name}' at line {node.lineno}"
                        }
            
            return {
                "success": True,
                "result": f"Symbol '{symbol_name}' not found in {path}"
            }
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class EditFileBlockTool(NexusTool):
    """Replace a specific block of text in a file."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="edit_file_block",
            description="Replace a specific block of text in a file. Block must be unique.",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=False,  # Destructive
            requires_permission=True,
            tags=["file", "edit", "replace"],
        )
    
    async def execute(
        self, context: Dict[str, Any], 
        path: str, 
        search_block: str, 
        replace_block: str
    ) -> Dict[str, Any]:
        """
        Replace text block in file.
        
        Args:
            context: Execution context
            path: Path to file
            search_block: Exact text to find and replace
            replace_block: Replacement text
            
        Returns:
            Dict with success or error
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            count = content.count(search_block)
            
            if count == 0:
                return {
                    "success": False,
                    "error": f"Search block not found in {path}. Check indentation."
                }
            
            if count > 1:
                return {
                    "success": False,
                    "error": f"Search block occurs {count} times. Provide more context."
                }
            
            new_content = content.replace(search_block, replace_block)
            
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            return {"success": True, "result": "Successfully replaced code block."}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class CreateFileTool(NexusTool):
    """Create a new file with specified content."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="create_file",
            description="Create a new file with content. Creates parent directories as needed.",
            category=ToolCategory.FILESYSTEM,
            can_auto_execute=False,  # Creates files
            requires_permission=True,
            tags=["file", "create", "write"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str, content: str
    ) -> Dict[str, Any]:
        """
        Create new file.
        
        Args:
            context: Execution context
            path: Path to new file
            content: File content
            
        Returns:
            Dict with success or error
        """
        try:
            parent_dir = os.path.dirname(path)
            if parent_dir:
                os.makedirs(parent_dir, exist_ok=True)
            
            if os.path.exists(path):
                # If file exists with identical content, report success (idempotent)
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        existing = f.read()
                    if existing.strip() == content.strip():
                        return {
                            "success": True,
                            "result": f"File already exists at {path} with correct content. No changes needed."
                        }
                except Exception:
                    pass  # Fall through to error
                return {
                    "success": False,
                    "error": f"File already exists at {path}. Use edit_file_block to modify existing files."
                }
            
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            
            return {"success": True, "result": f"Created file: {path}"}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


class RunSyntaxCheckTool(NexusTool):
    """Run a syntax check on a Python file."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="run_syntax_check",
            description="Verify Python syntax by attempting to parse the file.",
            category=ToolCategory.CODE_ANALYSIS,
            can_auto_execute=True,
            requires_permission=False,
            tags=["syntax", "check", "python"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str
    ) -> Dict[str, Any]:
        """
        Check file syntax.
        
        Args:
            context: Execution context
            path: Path to Python file
            
        Returns:
            Dict with success and validation result
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                ast.parse(f.read())
            return {"success": True, "result": "Valid Syntax"}
        except SyntaxError as e:
            return {
                "success": True,
                "result": f"SyntaxError: {e.msg} at line {e.lineno}"
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


def register_tools(registry) -> None:
    """Register all file editing tools with the registry."""
    registry.register(ReadFileWindowTool())
    registry.register(FindSymbolTool())
    registry.register(EditFileBlockTool())
    registry.register(CreateFileTool())
    registry.register(RunSyntaxCheckTool())
