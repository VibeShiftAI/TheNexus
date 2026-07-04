"""
Codebase Explorer Node - Fast codebase exploration

Finds files by patterns, searches code for keywords, answers questions about the codebase.
Supports thoroughness levels: "quick", "medium", "very_thorough"
"""

import os
import glob
import subprocess
from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class CodebaseExplorerNode(AtomicNode):
    """
    Fast codebase exploration - finding files, searching code, answering questions.
    
    Inspired by Claude Code's Explore sub-agent.
    Supports thoroughness levels matching Claude: quick, medium, very_thorough
    """
    
    type_id = "codebase_explorer"
    display_name = "Codebase Explorer"
    description = "Fast codebase exploration - find files, search code, map structure"
    category = "research"
    icon = "🔍"
    version = 1.0
    levels = ["project", "feature"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Query",
                "name": "query",
                "type": "string",
                "default": "",
                "description": "What to search for (file pattern, code keyword, or question)",
                "required": True,
            },
            {
                "displayName": "Search Type",
                "name": "search_type",
                "type": "options",
                "default": "auto",
                "options": [
                    {"name": "Auto-detect", "value": "auto"},
                    {"name": "File Pattern (glob)", "value": "glob"},
                    {"name": "Code Search (grep)", "value": "grep"},
                    {"name": "Structure Map", "value": "structure"},
                ],
                "description": "Type of search to perform",
            },
            {
                "displayName": "Thoroughness",
                "name": "thoroughness",
                "type": "options",
                "default": "medium",
                "options": [
                    {"name": "Quick", "value": "quick"},
                    {"name": "Medium", "value": "medium"},
                    {"name": "Very Thorough", "value": "very_thorough"},
                ],
                "description": "How deep to search (affects time and completeness)",
            },
            {
                "displayName": "Max Results",
                "name": "max_results",
                "type": "number",
                "default": 50,
                "description": "Maximum number of results to return",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute codebase exploration."""
        
        query = ctx.get_node_parameter("query", "")
        search_type = ctx.get_node_parameter("search_type", "auto")
        thoroughness = ctx.get_node_parameter("thoroughness", "medium")
        max_results = ctx.get_node_parameter("max_results", 50)
        
        # Allow query from input
        if not query and items:
            query = items[0].json.get("query", "")
        
        if not query:
            return [[NodeExecutionData(
                json={"error": "No query specified"},
                error=Exception("No query specified")
            )]]
        
        # Get project root
        try:
            global_ctx = ctx.get_global_context()
            project_root = global_ctx.get_project_path() or os.getcwd()
        except:
            project_root = os.getcwd()
        
        # Thoroughness config
        depth_config = {
            "quick": {"max_depth": 3, "max_files": 20},
            "medium": {"max_depth": 6, "max_files": 50},
            "very_thorough": {"max_depth": 15, "max_files": 200},
        }
        config = depth_config.get(thoroughness, depth_config["medium"])
        
        # Auto-detect search type
        if search_type == "auto":
            if "*" in query or "?" in query or query.startswith("."):
                search_type = "glob"
            elif query in ["structure", "map", "tree", "overview"]:
                search_type = "structure"
            else:
                search_type = "grep"
        
        results = []
        
        try:
            if search_type == "glob":
                results = await self._glob_search(project_root, query, config, max_results)
            elif search_type == "grep":
                results = await self._grep_search(project_root, query, config, max_results)
            elif search_type == "structure":
                results = await self._structure_map(project_root, config)
            
            return [[NodeExecutionData(
                json={
                    "query": query,
                    "search_type": search_type,
                    "thoroughness": thoroughness,
                    "project_root": project_root,
                    "result_count": len(results),
                    "results": results,
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e), "query": query},
                error=e
            )]]
    
    async def _glob_search(self, root: str, pattern: str, config: dict, max_results: int) -> List[Dict]:
        """Find files matching glob pattern."""
        results = []
        
        # Make pattern recursive if needed
        if not pattern.startswith("**"):
            pattern = f"**/{pattern}"
        
        for path in glob.iglob(os.path.join(root, pattern), recursive=True):
            if len(results) >= max_results:
                break
            
            rel_path = os.path.relpath(path, root)
            
            # Skip common ignore patterns
            if any(ignore in rel_path for ignore in [".git", "node_modules", "__pycache__", ".venv", "venv"]):
                continue
            
            try:
                stat = os.stat(path)
                results.append({
                    "path": rel_path,
                    "type": "directory" if os.path.isdir(path) else "file",
                    "size": stat.st_size if os.path.isfile(path) else None,
                })
            except:
                pass
        
        return results
    
    async def _grep_search(self, root: str, query: str, config: dict, max_results: int) -> List[Dict]:
        """Search code for keyword matches."""
        results = []
        
        try:
            # Use ripgrep if available, fallback to grep
            cmd = f'rg -n -i --max-count=5 --max-depth={config["max_depth"]} "{query}"'
            result = subprocess.run(
                cmd,
                shell=True,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            for line in result.stdout.split("\n")[:max_results]:
                if ":" in line:
                    parts = line.split(":", 2)
                    if len(parts) >= 3:
                        results.append({
                            "file": parts[0],
                            "line": int(parts[1]) if parts[1].isdigit() else 0,
                            "content": parts[2].strip()[:200],
                        })
        except subprocess.TimeoutExpired:
            results.append({"error": "Search timed out"})
        except Exception as e:
            # Fallback to basic grep
            try:
                cmd = f'grep -rn -i --include="*.py" --include="*.js" --include="*.ts" --include="*.tsx" "{query}"'
                result = subprocess.run(
                    cmd, shell=True, cwd=root, 
                    capture_output=True, text=True, timeout=30
                )
                for line in result.stdout.split("\n")[:max_results]:
                    if ":" in line:
                        parts = line.split(":", 2)
                        if len(parts) >= 3:
                            results.append({
                                "file": parts[0],
                                "line": int(parts[1]) if parts[1].isdigit() else 0,
                                "content": parts[2].strip()[:200],
                            })
            except:
                pass
        
        return results
    
    async def _structure_map(self, root: str, config: dict) -> List[Dict]:
        """Generate codebase structure map."""
        structure = []
        
        for dirpath, dirnames, filenames in os.walk(root):
            # Respect max depth
            depth = dirpath.replace(root, "").count(os.sep)
            if depth > config["max_depth"]:
                continue
            
            # Skip ignore patterns
            dirnames[:] = [d for d in dirnames if d not in [".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build"]]
            
            rel_path = os.path.relpath(dirpath, root)
            if rel_path == ".":
                rel_path = ""
            
            # Count significant files
            code_files = [f for f in filenames if f.endswith((".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java"))]
            
            if code_files or depth <= 2:
                structure.append({
                    "path": rel_path or "/",
                    "depth": depth,
                    "file_count": len(filenames),
                    "code_files": len(code_files),
                    "subdirs": len(dirnames),
                })
        
        return structure[:config["max_files"]]


__all__ = ["CodebaseExplorerNode"]
