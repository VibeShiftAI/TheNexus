from typing import Annotated, List, TypedDict, Literal, Optional, Any
from datetime import datetime
import hashlib
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langchain_core.tools import tool
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel, Field
from langchain_core.messages import SystemMessage, AIMessage, HumanMessage, ToolMessage

# Use unified tool registry
from tools import get_registry

from model_config import get_gemini_pro, get_gemini_flash

# Get research tools from registry
_registry = get_registry()
_research_tools = _registry.get_langchain_tools(["web_search", "scrape_documentation", "verify_library"])

# --- STATE ---
class ResearchState(TypedDict):
    messages: Annotated[List[Any], add_messages]
    user_request: str 
    
    # Enhanced context fields
    task_title: str  # High-level task name
    project_context: str  # Combined markdown from supervisor/*.md
    
    # The Plan
    proposed_queries: List[str]
    is_plan_approved: bool
    critique: str
    
    # Execution tracking
    execution_count: int
    
    # The Knowledge
    final_dossier: str
    
    # Blackboard session for findings persistence
    blackboard_session_id: Optional[str] 
    
    # Model overrides from workflow builder config
    model_overrides: dict

# --- MODELS (with automatic tracking) ---
llm_researcher = get_gemini_pro(temperature=0.2)
llm_professor = get_gemini_flash(temperature=0)

# --- STRUCTURED OUTPUTS ---
class ResearchPlan(BaseModel):
    needs_research: bool = Field(description="False if the request is trivial.")
    queries: List[str] = Field(description="List of search queries to execute.")
    target_urls: List[str] = Field(description="Specific documentation URLs if known.")
    rationale: str

class PlanReview(BaseModel):
    approved: bool
    feedback: str = Field(description="If rejected, explain why.")

# --- NODES ---

def scoper_node(state: ResearchState):
    """
    Phase 1: Scoping. Decides query plan based on task and project context.
    """
    # Extract enhanced context
    task_title = state.get('task_title', 'Unknown Task')
    project_context = state.get('project_context', '')
    critique = state.get('critique', 'None')
    
    # Truncate context to avoid token limits (keep most relevant parts)
    context_preview = project_context[:4000] if project_context else 'No project context available'
    
    prompt = f"""
    ROLE: Technical Researcher for software development tasks.
    
    TASK TITLE: {task_title}
    TASK DESCRIPTION: "{state['user_request']}"
    
    PROJECT CONTEXT:
    {context_preview}
    
    CRITIQUE FROM PROFESSOR (If any):
    {critique}
    
    INSTRUCTIONS:
    Based on the project context (tech stack, guidelines, existing patterns), identify:
    1. What external libraries, APIs, or documentation needs to be researched
    2. What specific technical questions need answers
    3. Skip research for things already documented in the project context
    
    Create a focused research plan that fills knowledge gaps.
    """
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("scoper_model")
    if override:
        from model_config import get_custom_model
        base_llm = get_custom_model(override, temperature=0.2)
    else:
        base_llm = llm_researcher
    model = base_llm.with_structured_output(ResearchPlan)
    
    # Inject prompt if first turn
    messages = state["messages"]
    
    # Debug logging
    print(f"[Research] Scoper Node - User Request: {state['user_request']}")
    
    try:
        if not messages:
            messages = [HumanMessage(content=prompt)]
        else:
            messages = messages + [HumanMessage(content=prompt)] # Append context
            
        print(f"[Research] Invoking model with {len(messages)} messages")
        plan = model.invoke(messages)  # Tracking via callback
        
        # Store plan in messages for context
        msg_content = f"Proposed Plan: {plan.queries}" if plan.needs_research else "No research needed."
        
        # KEY FIX: Return BOTH the prompt (Human) and response (AI) so history is [Human, AI]
        # This prevents "started with AI message" errors on future turns
        output_messages = messages[-1:] if not state['messages'] else [messages[-1]]
        # Wait, messages was constructed locally. 
        # If state['messages'] was empty, 'messages' var is [Human]. We need to return [Human, AI].
        # If state['messages'] had content, 'messages' var is [Old..., Human]. We need to return [Human, AI].
        # Effectively, we need to return the NEW HumanMessage and the NEW AIMessage.
        
        # 'messages' variable contains the full history used for generation.
        # We want to append the last HumanMessage we added, plus the result.
        
        new_human_msg = messages[-1] # The one we just added
        
        # NEW: Initialize Blackboard session if research is needed
        session_id = None
        if plan.needs_research:
            try:
                from cortex.blackboard import Blackboard
                
                # Generate unique session ID
                session_str = f"{state['user_request']}_{datetime.now().isoformat()}"
                session_id = hashlib.md5(session_str.encode()).hexdigest()[:12]
                
                bb = Blackboard.get_or_create(
                    session_id=session_id,
                    topic=state.get("task_title", "Research Task")
                )
                
                # Write research plan to blackboard
                plan_content = f"""# Research Plan

## Task: {state.get('task_title', 'Unknown')}

## Request
{state['user_request']}

## Proposed Queries
{chr(10).join(f'- {q}' for q in plan.queries)}

## Target URLs
{chr(10).join(f'- {u}' for u in plan.target_urls) if plan.target_urls else 'None'}

## Rationale
{plan.rationale if hasattr(plan, 'rationale') else 'N/A'}
"""
                bb.write_plan(plan_content, metadata={
                    "query_count": len(plan.queries),
                })
                print(f"📋 [Research] Blackboard session created: {session_id}")
                
            except ImportError:
                print("⚠️ [Research] Cortex not available, skipping Blackboard")
            except Exception as e:
                print(f"⚠️ [Research] Blackboard error: {e}")
        
        return {
            "proposed_queries": plan.queries + plan.target_urls if plan.needs_research else [],
            "is_plan_approved": False, 
            "messages": [new_human_msg, AIMessage(content=msg_content)],
            "blackboard_session_id": session_id,  # NEW
        }
    except Exception as e:
        print(f"[Research] SCOPER ERROR: {e}")
        import traceback
        traceback.print_exc()
        raise e

