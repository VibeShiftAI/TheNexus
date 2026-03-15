"""
Documentation Writer Workflow - Lightweight LangGraph for .context/ and .md file updates.

Architecture:
    START -> explore_docs -> draft_docs -> review_docs (INTERRUPT) -> write_docs -> END
                                              |                           ^
                                              +--- (revise hunks) --------+

Bypasses the Architect fleet's Drafter/Grounder validation loop entirely.
Produces a diff-based review artifact with per-hunk approve/reject/revise controls.
"""

import os
import uuid
import json
import re
import difflib
from typing import Literal
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.messages import AIMessage, HumanMessage

from workflow_state import WorkflowState
from model_config import get_gemini_flash, get_gemini_pro
from tools import get_registry

# Models
llm_explorer = get_gemini_flash(temperature=0)
llm_drafter = get_gemini_pro(temperature=0.2)

# Tools from unified registry
_registry = get_registry()
_doc_tools = _registry.get_langchain_tools([
    "read_file",
    "list_directory",
    "get_project_context",
    "git_log",
    "search_codebase",
])


# ═══════════════════════════════════════════════════════════════
# HELPER: Generate hunks from original vs proposed
# ═══════════════════════════════════════════════════════════════

def _generate_hunks(original: str, proposed: str) -> list:
    """Generate diff hunks between original and proposed content."""
    if original is None:
        # New file — entire content is one hunk
        return [{
            "id": f"h-{uuid.uuid4().hex[:8]}",
            "start_line": 1,
            "original_lines": [],
            "proposed_lines": proposed.splitlines(),
            "context": "New file",
            "status": "pending",
            "revision_comment": None
        }]
    
    orig_lines = original.splitlines()
    prop_lines = proposed.splitlines()
    
    matcher = difflib.SequenceMatcher(None, orig_lines, prop_lines)
    hunks = []
    
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            continue
        hunks.append({
            "id": f"h-{uuid.uuid4().hex[:8]}",
            "start_line": i1 + 1,
            "original_lines": orig_lines[i1:i2],
            "proposed_lines": prop_lines[j1:j2],
            "context": f"{tag}: lines {i1+1}-{i2} → {j1+1}-{j2}",
            "status": "pending",
            "revision_comment": None
        })
    
    # If no differences found, return empty
    return hunks


# ═══════════════════════════════════════════════════════════════
# NODE 1: EXPLORE
# ═══════════════════════════════════════════════════════════════

async def explore_docs(state: WorkflowState):
    """
    Explore the codebase to understand what documentation exists and what needs updating.
    Uses tools to read existing .context/ files, git history, and project structure.
    """
    context = state.get("context", {})
    project_path = context.get("project_path", ".")
    task_description = context.get("task_description", "Update documentation")
    
    # Gather existing documentation
    doc_files = {}
    context_dir = os.path.join(project_path, ".context")
    
    # Read all .context/ files if directory exists
    if os.path.isdir(context_dir):
        for filename in os.listdir(context_dir):
            if filename.endswith((".md", ".txt")):
                filepath = os.path.join(context_dir, filename)
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        doc_files[filepath] = f.read()
                except Exception as e:
                    print(f"[DocWorkflow] Could not read {filepath}: {e}")
    
    # Also check for README.md and other top-level docs
    for doc_name in ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "docs"]:
        doc_path = os.path.join(project_path, doc_name)
        if os.path.isfile(doc_path) and doc_name.endswith(".md"):
            try:
                with open(doc_path, "r", encoding="utf-8") as f:
                    doc_files[doc_path] = f.read()
            except Exception:
                pass
    
    # Use LLM with tools for deeper exploration if needed
    exploration_prompt = f"""You are exploring a codebase to prepare for a documentation task.

TASK: {task_description}
PROJECT ROOT: {project_path}

EXISTING DOCUMENTATION FILES FOUND:
{chr(10).join(f'- {path} ({len(content)} chars)' for path, content in doc_files.items())}

Use your tools to:
1. Call get_project_context to see the full .context/ documentation
2. Call git_log to see recent changes that might need documenting
3. Call search_codebase if you need to find specific patterns

Reply with a summary of what you found and what documentation changes are needed.
"""
    
    model = llm_explorer.bind_tools(_doc_tools)
    messages = [HumanMessage(content=exploration_prompt)]
    
    # Run tool loop (max 5 iterations)
    for _ in range(5):
        response = await model.ainvoke(messages)
        messages.append(response)
        
        if not response.tool_calls:
            break
        
        # Execute tools
        from langgraph.prebuilt import ToolNode
        tool_node = ToolNode(_doc_tools)
        tool_results = await tool_node.ainvoke({"messages": messages})
        messages.extend(tool_results.get("messages", []))
    
    # Store exploration results
    exploration_summary = response.content if hasattr(response, 'content') else str(response)
    
    return {
        "outputs": {
            **state.get("outputs", {}),
            "doc_exploration": {
                "existing_files": {path: content for path, content in doc_files.items()},
                "summary": exploration_summary,
            }
        },
        "messages": [AIMessage(content=f"[Doc Explorer] {exploration_summary[:500]}")]
    }


