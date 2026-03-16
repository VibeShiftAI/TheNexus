from typing import Annotated, List, TypedDict, Literal, Dict, Any
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langchain_core.tools import tool
from langgraph.prebuilt import ToolNode
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

from .tools import AuditorTools, write_dry_run_test, run_sandbox_cmd, read_reference_file, AuditVerdict
from model_config import get_discovered_model_id, DEFAULT_PRO_MODEL

# --- 1. STATE DEFINITION ---

# Module-level variable for bound audit tools (set by compile_auditor_graph)
# This allows forensic_node to bind the same tools that ToolNode uses
_active_audit_tools = [write_dry_run_test, run_sandbox_cmd, read_reference_file]

class AuditorState(TypedDict):
    messages: Annotated[List[Any], add_messages]
    
    # Enhanced context fields
    task_title: str  # High-level task name
    task_description: str  # Original user intent
    project_context: str  # Combined markdown from supervisor/*.md
    definition_of_done: dict  # Acceptance criteria from architect
    modified_files: List[str]  # List of files that were created/modified
    project_root: str  # Absolute path to the target project directory
    file_manifest: List[dict]  # Files the builder was ASKED to create/modify (scope boundary)
    
    # Artifacts injected at runtime
    diff_context: str
    blast_radius: str
    linter_report: str
    implementation_spec: str
    
    # Internal Reasoning
    test_logs: List[str]
    
    # The Output
    final_verdict: dict
    
    # Model overrides from workflow builder config
    model_overrides: dict

# --- 2. THE AGENT (Latest Gemini Pro via Discovery) ---
def get_auditor_llm():
    """Returns the latest Gemini Pro model (from discovery service) with token tracking.
    Falls back to DEFAULT_PRO_MODEL if the discovery service is unavailable."""
    from langchain_google_genai import ChatGoogleGenerativeAI
    from model_config import _get_tracking_handler
    
    discovered_id = get_discovered_model_id("Gemini Pro")
    model_id = discovered_id or DEFAULT_PRO_MODEL
    
    cb = []
    handler = _get_tracking_handler()
    if handler:
        cb = [handler]
    
    print(f"[Auditor] Using model: {model_id}" + (" (discovered)" if discovered_id else " (fallback)"))
    return ChatGoogleGenerativeAI(
        model=model_id,
        temperature=0,
        max_tokens=16384,
        callbacks=cb
    )

# --- 3. LOGIC NODES ---

