"""
AI Workflow Builder Subgraphs - Phase 8

Subgraph agents for the AI Workflow Builder.
Reference: packages/@n8n/ai-workflow-builder.ee/src/subgraphs/

Subgraphs:
1. discovery_subgraph - Find and search for node types
2. builder_subgraph - Create nodes and connections
3. configurator_subgraph - Set parameters on nodes
4. responder_agent - Synthesize responses to user
"""

from typing import Dict, Any, List
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.messages import SystemMessage, HumanMessage

from model_config import get_gemini_flash, get_gemini_pro
from .state import BuilderState

# Use unified tool registry (replaces .tools imports)
from tools import get_registry

# Get workflow tools from registry
_registry = get_registry()
DISCOVERY_TOOLS = _registry.get_langchain_tools(["search_nodes", "get_node_details"])
BUILDER_TOOLS = _registry.get_langchain_tools(["add_node", "connect_nodes"])
CONFIGURATOR_TOOLS = _registry.get_langchain_tools(["set_node_parameters", "get_node_details"])
ALL_TOOLS = _registry.get_langchain_tools()  # All available tools


# ═══════════════════════════════════════════════════════════════════════════
# DISCOVERY SUBGRAPH
# ═══════════════════════════════════════════════════════════════════════════

DISCOVERY_PROMPT = """You are a Discovery Agent for workflow building.

Your job is to search for and identify the right node types for the user's request.

## Available Tools
- search_nodes: Search for nodes by name or functionality
- get_node_details: Get detailed information about a specific node type

## Instructions
1. Analyze what the user wants to accomplish
2. Search for relevant node types
3. Return a summary of the nodes that would work

## User Request
{user_request}

## Workflow Context
{workflow_summary}

Search for appropriate nodes and explain what you found."""


async def discovery_subgraph(state: BuilderState) -> BuilderState:
    """
    Discovery subgraph - finds appropriate node types for the request.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/subgraphs/discovery.subgraph.ts
    """
    llm = get_gemini_flash(temperature=0)
    llm_with_tools = llm.bind_tools(DISCOVERY_TOOLS)
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", DISCOVERY_PROMPT),
    ])
    
    chain = prompt | llm_with_tools
    
    # Format workflow summary
    workflow = state.get("workflow", {})
    nodes = workflow.get("nodes", [])
    workflow_summary = f"Current workflow has {len(nodes)} nodes." if nodes else "Workflow is empty."
    
    try:
        result = await chain.ainvoke({
            "user_request": state.get("user_request", ""),
            "workflow_summary": workflow_summary,
        })
        
        # Extract tool calls and results
        discovered_nodes = []
        if hasattr(result, 'tool_calls') and result.tool_calls:
            for tool_call in result.tool_calls:
                if tool_call.get("name") == "search_nodes":
                    # Execute the search
                    from .tools import search_nodes, SearchNodesInput
                    search_input = SearchNodesInput(**tool_call.get("args", {}))
                    search_result = search_nodes.invoke({"input": search_input})
                    discovered_nodes.extend(search_result if isinstance(search_result, list) else [])
        
        # Add assistant message to history
        new_message = {
            "role": "assistant",
            "content": result.content if hasattr(result, 'content') else str(result),
            "agent": "discovery",
        }
        messages = state.get("messages", []) + [new_message]
        
        return {
            **state,
            "messages": messages,
            "discovered_nodes": discovered_nodes[:10],  # Limit results
            "next_agent": "builder" if discovered_nodes else "responder",
        }
    
    except Exception as e:
        return {
            **state,
            "error": f"Discovery error: {str(e)}",
            "next_agent": "responder",
        }


# ═══════════════════════════════════════════════════════════════════════════
# BUILDER SUBGRAPH
# ═══════════════════════════════════════════════════════════════════════════

BUILDER_PROMPT = """You are a Builder Agent for workflow building.

Your job is to add nodes and create connections based on the discovered node types.

## Available Tools
- add_node: Add a node to the workflow
- connect_nodes: Connect two nodes together
- remove_node: Remove a node from the workflow

## Discovered Nodes
{discovered_nodes}

## User Request
{user_request}

## Current Workflow
{workflow_summary}

Add the appropriate nodes and connections. Position nodes logically on the canvas (x increases right, y increases down). Use increments of 200 for spacing."""


