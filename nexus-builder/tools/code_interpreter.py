"""
CodeInterpreter Tool - Secure code execution for AI agents.

Executes Python/Node.js/R/Bash code in a network-isolated Docker sandbox.
"""

import base64
import os
from typing import Optional

import httpx
from langchain_core.tools import tool


SANDBOX_API_URL = os.getenv("SANDBOX_API_URL", "http://localhost:8765")


class SandboxError(Exception):
    """Raised when sandbox execution fails."""
    pass


class SandboxClient:
    """Client for the Sandbox Execution API."""
    
    def __init__(self, base_url: str = SANDBOX_API_URL):
        self.base_url = base_url
        self._session_id: Optional[str] = None
    
    async def _ensure_session(self) -> str:
        """Ensure we have an active session, creating one if needed."""
        if self._session_id:
            return self._session_id
        
        async with httpx.AsyncClient() as client:
            response = await client.post(f"{self.base_url}/sessions")
            response.raise_for_status()
            data = response.json()
            self._session_id = data["id"]
            return self._session_id
    
    async def execute(
        self,
        code: str,
        language: str = "python",
        timeout: int = 30,
        requirements: Optional[list[str]] = None,
    ) -> dict:
        """Execute code in the sandbox."""
        session_id = await self._ensure_session()
        
        async with httpx.AsyncClient(timeout=timeout + 10) as client:
            response = await client.post(
                f"{self.base_url}/sessions/{session_id}/execute",
                json={
                    "code": code,
                    "language": language,
                    "timeout": timeout,
                    "requirements": requirements or [],
                },
            )
            response.raise_for_status()
            return response.json()


# Global client instance
_client: Optional[SandboxClient] = None

def _get_client() -> SandboxClient:
    global _client
    if _client is None:
        _client = SandboxClient()
    return _client


@tool
async def execute_python(
    code: str,
    requirements: Optional[list[str]] = None,
    timeout: int = 30,
) -> str:
    """
    Execute Python code in a secure, network-isolated sandbox.
    
    Use this tool when you need to:
    - Run calculations or data analysis
    - Process data with pandas/numpy
    - Create visualizations (matplotlib - images auto-captured)
    - Test code snippets
    
    Security: The sandbox only allows connections to PyPI, GitHub, and npm.
    Installed packages persist across calls in the same session.
    
    Args:
        code: Python code to execute
        requirements: Optional pip packages to install (e.g., ["scikit-learn"])
        timeout: Max execution time in seconds (1-300, default 30)
        
    Returns:
        stdout if successful, or error message if failed.
        If code generates images, they are captured and returned as base64.
        
    Examples:
        >>> execute_python("print(sum(range(100)))")
        "4950"
        
        >>> execute_python("import numpy as np; print(np.mean([1,2,3]))")
        "2.0"
    """
    try:
        client = _get_client()
        result = await client.execute(
            code=code,
            language="python",
            timeout=min(timeout, 300),
            requirements=requirements,
        )
        
        if result.get("status") == "completed" and result.get("exit_code") == 0:
            output_parts = []
            
            # Add stdout
            stdout = result.get("stdout", "").strip()
            if stdout:
                output_parts.append(stdout)
            
            # Add captured images
            images = result.get("images", [])
            if images:
                output_parts.append(f"\n📊 {len(images)} image(s) captured:")
                for img in images:
                    output_parts.append(f"  - {img['name']}")
            
            return "\n".join(output_parts) or "(no output)"
            
        elif result.get("status") == "timeout":
            return f"⏱️ Execution timed out after {timeout}s"
        else:
            stderr = result.get("stderr", "").strip()
            error = result.get("error", "Unknown error")
            return f"❌ Error (exit {result.get('exit_code', '?')}):\n{stderr or error}"
            
    except httpx.HTTPStatusError as e:
        return f"🔧 Sandbox API error: {e.response.status_code}"
    except httpx.RequestError as e:
        return f"🔧 Sandbox unavailable: {e}"


@tool
async def execute_nodejs(
    code: str,
    timeout: int = 30,
) -> str:
    """
    Execute JavaScript/Node.js code in a secure sandbox.
    
    Use for Node.js-specific tasks, npm package testing, or JS snippets.
    
    Args:
        code: JavaScript code to execute
        timeout: Max execution time (1-300 seconds)
        
    Returns:
        stdout or error message
    """
    try:
        client = _get_client()
        result = await client.execute(
            code=code,
            language="nodejs",
            timeout=min(timeout, 300),
        )
        
        if result.get("status") == "completed" and result.get("exit_code") == 0:
            return result.get("stdout", "").strip() or "(no output)"
        else:
            return f"❌ Error:\n{result.get('stderr', result.get('error', 'Unknown'))}"
            
    except Exception as e:
        return f"🔧 Error: {e}"


@tool
async def execute_r(
    code: str,
    timeout: int = 60,
) -> str:
    """
    Execute R code in a secure sandbox.
    
    Pre-installed: tidyverse, ggplot2, jsonlite.
    
    Args:
        code: R code to execute
        timeout: Max execution time (1-300 seconds)
        
    Returns:
        stdout or error message
    """
    try:
        client = _get_client()
        result = await client.execute(
            code=code,
            language="r",
            timeout=min(timeout, 300),
        )
        
        if result.get("status") == "completed" and result.get("exit_code") == 0:
            output_parts = []
            stdout = result.get("stdout", "").strip()
            if stdout:
                output_parts.append(stdout)
            
            images = result.get("images", [])
            if images:
                output_parts.append(f"\n📊 {len(images)} plot(s) captured")
            
            return "\n".join(output_parts) or "(no output)"
        else:
            return f"❌ Error:\n{result.get('stderr', result.get('error', 'Unknown'))}"
            
    except Exception as e:
        return f"🔧 Error: {e}"


@tool
async def execute_bash(
    command: str,
    timeout: int = 30,
) -> str:
    """
    Execute a bash command in a secure sandbox.
    
    Use for shell operations, file manipulation, or running CLI tools.
    
    Args:
        command: Bash command to execute
        timeout: Max execution time (1-300 seconds)
        
    Returns:
        stdout or error message
    """
    try:
        client = _get_client()
        result = await client.execute(
            code=command,
            language="bash",
            timeout=min(timeout, 300),
        )
        
        if result.get("status") == "completed" and result.get("exit_code") == 0:
            return result.get("stdout", "").strip() or "(no output)"
        else:
            return f"❌ Error (exit {result.get('exit_code')}):\n{result.get('stderr', 'Unknown')}"
            
    except Exception as e:
        return f"🔧 Error: {e}"


# Export tools for registration
TOOLS = [execute_python, execute_nodejs, execute_r, execute_bash]


async def check_sandbox_health() -> bool:
    """Check if sandbox API is available."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{SANDBOX_API_URL}/health")
            return response.status_code == 200
    except Exception:
        return False
