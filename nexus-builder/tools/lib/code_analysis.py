"""
Code Analysis Tools - AST parsing, symbol search, and codebase exploration.

Migrated from:
- python/architect/tools.py (ArchitectTools class)

These tools enable agents to understand code structure without
reading entire files, saving context tokens.
"""

from typing import Dict, Any
import ast
import os
import re
import glob

from ..interface import NexusTool, ToolMetadata, ToolCategory


class ReadFileSignaturesTool(NexusTool):
    """Read only class and function definitions from a file."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="read_file_signatures",
            description="Read only class and function definitions from a file to save context.",
            category=ToolCategory.CODE_ANALYSIS,
            can_auto_execute=True,
            requires_permission=False,
            tags=["ast", "signature", "code"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str
    ) -> Dict[str, Any]:
        """
        Extract class/function signatures from file.
        
        Args:
            context: Execution context
            path: Path to Python file
            
        Returns:
            Dict with success and signatures
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                source = f.read()
            
            tree = ast.parse(source)
            signatures = []
            
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    bases = [ast.unparse(b) for b in node.bases] if node.bases else []
                    signatures.append(
                        f"class {node.name}({', '.join(bases)}):  # Line {node.lineno}"
                    )
                    # Add method signatures
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            prefix = "async def" if isinstance(item, ast.AsyncFunctionDef) else "def"
                            args_str = self._format_args(item.args)
                            signatures.append(
                                f"    {prefix} {item.name}({args_str}):  # Line {item.lineno}"
                            )
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    # Top-level functions only (skip if inside class)
                    if hasattr(node, '_parent') and isinstance(node._parent, ast.ClassDef):
                        continue
                    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
                    args_str = self._format_args(node.args)
                    signatures.append(
                        f"{prefix} {node.name}({args_str}):  # Line {node.lineno}"
                    )
            
            return {"success": True, "result": "\n".join(signatures)}
            
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def _format_args(self, args: ast.arguments) -> str:
        """Format function arguments to string."""
        parts = [a.arg for a in args.args]
        return ", ".join(parts)


class SearchCodebaseTool(NexusTool):
    """Search for patterns in the codebase."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="search_codebase",
            description="Search for string patterns in the codebase using regex or literal match.",
            category=ToolCategory.CODE_ANALYSIS,
            can_auto_execute=True,
            requires_permission=False,
            tags=["search", "grep", "code"],
        )
    
    async def execute(
        self, context: Dict[str, Any], query: str, path: str = None
    ) -> Dict[str, Any]:
        """
        Search codebase for pattern.
        
        Args:
            context: Execution context with project_root
            query: Search pattern (regex supported)
            path: Base path (defaults to project_root)
            
        Returns:
            Dict with success and list of matches
        """
        base_path = path or context.get("project_root", ".")
        
        # Directories to exclude (build artifacts, deps, caches)
        EXCLUDED_DIRS = {
            ".git", "__pycache__", "node_modules", "venv", "dist",
            ".next", "build", "coverage", ".turbo", ".vercel", ".cache"
        }
        
        try:
            pattern = re.compile(query, re.IGNORECASE)
            matches = []
            
            # Walk through source files
            for root, dirs, files in os.walk(base_path):
                # Prune excluded directories in-place to prevent descent
                dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
                
                for file in files:
                    if file.endswith((".py", ".js", ".ts", ".jsx", ".tsx")):
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                                for i, line in enumerate(f, 1):
                                    if pattern.search(line):
                                        rel_path = os.path.relpath(file_path, base_path)
                                        matches.append({
                                            "file": rel_path,
                                            "line": i,
                                            "content": line.strip()[:200]
                                        })
                        except Exception:
                            continue
            
            # Limit results
            return {"success": True, "result": matches[:50]}
            
        except re.error as e:
            return {"success": False, "error": f"Invalid regex: {e}"}
        except Exception as e:
            return {"success": False, "error": str(e)}


class GenerateAstMapTool(NexusTool):
    """Generate a lightweight skeleton of the codebase structure."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="generate_ast_map",
            description="Generate a lightweight skeleton of the codebase showing classes/methods.",
            category=ToolCategory.CODE_ANALYSIS,
            can_auto_execute=True,
            requires_permission=False,
            tags=["ast", "map", "structure"],
        )
    
    async def execute(
        self, context: Dict[str, Any], path: str = None
    ) -> Dict[str, Any]:
        """
        Generate codebase skeleton.
        
        Args:
            context: Execution context with project_root
            path: Base path (defaults to project_root)
            
        Returns:
            Dict with success and skeleton map
        """
        root_dir = path or context.get("project_root", ".")
        
        class MapVisitor(ast.NodeVisitor):
            def __init__(self):
                self.output = []
                self.indent = 0
            
            def visit_ClassDef(self, node):
                self.output.append(f"{'  ' * self.indent}class {node.name}")
                self.indent += 1
                self.generic_visit(node)
                self.indent -= 1
            
            def visit_FunctionDef(self, node):
                args = [a.arg for a in node.args.args]
                self.output.append(f"{'  ' * self.indent}def {node.name}({', '.join(args)})")
            
            def visit_AsyncFunctionDef(self, node):
                args = [a.arg for a in node.args.args]
                self.output.append(f"{'  ' * self.indent}async def {node.name}({', '.join(args)})")
        
        skeleton = []
        EXCLUDED_DIRS = {
            ".git", "__pycache__", "node_modules", "venv", "dist",
            ".next", "build", "coverage", ".turbo", ".vercel", ".cache"
        }
        
        try:
            for root, dirs, files in os.walk(root_dir):
                # Prune excluded directories in-place to prevent descent
                dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
                    
                for file in files:
                    if file.endswith(".py"):
                        try:
                            file_path = os.path.join(root, file)
                            rel_path = os.path.relpath(file_path, root_dir)
                            with open(file_path, "r", encoding="utf-8") as f:
                                tree = ast.parse(f.read())
                            
                            skeleton.append(f"\nFILE: {rel_path}")
                            visitor = MapVisitor()
                            visitor.visit(tree)
                            skeleton.extend(visitor.output)
                        except Exception:
                            continue
            
            return {"success": True, "result": "\n".join(skeleton)}
            
        except Exception as e:
            return {"success": False, "error": str(e)}


def register_tools(registry) -> None:
    """Register all code analysis tools with the registry."""
    registry.register(ReadFileSignaturesTool())
    registry.register(SearchCodebaseTool())
    registry.register(GenerateAstMapTool())
