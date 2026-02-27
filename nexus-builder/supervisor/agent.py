from typing import Annotated, List, Literal, Optional, Any, Dict
import os
import httpx
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from pydantic import BaseModel, Field

# Import WorkflowState (Reuse existing system)
from workflow_state import WorkflowState

# Import tracked LLM factory
from model_config import get_supervisor_llm

# Import Fleets
from researcher.agent import compile_researcher_graph
from architect.agent import compile_architect_graph
from builder.agent import compile_builder_graph
from auditor.agent import compile_auditor_graph

# --- MODELS ---

# THE CEO (Claude Opus 4.5) - now created via factory with tracking
llm_supervisor = get_supervisor_llm()

class SupervisorDecision(BaseModel):
    next_phase: Literal["research_fleet", "architect_fleet", "builder_fleet", "audit_fleet", "human_help", "finish"]
    status_message: str = Field(description="User-facing dashboard update string.")
    status_color: Literal["green", "yellow", "red"]
    reasoning: str

# --- HUMAN APPROVAL GATES ---

async def await_research_approval(state: WorkflowState):
    """
    Human Approval Gate: Review research report before sending to Architect.
    This node interrupts execution and waits for human review.
    """
    context = state.get("context", {})
    outputs = state.get("outputs", {})
    dossier = outputs.get("research_dossier", "No research available")
    
    # Defensive: normalize content if it came as Gemini parts list
    if isinstance(dossier, list):
        text_parts = []
        for part in dossier:
            if isinstance(part, dict) and part.get("type") == "text":
                text_parts.append(part["text"])
            elif isinstance(part, str):
                text_parts.append(part)
        dossier = "\n".join(text_parts)
    
    # Sync the research to the database so the frontend can display it
    # ALWAYS update status to 'researched' when entering approval gate
    # This ensures the modal shows approval UI instead of workflow selector
    
    # Ensure we always have meaningful content for the frontend
    research_content = dossier
    if not dossier or dossier == "No research available":
        research_content = "## Research Skipped\n\nThe research phase determined no external research was needed for this task."
    
    # Use sync_artifacts (which uses /api/langgraph/sync-output) instead of direct PATCH
    # The sync endpoint handles setting research_output + status='researched' automatically
    await sync_artifacts(context, {"research": research_content})
    print(f"[Approval Gate] Synced research to task {context.get('task_id')}")
    
    # Note: Status is already set via the PATCH above, no need to call update_task_status again
    
    # Return state that triggers interrupt
    # CRITICAL: Include full research in AIMessage so frontend StreamingLog can display it
    research_display = f"""## 📚 RESEARCH DOSSIER

{research_content}

---

**[APPROVAL GATE]** Research complete. Waiting for human approval to proceed to planning phase.
"""
    
    # Create artifact object for frontend ArtifactPanel
    import uuid
    artifact = {
        "id": str(uuid.uuid4()),
        "key": "research_dossier",
        "name": "Research Dossier",
        "content": research_content,
        "content_json": None,
        "category": "research",
        "mime_type": "text/markdown",
        "file_extension": ".md",
        "version": 1,
    }
    
    return {
        "pending_approval": {
            "gate": "research_approval",
            "artifact_type": "research_dossier",
            "artifact": artifact,  # Full artifact for ArtifactPanel
            "artifact_preview": dossier[:500] if isinstance(dossier, str) else str(dossier)[:500],
            "next_phase": "architect_fleet",
            "message": "Please review the research report before it is sent to the planning agent."
        },
        "messages": [AIMessage(content=research_display)]
    }

async def await_plan_approval(state: WorkflowState):
    """
    Human Approval Gate: Review architectural plan before sending to Builder.
    This node interrupts execution and waits for human review.
    """
    context = state.get("context", {})
    outputs = state.get("outputs", {})
    blueprint = outputs.get("blueprint", {})
    plan_content = blueprint.get("spec_markdown", "No plan available") if isinstance(blueprint, dict) else str(blueprint)
    
    # Sync the plan to the database so the frontend can display it
    # Use sync_artifacts (which uses /api/langgraph/sync-output) instead of direct PATCH
    # The sync endpoint handles setting plan_output + status='planned' automatically
    if plan_content and plan_content != "No plan available":
        await sync_artifacts(context, {"plan": plan_content})
        print(f"[Approval Gate] Synced plan to task {context.get('task_id')}")
    
    # Note: Status is already set via the PATCH above, no need to call update_task_status again
    
    # Return state that triggers interrupt
    # CRITICAL: Include full plan in AIMessage so frontend StreamingLog can display it
    plan_display = f"""## 🏗️ IMPLEMENTATION PLAN

{plan_content}

---

**[APPROVAL GATE]** Plan complete. Waiting for human approval to proceed to coding phase.
"""
    
    # Create artifact object for frontend ArtifactPanel
    import uuid
    artifact = {
        "id": str(uuid.uuid4()),
        "key": "implementation_plan",
        "name": "Implementation Plan",
        "content": plan_content,
        "content_json": None,
        "category": "plan",
        "mime_type": "text/markdown",
        "file_extension": ".md",
        "version": 1,
    }
    
    return {
        "pending_approval": {
            "gate": "plan_approval",
            "artifact_type": "blueprint",
            "artifact": artifact,  # Full artifact for ArtifactPanel
            "artifact_preview": plan_content[:500] if isinstance(plan_content, str) else str(plan_content)[:500],
            "next_phase": "builder_fleet",
            "message": "Please review the architectural plan before it is sent to the coding agent."
        },
        "messages": [AIMessage(content=plan_display)]
    }