def vetting_node(state: ResearchState):
    """
    Phase 2: The Gate. Audit queries.
    """
    if not state.get("proposed_queries"):
        return {"is_plan_approved": True}

    plan = state["proposed_queries"]
    
    prompt = f"""
    You are the Research Director. Review this plan.
    User Request: "{state['user_request']}"
    
    Proposed Search Queries:
    {plan}
    
    CRITERIA:
    1. Relevant?
    2. Specific?
    3. Safe?
    """
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("vetter_model")
    if override:
        from model_config import get_custom_model
        base_llm = get_custom_model(override, temperature=0)
    else:
        base_llm = llm_professor
    model = base_llm.with_structured_output(PlanReview)
    review = model.invoke(prompt)  # Tracking via callback
    
    return {
        "is_plan_approved": review.approved,
        "critique": review.feedback
    }

def execution_node(state: ResearchState):
    """
    Phase 3: The Hunt. Execute tools.
    This is the ONLY node with tool access.
    Includes iteration limit to prevent infinite loops.
    """
    if not state.get("proposed_queries"):
        return {"messages": [AIMessage(content="Skipping research.")], "execution_count": 0}

    current_count = state.get("execution_count", 0)
    queries = state["proposed_queries"]
    
    # After MAX iterations, stop generating tool calls
    MAX_ITERATIONS = 10
    if current_count >= MAX_ITERATIONS:
        print(f"[Research] Max iterations ({MAX_ITERATIONS}) reached, moving to synthesis")
        return {
            "messages": [AIMessage(content=f"Research complete after {current_count} iterations.")],
            "execution_count": current_count
        }
    
    # PROTOCOL ENFORCEMENT - Strict tool usage order
    system_instruction = """
    You are the Research Executor. Follow this PROTOCOL strictly:
    
    1. If the plan involves a specific library/package, use 'verify_library_existence' FIRST.
       - This prevents hallucinating non-existent packages.
    2. Use 'web_search' to find official documentation URLs.
    3. Use 'scrape_documentation' to read the full API reference from found URLs.
    
    After completing your research queries, conclude with "RESEARCH_COMPLETE".
    Do NOT continue searching indefinitely.
    """
    
    prompt = f"""
    {system_instruction}
    
    Execute these approved research queries:
    {queries}
    
    Summarize findings into a technical briefing.
    """
    
    # Bind research tools from unified registry
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("researcher_model")
    if override:
        from model_config import get_custom_model
        base_llm = get_custom_model(override, temperature=0.2)
    else:
        base_llm = llm_researcher
    model = base_llm.bind_tools(_research_tools)
    response = model.invoke(state["messages"] + [HumanMessage(content=prompt)])  # Tracking via callback
    
    return {
        "messages": [HumanMessage(content=prompt), response],
        "execution_count": current_count + 1
    }

def capture_findings_node(state: ResearchState):
    """
    Captures tool outputs and writes them to the Blackboard.
    
    Inserted in graph: tools -> capture_findings -> execution (loop)
    This node is a passthrough - it doesn't modify the graph state,
    just persists findings to the file-backed Blackboard.
    """
    session_id = state.get("blackboard_session_id")
    if not session_id:
        return {}
    
    try:
        from cortex.blackboard import Blackboard
        bb = Blackboard.get_or_create(session_id)
    except ImportError:
        return {}
    
    messages = state.get("messages", [])
    
    # Find ToolMessages in recent history
    for msg in messages[-15:]:  # Check last 15 messages
        # Check if it's a ToolMessage
        if not isinstance(msg, ToolMessage):
            continue
        
        tool_call_id = getattr(msg, "tool_call_id", None)
        if not tool_call_id:
            continue
        
        # Extract query args from preceding AIMessage
        query_args = _extract_query_args(tool_call_id, messages)
        
        # Submit (with deduplication via tool_call_id)
        finding = bb.submit_finding(
            worker_id="execution_agent",
            tool_name=getattr(msg, "name", "unknown_tool"),
            query=query_args,
            content=msg.content if isinstance(msg.content, str) else str(msg.content),
            tags=[getattr(msg, "name", "tool")],
            tool_call_id=tool_call_id,
        )
        
        if finding:
            print(f"📝 [Research] Finding captured: {finding.tool_name} ({finding.id})")
    
    return {}


