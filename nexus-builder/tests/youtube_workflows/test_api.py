import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from youtube_workflows.api import MAX_IN_MEMORY_RUNS, _remember_run, _runs, router


@pytest.fixture
def client():
    _runs.clear()
    app = FastAPI()
    app.include_router(router, prefix="/api/youtube")
    return TestClient(app, raise_server_exceptions=False)


def test_start_youtube_workflow_returns_run_id_and_gate(client):
    response = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"})

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["run_id"].startswith("yt-")
    assert data["pending_approval"]["gate"] == "concept"


def test_get_unknown_youtube_run_returns_404(client):
    response = client.get("/api/youtube/runs/missing")

    assert response.status_code == 404


def test_start_invalid_body_returns_422(client):
    response = client.post("/api/youtube/runs", json={})

    assert response.status_code == 422


def test_resume_invalid_decision_returns_422(client):
    start = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"}).json()

    response = client.post(
        f"/api/youtube/runs/{start['run_id']}/resume",
        json={"review_decision": "bogus"},
    )

    assert response.status_code == 422


def test_resume_approve_concept_returns_script_gate(client):
    response = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"})
    start = response.json()

    response = client.post(
        f"/api/youtube/runs/{start['run_id']}/resume",
        json={"review_decision": "approve"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["run_id"] == start["run_id"]
    assert data["pending_approval"]["gate"] == "script"


def test_start_response_state_is_json_serializable(client):
    response = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"})

    assert response.status_code == 200
    data = response.json()
    assert data["state"]["input"]["prompt"] == "Explain The Nexus"
    json.dumps(data["state"])


def test_in_memory_run_store_is_bounded(client):
    for index in range(MAX_IN_MEMORY_RUNS + 1):
        _remember_run(f"run-{index}", {"state": {}})

    assert len(_runs) == MAX_IN_MEMORY_RUNS
    assert "run-0" not in _runs
    assert f"run-{MAX_IN_MEMORY_RUNS}" in _runs