# --- HELPER: UPDATE DASHBOARD ---

# Maps workflow phase names to valid database task statuses
PHASE_TO_STATUS = {
    "research_fleet": "researching",
    "architect_fleet": "planning",
    "builder_fleet": "implementing",
    "audit_fleet": "testing",
    "human_help": "implementing",  # Preserve progress - don't regress to 'idea'
    "finish": "complete",
    # Fallbacks for raw phase names (from split)
    "research": "researching",
    "architect": "planning",
    "builder": "implementing",
    "audit": "testing",
    "human": "implementing",  # Preserve progress - don't regress to 'idea'
}

async def update_task_status(context: Dict, status: str, message: str):
    """Updates the Task in the Node.js Task Manager."""
    task_id = context.get("task_id")
    if not task_id:
        return
    
    # Map workflow phase to valid database status
    mapped_status = PHASE_TO_STATUS.get(status, status)
        
    url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
    service_key = os.getenv("SUPABASE_SERVICE_KEY")
    headers = {"Authorization": f"Bearer {service_key}"} if service_key else {}
    try:
        async with httpx.AsyncClient() as client:
            await client.patch(
                f"{url}/api/tasks/{task_id}",
                json={
                    "status": mapped_status, 
                    "status_message": message
                },
                headers=headers
            )
    except Exception as e:
        print(f"[Supervisor] Failed to update task status: {e}")

# --- NODES ---

# --- HELPER: SYNC ARTIFACTS ---
async def sync_artifacts(context: Dict, outputs: Dict):
    """Syncs artifacts to the Node.js backend via /api/langgraph/sync-output"""
    task_id = context.get("task_id")
    if not task_id:
        return

    url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{url}/api/langgraph/sync-output",
                json={
                    "task_id": task_id,
                    "outputs": outputs,
                    # Optional context
                    "project_id": context.get("project_id"),
                    "run_id": context.get("run_id") 
                },
                timeout=10.0
            )
            print(f"[Supervisor] Synced artifacts for {task_id}")
    except Exception as e:
        print(f"[Supervisor] ⚠️ CRITICAL: Failed to sync artifacts for {task_id}: {e}")
        import traceback
        traceback.print_exc()

# --- NODES ---

