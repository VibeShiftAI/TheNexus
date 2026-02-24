"""
Supabase Client - HTTP REST client for database operations

Uses the Supabase REST API instead of direct PostgreSQL connection.
This avoids DNS resolution issues on Windows.
"""

import os
import httpx
from typing import Dict, Any, List, Optional
from datetime import datetime
from dotenv import load_dotenv
from pathlib import Path

# Load .env from parent directory (project root) if not in current dir
env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)


class SupabaseClient:
    """
    HTTP client for Supabase database operations.
    Uses the REST API for CRUD operations.
    """
    
    def __init__(self):
        self.url = os.getenv("SUPABASE_URL")
        # Support SUPABASE_SERVICE_KEY, SUPABASE_SECRET_KEY, or SUPABASE_KEY
        self.key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_KEY")
        self._client = None
        
        if not self.url or not self.key:
            print("[Supabase] Warning: Missing SUPABASE_URL or SUPABASE_SECRET_KEY")
    
    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=f"{self.url}/rest/v1",
                headers={
                    "apikey": self.key,
                    "Authorization": f"Bearer {self.key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=representation"
                },
                timeout=30.0
            )
        return self._client
    
    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
    
    def is_configured(self) -> bool:
        return bool(self.url and self.key)
    
    # ═══════════════════════════════════════════════════════════════
    # WORKFLOW OPERATIONS
    # ═══════════════════════════════════════════════════════════════
    
    async def insert_workflow(self, workflow: Dict) -> Dict:
        """Insert a new workflow"""
        response = await self.client.post("/workflows", json=workflow)
        response.raise_for_status()
        data = response.json()
        return data[0] if isinstance(data, list) else data
    
    async def get_workflows(self, templates_only: bool = False) -> List[Dict]:
        """Get all workflows"""
        url = "/workflows?select=*"
        if templates_only:
            url += "&is_template=eq.true"
        url += "&order=created_at.desc"
        
        response = await self.client.get(url)
        response.raise_for_status()
        return response.json()
    
    async def get_workflow(self, workflow_id: str) -> Optional[Dict]:
        """Get a specific workflow by ID"""
        response = await self.client.get(f"/workflows?id=eq.{workflow_id}")
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    async def update_workflow(self, workflow_id: str, updates: Dict) -> Dict:
        """Update a workflow"""
        updates["updated_at"] = datetime.utcnow().isoformat()
        response = await self.client.patch(
            f"/workflows?id=eq.{workflow_id}",
            json=updates
        )
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    async def delete_workflow(self, workflow_id: str) -> bool:
        """Delete a workflow"""
        response = await self.client.delete(f"/workflows?id=eq.{workflow_id}")
        return response.status_code == 200 or response.status_code == 204
    
    # ═══════════════════════════════════════════════════════════════
    # RUN OPERATIONS
    # ═══════════════════════════════════════════════════════════════
    
    async def insert_run(self, run: Dict) -> Dict:
        """Insert a new workflow run"""
        response = await self.client.post("/runs", json=run)
        response.raise_for_status()
        data = response.json()
        return data[0] if isinstance(data, list) else data
    
    async def get_run(self, run_id: str) -> Optional[Dict]:
        """Get a specific run by ID"""
        response = await self.client.get(f"/runs?id=eq.{run_id}")
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    async def get_runs_by_project(self, project_id: str, limit: int = 20) -> List[Dict]:
        """Get runs for a project"""
        response = await self.client.get(
            f"/runs?project_id=eq.{project_id}&order=started_at.desc&limit={limit}"
        )
        response.raise_for_status()
        return response.json()
    
    async def get_runs_by_task(self, project_id: str, task_id: str) -> List[Dict]:
        """Get runs for a specific task"""
        response = await self.client.get(
            f"/runs?project_id=eq.{project_id}&task_id=eq.{task_id}&order=started_at.desc"
        )
        response.raise_for_status()
        return response.json()
    
    async def update_run(self, run_id: str, updates: Dict) -> Dict:
        """Update a run status/context"""
        response = await self.client.patch(
            f"/runs?id=eq.{run_id}",
            json=updates
        )
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    # ═══════════════════════════════════════════════════════════════
    # CHECKPOINT OPERATIONS (for time-travel)
    # ═══════════════════════════════════════════════════════════════
    
    async def insert_checkpoint(self, checkpoint: Dict) -> Dict:
        """Insert a checkpoint for time-travel"""
        response = await self.client.post("/checkpoints", json=checkpoint)
        response.raise_for_status()
        data = response.json()
        return data[0] if isinstance(data, list) else data
    
    async def get_checkpoints(self, run_id: str) -> List[Dict]:
        """Get all checkpoints for a run"""
        response = await self.client.get(
            f"/checkpoints?run_id=eq.{run_id}&order=step.asc"
        )
        response.raise_for_status()
        return response.json()
    
    async def get_checkpoint(self, checkpoint_id: str) -> Optional[Dict]:
        """Get a specific checkpoint"""
        response = await self.client.get(f"/checkpoints?id=eq.{checkpoint_id}")
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    # ═══════════════════════════════════════════════════════════════
    # NEXUS RUN OPERATIONS (workflow state persistence)
    # ═══════════════════════════════════════════════════════════════
    
    async def upsert_nexus_run(
        self, 
        run_id: str, 
        project_id: str, 
        task_id: str, 
        state: Dict
    ) -> Optional[Dict]:
        """
        Upsert a Nexus workflow run state.
        Uses the 'runs' table with state stored in the 'context' JSONB column.
        """
        run_data = {
            "id": run_id,
            "project_id": project_id,
            "task_id": task_id,
            "status": state.get("status", "running"),
            "current_node": state.get("current_stage"),
            "context": {
                "stages_completed": state.get("stages_completed", []),
                "artifacts": state.get("artifacts", {}),
                "activity_log": state.get("activity_log", []),
                "error": state.get("error"),
                "status_update": state.get("status_update"),
                "pending_approval": state.get("pending_approval"),
                "initial_state": state.get("initial_state")
            }
        }
        
        # Check if run exists
        existing = await self.get_run(run_id)
        
        if existing:
            # Update existing run
            return await self.update_run(run_id, {
                "status": run_data["status"],
                "current_node": run_data["current_node"],
                "context": run_data["context"]
            })
        else:
            # Insert new run
            run_data["started_at"] = datetime.utcnow().isoformat()
            return await self.insert_run(run_data)
    
    async def get_nexus_run(self, run_id: str) -> Optional[Dict]:
        """
        Get a Nexus workflow run and reconstruct the state dict.
        Returns the state in the same format as _nexus_runs in-memory store.
        """
        run = await self.get_run(run_id)
        if not run:
            return None
        
        context = run.get("context", {}) or {}
        
        return {
            "status": run.get("status", "unknown"),
            "current_stage": run.get("current_node"),
            "stages_completed": context.get("stages_completed", []),
            "artifacts": context.get("artifacts", {}),
            "activity_log": context.get("activity_log", []),
            "error": context.get("error"),
            "status_update": context.get("status_update"),
            "pending_approval": context.get("pending_approval"),
            "initial_state": context.get("initial_state"),
            # Metadata from run record
            "project_id": run.get("project_id"),
            "task_id": run.get("task_id"),
            "started_at": run.get("started_at")
        }
    
    async def get_active_nexus_runs(self) -> List[Dict]:
        """
        Get all active (non-completed) Nexus workflow runs.
        Used on server startup to restore in-memory cache.
        """
        response = await self.client.get(
            "/runs?status=in.(running,paused,pending)&order=started_at.desc"
        )
        response.raise_for_status()
        runs = response.json()
        
        # Convert to state format
        result = []
        for run in runs:
            context = run.get("context", {}) or {}
            result.append({
                "run_id": run.get("id"),
                "status": run.get("status", "unknown"),
                "current_stage": run.get("current_node"),
                "stages_completed": context.get("stages_completed", []),
                "artifacts": context.get("artifacts", {}),
                "activity_log": context.get("activity_log", []),
                "error": context.get("error"),
                "project_id": run.get("project_id"),
                "task_id": run.get("task_id"),
                "initial_state": context.get("initial_state")
            })
        
        return result
    
    async def complete_nexus_run(self, run_id: str, status: str = "completed", error: str = None) -> Optional[Dict]:
        """Mark a Nexus run as completed or failed"""
        updates = {
            "status": status,
            "completed_at": datetime.utcnow().isoformat()
        }
        if error:
            updates["error_message"] = error
        
        return await self.update_run(run_id, updates)
    
    # ═══════════════════════════════════════════════════════════════
    # TOKEN USAGE TRACKING
    # ═══════════════════════════════════════════════════════════════
    
    async def record_usage(
        self, 
        model: str, 
        input_tokens: int, 
        output_tokens: int
    ) -> Optional[Dict]:
        """
        Record AI token usage to the usage_stats table.
        Uses upsert with (date, model) as the conflict key, incrementing token counts.
        This matches the Node.js db.recordUsage() function.
        """
        today = datetime.utcnow().strftime("%Y-%m-%d")
        
        try:
            # First try to get existing record for today + model
            response = await self.client.get(
                f"/usage_stats?date=eq.{today}&model=eq.{model}"
            )
            response.raise_for_status()
            existing = response.json()
            
            if existing and len(existing) > 0:
                # Update existing record - increment token counts
                record = existing[0]
                update_data = {
                    "input_tokens": (record.get("input_tokens", 0) or 0) + input_tokens,
                    "output_tokens": (record.get("output_tokens", 0) or 0) + output_tokens,
                    "total_tokens": (record.get("total_tokens", 0) or 0) + input_tokens + output_tokens,
                    "request_count": (record.get("request_count", 0) or 0) + 1
                }
                update_response = await self.client.patch(
                    f"/usage_stats?id=eq.{record['id']}",
                    json=update_data
                )
                update_response.raise_for_status()
                return update_response.json()[0] if update_response.json() else None
            else:
                # Insert new record
                insert_data = {
                    "date": today,
                    "model": model,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": input_tokens + output_tokens,
                    "request_count": 1
                }
                insert_response = await self.client.post("/usage_stats", json=insert_data)
                insert_response.raise_for_status()
                return insert_response.json()[0] if insert_response.json() else None
                
        except Exception as e:
            print(f"[Supabase] Error recording usage: {e}")
            return None
    
    # ═══════════════════════════════════════════════════════════════
    # ARTIFACT COMMENTS (for human-in-the-loop review)
    # ═══════════════════════════════════════════════════════════════
    
    async def insert_comment(self, comment: Dict) -> Dict:
        """Insert a new artifact comment"""
        response = await self.client.post("/artifact_comments", json=comment)
        response.raise_for_status()
        data = response.json()
        return data[0] if isinstance(data, list) else data
    
    async def get_comments_for_artifact(self, artifact_id: str) -> List[Dict]:
        """Get all comments for an artifact, sorted by line then creation time"""
        response = await self.client.get(
            f"/artifact_comments?artifact_id=eq.{artifact_id}&order=line_number.asc,created_at.asc"
        )
        response.raise_for_status()
        return response.json()
    
    async def get_comment(self, comment_id: str) -> Optional[Dict]:
        """Get a specific comment by ID"""
        response = await self.client.get(f"/artifact_comments?id=eq.{comment_id}")
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    async def update_comment(self, comment_id: str, updates: Dict) -> Optional[Dict]:
        """Update a comment (e.g., resolve/unresolve)"""
        response = await self.client.patch(
            f"/artifact_comments?id=eq.{comment_id}",
            json=updates
        )
        response.raise_for_status()
        data = response.json()
        return data[0] if data else None
    
    async def delete_comment(self, comment_id: str) -> bool:
        """Delete a comment"""
        response = await self.client.delete(f"/artifact_comments?id=eq.{comment_id}")
        return response.status_code in (200, 204)
    
    async def delete_artifact_comments(self, artifact_id: str) -> bool:
        """Delete all comments for an artifact"""
        response = await self.client.delete(f"/artifact_comments?artifact_id=eq.{artifact_id}")
        return response.status_code in (200, 204)


# Global instance
_supabase: Optional[SupabaseClient] = None


def get_supabase() -> SupabaseClient:
    """Get the global Supabase client instance"""
    global _supabase
    if _supabase is None:
        _supabase = SupabaseClient()
    return _supabase
