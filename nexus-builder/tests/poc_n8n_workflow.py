
import asyncio
import sys
import os
import json
from dotenv import load_dotenv

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from graph_engine import GraphEngine
from node_registry import NodeRegistry

# Mock Graph Config (n8n-style JSON)
# This mimics what the Visual Editor would produce
MOCK_GRAPH_CONFIG = {
    "nodes": [
        {
            "id": "start_node",
            "type": "passthrough", # Generic start
            "data": {
                "label": "Start Trigger"
            }
        },
        {
            "id": "research_agent",
            "type": "researcher", # Using the actual Researcher Agent
            "data": {
                "request": "What is the capital of France?"
            }
        },
        {
            "id": "summarize_node",
            "type": "summarizer", # Using the Utility Summarizer
            "data": {
                "max_length": 100
            }
        },
        {
            "id": "end_node",
            "type": "passthrough",
            "data": {
                "label": "End"
            }
        }
    ],
    "edges": [
        {"source": "start_node", "target": "research_agent"},
        {"source": "research_agent", "target": "summarize_node"},
        {"source": "summarize_node", "target": "end_node"},
        {"source": "end_node", "target": "END"}
    ]
}

async def run_poc():
    print("--- [PoC] Starting n8n-style Workflow Execution ---")
    
    # 1. Initialize Engine (No DB for PoC)
    engine = GraphEngine()
    # Mocking DB connection to avoid startup errors if env vars missing
    engine.db_url = None 
    
    # 2. Initialize Registry
    registry = NodeRegistry()
    
    # Register the 'passthrough' node type manually for this test
    registry.register(
        type_id="passthrough",
        name="Passthrough Node",
        description="A simple passthrough node for testing",
        category="utility",
        icon="➡️"
    )
    
    # 3. Execute
    run_id = "poc-run-001"
    input_data = {
        "task_title": "PoC Research Task",
        "task_description": "Demonstrate JSON-driven workflow execution"
    }
    
    try:
        await engine.execute_graph(
            run_id=run_id,
            graph_config=MOCK_GRAPH_CONFIG,
            input_data=input_data,
            registry=registry
        )
        print("--- [PoC] Execution Finished Successfully ---")
        
        # Verify Output (In a real test we'd inspect the result object, 
        # but GraphEngine stores in DB/Memory. We can read internal state or partials if needed)
        
    except Exception as e:
        print(f"--- [PoC] Execution Failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(run_poc())