# ═══════════════════════════════════════════════════════════════
# NODE 2: DRAFT
# ═══════════════════════════════════════════════════════════════

async def draft_docs(state: WorkflowState):
    """
    Draft documentation changes. Produces a doc_changes artifact with hunks.
    On revision loops, only regenerates hunks marked 'revise'.
    """
    context = state.get("context", {})
    outputs = state.get("outputs", {})
    exploration = outputs.get("doc_exploration", {})
    existing_files = exploration.get("existing_files", {})
    exploration_summary = exploration.get("summary", "")
    task_description = context.get("task_description", "Update documentation")
    project_path = context.get("project_path", ".")
    
    # Check if this is a revision loop
    previous_changes = outputs.get("doc_changes", {}).get("files", [])
    revision_hunks = []
    for file_entry in previous_changes:
        for hunk in file_entry.get("hunks", []):
            if hunk.get("status") == "revise":
                revision_hunks.append({
                    "file_path": file_entry["path"],
                    "hunk": hunk
                })
    
    if revision_hunks:
        # Revision mode: only regenerate specific hunks
        revision_context = "\n".join([
            f"File: {rh['file_path']}, Hunk {rh['hunk']['id']}:\n"
            f"  Original: {rh['hunk']['original_lines']}\n"
            f"  Previous proposal: {rh['hunk']['proposed_lines']}\n"
            f"  Revision request: {rh['hunk']['revision_comment']}"
            for rh in revision_hunks
        ])
        
        prompt = f"""You previously drafted documentation changes that need revision.

REVISION REQUESTS:
{revision_context}

For each hunk that needs revision, provide the corrected proposed_lines.
Return a JSON array of objects: [{{"hunk_id": "...", "proposed_lines": [...]}}]
Return ONLY the JSON array, no other text.
"""
    else:
        # Initial draft mode
        existing_docs_text = "\n\n---\n\n".join([
            f"FILE: {path}\n```\n{content}\n```"
            for path, content in existing_files.items()
        ]) or "No existing documentation found."
        
        prompt = f"""You are a documentation writer for a software project.

TASK: {task_description}

PROJECT ROOT: {project_path}

EXPLORATION SUMMARY:
{exploration_summary[:3000]}

EXISTING DOCUMENTATION:
{existing_docs_text[:8000]}

INSTRUCTIONS:
1. Generate the updated documentation content for each file that needs changes.
2. For existing files, produce the COMPLETE updated file content (not just the changed parts).
3. For new files, produce the full file content.
4. Only modify .context/ and .md files.

Return a JSON array of objects:
[
  {{
    "path": "absolute/path/to/file.md",
    "action": "update" or "create",
    "content": "full file content here"
  }}
]

Return ONLY the JSON array, no other text.
"""
    
    response = await llm_drafter.ainvoke([HumanMessage(content=prompt)])
    
    # Parse the response
    
    response_text = response.content if hasattr(response, 'content') else str(response)
    
    # Extract JSON from response (handle markdown code blocks)
    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', response_text)
    if json_match:
        json_text = json_match.group(1)
    else:
        json_text = response_text.strip()
    
    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        print(f"[DocWorkflow] Failed to parse draft response as JSON")
        parsed = []
    
    if revision_hunks and parsed:
        # Apply revisions to existing changes
        revision_map = {item["hunk_id"]: item["proposed_lines"] for item in parsed}
        for file_entry in previous_changes:
            for hunk in file_entry.get("hunks", []):
                if hunk["id"] in revision_map:
                    hunk["proposed_lines"] = revision_map[hunk["id"]]
                    hunk["status"] = "pending"
                    hunk["revision_comment"] = None
        
        doc_changes = {"files": previous_changes}
    else:
        # Build fresh doc_changes with hunks
        files = []
        for item in parsed:
            file_path = item.get("path", "")
            action = item.get("action", "update")
            proposed_content = item.get("content", "")
            
            # Get original content
            original_content = existing_files.get(file_path)
            
            # Generate hunks
            hunks = _generate_hunks(original_content, proposed_content)
            
            files.append({
                "path": file_path,
                "action": action,
                "original": original_content,
                "proposed": proposed_content,
                "hunks": hunks
            })
        
        doc_changes = {"files": files}
    
    # Count stats
    total_hunks = sum(len(f.get("hunks", [])) for f in doc_changes["files"])
    total_files = len(doc_changes["files"])
    
    return {
        "outputs": {
            **state.get("outputs", {}),
            "doc_changes": doc_changes,
        },
        # Reset evaluator_decision so route_review evaluates the fresh hunks
        # instead of reading a stale 'complete' from the previous review cycle
        "evaluator_decision": None,
        "messages": [AIMessage(
            content=f"[Doc Drafter] Drafted {total_hunks} changes across {total_files} files. Ready for review."
        )]
    }


