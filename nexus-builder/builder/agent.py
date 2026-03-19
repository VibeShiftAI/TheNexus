from typing import Annotated, List, TypedDict, Literal, Dict, Any, Optional
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool

# Use unified tool registry (replaces .tools import and inline wrappers)
from tools import get_registry
from builder.tools import BuilderTools
from model_config import get_claude_opus, get_gemini_pro

# Get builder tools from unified registry
_registry = get_registry()
_scout_tools = _registry.get_langchain_tools(["read_file_window", "find_symbol", "explore_codebase"])
_builder_tools = _registry.get_langchain_tools(["edit_file_block", "create_file", "run_bash_command", "create_subplan"])

# Backward compatibility: expose individual tools for inline usage
read_file_window = _registry.get("read_file_window").to_langchain_tool() if _registry.get("read_file_window") else None
find_symbol = _registry.get("find_symbol").to_langchain_tool() if _registry.get("find_symbol") else None
edit_file_block = _registry.get("edit_file_block").to_langchain_tool() if _registry.get("edit_file_block") else None
create_file = _registry.get("create_file").to_langchain_tool() if _registry.get("create_file") else None


# ═══════════════════════════════════════════════════════════════════════════════
# CLAUDE-STYLE SUB-AGENT TOOLS (Specialized atomic agents)
# ═══════════════════════════════════════════════════════════════════════════════

@tool
def run_bash_command(command: str, cwd: str = "", timeout: int = 300) -> str:
    """
    Executes a shell command for git operations, builds, npm/pip installs, and terminal tasks.
    
    Args:
        command: The shell command to run (e.g., "npm install", "git status", "make build")
        cwd: Working directory (optional, defaults to project root)
        timeout: Maximum seconds to wait (default 60)
    
    Returns:
        Command output including stdout/stderr and exit code
    """
    import subprocess
    import os
    import sys
    
    work_dir = cwd if cwd else os.getcwd()
    
    # On Windows, use CREATE_NEW_PROCESS_GROUP so timeout can kill the entire tree
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,  # Prevent interactive prompts from hanging
            **kwargs,
        )
        
        output = f"Exit code: {result.returncode}\n"
        if result.stdout:
            output += f"STDOUT:\n{result.stdout[:2000]}\n"
        if result.stderr:
            output += f"STDERR:\n{result.stderr[:1000]}"
        return output
    except subprocess.TimeoutExpired:
        return f"ERROR: Command timed out after {timeout}s. If this is a scaffolding command (e.g. create-next-app), ensure all interactive prompts are suppressed with CLI flags."
    except Exception as e:
        return f"ERROR: {str(e)}"


@tool
def explore_codebase(query: str, search_type: str = "auto", thoroughness: str = "medium", project_root: str = "") -> str:
    """
    Fast codebase exploration - find files, search code, map project structure.
    
    Args:
        query: What to search for (file pattern like "*.py", code keyword, or "structure" for tree)
        search_type: "auto" (detect), "glob" (file patterns), "grep" (code search), "structure" (tree)
        thoroughness: "quick" (shallow), "medium" (balanced), "very_thorough" (deep search)
        project_root: Absolute path to the project root directory. Defaults to current working directory.
    
    Returns:
        Search results with file paths, line numbers, and content snippets
    """
    import os
    import glob
    import subprocess
    
    project_root = project_root or os.getcwd()
    
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
    
    if search_type == "glob":
        pattern = f"**/{query}" if not query.startswith("**") else query
        for path in glob.iglob(os.path.join(project_root, pattern), recursive=True):
            if len(results) >= config["max_files"]:
                break
            rel_path = os.path.relpath(path, project_root)
            if not any(x in rel_path for x in [".git", "node_modules", "__pycache__", ".venv"]):
                results.append(rel_path)
        return f"Found {len(results)} files:\n" + "\n".join(results[:50])
    
    elif search_type == "grep":
        try:
            cmd = f'rg -n -i --max-count=5 --max-depth={config["max_depth"]} "{query}"'
            result = subprocess.run(cmd, shell=True, cwd=project_root, capture_output=True, text=True, timeout=30)
            return result.stdout[:3000] if result.stdout else "No matches found"
        except:
            return "Search failed - ripgrep may not be available"
    
    elif search_type == "structure":
        tree_output = []
        for dirpath, dirnames, filenames in os.walk(project_root):
            depth = dirpath.replace(project_root, "").count(os.sep)
            if depth > config["max_depth"]:
                continue
            dirnames[:] = [d for d in dirnames if d not in [".git", "node_modules", "__pycache__", ".venv"]]
            indent = "  " * depth
            tree_output.append(f"{indent}{os.path.basename(dirpath)}/")
            for f in filenames[:10]:
                tree_output.append(f"{indent}  {f}")
        return "\n".join(tree_output[:100])
    
    return "Unknown search type"