async def supervisor_node(state: WorkflowState):
    """
    Mission Control with Translation Layer.
    Maps complex SupervisorDecision to simple Global Protocol.
    
    Uses DETERMINISTIC routing for critical decision points (audit verdicts)
    to avoid LLM non-determinism causing loops.
    """
    outputs = state.get("outputs", {})
    context = state.get("context", {})
    
    # 1. Analyze Artifact Vault (using contract-compliant keys)
    dossier = outputs.get("research_dossier")
    blueprint = outputs.get("blueprint")  # BLUEPRINT object from Architect
    source_artifacts = outputs.get("source_artifacts")  # From Builder
    audit = outputs.get("audit_report")  # VERDICT from Auditor
    
    retry_count = state.get("retry_count", 0)
    
    # DEBUG: Log artifact state for routing diagnosis
    print(f"[Supervisor] === ROUTING DECISION ===")
    print(f"[Supervisor]   dossier: {'YES' if dossier else 'NO'}")
    print(f"[Supervisor]   blueprint: {'YES' if blueprint else 'NO'}")
    print(f"[Supervisor]   source_artifacts: {'YES' if source_artifacts else 'NO'} (value: {type(source_artifacts).__name__})")
    print(f"[Supervisor]   audit: {'YES' if audit else 'NO'}")
    print(f"[Supervisor]   outputs keys: {list(outputs.keys())}")
    
    # ═══════════════════════════════════════════════════════════════
    # DETERMINISTIC SHORT-CIRCUIT: Audit verdicts are FINAL
    # This avoids LLM non-determinism causing loops after audit
    # ═══════════════════════════════════════════════════════════════
    
    if audit and audit.get("status") == "APPROVED":
        # Check if builder already produced a walkthrough
        walkthrough = outputs.get("walkthrough", "")
        if not walkthrough:
            sa = outputs.get("source_artifacts", {})
            if isinstance(sa, dict):
                walkthrough = sa.get("walkthrough", "")
        
        if walkthrough:
            print(f"[Supervisor] Audit APPROVED + walkthrough exists ({len(walkthrough)} chars) - routing to finish")
            return {
                "evaluator_decision": "finish",
                "nexus_protocol_extensions": {
                    "status_update": "Task completed successfully!",
                    "status_color": "green",
                    "reasoning": "Audit approved all changes - walkthrough already generated by builder."
                },
                "retry_count": retry_count,
                "messages": [AIMessage(content="Supervisor Decision: finish (Audit APPROVED, walkthrough present)")]
            }
        else:
            print(f"[Supervisor] Audit APPROVED but NO walkthrough - routing to walkthrough generator")
            return {
                "evaluator_decision": "walkthrough_generator",
                "nexus_protocol_extensions": {
                    "status_update": "Generating walkthrough...",
                    "status_color": "green",
                    "reasoning": "Audit approved but builder did not produce a walkthrough - generating one."
                },
                "retry_count": retry_count,
                "messages": [AIMessage(content="Supervisor Decision: walkthrough_generator (Audit APPROVED, no walkthrough)")]
            }
    
    if audit and audit.get("status") == "REJECTED":
        if retry_count >= 3:
            print(f"[Supervisor] Audit REJECTED but max retries reached - routing to human_help")
            return {
                "evaluator_decision": "human_help",
                "nexus_protocol_extensions": {
                    "status_update": "Max retries reached - needs human intervention",
                    "status_color": "red",
                    "reasoning": f"Audit rejected {retry_count} times. Manual fix required."
                },
                "retry_count": retry_count,
                "messages": [AIMessage(content=f"Supervisor Decision: human_help (Max retries reached after {retry_count} attempts)")]
            }
        
        print(f"[Supervisor] Audit REJECTED - deterministic route back to builder (retry {retry_count + 1}/3)")
        return {
            "evaluator_decision": "builder_fleet",
            "nexus_protocol_extensions": {
                "status_update": f"Fixing issues from audit (attempt {retry_count + 1}/3)",
                "status_color": "yellow",
                "reasoning": f"Audit rejected: {audit.get('blocking_issues', [])}"
            },
            "retry_count": retry_count + 1,
            "messages": [AIMessage(content=f"Supervisor Decision: builder_fleet (Audit REJECTED - fixing issues, attempt {retry_count + 1})")]
        }
    
    # Handle FAILED or UNKNOWN audit status (system error, not a real rejection)
    # The audit process crashed (e.g., recursion limit), but the builder's cross-provider
    # check already passed. Check if human already approved to break the loop.
    if audit and audit.get("status") in ["FAILED", "UNKNOWN"]:
        # Check if human has already approved (prevents infinite human_help loop)
        extensions = state.get("nexus_protocol_extensions", {})
        status_update = extensions.get("status_update", "") if isinstance(extensions, dict) else ""
        last_messages = state.get("messages", [])
        human_approved = any(
            "APPROVED" in str(getattr(m, 'content', '')) or "Human Approved" in str(getattr(m, 'content', ''))
            for m in (last_messages[-3:] if last_messages else [])
        )
        
        if human_approved:
            # Check if builder already produced a walkthrough
            walkthrough = outputs.get("walkthrough", "")
            if not walkthrough:
                sa = outputs.get("source_artifacts", {})
                if isinstance(sa, dict):
                    walkthrough = sa.get("walkthrough", "")
            
            if walkthrough:
                print(f"[Supervisor] Human approved + walkthrough exists - routing to finish")
                return {
                    "evaluator_decision": "finish",
                    "nexus_protocol_extensions": {
                        "status_update": "Completed (human override)",
                        "status_color": "green",
                        "reasoning": "Audit had a system error but human approved. Walkthrough already exists."
                    },
                    "retry_count": retry_count,
                    "messages": [AIMessage(content="Supervisor Decision: finish (Human override, walkthrough present)")]
                }
            else:
                print(f"[Supervisor] Human approved but NO walkthrough - routing to walkthrough generator")
                return {
                    "evaluator_decision": "walkthrough_generator",
                    "nexus_protocol_extensions": {
                        "status_update": "Generating walkthrough (human override)...",
                        "status_color": "green",
                        "reasoning": "Human approved but no walkthrough from builder - generating one."
                    },
                    "retry_count": retry_count,
                    "messages": [AIMessage(content="Supervisor Decision: walkthrough_generator (Human override, no walkthrough)")]
                }
        
        print(f"[Supervisor] Audit FAILED/UNKNOWN - routing to human_help")
        return {
            "evaluator_decision": "human_help",
            "nexus_protocol_extensions": {
                "status_update": "Audit system error - needs human review",
                "status_color": "red",
                "reasoning": f"Audit returned {audit.get('status')}: {audit.get('reasoning', 'Unknown error')}"
            },
            "retry_count": retry_count,
            "messages": [AIMessage(content=f"Supervisor Decision: human_help (Audit {audit.get('status')})")]
        }
    
    # ═══════════════════════════════════════════════════════════════
    # DETERMINISTIC SHORT-CIRCUIT: Standard Workflow Progression
    # The workflow follows a linear path: research -> architect -> builder -> audit -> finish
    # Using deterministic routing prevents LLM non-determinism from causing loops
    # ═══════════════════════════════════════════════════════════════
    
    if not dossier:
        print(f"[Supervisor] No research dossier - deterministic route to research_fleet")
        await update_task_status(context, "research", "Starting research phase...")
        return {
            "evaluator_decision": "research_fleet",
            "nexus_protocol_extensions": {
                "status_update": "Starting research phase",
                "status_color": "yellow",
                "reasoning": "No research dossier found - beginning research."
            },
            "retry_count": retry_count,
            "messages": [AIMessage(content="Supervisor Decision: research_fleet (no research dossier)")]
        }
    
    if not blueprint:
        print(f"[Supervisor] No blueprint - deterministic route to architect_fleet")
        await update_task_status(context, "architect", "Starting planning phase...")
        return {
            "evaluator_decision": "architect_fleet",
            "nexus_protocol_extensions": {
                "status_update": "Starting planning phase",
                "status_color": "yellow",
                "reasoning": "Research complete but no blueprint - beginning architecture."
            },
            "retry_count": retry_count,
            "messages": [AIMessage(content="Supervisor Decision: architect_fleet (no blueprint)")]
        }
    
    if not source_artifacts:
        print(f"[Supervisor] No source artifacts - deterministic route to builder_fleet")
        await update_task_status(context, "builder", "Starting implementation phase...")
        return {
            "evaluator_decision": "builder_fleet",
            "nexus_protocol_extensions": {
                "status_update": "Starting implementation phase",
                "status_color": "yellow",
                "reasoning": "Blueprint ready but no source artifacts - beginning implementation."
            },
            "retry_count": retry_count,
            "messages": [AIMessage(content="Supervisor Decision: builder_fleet (no source artifacts)")]
        }
    
    if not audit:
        print(f"[Supervisor] Source artifacts ready, no audit - deterministic route to audit_fleet")
        await update_task_status(context, "audit", "Starting audit phase...")
        return {
            "evaluator_decision": "audit_fleet",
            "nexus_protocol_extensions": {
                "status_update": "Starting audit phase",
                "status_color": "yellow",
                "reasoning": "Implementation complete - beginning audit."
            },
            "retry_count": retry_count,
            "messages": [AIMessage(content="Supervisor Decision: audit_fleet (source artifacts ready, no audit yet)")]
        }
    
    # ═══════════════════════════════════════════════════════════════
    # LLM-BASED ROUTING: Only for truly ambiguous situations
    # (All deterministic paths exhausted above)
    # ═══════════════════════════════════════════════════════════════
    
    # 2. Construct Decision Context
    ctx = f"""
    PROJECT DASHBOARD:
    - Task: {context.get('task_title', 'Unknown')}
    - Retries: {retry_count}/3
    
    ARTIFACTS:
    - Research Dossier: {"✅" if dossier else "❌"}
    - Blueprint: {"✅" if blueprint else "❌"}
    - Source Artifacts: {"✅" if source_artifacts else "❌"}
    - Audit Verdict: {audit.get('status', 'N/A') if audit else 'N/A'}
    
    DECISION LOGIC:
    1. If NO Research -> 'research_fleet'
    2. If NO Blueprint -> 'architect_fleet'
    3. If NO Source Artifacts -> 'builder_fleet'
    4. If NO Audit -> 'audit_fleet'
    5. If Audit == REJECTED -> 'builder_fleet' (Increment Retry)
    6. If Audit == APPROVED -> 'finish'
    
    If >3 retries, route to 'human_help'.
    """
    
    # 3. Get Decision (tracking handled automatically by callback)
    model = llm_supervisor.with_structured_output(SupervisorDecision)
    decision = await model.ainvoke(state["messages"] + [HumanMessage(content=ctx)])
    
    # 4. Side Effect: Update Dashboard
    await update_task_status(
        context, 
        decision.next_phase.split('_')[0], 
        decision.status_message
    )
    
    # 5. Translation Layer: Map Complex Decision to Global Protocol
    # Determine if this is a retry to builder
    is_builder_retry = (decision.next_phase == "builder_fleet" and 
                        audit and audit.get("status") == "REJECTED")

    return {
        # Routing Flag (simple protocol)
        "evaluator_decision": decision.next_phase,
        
        # Dashboard Updates (Nexus Protocol Extension)
        "nexus_protocol_extensions": {
            "status_update": decision.status_message,
            "status_color": decision.status_color,
            "reasoning": decision.reasoning
        },
        
        # Retry Logic: Increment only when routing back to builder after rejection
        "retry_count": retry_count + 1 if is_builder_retry else retry_count,
        
        "messages": [AIMessage(content=f"Supervisor Decision: {decision.next_phase} ({decision.reasoning})")]
    }

