from typing import Annotated, List, TypedDict, Literal, Dict, Any
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langchain_core.tools import tool
from langgraph.prebuilt import ToolNode
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

from .tools import write_dry_run_test, run_sandbox_cmd, read_reference_file, AuditVerdict
from model_config import get_claude_opus

# --- 1. STATE DEFINITION ---
class AuditorState(TypedDict):
    messages: Annotated[List[Any], add_messages]
    
    # Enhanced context fields
    task_title: str  # High-level task name
    task_description: str  # Original user intent
    project_context: str  # Combined markdown from supervisor/*.md
    definition_of_done: dict  # Acceptance criteria from architect
    modified_files: List[str]  # List of files that were created/modified
    project_root: str  # Absolute path to the target project directory
    
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

# --- 2. THE AGENT (Claude Opus) with automatic tracking ---
def get_auditor_llm():
    """Returns Claude Opus with token tracking via factory."""
    return get_claude_opus(temperature=0)

# --- 3. LOGIC NODES ---

async def forensic_node(state: AuditorState):
    """
    Phase 1: Investigation (async for streaming).
    Claude reviews the Diff, Blast Radius, and Linter Report.
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
    
    CHANGES (Diff):
    {state.get('diff_context', 'No diff provided.')[:5000]}
    
    BLAST RADIUS (Dependent Files):
    {state.get('blast_radius', 'No dependencies found.')}
    
    LINTER REPORT:
    {state.get('linter_report', 'No linter issues.')}
    
    PROCEDURE:
    1. Use 'read_reference_file' to read ALL modified files.
    2. For EACH acceptance criterion, verify it is met by inspecting the file contents.
    3. If the linter failed, call 'AuditVerdict' with REJECTED immediately.
    4. For simple static files (HTML, CSS, JS), do NOT write tests - just verify contents directly.
    5. ONLY use 'write_dry_run_test' for complex Python logic where edge cases need verification.
    6. Once you have verified ALL criteria are met, call 'AuditVerdict' with APPROVED.
    7. If ANY criterion is NOT met, call 'AuditVerdict' with REJECTED and list blocking_issues.
    
    IMPORTANT: Be efficient. For simple tasks like HTML scaffolding, read the files, verify criteria, and approve quickly.
    """
    
    # Bind tools: Probing + Final Verdict
    # We bind the Pydantic model 'AuditVerdict' as a tool to force structured exit
    model = llm.bind_tools(
        [write_dry_run_test, run_sandbox_cmd, read_reference_file, AuditVerdict]
    )
    
    # If first turn, inject prompt. Otherwise continue.
    # IMPORTANT: Claude requires at least one HumanMessage, so we use SystemMessage + HumanMessage
    messages = state.get("messages", [])
    if not messages:
        print(f"[Auditor:Forensic] Starting audit for task: {task_title}")
        # System message for role/context, Human message for the actual request
        system_msg = SystemMessage(content="""ROLE: Lead Security Auditor (The Sentinel).
You are responsible for reviewing code changes and ensuring they meet all acceptance criteria.
Use tools to investigate, then call AuditVerdict with your final decision.""")
        human_msg = HumanMessage(content=prompt)
        messages = [system_msg, human_msg]
    
    print(f"[Auditor:Forensic] Invoking Claude with {len(messages)} messages...")
    response = await model.ainvoke(messages)
    print(f"[Auditor:Forensic] Response received, tool_calls: {bool(hasattr(response, 'tool_calls') and response.tool_calls)}")
    return {"messages": [response]}

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
        # Claude often calls a regular tool AND AuditVerdict in the same response.
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

def compile_auditor_graph():
    workflow = StateGraph(AuditorState)

    # Define Nodes
    workflow.add_node("forensic_node", forensic_node)
    workflow.add_node("tools", ToolNode([write_dry_run_test, run_sandbox_cmd, read_reference_file]))
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
