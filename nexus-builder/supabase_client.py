"""
SQLite Client - Local database client for nexus-builder operations

Replaces the old Supabase HTTP REST client with direct SQLite access via aiosqlite.
Uses the same nexus.db file as the Node.js server.
"""

import os
import json
import uuid
import sqlite3
import aiosqlite
from typing import Dict, Any, List, Optional
from datetime import datetime
from pathlib import Path

# Resolve the nexus.db path (same as Node.js server uses)
_DB_PATH = os.getenv("NEXUS_DB_PATH") or str(Path(__file__).parent.parent / "nexus.db")


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _id() -> str:
    return str(uuid.uuid4())


def _parse_json(val: Any) -> Any:
    """Safely parse JSON strings from SQLite TEXT columns."""
    if val is None:
        return None
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return val


def _dict_row(cursor: aiosqlite.Cursor, row: tuple) -> dict:
    """Row factory that returns dicts instead of tuples."""
    desc = cursor.description
    return {col[0]: row[i] for i, col in enumerate(desc)}


class SQLiteClient:
    """
    Async SQLite client for nexus-builder database operations.
    Drop-in replacement for the old SupabaseClient.
    """

    def __init__(self):
        self.db_path = _DB_PATH
        self._db: Optional[aiosqlite.Connection] = None

    async def _get_db(self) -> aiosqlite.Connection:
        if self._db is None:
            self._db = await aiosqlite.connect(self.db_path)
            self._db.row_factory = _dict_row
            await self._db.execute("PRAGMA journal_mode=WAL")
            await self._db.execute("PRAGMA foreign_keys=ON")
        return self._db

    async def close(self):
        if self._db:
            await self._db.close()
            self._db = None

    def is_configured(self) -> bool:
        return os.path.exists(self.db_path)

    # ═══════════════════════════════════════════════════════════════
    # WORKFLOW OPERATIONS
    # ═══════════════════════════════════════════════════════════════

    async def insert_workflow(self, workflow: Dict) -> Dict:
        db = await self._get_db()
        if "id" not in workflow:
            workflow["id"] = _id()
        if "created_at" not in workflow:
            workflow["created_at"] = _now()
        cols = ", ".join(workflow.keys())
        placeholders = ", ".join("?" for _ in workflow)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in workflow.values()]
        await db.execute(f"INSERT INTO workflows ({cols}) VALUES ({placeholders})", vals)
        await db.commit()
        return workflow

    async def get_workflows(self, templates_only: bool = False) -> List[Dict]:
        db = await self._get_db()
        sql = "SELECT * FROM workflows"
        if templates_only:
            sql += " WHERE is_template = 1"
        sql += " ORDER BY created_at DESC"
        async with db.execute(sql) as cursor:
            rows = await cursor.fetchall()
        return [self._deser_row(r) for r in rows]

    async def get_workflow(self, workflow_id: str) -> Optional[Dict]:
        db = await self._get_db()
        async with db.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)) as cursor:
            row = await cursor.fetchone()
        return self._deser_row(row) if row else None

    async def update_workflow(self, workflow_id: str, updates: Dict) -> Dict:
        updates["updated_at"] = _now()
        return await self._update("workflows", workflow_id, updates)

    async def delete_workflow(self, workflow_id: str) -> bool:
        db = await self._get_db()
        await db.execute("DELETE FROM workflows WHERE id = ?", (workflow_id,))
        await db.commit()
        return True

    # ═══════════════════════════════════════════════════════════════
    # RUN OPERATIONS
    # ═══════════════════════════════════════════════════════════════

    async def insert_run(self, run: Dict) -> Dict:
        db = await self._get_db()
        if "id" not in run:
            run["id"] = _id()
        cols = ", ".join(run.keys())
        placeholders = ", ".join("?" for _ in run)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in run.values()]
        await db.execute(f"INSERT INTO runs ({cols}) VALUES ({placeholders})", vals)
        await db.commit()
        return run

    async def get_run(self, run_id: str) -> Optional[Dict]:
        db = await self._get_db()
        async with db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)) as cursor:
            row = await cursor.fetchone()
        return self._deser_row(row) if row else None

    async def get_runs_by_project(self, project_id: str, limit: int = 20) -> List[Dict]:
        db = await self._get_db()
        async with db.execute(
            "SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?",
            (project_id, limit)
        ) as cursor:
            rows = await cursor.fetchall()
        return [self._deser_row(r) for r in rows]

    async def get_runs_by_task(self, project_id: str, task_id: str) -> List[Dict]:
        db = await self._get_db()
        async with db.execute(
            "SELECT * FROM runs WHERE project_id = ? AND task_id = ? ORDER BY started_at DESC",
            (project_id, task_id)
        ) as cursor:
            rows = await cursor.fetchall()
        return [self._deser_row(r) for r in rows]

    async def update_run(self, run_id: str, updates: Dict) -> Dict:
        return await self._update("runs", run_id, updates)

    # ═══════════════════════════════════════════════════════════════
    # CHECKPOINT OPERATIONS (for time-travel)
    # ═══════════════════════════════════════════════════════════════

    async def insert_checkpoint(self, checkpoint: Dict) -> Dict:
        db = await self._get_db()
        if "id" not in checkpoint:
            checkpoint["id"] = _id()
        cols = ", ".join(checkpoint.keys())
        placeholders = ", ".join("?" for _ in checkpoint)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in checkpoint.values()]
        await db.execute(f"INSERT INTO checkpoints ({cols}) VALUES ({placeholders})", vals)
        await db.commit()
        return checkpoint

    async def get_checkpoints(self, run_id: str) -> List[Dict]:
        db = await self._get_db()
        async with db.execute(
            "SELECT * FROM checkpoints WHERE run_id = ? ORDER BY step ASC",
            (run_id,)
        ) as cursor:
            rows = await cursor.fetchall()
        return [self._deser_row(r) for r in rows]

    async def get_checkpoint(self, checkpoint_id: str) -> Optional[Dict]:
        db = await self._get_db()
        async with db.execute("SELECT * FROM checkpoints WHERE id = ?", (checkpoint_id,)) as cursor:
            row = await cursor.fetchone()
        return self._deser_row(row) if row else None

    # ═══════════════════════════════════════════════════════════════
    # NEXUS RUN OPERATIONS (workflow state persistence)
    # ═══════════════════════════════════════════════════════════════

    async def upsert_nexus_run(
        self, run_id: str, project_id: str, task_id: str, state: Dict
    ) -> Optional[Dict]:
        run_data = {
            "id": run_id,
            "project_id": project_id,
            "task_id": task_id,
            "status": state.get("status", "running"),
            "current_node": state.get("current_stage"),
            "context": json.dumps({
                "stages_completed": state.get("stages_completed", []),
                "artifacts": state.get("artifacts", {}),
                "activity_log": state.get("activity_log", []),
                "error": state.get("error"),
                "status_update": state.get("status_update"),
                "pending_approval": state.get("pending_approval"),
                "initial_state": state.get("initial_state")
            })
        }

        existing = await self.get_run(run_id)
        if existing:
            return await self.update_run(run_id, {
                "status": run_data["status"],
                "current_node": run_data["current_node"],
                "context": run_data["context"]
            })
        else:
            run_data["started_at"] = _now()
            return await self.insert_run(run_data)

    async def get_nexus_run(self, run_id: str) -> Optional[Dict]:
        run = await self.get_run(run_id)
        if not run:
            return None
        context = run.get("context", {}) or {}
        if isinstance(context, str):
            context = _parse_json(context) or {}
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
            "project_id": run.get("project_id"),
            "task_id": run.get("task_id"),
            "started_at": run.get("started_at")
        }

    async def get_active_nexus_runs(self) -> List[Dict]:
        db = await self._get_db()
        async with db.execute(
            "SELECT * FROM runs WHERE status IN ('running', 'paused', 'pending') ORDER BY started_at DESC"
        ) as cursor:
            rows = await cursor.fetchall()
        result = []
        for run in [self._deser_row(r) for r in rows]:
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
        updates = {"status": status, "completed_at": _now()}
        if error:
            updates["error_message"] = error
        return await self.update_run(run_id, updates)

    # ═══════════════════════════════════════════════════════════════
    # TOKEN USAGE TRACKING
    # ═══════════════════════════════════════════════════════════════

    async def record_usage(self, model: str, input_tokens: int, output_tokens: int) -> Optional[Dict]:
        db = await self._get_db()
        today = datetime.utcnow().strftime("%Y-%m-%d")
        try:
            async with db.execute(
                "SELECT * FROM usage_stats WHERE date = ? AND model = ?",
                (today, model)
            ) as cursor:
                existing = await cursor.fetchone()

            if existing:
                await db.execute(
                    """UPDATE usage_stats SET
                        input_tokens = input_tokens + ?,
                        output_tokens = output_tokens + ?,
                        total_tokens = total_tokens + ?,
                        request_count = request_count + 1
                    WHERE id = ?""",
                    (input_tokens, output_tokens, input_tokens + output_tokens, existing["id"])
                )
                await db.commit()
                return existing
            else:
                new_id = _id()
                await db.execute(
                    """INSERT INTO usage_stats (id, date, model, input_tokens, output_tokens, total_tokens, request_count)
                    VALUES (?, ?, ?, ?, ?, ?, 1)""",
                    (new_id, today, model, input_tokens, output_tokens, input_tokens + output_tokens)
                )
                await db.commit()
                return {"id": new_id, "date": today, "model": model}
        except Exception as e:
            print(f"[SQLite] Error recording usage: {e}")
            return None

    # ═══════════════════════════════════════════════════════════════
    # ARTIFACT COMMENTS (for human-in-the-loop review)
    # ═══════════════════════════════════════════════════════════════

    async def insert_comment(self, comment: Dict) -> Dict:
        db = await self._get_db()
        if "id" not in comment:
            comment["id"] = _id()
        if "created_at" not in comment:
            comment["created_at"] = _now()
        cols = ", ".join(comment.keys())
        placeholders = ", ".join("?" for _ in comment)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in comment.values()]
        await db.execute(f"INSERT INTO artifact_comments ({cols}) VALUES ({placeholders})", vals)
        await db.commit()
        return comment

    async def get_comments_for_artifact(self, artifact_id: str) -> List[Dict]:
        db = await self._get_db()
        async with db.execute(
            "SELECT * FROM artifact_comments WHERE artifact_id = ? ORDER BY line_number ASC, created_at ASC",
            (artifact_id,)
        ) as cursor:
            rows = await cursor.fetchall()
        return rows or []

    async def get_comment(self, comment_id: str) -> Optional[Dict]:
        db = await self._get_db()
        async with db.execute("SELECT * FROM artifact_comments WHERE id = ?", (comment_id,)) as cursor:
            row = await cursor.fetchone()
        return row

    async def update_comment(self, comment_id: str, updates: Dict) -> Optional[Dict]:
        return await self._update("artifact_comments", comment_id, updates)

    async def delete_comment(self, comment_id: str) -> bool:
        db = await self._get_db()
        await db.execute("DELETE FROM artifact_comments WHERE id = ?", (comment_id,))
        await db.commit()
        return True

    async def delete_artifact_comments(self, artifact_id: str) -> bool:
        db = await self._get_db()
        await db.execute("DELETE FROM artifact_comments WHERE artifact_id = ?", (artifact_id,))
        await db.commit()
        return True

    # ═══════════════════════════════════════════════════════════════
    # Helpers
    # ═══════════════════════════════════════════════════════════════

    async def _update(self, table: str, row_id: str, updates: Dict) -> Dict:
        db = await self._get_db()
        sets = ", ".join(f"{k} = ?" for k in updates)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in updates.values()]
        vals.append(row_id)
        await db.execute(f"UPDATE {table} SET {sets} WHERE id = ?", vals)
        await db.commit()
        # Return the updated row
        async with db.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)) as cursor:
            row = await cursor.fetchone()
        return self._deser_row(row) if row else updates

    def _deser_row(self, row: Optional[Dict]) -> Optional[Dict]:
        """Deserialize JSON-encoded TEXT columns back into Python dicts/lists."""
        if not row:
            return row
        result = dict(row)
        json_cols = ("context", "nodes", "edges", "config", "metadata", "settings",
                     "graph_definition", "allowed_tools", "details")
        for col in json_cols:
            if col in result and isinstance(result[col], str):
                result[col] = _parse_json(result[col])
        return result


# ═══════════════════════════════════════════════════════════════
# Global instance + backward-compatible accessor
# ═══════════════════════════════════════════════════════════════

_client: Optional[SQLiteClient] = None


def get_supabase() -> SQLiteClient:
    """Get the global SQLite client instance.
    
    Named get_supabase() for backward compatibility — all existing
    callers import get_supabase from this module.
    """
    global _client
    if _client is None:
        _client = SQLiteClient()
    return _client