# --- FLEET WRAPPERS (Safety & Mapping) ---

def _read_project_contexts(project_path: str) -> str:
    """Read all context markdown files from the project's supervisor/ directory.
    
    Returns combined markdown content from files like:
    - product.md (Product Vision)
    - tech-stack.md (Technology choices)
    - product-guidelines.md (Design principles)
    - workflow.md (Team processes)
    """
    import os
    supervisor_dir = os.path.join(project_path, "supervisor")
    context_parts = []
    
    if os.path.isdir(supervisor_dir):
        for filename in sorted(os.listdir(supervisor_dir)):
            if filename.endswith('.md'):
                filepath = os.path.join(supervisor_dir, filename)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        content = f.read()
                    # Use filename (without .md) as section header
                    section_name = filename.replace('.md', '').replace('-', ' ').title()
                    context_parts.append(f"## {section_name}\n{content}")
                except Exception as e:
                    print(f"[Supervisor] Warning: Could not read {filepath}: {e}")
    
    return "\n\n".join(context_parts) if context_parts else "No project context documents found."

async def call_research_fleet(state: WorkflowState):
    """Research Fleet Wrapper - produces RESEARCH_DOSSIER artifact.
    
    Enhanced to provide rich project context including:
    - Task title and description
    - Project context documents (from supervisor/*.md)
    """
    try:
        context = state.get("context", {})
        project_path = context.get("project_path", ".")
        
        # Gather project context documents
        project_context = _read_project_contexts(project_path)
        
        print(f"[Research Fleet] Loading context for task: {context.get('task_title', 'Unknown')}")
        print(f"[Research Fleet] Project context length: {len(project_context)} chars")
        
        inputs = {
            "messages": [], 
            "user_request": context.get("task_description", "Research task"),
            # Enhanced context fields
            "task_title": context.get("task_title", "Unknown Task"),
            "project_context": project_context,
            # Existing fields
            "proposed_queries": [],
            "is_plan_approved": False,
            "critique": "",
            "final_dossier": ""
        }
        graph = compile_researcher_graph()
        result = await graph.ainvoke(inputs)
        
        dossier = result.get("final_dossier")
        
        # CRITICAL: Always produce a truthy dossier so the supervisor 
        # doesn't loop back to research_fleet indefinitely
        if not dossier:
            dossier = "## Research Complete\n\nThe research phase determined no additional external research was needed for this task. Proceed with planning based on existing knowledge and project context."
        
        # Sync artifact
        await sync_artifacts(state["context"], {"research": dossier})
            
        return {
            "outputs": {**state.get("outputs", {}), "research_dossier": dossier}
        }
    except Exception as e:
        # Even on failure, produce a dossier so the workflow progresses
        fallback_dossier = f"## Research Phase Error\n\nThe research fleet encountered an error: {e}\n\nProceeding with planning based on existing knowledge."
        return {
            "messages": [AIMessage(content=f"Research Fleet Failed: {e}")],
            "outputs": {**state.get("outputs", {}), "research_dossier": fallback_dossier}
        }


