from typing import List, Literal, Optional
from langchain_core.tools import tool
from pydantic import BaseModel, Field
import subprocess
import os

class AuditorTools:
    """
    Forensic Tool Belt for The Auditor.
    Allows adversarial probing and impact inspection.
    """

    @staticmethod
    def write_dry_run_test(test_code: str, filename: str = "dry_run_test.py") -> str:
        """
        Writes a temporary test script to target a specific edge case.
        Uses a dedicated temp directory to avoid triggering uvicorn hot-reload.
        """
        try:
            import tempfile
            # Use system temp dir so file changes don't trigger uvicorn's WatchFiles
            temp_dir = os.path.join(tempfile.gettempdir(), "nexus_audit")
            os.makedirs(temp_dir, exist_ok=True)
            filepath = os.path.join(temp_dir, filename)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(test_code)
            return f"Successfully wrote test to {filepath}"
        except Exception as e:
            return f"Error writing test file: {e}"

    @staticmethod
    def run_sandbox_cmd(cmd: str, timeout: int = 30, cwd: str = None) -> str:
        """
        Executes a command in a sandboxed environment (simulated locally for now).
        Used to run existing tests or dry-run scripts.
        """
        try:
            # Check for dangerous commands (simple heuristic)
            forbidden = ["rm -rf", "delete", "drop table"]
            if any(f in cmd.lower() for f in forbidden):
                return "Error: Command rejected by safety filter."
            
            # Execute in the project directory if provided
            result = subprocess.run(
                cmd, 
                shell=True, 
                capture_output=True, 
                text=True, 
                timeout=timeout,
                cwd=cwd or None
            )
            
            output = result.stdout
            if result.stderr:
                output += f"\nSTDERR:\n{result.stderr}"
                
            return f"Command: {cmd}\nExit Code: {result.returncode}\nOutput:\n{output}"
            
        except subprocess.TimeoutExpired:
            return f"Command timed out after {timeout} seconds."
        except Exception as e:
            return f"Execution error: {e}"

    @staticmethod
    def read_reference_file(path: str) -> str:
        """
        Reads a file to verify APIs or imports.
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
            # Could implement windowing here too if files are huge, 
            # but Auditor usually needs full file context for dependencies.
        except Exception as e:
            return f"Error reading file {path}: {e}"
        
# --- STRUCTURED OUTPUT ---

class BlockingIssue(BaseModel):
    """A specific issue that must be fixed, with file and line evidence."""
    file: str = Field(description="Absolute path to the file containing the issue")
    line: Optional[int] = Field(default=None, description="Line number where the issue occurs, or null if file-level")
    description: str = Field(description="What is wrong and how to fix it")

class AuditVerdict(BaseModel):
    """The final verdict of the audit session."""
    status: Literal["APPROVED", "REJECTED"] = Field(description="Final decision: APPROVED if safe, REJECTED if bugs found.")
    security_score: int = Field(description="1-10 scale. 10 is perfectly secure/robust.")
    blocking_issues: List[BlockingIssue] = Field(description="List of specific bugs with file path, line number, and description. Each issue MUST reference a real file.")
    reasoning: str = Field(description="Detailed explanation of the verdict.")

# --- TOOL BINDINGS ---

@tool
def write_dry_run_test(test_code: str) -> str:
    """
    Writes a temporary python test script to verify an edge case.
    Use this to 'prove' a bug exists.
    """
    return AuditorTools.write_dry_run_test(test_code)

@tool
def run_sandbox_cmd(command: str) -> str:
    """
    Runs a shell command to execute tests or scripts.
    Example: 'python dry_run_test.py' or 'pytest tests/test_auth.py'
    """
    return AuditorTools.run_sandbox_cmd(command)

@tool
def read_reference_file(path: str) -> str:
    """
    Reads a file from the repository to check usage/imports of changed code.
    """
    return AuditorTools.read_reference_file(path)

# Verify verdict isn't bound as a tool function, but passed as a response model or bound tool-class
# In LangChain/LangGraph, binding the Pydantic model class usually works for structured output extraction.