def _extract_query_args(tool_call_id: str, messages: list) -> str:
    """
    Find the AIMessage that initiated this tool call and extract args.
    
    Args:
        tool_call_id: The ID to look for
        messages: Message history
        
    Returns:
        String representation of the tool arguments
    """
    for msg in reversed(messages):
        if not isinstance(msg, AIMessage):
            continue
        if not hasattr(msg, "tool_calls") or not msg.tool_calls:
            continue
        
        for tc in msg.tool_calls:
            if tc.get("id") == tool_call_id:
                args = tc.get("args", {})
                # Format nicely for display
                if isinstance(args, dict):
                    if "query" in args:
                        return str(args["query"])
                    if "url" in args:
                        return str(args["url"])
                    return str(args)
                return str(args)
    
    return "unknown"


async def synthesizer_node(state: ResearchState):
    """
    Phase 4: The Dossier.
    
    Now async to support Neo4j export via Blackboard.
    """
    if not state.get("proposed_queries"):
        return {"final_dossier": "## Research Skipped\nTask considered standard knowledge."}
    
    session_id = state.get("blackboard_session_id")
    bb = None  # Initialize for safety
    
    # Get context from Blackboard if available
    if session_id:
        try:
            from cortex.blackboard import Blackboard, BlackboardExporter
            bb = Blackboard.get_or_create(session_id)
            context = bb.get_full_context()
            
            prompt = f"""You have access to the following research context:

{context}

Compile this into a final 'RESEARCH_DOSSIER.md' document.
Structure it with clear sections, code examples where relevant, and actionable recommendations.
"""
        except ImportError:
            prompt = "Review the tool outputs. Compile the final 'RESEARCH_DOSSIER.md'."
            bb = None
        except Exception as e:
            print(f"⚠️ [Research] Blackboard context error: {e}")
            prompt = "Review the tool outputs. Compile the final 'RESEARCH_DOSSIER.md'."
            bb = None
    else:
        prompt = "Review the tool outputs. Compile the final 'RESEARCH_DOSSIER.md'."
    
    # Use async invoke
    # Use override model if configured, else default
    override = state.get("model_overrides", {}).get("synthesizer_model")
    if override:
        from model_config import get_custom_model
        synth_llm = get_custom_model(override, temperature=0.2)
    else:
        synth_llm = llm_researcher
    response = await synth_llm.ainvoke(state["messages"] + [HumanMessage(content=prompt)])
    
    # Extract text content - Gemini can return content as a list of parts
    # like [{"type": "text", "text": "..."}] instead of a plain string
    dossier_content = response.content
    if isinstance(dossier_content, list):
        # Extract text from parts list
        text_parts = []
        for part in dossier_content:
            if isinstance(part, dict) and part.get("type") == "text":
                text_parts.append(part["text"])
            elif isinstance(part, str):
                text_parts.append(part)
        dossier_content = "\n".join(text_parts)
    
    # Write synthesis and export to Neo4j
    if bb is not None:
        try:
            bb.write_synthesis(dossier_content)
            
            from cortex.blackboard import BlackboardExporter
            exporter = BlackboardExporter()
            findings_count, synth_ok = await exporter.export_all(bb)
            print(f"📤 [Research] Exported to Neo4j: {findings_count} findings, synthesis={synth_ok}")
        except Exception as e:
            print(f"⚠️ [Research] Export error: {e}")
    
    return {
        "final_dossier": dossier_content,
        "messages": [HumanMessage(content=prompt), response]
    }

# --- ROUTING ---

def route_research(state: ResearchState):
    if state["is_plan_approved"]:
        return "execution"
    return "scoper" 

def route_execution(state: ResearchState):
    # Check if we've exceeded max iterations
    if state.get("execution_count", 0) >= 10:
        print("[Research] Route: Max iterations reached, going to synthesizer")
        return "synthesizer"
        
    last_msg = state["messages"][-1]
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        return "tools"
    return "synthesizer"

def compile_researcher_graph():
    workflow = StateGraph(ResearchState)
    workflow.add_node("scoper", scoper_node)
    workflow.add_node("vetting", vetting_node)
    workflow.add_node("execution", execution_node)
    workflow.add_node("tools", ToolNode(_research_tools))
    workflow.add_node("capture_findings", capture_findings_node)  # NEW
    workflow.add_node("synthesizer", synthesizer_node)

    workflow.add_edge(START, "scoper")
    workflow.add_edge("scoper", "vetting")
    
    workflow.add_conditional_edges("vetting", route_research, {
        "execution": "execution",
        "scoper": "scoper"
    })
    
    workflow.add_conditional_edges("execution", route_execution, {
        "tools": "tools",
        "synthesizer": "synthesizer"
    })
    
    # CHANGED: Insert capture_findings between tools and execution
    # This persists tool outputs to the Blackboard before continuing the loop
    workflow.add_edge("tools", "capture_findings")
    workflow.add_edge("capture_findings", "execution")
    
    workflow.add_edge("synthesizer", END)

    return workflow.compile()