# ═══════════════════════════════════════════════════════════════
# NODE 3: REVIEW GATE (Interrupt)
# ═══════════════════════════════════════════════════════════════

async def review_docs(state: WorkflowState):
    """
    Presents the doc_changes artifact for human review.
    Creates a pending_approval with the diff-based artifact.
    The graph will interrupt after this node.
    """
    context = state.get("context", {})
    outputs = state.get("outputs", {})
    doc_changes = outputs.get("doc_changes", {})
    
    total_hunks = sum(len(f.get("hunks", [])) for f in doc_changes.get("files", []))
    total_files = len(doc_changes.get("files", []))
    
    # Sync the doc_changes to the database
    from supervisor.agent import sync_artifacts
    if doc_changes.get("files"):
        await sync_artifacts(context, {"doc_changes": json.dumps(doc_changes)})
    
    # Create artifact for the ArtifactPanel
    artifact = {
        "id": str(uuid.uuid4()),
        "key": "doc_changes",
        "name": "Documentation Changes",
        "content": f"{total_hunks} changes across {total_files} files",
        "content_json": doc_changes,
        "category": "doc_changes",
        "mime_type": "application/json",
        "file_extension": ".json",
        "version": 1,
    }
    
    # Build a readable preview
    preview_lines = []
    for file_entry in doc_changes.get("files", []):
        action_badge = "📝 UPDATE" if file_entry["action"] == "update" else "✨ CREATE"
        hunk_count = len(file_entry.get("hunks", []))
        preview_lines.append(f"{action_badge} {file_entry['path']} ({hunk_count} hunks)")
    
    preview = "\n".join(preview_lines)
    
    return {
        "pending_approval": {
            "gate": "doc_review",
            "artifact_type": "doc_changes",
            "artifact": artifact,
            "artifact_preview": preview,
            "next_phase": "write_docs",
            "message": f"Please review {total_hunks} documentation changes across {total_files} files."
        },
        "messages": [AIMessage(
            content=f"📋 **Documentation Review**\n\n{preview}\n\n"
                    f"Please review the changes in the artifact panel."
        )]
    }


# ═══════════════════════════════════════════════════════════════
# NODE 3.5: ROUTE AFTER REVIEW
# ═══════════════════════════════════════════════════════════════