async def builder_subgraph(state: BuilderState) -> BuilderState:
    """
    Builder subgraph - creates nodes and connections.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/subgraphs/builder.subgraph.ts
    """
    llm = get_gemini_pro(temperature=0)
    llm_with_tools = llm.bind_tools(BUILDER_TOOLS)
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", BUILDER_PROMPT),
    ])
    
    chain = prompt | llm_with_tools
    
    # Format discovered nodes
    discovered = state.get("discovered_nodes", [])
    discovered_str = "\n".join([
        f"- {n.get('display_name', 'Unknown')} ({n.get('type_id', '?')}): {n.get('description', '')}"
        for n in discovered
    ]) if discovered else "No nodes discovered yet."
    
    # Format workflow
    workflow = state.get("workflow", {})
    nodes = workflow.get("nodes", [])
    workflow_summary = "\n".join([
        f"- {n.get('name', 'Unnamed')} ({n.get('type', '?')}) ID: {n.get('id', '?')}"
        for n in nodes
    ]) if nodes else "Workflow is empty."
    
    try:
        result = await chain.ainvoke({
            "user_request": state.get("user_request", ""),
            "discovered_nodes": discovered_str,
            "workflow_summary": workflow_summary,
        })
        
        # Collect pending operations from tool calls
        pending_operations = state.get("pending_operations", [])
        if hasattr(result, 'tool_calls') and result.tool_calls:
            for tool_call in result.tool_calls:
                # Execute each tool and collect operations
                tool_name = tool_call.get("name", "")
                args = tool_call.get("args", {})
                
                if tool_name == "add_node":
                    from .tools import add_node, AddNodeInput
                    tool_input = AddNodeInput(**args)
                    tool_result = add_node.invoke({"input": tool_input, "config": {}})
                    if tool_result.get("operation"):
                        pending_operations.append(tool_result["operation"])
                
                elif tool_name == "connect_nodes":
                    from .tools import connect_nodes, ConnectNodesInput
                    tool_input = ConnectNodesInput(**args)
                    tool_result = connect_nodes.invoke({"input": tool_input, "config": {}})
                    if tool_result.get("operation"):
                        pending_operations.append(tool_result["operation"])
        
        # Add assistant message
        new_message = {
            "role": "assistant",
            "content": result.content if hasattr(result, 'content') else str(result),
            "agent": "builder",
        }
        messages = state.get("messages", []) + [new_message]
        
        return {
            **state,
            "messages": messages,
            "pending_operations": pending_operations,
            "next_agent": "configurator" if pending_operations else "responder",
        }
    
    except Exception as e:
        return {
            **state,
            "error": f"Builder error: {str(e)}",
            "next_agent": "responder",
        }


# ═══════════════════════════════════════════════════════════════════════════
# CONFIGURATOR SUBGRAPH
# ═══════════════════════════════════════════════════════════════════════════

CONFIGURATOR_PROMPT = """You are a Configurator Agent for workflow building.

Your job is to set parameters on nodes that have been added to the workflow.

## Available Tools
- set_node_parameters: Set configuration values on a node
- get_node_details: Get the parameter schema for a node type

## Nodes to Configure
{nodes_to_configure}

## User Request
{user_request}

Configure the nodes with appropriate parameters based on the user's request."""


async def configurator_subgraph(state: BuilderState) -> BuilderState:
    """
    Configurator subgraph - sets parameters on nodes.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/subgraphs/configurator.subgraph.ts
    """
    llm = get_gemini_flash(temperature=0)
    llm_with_tools = llm.bind_tools(CONFIGURATOR_TOOLS)
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", CONFIGURATOR_PROMPT),
    ])
    
    chain = prompt | llm_with_tools
    
    # Get nodes that were just added (from pending operations)
    pending = state.get("pending_operations", [])
    nodes_to_configure = "\n".join([
        f"- {op.get('name', 'Unknown')} (ID: {op.get('node_id', '?')}, Type: {op.get('node_type', '?')})"
        for op in pending if op.get("operation") == "add_node"
    ]) if pending else "No nodes pending configuration."
    
    try:
        result = await chain.ainvoke({
            "user_request": state.get("user_request", ""),
            "nodes_to_configure": nodes_to_configure,
        })
        
        # Add any configuration operations
        updated_operations = list(pending)
        if hasattr(result, 'tool_calls') and result.tool_calls:
            for tool_call in result.tool_calls:
                if tool_call.get("name") == "set_node_parameters":
                    from .tools import set_node_parameters, SetNodeParametersInput
                    args = tool_call.get("args", {})
                    tool_input = SetNodeParametersInput(**args)
                    tool_result = set_node_parameters.invoke({"input": tool_input, "config": {}})
                    if tool_result.get("operation"):
                        updated_operations.append(tool_result["operation"])
        
        # Add assistant message
        new_message = {
            "role": "assistant",
            "content": result.content if hasattr(result, 'content') else str(result),
            "agent": "configurator",
        }
        messages = state.get("messages", []) + [new_message]
        
        return {
            **state,
            "messages": messages,
            "pending_operations": updated_operations,
            "next_agent": "responder",  # After configuration, respond to user
        }
    
    except Exception as e:
        return {
            **state,
            "error": f"Configurator error: {str(e)}",
            "next_agent": "responder",
        }