async def forensic_node(state: AuditorState):
    """
    Phase 1: Investigation (async for streaming).
    LLM reviews the Diff, Blast Radius, and Linter Report.
    Enhanced with full task context and acceptance criteria.
    """
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("forensic_model")
    if override:
        from model_config import get_custom_model
        llm = get_custom_model(override, temperature=0)
    else:
        llm = get_auditor_llm()
    
    # Extract enhanced context
    task_title = state.get('task_title', 'Unknown Task')
    task_description = state.get('task_description', '')
    project_context = state.get('project_context', '')
    definition_of_done = state.get('definition_of_done', {})
    modified_files = state.get('modified_files', [])
    
    # Truncate context to avoid token limits
    context_preview = project_context[:2000] if project_context else 'No project context'
    
    # Format definition of done
    dod_text = ""
    if definition_of_done:
        criteria = definition_of_done.get('criteria', [])
        if criteria:
            dod_text = "ACCEPTANCE CRITERIA (must ALL pass):\n" + "\n".join([f"  ✓ {c}" for c in criteria])
    
    # Format modified files list
    files_text = ""
    if modified_files:
        files_text = "FILES TO REVIEW:\n" + "\n".join([f"  - {f}" for f in modified_files])
    
    project_root = state.get('project_root', 'Unknown')
    
    # Generate file listing so auditor knows what exists
    file_listing = ""
    if project_root and project_root != 'Unknown':
        try:
            import os as _os
            listing = []
            for root, dirs, files in _os.walk(project_root):
                # Skip hidden dirs, node_modules, venv, __pycache__
                dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', 'venv', '__pycache__', '.git')]
                level = root.replace(project_root, '').count(_os.sep)
                indent = '  ' * level
                listing.append(f"{indent}{_os.path.basename(root)}/")
                for file in sorted(files):
                    listing.append(f"{indent}  {file}")
                if len(listing) > 200:
                    listing.append("  ... (truncated)")
                    break
            file_listing = "\n".join(listing)
        except Exception:
            file_listing = "(could not generate file listing)"
    
    # Extract file manifest for scope boundary
    file_manifest = state.get('file_manifest', [])
    scope_text = ""
    if file_manifest:
        manifest_files = []
        for op in file_manifest:
            if isinstance(op, dict):
                path = op.get('path', op.get('file', ''))
                operation = op.get('operation', 'modify')
                manifest_files.append(f"  - [{operation.upper()}] {path}")
            else:
                manifest_files.append(f"  - {op}")
        scope_text = "TASK SCOPE (files the builder was asked to create/modify):\n" + "\n".join(manifest_files)
    
    prompt = f"""
    ROLE: Lead Security Auditor (The Sentinel).
    
    TASK TITLE: {task_title}
    TASK DESCRIPTION: {task_description}
    
    PROJECT ROOT: {project_root}
    IMPORTANT: Use this path when running sandbox commands or reading files.
    All modified files use absolute paths relative to this root.
    
    PROJECT CONTEXT (tech stack, guidelines):
    {context_preview}
    
    {dod_text}
    
    {files_text}
    
    {scope_text}
    
    AVAILABLE FILES IN PROJECT:
    {file_listing or '(no file listing available)'}
    
    CHANGES (Diff):
    {state.get('diff_context', 'No diff provided.')[:5000]}
    
    BLAST RADIUS (Dependent Files):
    {state.get('blast_radius', 'No dependencies found.')}
    
    LINTER REPORT:
    {state.get('linter_report', 'No linter issues.')}
    
    PROCEDURE:
    1. Use 'read_reference_file' to read ALL modified files listed above.
    2. For EACH acceptance criterion, verify it is met by inspecting the file contents.
    3. If the linter failed, call 'AuditVerdict' with REJECTED immediately.
    4. For simple static files (HTML, CSS, JS), do NOT write tests - just verify contents directly.
    5. ONLY use 'write_dry_run_test' for complex Python logic where edge cases need verification.
    6. Once you have verified ALL criteria are met, call 'AuditVerdict' with APPROVED.
    7. If ANY criterion is NOT met, call 'AuditVerdict' with REJECTED.
       CRITICAL: Each blocking_issue MUST include a real file path and line number.
       Do NOT report issues you cannot verify in the actual file contents.
    
    SCOPE RULES (CRITICAL):
    - ONLY audit changes to files listed in the TASK SCOPE or modified files above.
    - Do NOT flag references to files outside this task's scope as blocking issues.
      For example, if this task creates index.html that references styles.css, but styles.css
      is NOT in this task's scope, that is NOT a blocking issue — another task will create it.
    - Focus on whether THIS task's deliverables meet THIS task's acceptance criteria.
    
    IMPORTANT: Be efficient. For simple tasks like HTML scaffolding, read the files, verify criteria, and approve quickly.
    """
    
    # Bind tools: Probing + Final Verdict
    # We bind the Pydantic model 'AuditVerdict' as a tool to force structured exit
    # Uses _active_audit_tools (set by compile_auditor_graph with correct CWD)
    model = llm.bind_tools(
        _active_audit_tools + [AuditVerdict]
    )
    
    # If first turn, inject prompt. Otherwise continue.
    # Both Claude and Gemini require at least one HumanMessage, so we use SystemMessage + HumanMessage
    messages = state.get("messages", [])
    if not messages:
        print(f"[Auditor:Forensic] Starting audit for task: {task_title}")
        # System message for role/context, Human message for the actual request
        system_msg = SystemMessage(content="""ROLE: Lead Security Auditor (The Sentinel).
You are responsible for reviewing code changes and ensuring they meet all acceptance criteria.
Use tools to investigate, then call AuditVerdict with your final decision.""")
        human_msg = HumanMessage(content=prompt)
        messages = [system_msg, human_msg]
    else:
        # Subsequent turns after tool execution: append a HumanMessage to satisfy
        # Gemini's strict turn-ordering (function_call must be followed by
        # function_response, then a user turn before the next model response)
        messages = list(messages) + [HumanMessage(
            content="Continue your audit. Review the tool results above and proceed "
                    "with your investigation. When ready, call AuditVerdict with your final decision."
        )]
    
    print(f"[Auditor:Forensic] Invoking LLM with {len(messages)} messages...")
    
    # Retry with exponential backoff for transient API errors (overloaded, rate limit)
    max_retries = 3
    retry_delays = [5, 15, 30]  # seconds
    last_error = None
    
    for attempt in range(max_retries + 1):
        try:
            response = await model.ainvoke(messages)
            print(f"[Auditor:Forensic] Response received, tool_calls: {bool(hasattr(response, 'tool_calls') and response.tool_calls)}")
            return {"messages": [response]}
        except Exception as e:
            error_str = str(e).lower()
            is_transient = any(term in error_str for term in [
                'overloaded', 'rate_limit', 'rate limit', '529', '503', '429',
                'server_error', 'internal_error', 'timeout', 'connection',
                'resource_exhausted', 'quota', '500', 'unavailable'
            ])
            
            if is_transient and attempt < max_retries:
                delay = retry_delays[attempt]
                print(f"[Auditor:Forensic] Transient API error (attempt {attempt + 1}/{max_retries + 1}): {e}")
                print(f"[Auditor:Forensic] Retrying in {delay}s...")
                import asyncio as _asyncio
                await _asyncio.sleep(delay)
                last_error = e
            else:
                raise  # Non-transient or exhausted retries

