"""
Session Manager - Manages persistent sandbox sessions with lazy container loading.
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from typing import Optional

import docker
from docker.errors import NotFound, APIError
from docker.models.containers import Container

from .database import db
from .models import Language

logger = logging.getLogger(__name__)


# Image mapping
LANGUAGE_IMAGES = {
    Language.PYTHON: "sandbox-python:latest",
    Language.NODEJS: "sandbox-node:latest",
    Language.R: "sandbox-r:latest",
    Language.BASH: "sandbox-python:latest",  # Bash uses Python image
}


class Session:
    """Represents a sandbox session."""
    
    def __init__(
        self,
        session_id: str,
        name: Optional[str] = None,
        workspace_path: Optional[str] = None,
    ):
        self.id = session_id
        self.name = name or f"session-{session_id[:8]}"
        self.workspace_path = workspace_path or f"/data/sessions/{session_id}"
        self.containers: dict[Language, str] = {}  # language -> container_id
        self.created_at = datetime.utcnow()
        self.last_activity = datetime.utcnow()
    
    def touch(self):
        """Update last activity timestamp."""
        self.last_activity = datetime.utcnow()
        # Note: DB update is handled by the manager or periodic sync
        # We don't want to await DB on every touch for performance


class SessionManager:
    """
    Manages sandbox sessions with persistent DB storage and lazy container loading.
    """
    
    def __init__(self):
        self.client = docker.from_env()
        self.sessions_cache: dict[str, Session] = {}  # In-memory cache
        self.network = os.getenv("SANDBOX_NETWORK", "sandbox-net")
        self.memory_limit = os.getenv("SANDBOX_MEMORY_LIMIT", "512m")
        self.cpu_limit = float(os.getenv("SANDBOX_CPU_LIMIT", "1.0"))
        self.pids_limit = int(os.getenv("SANDBOX_PIDS_LIMIT", "50"))
        
    def _verify_images(self) -> dict[str, bool]:
        """Check which executor images are available."""
        result = {}
        for lang, image in LANGUAGE_IMAGES.items():
            try:
                self.client.images.get(image)
                result[lang.value] = True
            except NotFound:
                result[lang.value] = False
        return result

    def _row_to_session(self, row) -> Session:
        """Convert DB row to Session object."""
        session = Session(
            session_id=str(row["id"]),
            name=row["name"],
            workspace_path=row["workspace_path"]
        )
        session.created_at = row["created_at"]
        session.last_activity = row["last_activity"]
        
        if row["containers"]:
            try:
                # DB stores { "python": "id" }
                raw_containers = json.loads(row["containers"])
                # Convert string keys to Language enum
                session.containers = {
                    Language(k): v for k, v in raw_containers.items()
                }
            except Exception as e:
                logger.error(f"Failed to parse containers JSON for session {session.id}: {e}")
                
        return session
    
    async def create_session(self, name: Optional[str] = None) -> Session:
        """Create a new sandbox session in DB."""
        session_id = str(uuid.uuid4())
        workspace = f"/data/sessions/{session_id}"
        session_name = name or f"session-{session_id[:8]}"
        
        # Insert into DB
        query = """
            INSERT INTO sandbox_sessions (id, name, workspace_path, containers, status)
            VALUES ($1, $2, $3, $4, 'active')
            RETURNING *
        """
        row = await db.fetch_one(query, session_id, session_name, workspace, "{}")
        if not row:
            raise RuntimeError("Failed to create session in DB")
            
        session = self._row_to_session(row)
        self.sessions_cache[session_id] = session
        
        logger.info(f"Created session {session_id}")
        return session
    
    async def get_session(self, session_id: str) -> Optional[Session]:
        """Get session from cache or DB."""
        # 1. Check cache
        if session_id in self.sessions_cache:
            return self.sessions_cache[session_id]
            
        # 2. Check DB
        query = "SELECT * FROM sandbox_sessions WHERE id = $1"
        try:
            row = await db.fetch_one(query, session_id)
            if row:
                session = self._row_to_session(row)
                self.sessions_cache[session_id] = session
                return session
        except Exception as e:
            logger.error(f"DB error in get_session: {e}")
            
        return None
    
    async def delete_session(self, session_id: str) -> bool:
        """Delete session from DB and remove containers."""
        # Get session first (from cache or DB) to find containers
        session = await self.get_session(session_id)
        if not session:
            return False
        
        # Stop and remove all containers
        for lang, container_id in session.containers.items():
            try:
                container = self.client.containers.get(container_id)
                container.remove(force=True)
                logger.info(f"Removed {lang} container for session {session_id[:8]}")
            except NotFound:
                pass
            except Exception as e:
                logger.warning(f"Failed to remove container: {e}")
        
        # Delete from DB
        await db.execute("DELETE FROM sandbox_sessions WHERE id = $1", session_id)
        
        # Remove from cache
        if session_id in self.sessions_cache:
            del self.sessions_cache[session_id]
            
        logger.info(f"Deleted session {session_id}")
        return True
    
    async def _update_session_containers(self, session: Session):
        """Persist session container state to DB."""
        containers_json = {
            k.value: v for k, v in session.containers.items()
        }
        query = """
            UPDATE sandbox_sessions 
            SET containers = $1, last_activity = NOW()
            WHERE id = $2
        """
        await db.execute(query, json.dumps(containers_json), session.id)

    async def get_executor(self, session_id: str, language: Language) -> Container:
        """
        Get or create an executor container.
        Lazy loading + DB persistence.
        """
        session = await self.get_session(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        
        # Check if container known in DB info
        container_id = session.containers.get(language)
        
        if container_id:
            try:
                container = self.client.containers.get(container_id)
                if container.status == "running":
                    session.touch()
                    # Optionally sync touch to DB periodically, but definitely we should ensuring
                    # container info is consistent.
                    return container
                
                # Container exists but not running - remove to recreate
                container.remove(force=True)
            except NotFound:
                # Container recorded in DB but missing in Docker (e.g. pruned)
                logger.warning(f"Container {container_id} missing for session {session_id}")
            except Exception as e:
                logger.warning(f"Error checking container: {e}")
                
        # Create new container
        image = LANGUAGE_IMAGES.get(language)
        if not image:
            raise ValueError(f"Unsupported language: {language}")
        
        logger.info(f"Creating {language} executor for session {session_id[:8]}")
        
        container = self.client.containers.run(
            image,
            detach=True,
            network=self.network,
            volumes={
                "sandbox-sessions": {"bind": "/data/sessions", "mode": "rw"}
            },
            working_dir=session.workspace_path,
            environment={
                "HTTP_PROXY": "http://host.docker.internal:3128",
                "HTTPS_PROXY": "http://host.docker.internal:3128",
                "NO_PROXY": "localhost,127.0.0.1",
            },
            mem_limit=self.memory_limit,
            memswap_limit=self.memory_limit,
            nano_cpus=int(self.cpu_limit * 1e9),
            pids_limit=self.pids_limit,
            labels={
                "sandbox": "true",
                "sandbox.session": session_id,
                "sandbox.language": language.value,
            },
        )
        
        # Update local object
        session.containers[language] = container.id
        session.touch()
        
        # Persist to DB
        await self._update_session_containers(session)
        
        logger.info(f"Started {language} container {container.short_id}")
        return container
    
    async def cleanup_orphaned_containers(self):
        """Remove orphaned containers AND sync DB state if needed."""
        # For now, just remove containers not in active sessions cache?
        # Better: get all sessions from DB to know what's valid.
        
        try:
            # Get valid active sessions from DB
            rows = await db.fetch_all("SELECT id, containers FROM sandbox_sessions")
            valid_containers = set()
            for row in rows:
                if row["containers"]:
                    try:
                        c_dict = json.loads(row["containers"])
                        valid_containers.update(c_dict.values())
                    except:
                        pass
                        
            # List actual docker containers
            containers = self.client.containers.list(
                all=True,
                filters={"label": "sandbox=true"}
            )
            
            for container in containers:
                if container.id not in valid_containers:
                    try:
                        container.remove(force=True)
                        logger.info(f"Reaped orphaned container {container.short_id}")
                    except Exception as e:
                        logger.warning(f"Failed to reap container: {e}")
                        
        except Exception as e:
            logger.error(f"Cleanup failed (DB might be unreachable?): {e}")

    def list_sessions(self) -> list[Session]:
        """
        List sessions (synchronous shim).
        Note: The API route is async, calling manager.list_sessions().
        BUT `list_sessions` in original code was synchronous.
        Our API endpoint `list_sessions` calls `manager.list_sessions()`.
        We should make `manager.list_sessions()` ASYNC and update server.py.
        """
        # Since we can't change the signature easily in a shim without breaking compatibility 
        # if this was a widely used lib, but here we control server.py.
        # I will update server.py to await manager.list_sessions().
        return list(self.sessions_cache.values()) 
        # Wait, if we only return cache, we miss DB sessions not loaded?
        # WE NEED TO QUERY DB.
        # So I MUST make it async.
        # I'll update `server.py` to `await manager.list_sessions()`.

    async def list_all_sessions(self) -> list[Session]:
        """Fetch all sessions from DB."""
        if not db.pool:
            return []
        rows = await db.fetch_all("SELECT * FROM sandbox_sessions ORDER BY last_activity DESC")
        return [self._row_to_session(row) for row in rows]

# Singleton
_manager: Optional[SessionManager] = None

def get_session_manager() -> SessionManager:
    global _manager
    if _manager is None:
        _manager = SessionManager()
    return _manager