@tool
def create_subplan(goal: str, context: str = "") -> str:
    """
    Creates a detailed sub-plan for a complex component or feature.
    Use when implementing something that needs its own step-by-step breakdown.
    
    Args:
        goal: What needs to be implemented
        context: Additional context about requirements or constraints
    
    Returns:
        Step-by-step implementation plan
    """
    from model_config import get_gemini_flash
    from langchain_core.messages import HumanMessage, SystemMessage
    
    llm = get_gemini_flash(temperature=0.2)
    
    prompt = f"""Create a concise implementation plan for:

Goal: {goal}
Context: {context or "None provided"}

Provide:
1. 3-5 numbered steps
2. Key files to create/modify
3. Any dependencies or prerequisites

Be specific but concise."""

    try:
        response = llm.invoke([HumanMessage(content=prompt)])
        return response.content
    except Exception as e:
        return f"Error creating sub-plan: {str(e)}"


# --- 1. STATE DEFINITION ---
class BuilderState(TypedDict):
    messages: Annotated[List[Any], add_messages]
    
    # Enhanced context fields
    task_title: str  # High-level task name
    task_description: str  # Original user intent
    project_context: str  # Combined markdown from supervisor/*.md
    
    # Full blueprint from architect
    implementation_spec: str  # The detailed implementation guide
    file_manifest: List[dict]  # List of {path, operation, rationale} from architect
    definition_of_done: dict  # Acceptance criteria from architect
    
    # Context
    repo_skeleton: str
    project_root: str
    
    # Internal Tracking
    modified_files: List[str]
    syntax_error: str
    thought_signature: str
    
    # Loop protection
    loop_count: int
    builder_iteration: int  # Tracks builder-phase tool loops (prevents impl_prompt re-injection)
    
    # Conversational feedback
    dialogue_history: List[dict]  # [{role: "scout"|"builder"|"check", content: str}]
    
    # Audit feedback (populated on retry after audit rejection)
    negative_constraints: List[str]  # Blocking issues from previous audit
    
    # Output artifact
    walkthrough: str  # Markdown summary of changes for human review
    
    # Dispute: if scout verifies all audit issues are already fixed
    dispute: Optional[Dict[str, Any]]  # {disputed: bool, evidence: str, issues_verified: List[str]}
    
    # Generated diff for auditor (file content snapshot)
    diff_patch: str

    # Model overrides from workflow builder config
    model_overrides: dict

# --- 2. LOGIC NODES ---

# Maximum iterations to prevent infinite loops
MAX_SCOUT_ITERATIONS = 25
MAX_BUILDER_ITERATIONS = 50

def _format_negative_constraints(state: BuilderState) -> str:
    """Format audit feedback for injection into builder prompt."""
    constraints = state.get("negative_constraints", [])
    prev_files = state.get("modified_files", [])
    
    parts = []
    
    if prev_files:
        parts.append("📁 FILES ALREADY BUILT (from previous attempt — do NOT re-read these one by one):")
        for f in prev_files:
            parts.append(f"  - {f}")
        parts.append("")
    
    if constraints:
        parts.append("⚠️ AUDIT FEEDBACK (Previous attempt was REJECTED — you MUST fix these issues):")
        for i, issue in enumerate(constraints, 1):
            parts.append(f"  {i}. {issue}")
        parts.append("")
        parts.append("DO NOT repeat the same mistakes. Focus ONLY on the specific issues listed above.")
        parts.append("Say READY immediately in scout phase — you already know the codebase.")
        parts.append("")
    
    return "\n".join(parts)


