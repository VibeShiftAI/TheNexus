"""
Cortex FastAPI Application Entry Point.

Mounts all API routers and configures the application.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import routers
from cortex.api.routes.terminal_routes import router as terminal_router

app = FastAPI(
    title="Cortex API",
    description="The Synthetic Mind - System 2 Orchestration Layer",
    version="2.0.0"
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to Nexus domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(terminal_router, prefix="/api", tags=["terminal"])


@app.get("/health")
async def health_check():
    return {"status": "healthy", "system": "cortex", "version": "2.0.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
