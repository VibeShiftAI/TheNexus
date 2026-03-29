#!/bin/bash
# The Nexus LangGraph — LaunchAgent start script
export PYTHONPATH="/Volumes/Projects/TheNexus"
exec /Volumes/Projects/TheNexus/nexus-builder/venv/bin/uvicorn main:app --port 8000
