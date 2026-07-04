"""
Startup script for TheNexus LangGraph Engine.

On Windows, psycopg (async PostgreSQL driver) requires the SelectorEventLoop
instead of the default ProactorEventLoop. This script ensures the correct
event loop policy is set BEFORE uvicorn starts.

Usage: python run.py
"""
import sys
import asyncio

# CRITICAL: This must be set BEFORE any async code runs, including uvicorn startup
if sys.platform == 'win32':
    # Set the event loop policy to use SelectorEventLoop
    # This is required because psycopg cannot work with ProactorEventLoop
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    print("[Startup] Set Windows event loop policy to SelectorEventLoop (required for psycopg)")

if __name__ == "__main__":
    import uvicorn
    
    # Now start uvicorn - it will inherit the correct event loop policy
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_excludes=["dry_run_test*", "*.tmp", "_audit_temp/*"]
    )
