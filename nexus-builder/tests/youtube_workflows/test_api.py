from fastapi import FastAPI
from fastapi.testclient import TestClient

from youtube_workflows.api import router


def test_start_youtube_workflow_returns_run_id_and_gate():
    app = FastAPI()
    app.include_router(router, prefix="/api/youtube")
    client = TestClient(app)

    response = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"})

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["run_id"].startswith("yt-")
    assert data["pending_approval"]["gate"] == "concept"


def test_get_unknown_youtube_run_returns_404():
    app = FastAPI()
    app.include_router(router, prefix="/api/youtube")
    client = TestClient(app)

    response = client.get("/api/youtube/runs/missing")

    assert response.status_code == 404


def test_start_response_state_is_json_serializable():
    app = FastAPI()
    app.include_router(router, prefix="/api/youtube")
    client = TestClient(app)

    response = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"})

    assert response.status_code == 200
    data = response.json()
    assert data["state"]["input"]["prompt"] == "Explain The Nexus"