async def call_architect_fleet(state: WorkflowState):
    """Architect Fleet Wrapper - produces BLUEPRINT artifact.
    
    Enhanced to provide rich context including:
    - Task title and original description
    - Research dossier from Phase 0
    - Project context documents (from supervisor/*.md)
    - Repository structure for file operations
    """
    try:
        from architect.tools import ArchitectTools
        context = state.get("context", {})
        project_root = context.get("project_path", ".")
        
        # Gather project context documents (reuse helper from research fleet)
        project_context = _read_project_contexts(project_root)
        
        print(f"[Architect Fleet] Loading context for task: {context.get('task_title', 'Unknown')}")
        print(f"[Architect Fleet] Project context length: {len(project_context)} chars")
        
        inputs = {
            "messages": [],
            # Enhanced context fields
            "task_title": context.get("task_title", "Unknown Task"),
            "task_description": context.get("task_description", ""),
            "project_context": project_context,
            # Research output as primary input
            "user_request": state["outputs"].get("research_dossier", "No research"),
            # Existing fields
            "project_root": project_root,  # CRITICAL: Pass absolute path for file operations
            "repo_structure": ArchitectTools.get_repo_structure(project_root),
            "thought_signature": "",
            "draft_spec": None,
            "draft_manifest": None,
            "final_spec": None,
            "final_manifest": None,
            "definition_of_done": None,
            "grounding_errors": [],
            "loop_count": 0
        }
        graph = compile_architect_graph()
        result = await graph.ainvoke(inputs)
        
        # ARTIFACT CONTRACT: Produce BLUEPRINT object
        blueprint = {
            "spec_markdown": result.get("final_spec"),
            "manifest_json": result.get("final_manifest"),
            "dod_json": result.get("definition_of_done")

        }
        
        # Sync artifact (Plan is the spec_markdown)
        if blueprint["spec_markdown"]:
             await sync_artifacts(state["context"], {"plan": blueprint["spec_markdown"]})
        
        return {
            "outputs": {
                **state.get("outputs", {}), 
                "blueprint": blueprint,
                # Legacy support
                "plan": result.get("final_spec"),
                "target_files": result.get("final_manifest")
            }
        }
    except Exception as e:
        return {"messages": [AIMessage(content=f"Architect Fleet Failed: {e}")]}