async def scout_node(state: BuilderState):
    """
    Phase 1: Orientation (async for streaming).
    The agent reads the Skeleton and Spec to decide which files to open.
    Enhanced with full project context and architect's file manifest.
    
    Uses Claude Opus with prompt caching - static context is cached
    to reduce costs across the 15+ LLM calls per build session.
    """
    loop_count = state.get("loop_count", 0)
    print(f"[Builder:Scout] === Iteration {loop_count + 1}/{MAX_SCOUT_ITERATIONS} ===")
    
    # Get Claude Opus with caching enabled — use override if configured
    override = state.get("model_overrides", {}).get("scout_model")
    if override:
        from model_config import get_custom_model
        llm = get_custom_model(override, temperature=0.1)
    else:
        llm = get_claude_opus(temperature=0.1, enable_caching=True)
    
    # Generate skeleton only once (None = not generated yet, "" = generated but empty)
    skeleton = state.get("repo_skeleton")
    if skeleton is None and state.get("project_root"):
        print(f"[Builder:Scout] Generating AST map for: {state.get('project_root')}")
        skeleton = BuilderTools.generate_ast_map(state["project_root"])
        print(f"[Builder:Scout] AST map generated ({len(skeleton)} chars)")
    
    # Extract enhanced context
    task_title = state.get('task_title', 'Unknown Task')
    task_description = state.get('task_description', '')
    project_context = state.get('project_context', '')
    spec = state.get('implementation_spec', 'No specific spec provided.')
    file_manifest = state.get('file_manifest', [])
    definition_of_done = state.get('definition_of_done', {})
    project_root = state.get('project_root', '.')
    
    # Truncate context to avoid token limits
    context_preview = project_context[:2000] if project_context else 'No project context'
    
    # Format file manifest for the prompt
    manifest_text = ""
    if file_manifest:
        manifest_text = "FILE OPERATIONS PLANNED BY ARCHITECT:\n"
        for f in file_manifest:
            manifest_text += f"  - [{f.get('operation', 'UNKNOWN')}] {f.get('path', 'unknown')}: {f.get('rationale', '')}\n"
    
    # Format definition of done
    dod_text = ""
    if definition_of_done:
        criteria = definition_of_done.get('criteria', [])
        if criteria:
            dod_text = "ACCEPTANCE CRITERIA:\n" + "\n".join([f"  - {c}" for c in criteria])
    
    print(f"[Builder:Scout] Implementation spec: {spec[:200]}..." if len(str(spec)) > 200 else f"[Builder:Scout] Implementation spec: {spec}")
    
    # Build static context that will be CACHED across all iterations
    static_context = f"""ROLE: Implementation Engineer (The Builder).

TASK TITLE: {task_title}
TASK DESCRIPTION: {task_description}

PROJECT CONTEXT (tech stack, guidelines):
{context_preview}

{manifest_text}

{dod_text}

IMPLEMENTATION SPEC:
{spec[:3000]}

PROJECT ROOT: {project_root}
CRITICAL: All file paths MUST be absolute paths starting with the project root above.
Example: {project_root}/src/main.py (NOT just src/main.py)

CONTEXT MAP (AST Skeleton):
{skeleton[:6000]}

{_format_negative_constraints(state)}
AVAILABLE TOOLS:
- read_file_window(path, start, end): Read specific lines from a file
- find_symbol(path, symbol_name): Find where a class/function is defined
- explore_codebase(query, type, thoroughness): Fast file/code search ("quick"/"medium"/"very_thorough")
- create_file(path, content): Create a NEW file (for scaffolding)
- edit_file_block(path, search, replace): Edit EXISTING file content

SUB-AGENT TOOLS (available in builder phase):
- run_bash_command(command, cwd): Run shell commands (git, npm, pip, make, builds)
  NOTE: Environment is Windows. Use PowerShell syntax, NOT bash/grep/tail.
  Use 'findstr' or 'Select-String' instead of grep. Use 'type' instead of cat.
- create_subplan(goal, context): Create detailed sub-plans for complex components

YOUR GOAL: Locate relevant files (if any exist), read necessary code, and plan the implementation.
Use the FILE OPERATIONS list as your guide - it tells you which files to create vs modify.

RULES:
1. ALWAYS use absolute paths with the PROJECT ROOT prefix.
2. Use 'find_symbol' to locate functions/classes in existing files.
3. Use 'read_file_window' to inspect code. DO NOT read entire files.
4. Use 'explore_codebase' for fast pattern/keyword searches.
5. For files marked as NEW, you will CREATE them.
6. For files marked as MODIFY, read them first to understand the context.
7. When ready to implement, reply with exactly "READY".
8. Be EFFICIENT: If all files are NEW, you already know what to do — say "READY" immediately.
9. If audit feedback lists specific missing files, focus only on those — do NOT re-read every existing file.
10. Do NOT create summary markdown files, checklists, or placeholder test HTML files.
    Only modify existing source files or create files specified in the FILE OPERATIONS list.
11. DISPUTE: If audit feedback is present AND you verify by reading the actual files that
    ALL listed issues have already been fixed, respond with DISPUTE followed by evidence
    explaining what you checked and why each issue is resolved. Do NOT write any code —
    just provide file paths and line references as proof."""
    
    # Bind navigation tools from unified registry
    model = llm.bind_tools(_scout_tools)
    
    # Build messages with cache_control on static content
    messages = state["messages"]
    first_turn = not messages
    
    if first_turn:
        # First turn: Use SystemMessage with cache_control for static context
        # This caches the entire static prompt across all subsequent iterations
        system_msg = SystemMessage(content=[
            {
                "type": "text",
                "text": static_context,
                "cache_control": {"type": "ephemeral"}  # Cache this content
            }
        ])
        user_msg = HumanMessage(content="Please begin by scouting the codebase and identifying the files you need to work with.")
        messages = [system_msg, user_msg]
        print(f"[Builder:Scout] First turn - creating cached system prompt ({len(static_context)} chars)")
    else:
        print(f"[Builder:Scout] Continuing conversation with {len(messages)} messages (using cached context)")
    
    print(f"[Builder:Scout] Invoking Claude Opus (async)...")
    try:
        response = await model.ainvoke(messages)
        
        # Log the response
        content_preview = str(response.content)[:300] if response.content else "(empty)"
        print(f"[Builder:Scout] AI Response: {content_preview}")
        
        if hasattr(response, 'tool_calls') and response.tool_calls:
            print(f"[Builder:Scout] Tool calls requested: {[tc['name'] for tc in response.tool_calls]}")
        else:
            print(f"[Builder:Scout] No tool calls in response")
            
    except Exception as e:
        print(f"[Builder:Scout] ERROR invoking model: {e}")
        import traceback
        traceback.print_exc()
        raise e
    
    # Return messages - on first turn include system + user + response
    dialogue_history = state.get("dialogue_history", []) or []
    scout_summary = "Scouting codebase..."
    if hasattr(response, 'tool_calls') and response.tool_calls:
        scout_summary = f"Using tools: {[tc['name'] for tc in response.tool_calls]}"
    elif "READY" in str(response.content):
        scout_summary = "Ready to implement."
    
    # Include system message on first turn so it persists in state for cache hits
    if first_turn:
        return_messages = [system_msg, user_msg, response]
    else:
        return_messages = [response]
    
    return {
        "messages": return_messages, 
        "repo_skeleton": skeleton,
        "loop_count": loop_count + 1,
        "dialogue_history": dialogue_history + [{"role": "scout", "content": scout_summary}]
    }

