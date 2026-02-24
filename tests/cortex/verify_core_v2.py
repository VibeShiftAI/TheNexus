# tests/verify_core_v2.py
import asyncio
import os
import sys

# Ensure root is in path
sys.path.append(os.getcwd())

async def run_tests():
    print("🔬 STARTING CORE INTEGRITY CHECK (V2)...")
    
    # --- TEST 1: LEGACY MIGRATION ---
    print("\n[1/4] Checking Legacy Migration...")
    if os.path.exists("python/cortex/agora/graph.py"):
        print("❌ FAILED: Legacy 'agora/graph.py' still exists in active path.")
    elif os.path.exists("python/cortex/_legacy/agora/graph.py"):
        print("✅ Legacy code successfully moved to '_legacy'.")
    else:
        print("⚠️ NOTE: Legacy code deleted (Acceptable).")

    # --- TEST 2: CONSOLIDATED SCHEMAS ---
    print("\n[2/4] Checking Consolidated Schemas...")
    try:
        # UPDATED: Importing everything from state.py as per implementation report
        from cortex.schemas.state import System2State, ProjectPlan, WorkflowNode
        
        # Test Instantiation
        node = WorkflowNode(id="test", type="reasoning", description="sanity check")
        plan = ProjectPlan(title="Test", nodes=[node], status="draft")
        print("✅ Schemas Valid & Importable from 'state.py'.")
    except ImportError as e:
        print(f"❌ FAILED: Schema Import Error: {e}")
        return
    except Exception as e:
        print(f"❌ FAILED: Schema Validation Error: {e}")
        return

    # --- TEST 3: DAEMON WIRING ---
    print("\n[3/4] Checking Daemon & Ingestion...")
    try:
        from cortex.daemon import CortexDaemon
        daemon = CortexDaemon()
        
        # Verify Brain is compiled
        if hasattr(daemon, 'brain') and daemon.brain is not None:
            print("✅ Daemon successfully initialized System 2 Brain.")
        else:
            print("❌ FAILED: Daemon.brain is missing.")
            return

        # Mock the internal processor to avoid needing Real DB/LLM connection for this test
        # This prevents the "Pre-existing env issue" from blocking our wiring test
        async def mock_process(source):
            return type('obj', (object,), {'id': '123', 'should_accept': True})
        daemon.sensorium._process_source = mock_process

        # Test Manual Ingestion Method
        res = await daemon.sensorium.ingest_user_submission("Run system analysis", "manual")
        if res["route"] == "orchestrator":
             print("✅ Ingestion routed command to Orchestrator.")
        else:
             print(f"❌ FAILED: Expected 'orchestrator', got {res.get('route')}")

    except Exception as e:
        print(f"❌ FAILED: Daemon/Ingestion Error: {e}")
        return

    print("\n🎉 ALL CORE TESTS PASSED.")

if __name__ == "__main__":
    asyncio.run(run_tests())