async def call_builder_fleet(state: WorkflowState):
    """Builder Fleet Wrapper - produces SOURCE_ARTIFACTS.
    
    Enhanced to provide rich context including:
    - Task title and original description
    - Project context documents (from supervisor/*.md)
    - Full blueprint with spec, manifest, and definition of done
    """
    try:
        context = state.get("context", {})
        project_root = context.get("project_path", ".")
        
        # Gather project context documents
        project_context = _read_project_contexts(project_root)
        
        # Extract full blueprint from outputs
        blueprint = state["outputs"].get("blueprint", {})
        spec_markdown = blueprint.get("spec_markdown") or state["outputs"].get("plan", "")
        manifest = blueprint.get("manifest_json", [])  # List of file operations
        definition_of_done = blueprint.get("dod_json", {})
        
        # Inject negative constraints from previous audit if this is a retry
        negative_constraints = state.get("negative_constraints", [])
        
        print(f"[Builder Fleet] Loading context for task: {context.get('task_title', 'Unknown')}")
        print(f"[Builder Fleet] Project context length: {len(project_context)} chars")
        print(f"[Builder Fleet] Blueprint manifest has {len(manifest)} file operations")
        
        inputs = {
            "messages": [],
            # Enhanced context fields
            "task_title": context.get("task_title", "Unknown Task"),
            "task_description": context.get("task_description", ""),
            "project_context": project_context,
            # Full blueprint
            "implementation_spec": spec_markdown,
            "file_manifest": manifest,  # NEW: list of {path, operation, rationale}
            "definition_of_done": definition_of_done,  # NEW: acceptance criteria
            # Existing fields
            "repo_skeleton": "",
            "project_root": project_root,
            "modified_files": [],
            "syntax_error": None,
            "thought_signature": "",
            "builder_iteration": 0,  # Track builder tool loops (prevents impl_prompt re-injection)
            # Pass constraints from failed audits
            "negative_constraints": negative_constraints
        }
        
        graph = compile_builder_graph()
        result = await graph.ainvoke(inputs)
        
        print(f"[Builder Fleet] ainvoke complete. Result keys: {list(result.keys()) if result else 'None'}")
        
        # ARTIFACT CONTRACT: Produce SOURCE_ARTIFACTS object
        source_artifacts = {
            "diff_patch": result.get("diff_patch", ""),  # If builder generates this
            "modified_files": result.get("modified_files", []),
            "walkthrough": result.get("walkthrough", "")  # Markdown summary for human review
        }
        
        print(f"[Builder Fleet] source_artifacts: modified_files={len(source_artifacts['modified_files'])}, walkthrough={len(source_artifacts['walkthrough'])} chars")
        
        # Sync walkthrough to database for UI display
        walkthrough = result.get("walkthrough", "")
        if walkthrough:
            await sync_artifacts(state["context"], {"walkthrough": walkthrough})
        
        return_val = {
            "outputs": {
                **state.get("outputs", {}), 
                "source_artifacts": source_artifacts,
                # Legacy support
                "implementation": "Changes applied to file system.",
                "modified_files": result.get("modified_files"),
                "walkthrough": walkthrough  # Also at top level for task sync
            }
        }
        print(f"[Builder Fleet] Returning outputs with keys: {list(return_val['outputs'].keys())}")
        return return_val
    except Exception as e:
        import traceback
        print(f"[Builder Fleet] ❌ EXCEPTION: {e}")
        traceback.print_exc()
        # Still set source_artifacts (empty) so supervisor knows builder ran but failed
        return {
            "messages": [AIMessage(content=f"Builder Fleet Failed: {e}")],
            "outputs": {
                **state.get("outputs", {}),
                "source_artifacts": {"diff_patch": "", "modified_files": [], "walkthrough": "", "error": str(e)}
            }
        }