def route_review(state: WorkflowState) -> Literal["write_docs", "draft_docs"]:
    """
    Route based on review decisions.
    If any hunks are marked 'revise', loop back to draft_docs.
    Otherwise, proceed to write_docs.
    """
    outputs = state.get("outputs", {})
    doc_changes = outputs.get("doc_changes", {})
    
    for file_entry in doc_changes.get("files", []):
        for hunk in file_entry.get("hunks", []):
            if hunk.get("status") == "revise":
                return "draft_docs"
    
    return "write_docs"


# ═══════════════════════════════════════════════════════════════
# NODE 4: WRITE FILES
# ═══════════════════════════════════════════════════════════════

async def write_docs(state: WorkflowState):
    """
    Write approved documentation changes to disk.
    Only writes files where at least one hunk is approved.
    Reconstructs file content from approved hunks.
    """
    outputs = state.get("outputs", {})
    doc_changes = outputs.get("doc_changes", {})
    context = state.get("context", {})
    
    written_files = []
    skipped_files = []
    
    for file_entry in doc_changes.get("files", []):
        path = file_entry["path"]
        hunks = file_entry.get("hunks", [])
        
        # Check if any hunks are approved
        approved_hunks = [h for h in hunks if h.get("status") == "approved"]
        rejected_all = all(h.get("status") == "rejected" for h in hunks)
        
        if rejected_all or not approved_hunks:
            skipped_files.append(path)
            continue
        
        # If all hunks approved, write the full proposed content
        if len(approved_hunks) == len(hunks):
            content = file_entry.get("proposed", "")
        else:
            # Partial approval: reconstruct from original with only approved changes
            original = file_entry.get("original", "") or ""
            orig_lines = original.splitlines()
            result_lines = list(orig_lines)  # start with original
            
            # Apply approved hunks in reverse order to preserve line numbers
            for hunk in sorted(approved_hunks, key=lambda h: h.get("start_line", 0), reverse=True):
                start = hunk["start_line"] - 1
                orig_len = len(hunk.get("original_lines", []))
                result_lines[start:start + orig_len] = hunk.get("proposed_lines", [])
            
            content = "\n".join(result_lines)
        
        # Write the file
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            written_files.append(path)
            print(f"[DocWorkflow] ✅ Wrote: {path}")
        except Exception as e:
            print(f"[DocWorkflow] ❌ Failed to write {path}: {e}")
            skipped_files.append(path)
    
    # Sync completion
    from supervisor.agent import sync_artifacts
    await sync_artifacts(context, {
        "doc_result": json.dumps({
            "written": written_files,
            "skipped": skipped_files
        })
    })
    
    summary = f"Wrote {len(written_files)} files"
    if skipped_files:
        summary += f", skipped {len(skipped_files)}"
    
    return {
        "outputs": {
            **state.get("outputs", {}),
            "doc_result": {
                "written": written_files,
                "skipped": skipped_files
            }
        },
        "messages": [AIMessage(content=f"[Doc Writer] ✅ {summary}")]
    }


# ═══════════════════════════════════════════════════════════════
# ASSEMBLE THE GRAPH
# ═══════════════════════════════════════════════════════════════



def build_doc_graph(checkpointer=None):
    """Build and compile the Documentation Writer workflow graph."""
    builder = StateGraph(WorkflowState)
    
    # Register nodes
    builder.add_node("explore_docs", explore_docs)
    builder.add_node("draft_docs", draft_docs)
    builder.add_node("review_docs", review_docs)
    builder.add_node("write_docs", write_docs)
    
    # Linear flow: explore -> draft -> review -> (conditional) -> write
    builder.add_edge(START, "explore_docs")
    builder.add_edge("explore_docs", "draft_docs")
    builder.add_edge("draft_docs", "review_docs")
    builder.add_conditional_edges(
        "review_docs",
        route_review,
        {
            "write_docs": "write_docs",
            "draft_docs": "draft_docs"
        }
    )
    builder.add_edge("write_docs", END)
    
    # Compile with interrupt after review gate
    if checkpointer is None:
        checkpointer = MemorySaver()
    
    return builder.compile(
        checkpointer=checkpointer,
        interrupt_after=["review_docs"]
    )


# Pre-compiled graph instance
doc_graph = build_doc_graph()