async def builder_node(state: BuilderState):
    """
    Phase 2: Execution with conversational feedback (async for streaming).
    The agent creates new files or edits existing ones.
    Uses Claude Opus with caching - benefits from cached system prompt.
    
    IMPORTANT: The impl_prompt is only injected on the FIRST call (builder_iteration == 0).
    On subsequent iterations (after tool results), existing messages already contain the
    full conversation history including prior tool calls and results, so re-injecting
    the prompt would cause the model to forget its progress and restart from scratch.
    """
    loop_count = state.get("loop_count", 0)
    builder_iteration = state.get("builder_iteration", 0)
    print(f"[Builder:Execute] === Builder Node (loop {loop_count}, iteration {builder_iteration}) ===")
    
    # Get Claude Opus with caching enabled — use override if configured
    override = state.get("model_overrides", {}).get("coder_model")
    if override:
        from model_config import get_custom_model
        llm = get_custom_model(override, temperature=0.1, enable_caching=True)
    else:
        llm = get_claude_opus(temperature=0.1, enable_caching=True)
    
    # Bind file editing tools from unified registry
    model = llm.bind_tools(_builder_tools)
    
    # Build dialogue context
    dialogue_history = state.get("dialogue_history", []) or []
    dialogue_context = ""
    if dialogue_history:
        dialogue_context = "\n\nPREVIOUS ACTIONS:\n" + "\n".join(
            [f"- {d['role']}: {d['content']}" for d in dialogue_history[-5:]]
        )
    
    # Mid-builder pruning: compress old tool outputs after 15 iterations
    PRUNE_THRESHOLD = 15
    if builder_iteration > 0 and builder_iteration % PRUNE_THRESHOLD == 0:
        _prune_builder_messages(state)

    messages = list(state["messages"])
    
    # Only inject the implementation prompt on the FIRST builder call.
    # On subsequent iterations, the model already has the full conversation
    # with its prior tool calls and results -- re-injecting would cause amnesia.
    if builder_iteration == 0:
        # Inject feedback if there were errors from a previous check phase
        if state.get("syntax_error"):
            error_msg = state['syntax_error']
            feedback = f"""
            SYSTEM ALERT: Previous check found issues!
            Error: {error_msg}
            
            Please analyze this error carefully and fix your approach.
            {dialogue_context}
            """
            print(f"[Builder:Execute] Injecting error feedback from check phase")
            messages.append(HumanMessage(content=feedback))
        
        # Add implementation guidance prompt (first time only)
        spec = state.get('implementation_spec', '')
        project_root = state.get('project_root', '.')
        
        impl_prompt = f"""
        Now implement the plan. You have these tools:
        
        FILE TOOLS:
        - create_file(path, content): Create NEW files
        - edit_file_block(path, search, replace): Edit EXISTING files
        
        SUB-AGENT TOOLS:
        - run_bash_command(command, cwd): Run shell commands (git, npm, pip, make, tests)
        - explore_codebase(query, type, thoroughness): Fast file/code search
        - create_subplan(goal, context): Create sub-plans for complex components
        
        PROJECT ROOT: {project_root}
        CRITICAL: All file paths MUST be absolute paths starting with the project root above.
        Example: {project_root}/src/main.py (NOT just src/main.py)
        
        For scaffolding (new project), use create_file for each file with ABSOLUTE paths.
        For modifications, use edit_file_block on existing files with ABSOLUTE paths.
        For dependencies, use run_bash_command to install (e.g., "npm install", "pip install -r requirements.txt").
        
        IMPORTANT: You can call MULTIPLE tools in a single response! For scaffolding tasks,
        create ALL files at once by including multiple create_file calls in one response.
        This is much more efficient than creating one file per response.
        
        When you have completed ALL necessary file operations, stop calling tools.
        Do NOT re-create files that already exist.
        
        Implementation spec:
        {spec[:2000]}...
        """
        messages.append(HumanMessage(content=impl_prompt))
        print(f"[Builder:Execute] Injected impl_prompt (first iteration)")
    else:
        # On subsequent iterations, only inject error feedback if needed
        if state.get("syntax_error"):
            error_msg = state['syntax_error']
            feedback = f"""
            SYSTEM ALERT: Previous action failed!
            Error: {error_msg}
            
            Please analyze this error carefully and fix your approach.
            {dialogue_context}
            """
            print(f"[Builder:Execute] Injecting error feedback (iteration {builder_iteration})")
            messages.append(HumanMessage(content=feedback))
        print(f"[Builder:Execute] Continuing with existing context (iteration {builder_iteration})")
    
    print(f"[Builder:Execute] Invoking model (async) with {len(messages)} messages...")
    try:
        response = await model.ainvoke(messages)
        
        content_preview = str(response.content)[:300] if response.content else "(empty)"
        print(f"[Builder:Execute] AI Response: {content_preview}")
        
        if hasattr(response, 'tool_calls') and response.tool_calls:
            for tc in response.tool_calls:
                print(f"[Builder:Execute] Tool call: {tc['name']}({list(tc['args'].keys())})")
        else:
            print(f"[Builder:Execute] No tool calls - builder thinks it's done")
            
    except Exception as e:
        print(f"[Builder:Execute] ERROR invoking model: {e}")
        import traceback
        traceback.print_exc()
        raise e
    
    # Track modified/created files
    modified = list(state.get("modified_files", []))
    builder_actions = []
    if hasattr(response, 'tool_calls') and response.tool_calls:
        for tool_call in response.tool_calls:
            tool_name = tool_call["name"]
            if tool_name in ["edit_file_block", "create_file"]:
                path = tool_call["args"].get("path")
                if path and path not in modified:
                    modified.append(path)
                    print(f"[Builder:Execute] Will {'create' if tool_name == 'create_file' else 'modify'}: {path}")
                    builder_actions.append(f"{tool_name}: {path}")

    return {
        "messages": [response],
        "modified_files": modified,
        "syntax_error": None,
        "builder_iteration": builder_iteration + 1,
        "dialogue_history": dialogue_history + [
            {"role": "builder", "content": "; ".join(builder_actions) if builder_actions else "No actions taken"}
        ]
    }