async def call_audit_fleet(state: WorkflowState):
    """Auditor Fleet Wrapper - produces VERDICT with blocking_issues.
    
    Enhanced to provide rich context including:
    - Task title and description
    - Project context documents (from supervisor/*.md)
    - Definition of done (acceptance criteria)
    - List of modified files for targeted review
    """
    try:
        context = state.get("context", {})
        project_root = context.get("project_path", ".")
        
        # Gather project context documents
        project_context = _read_project_contexts(project_root)
        
        # Extract artifacts from previous phases
        blueprint = state["outputs"].get("blueprint", {})
        source_artifacts = state["outputs"].get("source_artifacts", {})
        definition_of_done = blueprint.get("dod_json", {})
        modified_files = source_artifacts.get("modified_files", [])
        
        print(f"[Audit Fleet] Loading context for task: {context.get('task_title', 'Unknown')}")
        print(f"[Audit Fleet] Project context length: {len(project_context)} chars")
        print(f"[Audit Fleet] Reviewing {len(modified_files)} modified files")
        
        # Generate blast radius if we have modified files
        blast_radius_result = {}
        diff_context = source_artifacts.get("diff_patch", "No diff available")
        
        if modified_files:
            try:
                # Import from standalone tools.py (not tools/ package which shadows it)
                import importlib.util
                import os
                _tools_path = os.path.join(os.path.dirname(__file__), '..', 'tools.py')
                _spec = importlib.util.spec_from_file_location("tools_standalone", os.path.abspath(_tools_path))
                _tools_mod = importlib.util.module_from_spec(_spec)
                _spec.loader.exec_module(_tools_mod)
                bridge = _tools_mod.get_tool_bridge()
                blast_radius_result = await bridge.generate_blast_radius(
                    diff_context, 
                    project_root
                )
            except Exception:
                pass  # Blast radius is optional enhancement
        
        inputs = {
            "messages": [],
            # Enhanced context fields
            "task_title": context.get("task_title", "Unknown Task"),
            "task_description": context.get("task_description", ""),
            "project_context": project_context,
            "definition_of_done": definition_of_done,
            "modified_files": modified_files,
            # Existing fields
            "diff_context": diff_context,
            "blast_radius": blast_radius_result if blast_radius_result.get("success") else {},
            "linter_report": "TODO: Run Linter",
            "implementation_spec": blueprint.get("spec_markdown") or state["outputs"].get("plan"),
            "test_logs": [],
            "final_verdict": {}
        }
        
        graph = compile_auditor_graph()
        print(f"[Audit Fleet] Invoking auditor graph...")
        result = await graph.ainvoke(inputs, config={"recursion_limit": 50})
        print(f"[Audit Fleet] Graph completed, extracting verdict...")
        
        # ARTIFACT CONTRACT: Produce VERDICT with status and blocking_issues
        verdict = result.get("final_verdict", {})
        audit_report = {
            "status": verdict.get("status", "UNKNOWN"),
            "blocking_issues": verdict.get("blocking_issues", []),
            "security_score": verdict.get("security_score"),
            "reasoning": verdict.get("reasoning")
        }
        
        print(f"[Audit Fleet] Verdict: {audit_report.get('status')} - {audit_report.get('reasoning', '')[:100]}")
        
        return {
            "outputs": {
                **state.get("outputs", {}), 
                "audit_report": audit_report
            },
            # CRITICAL: Map blocking issues to negative constraints for Builder retry
            "negative_constraints": audit_report.get("blocking_issues", [])
        }
    except Exception as e:
        print(f"[Audit Fleet] ERROR: {e}")
        # Return a FAILED audit so supervisor doesn't loop back - routes to human_in_loop instead
        return {
            "outputs": {
                **state.get("outputs", {}),
                "audit_report": {
                    "status": "FAILED",
                    "blocking_issues": [f"Audit failed: {str(e)}"],
                    "reasoning": f"Auditor encountered an error: {str(e)}"
                }
            },
            "messages": [AIMessage(content=f"Audit Fleet Failed: {e}")]
        }