def verdict_parser(state: AuditorState):
    """
    Phase 3: The Gavel.
    Extracts the structured verdict to pass back to the Nexus.
    """
    last_msg = state["messages"][-1]
    # Iterate tool calls to find the verdict
    final_verdict = {}
    
    for tool_call in last_msg.tool_calls:
        if tool_call["name"] == "AuditVerdict":
            final_verdict = tool_call["args"]
            break
            
    # Format a summary message
    summary = f"Auditor Verdict: {final_verdict.get('status', 'UNKNOWN')}\n"
    summary += f"Score: {final_verdict.get('security_score', 0)}/10\n"
    summary += f"Reasoning: {final_verdict.get('reasoning', '')}"
    
    return {
        "final_verdict": final_verdict,
        "messages": [AIMessage(content=summary)]
    }

# --- 4. ROUTER ---

def route_auditor(state: AuditorState):
    last_msg = state["messages"][-1]
    
    # Check for Tool Calls
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        # Check ALL tool calls for AuditVerdict (not just the first one!)
        # Models may call a regular tool AND AuditVerdict in the same response.
        # If we only check tool_calls[0], the verdict gets routed to ToolNode
        # which doesn't know about AuditVerdict, silently dropping it.
        for tc in last_msg.tool_calls:
            if tc["name"] == "AuditVerdict":
                return "verdict_parser"
        # No verdict found — route to standard tools
        return "tools"
    
    # Default fallback (if model just chatted without calling tools, loop back)
    return "forensic_node"

# --- 5. COMPILE GRAPH ---

def compile_auditor_graph(project_root: str = ""):
    global _active_audit_tools
    
    # Create closure-wrapped run_sandbox_cmd that uses the correct project directory
    _bound_root = project_root

    @tool
    def run_sandbox_cmd_bound(command: str) -> str:
        """Runs a shell command in the project directory to execute tests or scripts.
        Example: 'python dry_run_test.py' or 'pytest tests/test_auth.py'
        """
        return AuditorTools.run_sandbox_cmd(command, cwd=_bound_root or None)

    # Set module-level tools so forensic_node uses the same bound tools
    _active_audit_tools = [write_dry_run_test, run_sandbox_cmd_bound, read_reference_file]

    workflow = StateGraph(AuditorState)

    # Define Nodes
    workflow.add_node("forensic_node", forensic_node)
    workflow.add_node("tools", ToolNode(_active_audit_tools))
    workflow.add_node("verdict_parser", verdict_parser)

    # Define Edges
    workflow.add_edge(START, "forensic_node")
    
    workflow.add_conditional_edges(
        "forensic_node", 
        route_auditor,
        {
            "verdict_parser": "verdict_parser",
            "tools": "tools",
            "forensic_node": "forensic_node"
        }
    )
    
    workflow.add_edge("tools", "forensic_node") # Loop back to analyze test results
    workflow.add_edge("verdict_parser", END)

    return workflow.compile()