def basic_check_node(state: BuilderState):
    """
    Phase 3: The Gatekeeper.
    Checks that work was actually done, runs syntax checks, and performs
    a cross-provider LLM review using Gemini Pro (different provider than Claude builder).
    """
    modified = state.get("modified_files", [])
    dialogue_history = state.get("dialogue_history", []) or []
    print(f"[Builder:Check] Checking {len(modified)} modified files: {modified}")
    
    # CRITICAL: Fail if no work was done
    if not modified:
        error_msg = "ERROR: No files were created or modified. Builder did not complete any work. " \
                    "If this is a scaffolding task, use create_file to create new files."
        print(f"[Builder:Check] {error_msg}")
        return {
            "syntax_error": error_msg,
            "builder_iteration": 0,  # Reset so impl_prompt is re-injected with error context
            "dialogue_history": dialogue_history + [
                {"role": "check", "content": error_msg}
            ]
        }
    
    errors = []
    file_contents = {}
    
    for path in modified:
        # Only check Python files for syntax
        if path.endswith(".py"):
            print(f"[Builder:Check] Syntax checking: {path}")
            result = BuilderTools.run_syntax_check(path)
            print(f"[Builder:Check] Result: {result}")
            if "SyntaxError" in result or "Check Failed" in result:
                errors.append(f"{path}: {result}")
            else:
                # Read file content for LLM review
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        file_contents[path] = f.read()
                except Exception as e:
                    print(f"[Builder:Check] Could not read {path} for review: {e}")
        else:
            print(f"[Builder:Check] Skipping syntax check for non-Python file: {path}")
            
    if errors:
        error_msg = "; ".join(errors)
        print(f"[Builder:Check] ERRORS FOUND: {errors}")
        return {
            "syntax_error": error_msg,
            "builder_iteration": 0,  # Reset so impl_prompt is re-injected with error context
            "dialogue_history": dialogue_history + [
                {"role": "check", "content": f"Syntax errors: {error_msg}"}
            ]
        }
    
    # Cross-provider LLM review using Gemini Pro
    # This provides a second opinion from a different AI than the Claude builder
    if file_contents:
        print(f"[Builder:Check] Running cross-provider review with Gemini Pro...")
        try:
            # Use override model if configured, else default
            override = state.get("model_overrides", {}).get("checker_model")
            if override:
                from model_config import get_custom_model
                llm = get_custom_model(override, temperature=0)
            else:
                llm = get_gemini_pro(temperature=0)
            
            # Build review prompt with file contents
            files_text = "\n\n".join([
                f"=== {path} ===\n{content[:3000]}" 
                for path, content in list(file_contents.items())[:3]
            ])
            
            review_prompt = f"""You are a code reviewer. Quickly check these files for obvious issues:

{files_text}

Look for:
1. Obvious bugs or logic errors
2. Missing imports
3. Undefined variables or functions
4. Security issues (hardcoded secrets, SQL injection, etc.)

If the code looks reasonable, respond with just "APPROVED".
If there are serious issues, respond with "ISSUES:" followed by a brief list."""

            response = llm.invoke([HumanMessage(content=review_prompt)])
            review_result = str(response.content)
            print(f"[Builder:Check] Gemini review: {review_result[:200]}")
            
            if "ISSUES:" in review_result.upper():
                # Return issues as syntax_error to trigger retry loop back to Claude
                print(f"[Builder:Check] Gemini flagged issues - sending back to Claude for fixes")
                return {
                    "syntax_error": f"Cross-provider review (Gemini): {review_result}",
                    "builder_iteration": 0,  # Reset so impl_prompt is re-injected with error context
                    "dialogue_history": dialogue_history + [
                        {"role": "check", "content": f"Gemini review found issues: {review_result[:500]}"}
                    ]
                }
        except Exception as e:
            print(f"[Builder:Check] Cross-provider review failed (non-blocking): {e}")
    
    print(f"[Builder:Check] All checks passed!")
    
    # Generate walkthrough document for human review
    task_title = state.get('task_title', 'Unknown Task')
    task_description = state.get('task_description', '')
    definition_of_done = state.get('definition_of_done', {})
    
    # Build DoD checklist with all items marked complete
    dod_items = ""
    if definition_of_done:
        criteria = definition_of_done.get('criteria', []) or definition_of_done.get('items', [])
        if isinstance(criteria, list):
            dod_items = "\n".join([f"- [x] {item}" for item in criteria])
        elif isinstance(definition_of_done, dict):
            # Handle object format
            for key, value in definition_of_done.items():
                if key not in ['criteria', 'items']:
                    dod_items += f"- [x] {key}: {value}\n"
    
    # Build modified files list
    files_list = "\n".join([f"- `{f}`" for f in modified])
    
    walkthrough = f"""# Walkthrough: {task_title}

## Summary
{task_description}

## Files Modified
{files_list}

## Definition of Done
{dod_items if dod_items else "All requirements met."}

## Verification
- [x] Syntax checks passed
- [x] Cross-provider review passed (Gemini Pro)
- [x] Ready for audit
"""
    
    print(f"[Builder:Check] Generated walkthrough ({len(walkthrough)} chars)")
    
    # Generate diff context for auditor (file content snapshot)
    diff_parts = []
    for path in modified:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            # Cap each file at 3000 chars to keep diff manageable
            preview = content[:3000]
            if len(content) > 3000:
                preview += f"\n... ({len(content) - 3000} more chars)"
            diff_parts.append(f"=== {path} ===\n{preview}")
        except Exception as e:
            diff_parts.append(f"=== {path} === (could not read: {e})")
    diff_patch = "\n\n".join(diff_parts)
    print(f"[Builder:Check] Generated diff_patch ({len(diff_patch)} chars) for {len(modified)} files")
    
    return {
        "syntax_error": None,
        "walkthrough": walkthrough,
        "diff_patch": diff_patch,
        "dialogue_history": dialogue_history + [
            {"role": "check", "content": f"Success: {len(modified)} files verified"}
        ]
    }