# ═══════════════════════════════════════════════════════════════════════════
# RESPONDER AGENT
# ═══════════════════════════════════════════════════════════════════════════

RESPONDER_PROMPT = """You are a Responder Agent for workflow building and system interaction.

Your job is to:
1. Synthesize what has been done based on pending operations.
2. Answer user questions about the system or workflow.
3. USE TOOLS to interact with The Nexus if the user asks.

## Available Tools
- **scaffold_new_vibe(name, type)**: Create a new project in The Nexus.
- **init_git(project_name)**: Initialize a git repo for a project.

## Conversation History
{conversation_history}

## Current Workflow
{workflow_summary}

## Pending Operations
{pending_operations}

## Error (if any)
{error}

## Instructions
- If the user asks to perform an action, USE THE APPROPRIATE TOOL.
- If you used a tool, explain the result clearly.
- If just responding to a previous action, be helpful and concise."""


async def responder_agent(state: BuilderState) -> BuilderState:
    """
    Responder agent - synthesizes response and handles general tool execution.
    Now supports a ReAct loop for tool use.
    """
    print(f"\n{'='*60}")
    print(f"[Responder] 🧠 RESPONDER AGENT ACTIVATED")
    print(f"{'='*60}")
    
    llm = get_gemini_flash(temperature=0)
    
    # Restrict to safe, read-only tools or explicitly permitted planning tools
    ALLOWED_TOOL_NAMES = {
        "read_file", "list_directory", "search_files", "search_nodes", 
        "get_node_details", "create_subplan", "web_search", 
        "search_codebase", "explore_codebase", "fact_check",
    }
    safe_tools = [t for t in ALL_TOOLS if t.name in ALLOWED_TOOL_NAMES]
    llm_with_tools = llm.bind_tools(safe_tools)
    
    print(f"[Responder] 🔧 Tools bound to LLM: {[t.name for t in safe_tools]}")
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", RESPONDER_PROMPT),
        ("human", "{user_request}"),
    ])
    
    chain = prompt | llm_with_tools
    
    # helper to format state
    def get_prompt_inputs(s):
        msgs = s.get("messages", [])
        hist = "\n".join([f"{m.get('role', 'unknown').upper()}: {m.get('content', '')[:300]}" for m in msgs[-5:]]) if msgs else "No history."
        
        wf = s.get("workflow", {})
        nodes = wf.get("nodes", [])
        wf_sum = "\n".join([f"- {n.get('name')} ({n.get('type')})" for n in nodes]) if nodes else "Empty."
        
        pend = s.get("pending_operations", [])
        pend_str = "\n".join([f"- {op.get('operation')}: {op.get('node_id')}" for op in pend]) if pend else "None."
        
        # Get the latest user message for the human prompt
        user_msgs = [m for m in msgs if m.get('role') == 'user']
        user_request = user_msgs[-1].get('content', '') if user_msgs else s.get('user_request', 'No request provided.')
        
        return {
            "conversation_history": hist,
            "workflow_summary": wf_sum,
            "pending_operations": pend_str,
            "error": s.get("error", "None"),
            "user_request": user_request,
        }

    try:
        # 1. Initial Call
        inputs = get_prompt_inputs(state)
        
        # Atomic-level logging
        print(f"[Responder] � State received:")
        print(f"   • messages count: {len(state.get('messages', []))}")
        print(f"   • workflow nodes: {len(state.get('workflow', {}).get('nodes', []))}")
        print(f"   • pending_operations: {len(state.get('pending_operations', []))}")
        print(f"[Responder] 📝 User request preview (first 200 chars):")
        print(f"   {inputs.get('user_request', 'N/A')[:200]}")
        
        print(f"[Responder] 🚀 Invoking LLM...")
        result = await chain.ainvoke(inputs)
        
        # Log the LLM's decision
        has_tool_calls = hasattr(result, 'tool_calls') and result.tool_calls
        raw_content = getattr(result, 'content', None)
        print(f"[Responder] 🤔 LLM Decision:")
        print(f"   • tool_calls: {len(result.tool_calls) if has_tool_calls else 0}")
        print(f"   • content type: {type(raw_content).__name__}")
        print(f"   • content length: {len(raw_content) if isinstance(raw_content, (str, list)) else 'N/A'}")
        
        if has_tool_calls:
            print(f"[Responder] 🔧 LLM chose to call tools: {[tc['name'] for tc in result.tool_calls]}")
        else:
            print(f"[Responder] 💬 LLM chose to respond directly (no tools needed)")
        
        # 2. Multi-Turn Tool Execution Loop (ReAct pattern)
        # Keep executing tools until LLM produces a text response (no tool_calls)
        MAX_ITERATIONS = 5  # Safety limit to prevent infinite loops
        iteration = 0
        all_tool_outputs = []
        
        while hasattr(result, 'tool_calls') and result.tool_calls and iteration < MAX_ITERATIONS:
            iteration += 1
            print(f"[Responder] � Tool iteration {iteration}/{MAX_ITERATIONS}")
            print(f"[Responder] �🔧 LLM requested {len(result.tool_calls)} tool(s): {[tc['name'] for tc in result.tool_calls]}")
            
            # Execute all requested tools
            tool_outputs = []
            for tool_call in result.tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["args"]
                print(f"[Responder]    → Executing: {tool_name}({tool_args})")
                
                # Find the tool callable
                tool_func = next((t for t in ALL_TOOLS if t.name == tool_name), None)
                if tool_func:
                    try:
                        # Execute tool (use ainvoke for async tools like Cortex)
                        output = await tool_func.ainvoke(tool_args)
                        print(f"[Responder]    ✓ {tool_name} returned: {str(output)[:200]}...")
                        tool_outputs.append(f"Tool '{tool_name}' output: {output}")
                    except Exception as te:
                        import traceback
                        traceback.print_exc()
                        print(f"[Responder]    ✗ {tool_name} FAILED: {te}")
                        tool_outputs.append(f"Tool '{tool_name}' failed: {te}")
                else:
                    print(f"[Responder]    ✗ Tool '{tool_name}' NOT FOUND in ALL_TOOLS")
                    tool_outputs.append(f"Tool '{tool_name}' not found.")
            
            all_tool_outputs.extend(tool_outputs)
            
            # Append tool outputs to conversation history for next LLM call
            tool_context = "\n".join(tool_outputs)
            print(f"[Responder] 📋 Tool outputs compiled ({len(tool_context)} chars)")
            
            inputs["conversation_history"] += f"\n\n[System]: Tool Execution Results:\n{tool_context}"
            
            # Re-invoke LLM with updated context - it can call more tools or respond
            print(f"[Responder] 📤 Re-invoking LLM (iteration {iteration})...")
            result = await chain.ainvoke(inputs)
            
            # Check if LLM wants to call more tools or respond
            if hasattr(result, 'tool_calls') and result.tool_calls:
                print(f"[Responder] � LLM wants more tools: {[tc['name'] for tc in result.tool_calls]}")
            else:
                print(f"[Responder] ✅ LLM ready to respond (no more tool calls)")
        
        if iteration >= MAX_ITERATIONS and hasattr(result, 'tool_calls') and result.tool_calls:
            print(f"[Responder] ⚠️ Hit max iterations ({MAX_ITERATIONS}), forcing response")
        
        # 3. Extract final response from LLM
        raw_content = getattr(result, 'content', None)
        print(f"[Responder] 🔍 Final raw_content type: {type(raw_content)}")
        
        # Extract text from various content formats
        if isinstance(raw_content, str) and raw_content:
            response_text = raw_content
        elif isinstance(raw_content, list) and len(raw_content) > 0:
            parts = []
            for p in raw_content:
                if isinstance(p, dict) and 'text' in p:
                    parts.append(p['text'])
                elif hasattr(p, 'text'):
                    parts.append(p.text)
                elif isinstance(p, str):
                    parts.append(p)
                elif p:
                    parts.append(str(p))
            response_text = "\n".join(parts)
        else:
            # If we have tool outputs but no text response, synthesize one
            if all_tool_outputs:
                response_text = f"Based on my analysis:\n\n" + "\n".join(all_tool_outputs)
            else:
                response_text = f"[DEBUG] Empty response. Raw: {repr(result)[:300]}"
        
        print(f"[Responder] ✅ Final response ({iteration} tool iterations): {response_text[:200] if response_text else 'EMPTY'}...")
            
        # Add response to messages
        new_message = {
            "role": "assistant",
            "content": response_text,
            "agent": "responder",
        }
        messages_updated = state.get("messages", []) + [new_message]
        
        print(f"[Responder] 🏁 Returning final_response (type={type(response_text).__name__}, len={len(response_text) if response_text else 0})")
        
        return {
            **state,
            "messages": messages_updated,
            "final_response": response_text,
            "is_complete": True, # Responder implies turn completion
            "next_agent": "end",
        }
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[Responder] ❌ Exception: {e}")
        return {
            **state,
            "final_response": f"I encountered an error while responding: {str(e)}",
            "is_complete": True,
            "next_agent": "end",
        }
