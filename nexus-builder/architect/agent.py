from typing import Annotated, List, Literal, Optional
from langgraph.graph import StateGraph, START, END
from langchain_core.tools import tool
import os
from langgraph.prebuilt import ToolNode
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage

from .state import ArchitectState, ProjectBlueprint, GroundingReport
from tools import get_registry
from model_config import get_gemini_pro, get_gemini_flash

# Get exploration tools from unified registry
_registry = get_registry()
_architect_tools = _registry.get_langchain_tools([
    "read_file_signatures",   # AST-based class/function signatures
    "search_codebase",        # Regex search with proper filtering
    "read_file",              # Read full file contents
    "list_directory",         # Targeted directory exploration
    "generate_ast_map",       # Full codebase class/method skeleton
    "get_project_context",    # Project .context/ documentation
    "git_log",                # Recent commit history
])

# --- MODELS (with automatic tracking) ---
# THE STRATEGIST (Gemini 3 Pro)
llm_strategist = get_gemini_pro(temperature=0.1)

# THE GROUNDER (Gemini 3 Flash)
llm_grounder = get_gemini_flash(temperature=0)

# --- NODES ---

async def cartographer_node(state: ArchitectState):
    """
    Phase 1: Discovery (async for streaming).
    The Strategist explores the codebase with full project context.
    """
    project_root = state.get('project_root', '.')
    task_title = state.get('task_title', 'Unknown Task')
    task_description = state.get('task_description', '')
    project_context = state.get('project_context', '')
    
    # Truncate context to avoid token limits
    context_preview = project_context[:3000] if project_context else 'No project context available'
    
    prompt = f"""
    ROLE: Chief Architect for software implementation.
    
    TASK TITLE: {task_title}
    TASK DESCRIPTION: {task_description}
    
    PROJECT CONTEXT (tech stack, guidelines, patterns):
    {context_preview}
    
    RESEARCH FINDINGS:
    {state['user_request'][:4000]}
    
    PROJECT ROOT: {project_root}
    CRITICAL: All file paths MUST be absolute paths starting with the project root above.
    Example: {project_root}/src/main.py (NOT just src/main.py)
    
    CONTEXT OVERVIEW (File Tree):
    {state.get('repo_structure', 'Structure Unknown')[:8000]}...
    
    YOUR EXPLORATION TOOLS:
    1. **get_project_context** - Fetch all .context/ documents (product vision, tech-stack, guidelines).
       Use this FIRST to understand project conventions. No arguments needed.
    2. **search_codebase** - Find code patterns using regex. Use to locate similar implementations.
    3. **read_file_signatures** - Read class/function signatures from a file (AST-based). USE ABSOLUTE PATHS.
    4. **read_file** - Read the full contents of a file when you need detailed understanding.
    5. **list_directory** - List files in a specific directory. Use for targeted exploration.
    6. **generate_ast_map** - Generate a complete class/method skeleton of the codebase or a subdirectory.
       Use this for large projects instead of relying on the truncated file tree above.
    7. **git_log** - View recent commit history. Useful for understanding what changed recently.
    
    EXPLORATION STRATEGY:
    - For LARGE projects: Start with get_project_context, then generate_ast_map on relevant subdirectories.
    - For TARGETED tasks: Use search_codebase to find relevant files, then read_file_signatures.
    - For DOCUMENTATION tasks: Use list_directory + read_file on the docs directory.
    - Always check git_log for recent modifications to files you plan to change.
    
    Do NOT draft yet. Reply "READY_TO_DRAFT" when you have a mental model.
    """
    
    # Bind exploration tools from unified registry
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("cartographer_model")
    if override:
        from model_config import get_custom_model
        base_llm = get_custom_model(override, temperature=0.1)
    else:
        base_llm = llm_strategist
    model = base_llm.bind_tools(_architect_tools)
    
    # Restore thought signature if supported by API (simulated here)
    messages = state["messages"]
    
    # Ensure correct start of conversation
    if not messages:
        messages = [HumanMessage(content=prompt)]
    else:
        # If continuing, append prompt as HumanMessage to guide next step
        messages = messages + [HumanMessage(content=prompt)]
        
    response = await model.ainvoke(messages)
    
    # Return NEW messages to append to state
    # If we created the first message locally, we need to return it too
    new_messages = []
    if not state["messages"]:
        new_messages.append(HumanMessage(content=prompt))
    else:
        new_messages.append(HumanMessage(content=prompt))
        
    new_messages.append(response)
    
    return {
        "messages": new_messages,
        "thought_signature": response.response_metadata.get("thought_signature")
    }