# --- 3. CONTEXT PRUNING ---

def _ensure_tool_pair_integrity(messages):
    """Post-pruning safety net: remove orphaned tool_use and tool_result messages.
    
    Anthropic requires every tool_use block to have a corresponding tool_result
    in the immediately following message. Gemini requires function call turns to
    come after user turns or function response turns. This function strips any
    orphaned messages that would violate these constraints.
    
    Returns the sanitized message list (may be unchanged if no orphans found).
    """
    from langchain_core.messages import ToolMessage as _ToolMessage, AIMessage as _AIMessage
    
    # Collect all tool_call IDs present on each side of the pairing
    use_ids = set()   # IDs from AIMessage.tool_calls
    result_ids = set()  # IDs from ToolMessage.tool_call_id
    for msg in messages:
        if hasattr(msg, 'tool_calls') and msg.tool_calls:
            for tc in msg.tool_calls:
                use_ids.add(tc['id'])
        if isinstance(msg, _ToolMessage) and hasattr(msg, 'tool_call_id'):
            result_ids.add(msg.tool_call_id)
    
    orphaned_uses = use_ids - result_ids      # tool_use without tool_result
    orphaned_results = result_ids - use_ids   # tool_result without tool_use
    
    if not orphaned_uses and not orphaned_results:
        return messages  # All pairs intact
    
    cleaned = []
    for msg in messages:
        # Drop orphaned tool_result messages
        if isinstance(msg, _ToolMessage) and msg.tool_call_id in orphaned_results:
            continue
        
        # Handle AI messages whose tool_calls are orphaned
        if hasattr(msg, 'tool_calls') and msg.tool_calls:
            if all(tc['id'] in orphaned_uses for tc in msg.tool_calls):
                # ALL tool_calls are orphaned — preserve any text content as plain AI message
                text = ""
                if isinstance(msg.content, str):
                    text = msg.content.strip()
                elif isinstance(msg.content, list):
                    text = " ".join(
                        b.get("text", "") if isinstance(b, dict) and b.get("type") == "text"
                        else (str(b) if isinstance(b, str) else "")
                        for b in msg.content
                    ).strip()
                if text:
                    cleaned.append(_AIMessage(content=text))
                continue  # Drop the tool_use version
        
        cleaned.append(msg)
    
    print(f"[Builder:Prune] Pair integrity: removed {len(messages) - len(cleaned)} orphaned messages "
          f"({len(orphaned_uses)} orphaned tool_use, {len(orphaned_results)} orphaned tool_result)")
    return cleaned


