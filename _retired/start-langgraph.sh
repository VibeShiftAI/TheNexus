#!/bin/bash
# The Nexus LangGraph — LaunchAgent start script
export PYTHONPATH="/Volumes/Projects/TheNexus"
export NEXUS_YOUTUBE_LIVE_ENABLED=1
exec /Volumes/Projects/TheNexus/nexus-builder/venv/bin/uvicorn main:app --port 8000
