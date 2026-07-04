"""
Security Code Review Agent Node - Specialized agent for security analysis

A specialized GeneralAgentNode with a security-focused system prompt and
tool configuration baked in. Used in the security sweep workflow to analyze
codebases for vulnerabilities before the SecurityTaskCreatorNode generates
remediation tasks.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData
from .general_agent import GeneralAgentNode


SECURITY_SYSTEM_PROMPT = """You are an expert security analyst performing a code review.

You have access to tools for exploring a codebase. Use them to actively inspect files,
search for patterns, and check git history for recent changes.

**Areas to investigate:**
- Exposed secrets, API keys, credentials, or tokens in source code
- Hardcoded passwords or connection strings
- Unsafe use of eval(), exec(), or dynamic code execution
- SQL injection, XSS, or command injection vectors
- Missing input validation on API endpoints or user-facing surfaces
- Insecure file permissions or path traversal risks
- Dependencies with known vulnerabilities (check package.json, requirements.txt)
- Missing security headers (CORS, CSP, rate limiting)
- Debug or test code left in production paths
- Insecure deserialization or unsafe data handling

**Rules:**
- Ground every finding in actual code evidence — cite the file path and relevant code.
- If the codebase is clean, say so. Do NOT fabricate issues.
- Focus on actionable, real vulnerabilities — not theoretical concerns.

**Output Format:**
Return your findings as a JSON array. Each finding should have:
- title: Short descriptive title for a remediation task
- severity: "critical", "high", "medium", or "low"
- category: e.g. "secrets", "injection", "dependencies", "configuration", "input-validation", "access-control"
- description: What the issue is and why it matters
- files: Array of affected file paths
- evidence: The relevant code snippet or pattern found
- remediation: Recommended fix

If no issues are found, return an empty array: []"""


class SecurityCodeReviewNode(GeneralAgentNode):
    """
    Specialized security code review agent.

    Extends GeneralAgentNode with a security-focused system prompt and
    default configuration tuned for thorough security analysis.
    Used in the security-sweep-project workflow.
    """

    type_id = "security_code_review"
    display_name = "Security Code Review"
    description = "AI-powered security audit — scans codebases for vulnerabilities and produces structured findings"
    category = "review"
    icon = "🛡️"
    version = 1.0
    levels = ["project"]

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Max Turns",
                "name": "max_turns",
                "type": "number",
                "default": 25,
                "description": "Maximum reasoning/action turns (security reviews need more depth)",
            },
            {
                "displayName": "Model",
                "name": "model",
                "type": "string",
                "default": "gemini-3-pro-preview",
                "description": "LLM model for security analysis (Pro recommended for thoroughness)",
            },
            {
                "displayName": "Verbose",
                "name": "verbose",
                "type": "boolean",
                "default": True,
                "description": "Log each reasoning step",
            },
        ]

    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Run security code review with baked-in security prompt."""
        from model_config import get_gemini_flash
        from langchain_core.messages import HumanMessage

        max_turns = ctx.get_node_parameter("max_turns", 25)
        model_name = ctx.get_node_parameter("model", "gemini-3-pro-preview")
        verbose = ctx.get_node_parameter("verbose", True)

        # Build context from upstream (e.g. codebase_explorer)
        upstream_context = self._build_upstream_context(items)

        # Get project_root
        project_root = (
            ctx.get_node_parameter("project_root", "") or
            ctx.get_node_parameter("project_path", "") or
            "."
        )

        run_id = ctx.get_node_parameter("run_id", "") or ""
        if not run_id and items:
            run_id = items[0].json.get("context", {}).get("run_id", "")
        log_tag = f"[SecurityReview][{run_id[:8]}]" if run_id else "[SecurityReview]"

        if verbose:
            print(f"{log_tag} Starting security code review")
            print(f"{log_tag} Project root: {project_root}")

        # Get project_id for tools
        project_id = ctx.project_id or ""
        tools = self._get_tools(self.DEFAULT_TOOLS, project_root, project_id)

        # Build the security-aware system prompt with project path injected
        system_prompt = f"""{SECURITY_SYSTEM_PROMPT}

The project is located at: {project_root}

**Strategy:**
1. FIRST call get_project_context to understand the project
2. Call explore_codebase to get the full file tree
3. Use read_multiple_files to batch-read configuration files, auth modules, and API routes
4. Use search_codebase to grep for dangerous patterns (eval, exec, password, secret, API_KEY, token, etc.)
5. Use git_log/git_diff to check for recently introduced changes
6. Produce your structured JSON findings

When using file tools, use paths relative to the project root.
Be thorough — minimize false positives by grounding every finding in actual code evidence."""

        user_prompt = f"""Perform a comprehensive security code review of this project.

**Context from previous analysis:**
{upstream_context or "None available — use tools to explore the codebase."}

Scan the codebase thoroughly and return your findings as a JSON array."""

        try:
            llm = get_gemini_flash(temperature=0.3)

            if tools:
                result = await self._run_react_agent(
                    llm, tools, system_prompt, user_prompt,
                    max_turns, verbose, log_tag
                )
            else:
                result = await self._run_single_turn(
                    llm, system_prompt, user_prompt, verbose
                )

            if verbose:
                print(f"{log_tag} Review complete: {len(result)} chars")

            return [[NodeExecutionData(
                json={
                    "task": "Security Code Review",
                    "result": result,
                    "turns_used": max_turns,
                    "max_turns": max_turns,
                    "model": model_name,
                }
            )]]

        except Exception as e:
            print(f"{log_tag} ERROR: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            return [[NodeExecutionData(
                json={"error": str(e), "task": "Security Code Review"},
                error=e
            )]]


__all__ = ["SecurityCodeReviewNode"]