async def drafter_node(state: ArchitectState):
    """
    Phase 2: Strategy (async for streaming).
    Writes the Spec and Manifest with conversational awareness.
    """
    # Build dialogue context from previous iterations
    dialogue_context = ""
    dialogue_history = state.get("dialogue_history", []) or []
    if dialogue_history:
        dialogue_context = "\n\n## PREVIOUS DIALOGUE WITH VALIDATOR:\n"
        for turn in dialogue_history:
            dialogue_context += f"\n**{turn['role'].upper()}:** {turn['content']}\n"
    
    # If there was a rejection, drafter must EXPLAIN its reasoning
    clarification = ""
    if state.get("grounding_errors"):
        clarification = """
        IMPORTANT: The Grounder rejected your previous plan. You MUST:
        1. READ the Grounder's feedback carefully (see PREVIOUS DIALOGUE below)
        2. EXPLAIN your intent for each disputed file via the 'rationale' field
        3. Either CORRECT your manifest OR DEFEND your choices with evidence
        
        Example defense rationale: "This is a greenfield project. The repo only 
        contains project.json (metadata), so package.json must be created as NEW."
        """

    project_root = state.get('project_root', '.')
    
    prompt = f"""
    Based on your research, create the PROJECT BLUEPRINT.
    {clarification}
    {dialogue_context}
    
    PROJECT ROOT: {project_root}
    CRITICAL: All file paths MUST be absolute paths starting with the project root.
    Example: {project_root}/src/main.py (NOT just src/main.py)
    
    BUILDER CAPABILITIES:
    The Builder has access to these specialized sub-agents that you can reference in your plan:
    - **Bash Executor**: Run shell commands (git, npm, pip, make, builds, tests)
    - **Codebase Explorer**: Fast file/code search (quick/medium/very_thorough modes)
    - **Plan Architect**: Create sub-plans for complex components
    - **General Agent**: Multi-step task execution for complex operations
    
    When your plan requires shell commands, dependency installation, or codebase exploration,
    explicitly mention which sub-agent the Builder should use.
    
    REQUIREMENTS:
    1. MANIFEST: For EACH file, specify:
       - path: The ABSOLUTE file path (starting with {project_root})
       - operation: "NEW" (create), "MODIFY" (edit existing), or "DELETE" (remove)
       - rationale: Why you chose this operation (critical for validator understanding)
    2. SPEC: Pseudo-code with function signatures.
    3. DOD: Verification steps.
    4. SUB-AGENT INSTRUCTIONS: When applicable, include steps like:
       - "Use Bash Executor to run: npm install"
       - "Use Codebase Explorer (thorough) to find all usages of X"
    
    CRITICAL: Use "NEW" for files that don't exist yet. Use "MODIFY" only for files 
    that MUST already exist in the repository.
    """
    
    # Enforce Pydantic Output with FileOperation structure
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("drafter_model")
    if override:
        from model_config import get_custom_model
        base_llm = get_custom_model(override, temperature=0.1)
    else:
        base_llm = llm_strategist
    model = base_llm.with_structured_output(ProjectBlueprint)
    plan = await model.ainvoke(state["messages"] + [HumanMessage(content=prompt)])
    
    # Convert FileOperation objects to dicts for state storage
    manifest_dicts = [f.model_dump() for f in plan.target_files]
    
    # Add drafter's turn to dialogue
    drafter_summary = f"Proposed {len(plan.target_files)} files: " + \
        ", ".join([f"{f.path} ({f.operation})" for f in plan.target_files[:5]])
    if len(plan.target_files) > 5:
        drafter_summary += f"... and {len(plan.target_files) - 5} more"
    
    return {
        "draft_spec": plan.spec_markdown,
        "draft_manifest": manifest_dicts,
        "definition_of_done": {"criteria": plan.acceptance_criteria},
        "loop_count": state.get("loop_count", 0) + 1,
        "dialogue_history": dialogue_history + [
            {"role": "drafter", "content": drafter_summary}
        ]
    }

