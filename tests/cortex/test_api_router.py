# tests/test_api_router.py
import os
import sys
sys.path.append(os.getcwd())

from fastapi import FastAPI
from fastapi.testclient import TestClient
from cortex.api.routes.terminal_routes import router
import os

# 1. Create Ephemeral App for Testing
app = FastAPI()
app.include_router(router)
client = TestClient(app)

def test_upload():
    print("🔌 TESTING API ROUTER...")
    
    # Create dummy file
    filename = "test_plan.txt"
    with open(filename, "w") as f:
        f.write("Plan: Take over the world.")
        
    try:
        # 2. Simulate File Upload
        with open(filename, "rb") as f:
            response = client.post(
                "/terminal/upload",
                files={"file": (filename, f, "text/plain")},
                data={"comment": "Execute immediately"}
            )
        
        # 3. Validate
        if response.status_code == 200:
            data = response.json()
            if data["routing"] in ["orchestrator", "memory"]:
                print(f"✅ API Success! Routed to: {data['routing']}")
            else:
                print(f"❌ API returned unexpected structure: {data}")
        else:
            print(f"❌ API Failed: {response.status_code} - {response.text}")
            
    finally:
        if os.path.exists(filename):
            os.remove(filename)

if __name__ == "__main__":
    test_upload()
