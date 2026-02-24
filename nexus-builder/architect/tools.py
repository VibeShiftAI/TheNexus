from langchain_core.tools import tool
import os
import re

class ArchitectTools:
    """
    Cartography tools for The Architect.
    """
    
    @staticmethod
    def get_repo_structure(root_path: str) -> str:
        """
        Generates a tree-like structure of the repo.
        """
        structure = []
        for root, dirs, files in os.walk(root_path):
            # Skip hidden dirs
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['node_modules', 'venv', 'pycache']]
            level = root.replace(root_path, '').count(os.sep)
            indent = ' ' * 4 * (level)
            structure.append(f'{indent}{os.path.basename(root)}/')
            subindent = ' ' * 4 * (level + 1)
            for f in files:
                structure.append(f'{subindent}{f}')
        return '\n'.join(structure)

    @staticmethod
    def read_file_signatures(path: str) -> str:
        """
        Reads only class and function definitions from a file to save context.
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Simple regex parser for python/ts signatures
            lines = content.split('\n')
            signatures = []
            for line in lines:
                stripped = line.strip()
                # Python def/class
                if stripped.startswith('def ') or stripped.startswith('class '):
                    signatures.append(line) # Keep indentation
                # TS/JS function/class
                elif stripped.startswith('function ') or stripped.startswith('export class ') or stripped.startswith('interface '):
                    signatures.append(line)
            
            return "\n".join(signatures)
        except Exception as e:
            return f"Error reading file {path}: {e}"

    @staticmethod
    def search_codebase(query: str, root_path: str = ".") -> str:
        """
        Basic grep search for patterns.
        """
        matches = []
        try:
            for root, dirs, files in os.walk(root_path):
                 dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['node_modules', 'venv', '__pycache__']]
                 for file in files:
                    if file.endswith(('.py', '.js', '.ts', '.tsx', '.jsx')):
                        path = os.path.join(root, file)
                        try:
                            with open(path, 'r', encoding='utf-8') as f:
                                for i, line in enumerate(f, 1):
                                    if query in line:
                                        matches.append(f"{path}:{i}: {line.strip()[:100]}")
                                        if len(matches) > 50:
                                            return "\n".join(matches) + "\n... (more matches truncated)"
                        except: continue
            return "\n".join(matches) if matches else "No matches found."
        except Exception as e:
            return f"Search error: {e}"

@tool
def read_file_signatures(path: str) -> str:
    """Read only class and function definitions from a file."""
    return ArchitectTools.read_file_signatures(path)

@tool
def search_codebase(query: str) -> str:
    """Search for string patterns in the codebase."""
    return ArchitectTools.search_codebase(query)