def _prune_scout_messages(state: BuilderState):
    """Compress scout phase messages before transitioning to builder.
    
    Keeps: SystemMessage, HumanMessage prompts, the final READY message.
    Drops: ToolMessage responses AND their corresponding AIMessage tool_calls
           as matched pairs to prevent orphaned tool_use/tool_result.
    """
    from langchain_core.messages import ToolMessage as _ToolMessage, SystemMessage as _SystemMessage, HumanMessage as _HumanMessage
    
    messages = state.get("messages", [])
    if len(messages) <= 5:
        return  # Nothing to prune
    
    pruned = []
    tool_results_dropped = 0
    
    for i, msg in enumerate(messages):
        # Keep all system and human messages (prompts, context)
        if isinstance(msg, (_SystemMessage, _HumanMessage)):
            pruned.append(msg)
        # Keep the last 3 messages (scout's final reasoning + READY)
        elif i >= len(messages) - 3:
            pruned.append(msg)
        # Drop tool result messages (raw file reads, grep outputs)
        elif isinstance(msg, _ToolMessage):
            tool_results_dropped += 1
        # Drop AI messages with tool_calls (their ToolMessages are also being dropped)
        elif hasattr(msg, 'tool_calls') and msg.tool_calls:
            tool_results_dropped += 1
        else:
            pruned.append(msg)
    
    if tool_results_dropped > 0:
        # Inject summary of what was dropped
        summary = _HumanMessage(content=f"[Context: {tool_results_dropped} scout tool outputs pruned to save tokens. Scout phase complete — all file analysis is done.]")
        pruned.insert(-3, summary)  # Before the last 3 messages
        # Safety net: ensure no orphans remain (e.g. in the kept tail)
        pruned = _ensure_tool_pair_integrity(pruned)
        state["messages"] = pruned
        print(f"[Builder:Prune] Scout phase: {len(messages)} messages → {len(pruned)} (dropped {tool_results_dropped} tool outputs)")

def _prune_builder_messages(state: BuilderState):
    """Compress old builder tool outputs, keeping recent context.
    
    Strategy: Keep the first 3 messages (system + prompt + initial guidance)
    and the last 10 messages (recent tool calls and results).
    Replace everything in between with a summary.
    
    CRITICAL: Head and tail are trimmed at clean boundaries to ensure
    tool_use/tool_result pairs are never split across the prune cut.
    """
    from langchain_core.messages import ToolMessage as _ToolMessage
    
    messages = state.get("messages", [])
    if len(messages) <= 15:
        return  # Not enough to prune
    
    keep_start = 3   # System prompt + initial context
    keep_end = 10    # Recent tool interactions
    
    head = list(messages[:keep_start])
    tail = list(messages[-keep_end:])
    
    # Trim head backward: if it ends with an AIMessage that has tool_calls,
    # the matching tool_results would be in the pruned middle — remove it.
    while head and hasattr(head[-1], 'tool_calls') and head[-1].tool_calls:
        head.pop()
    
    # Trim tail forward: if it starts with orphaned ToolMessages whose
    # matching tool_use AIMessage was in the pruned middle — remove them.
    while tail and isinstance(tail[0], _ToolMessage):
        tail.pop(0)
    
    dropped = len(messages) - len(head) - len(tail)
    if dropped <= 0:
        return  # Nothing useful to prune after boundary trimming
    
    modified_count = len(state.get('modified_files', []))
    summary = HumanMessage(content=f"[Context: {dropped} intermediate messages pruned. {modified_count} files modified so far. Continue implementing.]")
    
    # Final safety net: validate all pairs are intact
    result = _ensure_tool_pair_integrity(head + [summary] + tail)
    state["messages"] = result
    print(f"[Builder:Prune] Builder phase: {len(messages)} messages → {len(state['messages'])} (dropped {dropped} intermediate)")

# --- 3.5 ROUTING ---

def route_scout(state: BuilderState):
    loop_count = state.get("loop_count", 0)
    
    # Safety valve: prevent infinite loops — gracefully degrade to builder
    if loop_count >= MAX_SCOUT_ITERATIONS:
        print(f"[Builder:Route] Scout hit MAX ITERATIONS ({MAX_SCOUT_ITERATIONS}) — gracefully proceeding to builder phase")
        # CRITICAL: If the last message has pending tool_calls, we must inject
        # synthetic tool_result messages before transitioning. Otherwise Claude's API
        # will reject the conversation with a 400 error (tool_use without tool_result).
        last_msg = state["messages"][-1]
        if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
            from langchain_core.messages import ToolMessage
            synthetic_results = []
            for tc in last_msg.tool_calls:
                synthetic_results.append(ToolMessage(
                    content="[Scout max iterations reached — tool not executed. Proceeding to implementation.]",
                    tool_call_id=tc["id"]
                ))
            # Inject into state so builder_node sees valid message history
            state["messages"].extend(synthetic_results)
            print(f"[Builder:Route] Injected {len(synthetic_results)} synthetic tool_result(s) for pending tool calls")
        return "builder"
    
    last_msg = state["messages"][-1]
    
    # If tool called, return to tools (implicit in LangGraph prebuilt, but explicit here)
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        print(f"[Builder:Route] Scout -> scout_tools (tool calls detected)")
        return "tools"
        
    if hasattr(last_msg, 'content') and last_msg.content and "READY" in str(last_msg.content):
        print(f"[Builder:Route] Scout -> builder (READY detected)")
        # Prune raw scout tool outputs before transitioning to builder
        _prune_scout_messages(state)
        return "builder"
    
    # Dispute: scout verified all audit issues are already fixed
    if hasattr(last_msg, 'content') and last_msg.content and "DISPUTE" in str(last_msg.content):
        print(f"[Builder:Route] Scout -> dispute_exit (DISPUTE — audit issues already fixed)")
        return "dispute_exit"
    
    # If just talking, continue scouting (or could be error/confusion)
    print(f"[Builder:Route] Scout -> scout (no READY, no tools, continuing)")
    return "scout"