async def grounding_node(state: ArchitectState):
    """
    Phase 3: Validation with conversational feedback (async for streaming).
    Flash validates the manifest and provides structured feedback.
    """
    manifest = state.get("draft_manifest", [])
    repo_truth = state.get("repo_structure", "")
    dialogue_history = state.get("dialogue_history", []) or []
    
    # Build context from drafter's rationales
    rationales_text = "\n".join([
        f"- {f.get('path')}: [{f.get('operation')}] {f.get('rationale', 'No rationale given')}" 
        for f in manifest
    ])
    
    # Programmatic file existence verification (bypasses truncated repo tree)
    file_existence_checks = []
    for f in manifest:
        file_path = f.get('path')
        if file_path:
            exists = os.path.exists(file_path)
            status = "EXISTS" if exists else "DOES NOT EXIST"
            file_existence_checks.append(f"- {file_path}: {status}")
    existence_text = "\n".join(file_existence_checks) if file_existence_checks else "(no files to verify)"
    
    # Format previous dialogue for context
    dialogue_text = "\n".join([
        f"{turn['role'].upper()}: {turn['content']}" 
        for turn in dialogue_history
    ]) if dialogue_history else "(First iteration)"
    
    prompt = f"""
    You are the Feasibility Officer validating the Architect's implementation plan.
    
    ## MANIFEST WITH RATIONALES:
    {rationales_text}
    
    ## DISK VERIFICATION (AUTHORITATIVE — TRUST THIS OVER REPO TREE):
    {existence_text}
    
    ## ACTUAL REPO FILE TREE (may be truncated, use only for context):
    {repo_truth[:15000]}
    
    ## PREVIOUS DIALOGUE:
    {dialogue_text}
    
    VALIDATION RULES:
    1. MODIFY files: Must say "EXISTS" in DISK VERIFICATION above. If it says EXISTS, ACCEPT it regardless of the repo tree.
    2. NEW files: Must say "DOES NOT EXIST" in DISK VERIFICATION. If it says DOES NOT EXIST, ACCEPT it.
    3. DELETE files: Must say "EXISTS" in DISK VERIFICATION.
    4. The repo tree may be truncated. NEVER reject based on a file missing from the tree if DISK VERIFICATION says it EXISTS.
    
    CRITICAL INSTRUCTIONS:
    - Consider the drafter's RATIONALE before rejecting.
    - If the rationale explains why a file is NEW (e.g., "greenfield project"), ACCEPT it.
    - If rejecting, provide SPECIFIC suggestions for how to fix each issue.
    - State your understanding of their intent in 'understood_intent' to prevent miscommunication.
    - Be lenient for scaffolding scenarios where all files are legitimately NEW.
    
    Return GroundingReport.
    """
    
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("grounder_model")
    if override:
        from model_config import get_custom_model
        base_llm = get_custom_model(override, temperature=0)
    else:
        base_llm = llm_grounder
    structured_llm = base_llm.with_structured_output(GroundingReport)
    result = await structured_llm.ainvoke(prompt)
    
    if result.is_valid:
        return {
            "final_spec": state["draft_spec"],
            "final_manifest": state["draft_manifest"],
            "grounding_errors": [],
            "dialogue_history": dialogue_history + [
                {"role": "grounder", "content": f"APPROVED. {result.understood_intent}"}
            ]
        }
    else:
        # Structured feedback for the drafter to learn from
        feedback = f"REJECTED. My understanding: {result.understood_intent}\n\n"
        feedback += f"Issues: {result.issues}\n\n"
        feedback += f"Suggestions: {result.suggestions}"
        
        return {
            "grounding_errors": result.issues,
            "dialogue_history": dialogue_history + [
                {"role": "grounder", "content": feedback}
            ]
        }


def escalation_node(state: ArchitectState):
    """
    Called when max retries exceeded. Logs dialogue and returns error.
    """
    dialogue_history = state.get("dialogue_history", []) or []
    
    # Log the full dialogue for debugging
    print(f"[ARCHITECT] Max retries exceeded after {state.get('loop_count', 0)} attempts.")
    print("[ARCHITECT] Full dialogue history:")
    for turn in dialogue_history:
        print(f"  {turn['role'].upper()}: {turn['content'][:300]}...")
    
    # Return with draft_spec fallback — the draft was good enough to stream,
    # so it's better than returning None and losing the plan entirely
    return {
        "final_spec": state.get("draft_spec"),
        "final_manifest": state.get("draft_manifest"),
        "grounding_errors": [
            f"Architect failed after {state.get('loop_count', 0)} attempts. "
            "The drafter and grounder could not reach agreement. "
            "Using draft spec as fallback. Review the dialogue history for details."
        ]
    }

# --- ROUTER & GRAPH ---

def route_architect(state: ArchitectState):
    # Safety Valve - route to escalation instead of silent END
    if state.get("loop_count", 0) > 3:
        return "escalation"
        
    # Validation Failure Loop - drafter gets another chance
    if state.get("grounding_errors"):
        return "drafter" 
        
    # Success
    if state.get("final_spec"):
        return END
        
    # Exploration Loop
    last_msg = state["messages"][-1]
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        return "tools"
        
    if "READY_TO_DRAFT" in str(last_msg.content):
        return "drafter"
        
    return "cartographer"  # Continue exploring

def compile_architect_graph():
    workflow = StateGraph(ArchitectState)

    workflow.add_node("cartographer", cartographer_node)
    workflow.add_node("drafter", drafter_node)
    workflow.add_node("grounding", grounding_node)
    workflow.add_node("escalation", escalation_node)
    workflow.add_node("tools", ToolNode(_architect_tools))

    workflow.add_edge(START, "cartographer")
    
    workflow.add_conditional_edges("cartographer", route_architect, {
        "tools": "tools",
        "drafter": "drafter",
        "cartographer": "cartographer",
        "escalation": "escalation",
        END: END
    })
    
    workflow.add_edge("tools", "cartographer")
    workflow.add_edge("drafter", "grounding")
    
    workflow.add_conditional_edges("grounding", route_architect, {
        "drafter": "drafter",
        "escalation": "escalation",
        END: END
    })
    
    # Escalation always ends the graph
    workflow.add_edge("escalation", END)

    return workflow.compile()
