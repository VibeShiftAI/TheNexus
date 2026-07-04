import ast
import os
import re
from typing import List, Dict, Any, Optional
from langchain_core.tools import tool

class BuilderTools:
    """
    Specialized tools for the Builder Agent.
    Includes AST map generation, surgical file reading, and safe block replacement.
    """

    @staticmethod
    def generate_ast_map(root_dir: str = ".") -> str:
        """
        Generates a lightweight skeleton of the codebase.
        Shows classes/methods/docstrings but HIDES the body code to save tokens.
        """
        skeleton = []
        for root, _, files in os.walk(root_dir):
            for file in files:
                if file.endswith(".py"):
                    path = os.path.join(root, file)
                    # Normalize path for display
                    rel_path = os.path.relpath(path, root_dir)
                    
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            tree = ast.parse(f.read())
                    except Exception:
                        continue 
                    
                    skeleton.append(f"\nFILE: {rel_path}")
                    for node in ast.walk(tree):
                        if isinstance(node, ast.ClassDef):
                            skeleton.append(f"  class {node.name}")
                            # Add methods
                            for item in node.body:
                                if isinstance(item, ast.FunctionDef):
                                    args = [a.arg for a in item.args.args]
                                    skeleton.append(f"    def {item.name}({', '.join(args)})")
                                    if ast.get_docstring(item):
                                        doc = ast.get_docstring(item).split('\n')[0]
                                        skeleton.append(f"      \"\"\"{doc}...\"\"\"")
                        elif isinstance(node, ast.FunctionDef):
                            # Only top-level functions (not methods of classes we just visited)
                            # Simple check: if not indented in our output logic (which is imperfect but sufficient for a map)
                            # Better approach: check indentation or parent. 
                            # For simplicity in this walker, we just list top-levels if we can distinguish, 
                            # but ast.walk is flat.
                            # Let's trust the formatted output implies structure, but ast.walk visits everything.
                            # To do this right, we should visit recursively.
                            pass
        
        # Re-implementing with recursive visitor for better structure
        skeleton = []
        
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
                if ast.get_docstring(node):
                    doc = ast.get_docstring(node).split('\n')[0]
                    self.output.append(f"{'  ' * (self.indent + 1)}\"\"\"{doc}...\"\"\"")
                # Don't visit body of functions to avoid inner functions cluttering map
                
        for root, _, files in os.walk(root_dir):
            for file in files:
                if file.endswith(".py"):
                    try:
                        path = os.path.join(root, file)
                        rel_path = os.path.relpath(path, root_dir)
                        with open(path, "r", encoding="utf-8") as f:
                            tree = ast.parse(f.read())
                        
                        skeleton.append(f"\nFILE: {rel_path}")
                        visitor = MapVisitor()
                        visitor.visit(tree)
                        skeleton.extend(visitor.output)
                    except Exception:
                        continue
                        
        return "\n".join(skeleton)

    @staticmethod
    def read_file_window(path: str, start: int, end: int) -> str:
        """
        Reads a specific window of lines from a file (1-indexed).
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            # Adjust for 0-based indexing
            start_idx = max(0, start - 1)
            end_idx = min(len(lines), end)
            
            target_lines = lines[start_idx:end_idx]
            numbered_lines = []
            for i, line in enumerate(target_lines):
                numbered_lines.append(f"{start + i}: {line}")
                
            return "".join(numbered_lines)
        except Exception as e:
            return f"Error reading file window: {e}"

    @staticmethod
    def find_symbol(path: str, symbol_name: str) -> str:
        """
        Finds the line definition of a class or function symbol in a specific file.
        Returns "Found at line X" or "Not found".
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                tree = ast.parse(f.read())
            
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)):
                    if node.name == symbol_name:
                        return f"Found '{symbol_name}' definition at line {node.lineno}"
            return f"Symbol '{symbol_name}' not found in {path}"
        except Exception as e:
            return f"Error parsing {path}: {e}"

    @staticmethod
    def edit_file_block(path: str, search_block: str, replace_block: str) -> str:
        """
        Replaces a specific block of text in a file.
        Returns success message or error if block not found/unique.
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Normalize line endings
            # search_block_norm = search_block.replace('\r\n', '\n')
            # replace_block_norm = replace_block.replace('\r\n', '\n')
            # content_norm = content.replace('\r\n', '\n')
            
            # Check occurrence count
            count = content.count(search_block)
            
            if count == 0:
                # Try relaxed matching (strip whitespace)
                return f"Error: Search block not found in {path}. Check indentation and exact content."
                
            if count > 1:
                return f"Error: Search block occurs {count} times in {path}. Provide more context to make it unique."
            
            # Perform replacement
            new_content = content.replace(search_block, replace_block)
            
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_content)
                
            return "Successfully replaced code block."
            
        except Exception as e:
            return f"Error editing file: {e}"

    @staticmethod
    def run_syntax_check(path: str) -> str:
        """
        Runs a syntax check (ast.parse) on the file.
        Returns 'Valid Syntax' or error message.
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                ast.parse(f.read())
            return "Valid Syntax"
        except SyntaxError as e:
            return f"SyntaxError: {e.msg} at line {e.lineno}"
        except Exception as e:
            return f"Check Failed: {e}"

    @staticmethod
    def create_file(path: str, content: str) -> str:
        """
        Creates a new file with the given content.
        Creates parent directories if they don't exist.
        """
        try:
            # Create parent directories if needed
            parent_dir = os.path.dirname(path)
            if parent_dir:
                os.makedirs(parent_dir, exist_ok=True)
            
            # Check if file already exists
            if os.path.exists(path):
                return f"Warning: File already exists at {path}. Use edit_file_block to modify existing files."
            
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            
            return f"Successfully created file: {path}"
        except Exception as e:
            return f"Error creating file: {e}"