async def call_walkthrough_generator(state: WorkflowState):
    """Walkthrough Generator — produces a human-readable walkthrough from all workflow artifacts.
    
    Runs after the audit fleet approves. Uses Gemini Flash to synthesize a structured
    walkthrough from the research dossier, blueprint, builder output, and audit verdict.
    This ensures every completed task has a walkthrough regardless of builder internals.
    """
    from model_config import get_gemini_flash
    
    context = state.get("context", {})
    outputs = state.get("outputs", {})
    
    # Gather all artifacts
    dossier = outputs.get("research_dossier", "")
    blueprint = outputs.get("blueprint", {})
    spec = blueprint.get("spec_markdown", "") if isinstance(blueprint, dict) else str(blueprint)
    source_artifacts = outputs.get("source_artifacts", {})
    modified_files = source_artifacts.get("modified_files", []) if isinstance(source_artifacts, dict) else []
    existing_walkthrough = source_artifacts.get("walkthrough", "") if isinstance(source_artifacts, dict) else ""
    audit = outputs.get("audit_report", {})
    
    task_title = context.get("task_title", "Unknown Task")
    task_description = context.get("task_description", "")
    
    # If builder already generated a walkthrough, use it as a base
    if existing_walkthrough and len(existing_walkthrough) > 100:
        print(f"[Walkthrough Generator] Builder already produced a walkthrough ({len(existing_walkthrough)} chars), enhancing it")
    
    try:
        llm = get_gemini_flash(temperature=0.2)
        
        # Build the files list
        files_list = "\n".join([f"- {f}" for f in modified_files]) if modified_files else "No files tracked"
        
        # Build audit summary
        audit_summary = ""
        if audit:
            audit_summary = f"Status: {audit.get('status', 'N/A')}\nReasoning: {audit.get('reasoning', 'N/A')}"
        
        prompt = f"""Write a concise walkthrough document for the following completed task.

TASK: {task_title}
DESCRIPTION: {task_description}

RESEARCH SUMMARY:
{str(dossier)[:1500] if dossier else "No research phase."}

IMPLEMENTATION PLAN:
{str(spec)[:2000] if spec else "No plan available."}

FILES MODIFIED:
{files_list}

{f"EXISTING WALKTHROUGH FROM BUILDER:{chr(10)}{existing_walkthrough[:1500]}" if existing_walkthrough else ""}

AUDIT VERDICT:
{audit_summary}

Write a structured markdown walkthrough with these sections:
1. **Summary** — What was done and why (2-3 sentences)
2. **Changes Made** — Key changes organized by component/file
3. **How It Works** — Brief explanation of the implementation approach
4. **Verification** — What was tested/verified

Keep it concise but informative. Focus on WHAT changed and WHY, not implementation minutiae."""

        response = await llm.ainvoke([HumanMessage(content=prompt)])
        walkthrough = response.content if hasattr(response, 'content') else str(response)
        
        # Prepend title
        walkthrough = f"# Walkthrough: {task_title}\n\n{walkthrough}"
        
        print(f"[Walkthrough Generator] Generated walkthrough ({len(walkthrough)} chars)")
        
        # Sync to database
        await sync_artifacts(context, {"walkthrough": walkthrough})
        
        return {
            "outputs": {
                **outputs,
                "walkthrough": walkthrough
            },
            "messages": [AIMessage(content=f"Walkthrough generated ({len(walkthrough)} chars)")]
        }
        
    except Exception as e:
        print(f"[Walkthrough Generator] ⚠️ LLM failed, generating basic walkthrough: {e}")
        
        # Fallback: generate a basic walkthrough without LLM
        files_md = "\n".join([f"- `{f}`" for f in modified_files]) if modified_files else "- No files tracked"
        fallback = f"""# Walkthrough: {task_title}

## Summary
{task_description}

## Changes Made
{files_md}

## Audit Result
{audit.get('status', 'N/A')}: {audit.get('reasoning', 'No details')}
"""
        await sync_artifacts(context, {"walkthrough": fallback})
        
        return {
            "outputs": {
                **outputs,
                "walkthrough": fallback
            },
            "messages": [AIMessage(content=f"Walkthrough generated (fallback, {len(fallback)} chars)")]
        }
