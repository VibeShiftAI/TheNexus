"""
Context Loader - Shared utility for loading project context files.

Extracted from supervisor/agent.py for use by standalone AtomicNodes.
This allows agents to work independently when dragged onto a blank canvas.
"""

import os
from typing import Optional


def read_project_contexts(project_path: str) -> str:
    """
    Read all context markdown files from the project's supervisor/ directory.
    
    Args:
        project_path: Absolute path to the project root
        
    Returns:
        Combined markdown string with all context files
    """
    if not project_path or project_path == ".":
        return ""
        
    context_parts = []
    
    # Standard context files (The Nexus "Soul" documents)
    context_files = [
        "product.md",
        "tech-stack.md",
        "product-guidelines.md", 
        "workflow.md"
    ]
    
    supervisor_dir = os.path.join(project_path, "supervisor")
    
    if os.path.exists(supervisor_dir):
        for filename in context_files:
            file_path = os.path.join(supervisor_dir, filename)
            if os.path.exists(file_path):
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        # Format with a header
                        title = filename.replace('.md', '').replace('-', ' ').title()
                        context_parts.append(f"## {title}\n\n{content}")
                except Exception as e:
                    print(f"[ContextLoader] Error reading {filename}: {e}")
                    
    return "\n\n".join(context_parts)


def get_repo_structure(project_path: str, max_depth: int = 3) -> str:
    """
    Generate a file tree structure of the project.
    
    Args:
        project_path: Absolute path to the project root
        max_depth: Maximum directory depth to traverse
        
    Returns:
        String representation of the file tree
    """
    if not project_path or project_path == "." or not os.path.exists(project_path):
        return ""
    
    lines = []
    
    def walk_dir(path: str, prefix: str = "", depth: int = 0):
        if depth > max_depth:
            return
            
        try:
            entries = sorted(os.listdir(path))
        except PermissionError:
            return
            
        # Filter out common non-essential directories
        skip_dirs = {'.git', '__pycache__', 'node_modules', 'venv', '.venv', 'dist', 'build', '.next'}
        entries = [e for e in entries if e not in skip_dirs]
        
        for i, entry in enumerate(entries):
            is_last = i == len(entries) - 1
            connector = "└── " if is_last else "├── "
            full_path = os.path.join(path, entry)
            
            if os.path.isdir(full_path):
                lines.append(f"{prefix}{connector}{entry}/")
                new_prefix = prefix + ("    " if is_last else "│   ")
                walk_dir(full_path, new_prefix, depth + 1)
            else:
                lines.append(f"{prefix}{connector}{entry}")
    
    lines.append(os.path.basename(project_path) + "/")
    walk_dir(project_path)
    
    return "\n".join(lines[:200])  # Limit output size