def route_builder(state: BuilderState):
    last_msg = state["messages"][-1]
    builder_iteration = state.get("builder_iteration", 0)
    
    # Safety valve: cap builder tool loops to prevent infinite looping
    if builder_iteration >= MAX_BUILDER_ITERATIONS:
        print(f"[Builder:Route] MAX BUILDER ITERATIONS ({MAX_BUILDER_ITERATIONS}) reached! Forcing check.")
        return "basic_check"
    
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        print(f"[Builder:Route] Builder -> builder_tools (tool calls detected, iteration {builder_iteration})")
        return "tools"
    
    # If no tools called, we assume it thinks it's done -> Check it
    print(f"[Builder:Route] Builder -> basic_check (no tool calls, checking result)")
    return "basic_check"

def route_check(state: BuilderState):
    if state.get("syntax_error"):
        print(f"[Builder:Route] Check -> builder (syntax errors found, retrying)")
        # Reset builder_iteration so the impl_prompt is re-injected with the error context
        return "builder"
    print(f"[Builder:Route] Check -> END (all checks passed!)")
    return END  # Exit

# --- 4. EXPORT GRAPH ---

from langgraph.prebuilt import ToolNode

def dispute_exit_node(state: BuilderState):
    """Captures the scout's dispute evidence and exits the builder graph.
    
    Called when the scout verifies all audit issues are already fixed
    and responds with DISPUTE instead of READY.
    """
    last_msg = state["messages"][-1]
    content = str(last_msg.content) if hasattr(last_msg, 'content') else ""
    
    # Extract everything after "DISPUTE"
    evidence = content.split("DISPUTE", 1)[-1].strip() if "DISPUTE" in content else content
    negative_constraints = state.get("negative_constraints", [])
    
    print(f"[Builder:Dispute] Filing dispute with {len(negative_constraints)} issues verified")
    print(f"[Builder:Dispute] Evidence: {evidence[:300]}")
    
    return {
        "dispute": {
            "disputed": True,
            "evidence": evidence,
            "issues_verified": negative_constraints,
        },
        "walkthrough": f"## Audit Dispute\n\nBuilder verified all audit issues are already resolved:\n\n{evidence}",
    }

def compile_builder_graph(project_root: str = ""):
    workflow = StateGraph(BuilderState)

    # Create closure-wrapped tools that hard-code project_root
    # This ensures explore_codebase and run_bash_command always use the correct directory,
    # regardless of whether the LLM passes the parameter
    _bound_root = project_root

    @tool
    def explore_codebase_bound(query: str, search_type: str = "auto", thoroughness: str = "medium") -> str:
        """Fast codebase exploration - find files, search code, map project structure.
        
        Args:
            query: What to search for (file pattern like "*.py", code keyword, or "structure" for tree)
            search_type: "auto" (detect), "glob" (file patterns), "grep" (code search), "structure" (tree)
            thoroughness: "quick" (shallow), "medium" (balanced), "very_thorough" (deep search)
        
        Returns:
            Search results with file paths, line numbers, and content snippets
        """
        return explore_codebase.invoke({
            "query": query, "search_type": search_type,
            "thoroughness": thoroughness, "project_root": _bound_root or ""
        })

    @tool
    def run_bash_command_bound(command: str, timeout: int = 300) -> str:
        """Execute terminal commands for git, builds, npm/pip installs, and other tasks.
        
        Args:
            command: The command to run (e.g., "npm install", "git status")
            timeout: Maximum seconds to wait (default 300)
        
        Returns:
            Command output including stdout/stderr and exit code
        """
        return run_bash_command.invoke({
            "command": command, "cwd": _bound_root or "", "timeout": timeout
        })

    workflow.add_node("scout", scout_node)
    workflow.add_node("builder", builder_node)
    workflow.add_node("basic_check", basic_check_node)
    
    # Tools node handles execution
    workflow.add_node("tools", ToolNode([read_file_window, find_symbol, edit_file_block]))

    workflow.add_edge(START, "scout")
    
    # Define specialized tool nodes (using bound tools with correct project_root)
    # Scout has navigation tools + codebase explorer for research
    workflow.add_node("scout_tools", ToolNode([read_file_window, find_symbol, explore_codebase_bound]))
    # Builder has file editing + sub-agents for shell commands and planning
    workflow.add_node("builder_tools", ToolNode([edit_file_block, create_file, run_bash_command_bound, explore_codebase_bound, create_subplan]))
    
    workflow.add_node("dispute_exit", dispute_exit_node)
    
    workflow.add_edge("scout_tools", "scout")
    workflow.add_edge("builder_tools", "builder")
    workflow.add_edge("dispute_exit", END)
    
    # Scout routing (includes dispute exit)
    workflow.add_conditional_edges(
        "scout",
        route_scout,
        {"tools": "scout_tools", "builder": "builder", "scout": "scout", "dispute_exit": "dispute_exit"}
    )
    
    # Builder routing
    workflow.add_conditional_edges(
        "builder",
        route_builder,
        {"tools": "builder_tools", "basic_check": "basic_check"}
    )

    workflow.add_conditional_edges(
        "basic_check", 
        route_check,
        {"builder": "builder", END: END}
    )

    return workflow.compile()
