"""
Git Tools - Direct access to git history and changes.

Provides tools for inspecting commit history, diffs, and recent changes.
Uses subprocess directly (git is local to the machine).
"""

from typing import Dict, Any
import subprocess
import os

from ..interface import NexusTool, ToolMetadata, ToolCategory


class GitLogTool(NexusTool):
    """View recent git commit history."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="git_log",
            description="View recent git commit history. Returns commit hashes, authors, dates, and messages.",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["git", "history", "commits"],
        )
    
    async def execute(
        self, context: Dict[str, Any], count: int = 20, path: str = None
    ) -> Dict[str, Any]:
        """
        Get recent git commits.
        
        Args:
            context: Execution context with project_root
            count: Number of commits to show (default 20)
            path: Optional file/directory path to filter commits
        
        Returns:
            Dict with success and commit list
        """
        project_root = context.get("project_root", ".")
        
        try:
            cmd = ["git", "log", f"--max-count={min(count, 50)}", 
                   "--format=%H|%an|%ar|%s"]
            if path:
                cmd.extend(["--", path])
            
            result = subprocess.run(
                cmd, cwd=project_root,
                capture_output=True, text=True, timeout=15
            )
            
            if result.returncode != 0:
                return {"success": False, "error": result.stderr.strip()}
            
            commits = []
            for line in result.stdout.strip().split("\n"):
                if "|" in line:
                    parts = line.split("|", 3)
                    if len(parts) == 4:
                        commits.append({
                            "hash": parts[0][:8],
                            "author": parts[1],
                            "date": parts[2],
                            "message": parts[3]
                        })
            
            return {"success": True, "result": commits}
            
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Git command timed out"}
        except Exception as e:
            return {"success": False, "error": str(e)}


class GitDiffTool(NexusTool):
    """Show what files changed recently in git."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="git_diff",
            description="Show files changed in recent commits. Useful for understanding what has been modified recently.",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["git", "diff", "changes"],
        )
    
    async def execute(
        self, context: Dict[str, Any], commits_back: int = 5
    ) -> Dict[str, Any]:
        """
        Show files changed in recent commits.
        
        Args:
            context: Execution context with project_root
            commits_back: How many commits back to diff (default 5)
        
        Returns:
            Dict with success and list of changed files
        """
        project_root = context.get("project_root", ".")
        commits_back = min(commits_back, 20)
        
        try:
            result = subprocess.run(
                ["git", "diff", "--stat", f"HEAD~{commits_back}", "HEAD"],
                cwd=project_root,
                capture_output=True, text=True, timeout=15
            )
            
            if result.returncode != 0:
                return {"success": False, "error": result.stderr.strip()}
            
            return {"success": True, "result": result.stdout.strip()}
            
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Git command timed out"}
        except Exception as e:
            return {"success": False, "error": str(e)}


class GitShowTool(NexusTool):
    """Show the contents of a specific git commit."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="git_show",
            description="Show detailed changes from a specific commit. Use with a commit hash from git_log.",
            category=ToolCategory.RESEARCH,
            can_auto_execute=True,
            requires_permission=False,
            tags=["git", "commit", "show"],
        )
    
    async def execute(
        self, context: Dict[str, Any], commit: str = "HEAD"
    ) -> Dict[str, Any]:
        """
        Show commit details and diff.
        
        Args:
            context: Execution context with project_root
            commit: Commit hash or ref (default HEAD)
        
        Returns:
            Dict with success and commit details
        """
        project_root = context.get("project_root", ".")
        
        try:
            result = subprocess.run(
                ["git", "show", "--stat", commit],
                cwd=project_root,
                capture_output=True, text=True, timeout=15
            )
            
            if result.returncode != 0:
                return {"success": False, "error": result.stderr.strip()}
            
            # Truncate to avoid overwhelming context
            output = result.stdout[:5000]
            return {"success": True, "result": output}
            
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Git command timed out"}
        except Exception as e:
            return {"success": False, "error": str(e)}


def register_tools(registry) -> None:
    """Register all git tools with the registry."""
    registry.register(GitLogTool())
    registry.register(GitDiffTool())
    registry.register(GitShowTool())
