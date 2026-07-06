"""
Cortex Usage Callback — Phase 24: Treasury Guard Infrastructure

Provides automatic token usage tracking for every LLM call that goes through
the LLMFactory. Three key components:

1. SessionLedger: Thread-safe in-memory store, keyed by session_id
2. CortexUsageCallback: LangChain BaseCallbackHandler injected into every model
3. _persist_to_database: Synchronous SQLite writer for the system monitor

The session_id is read at call time via contextvars, NOT baked in at creation.
This supports module-level LLM singletons that serve multiple sessions.
"""

import logging
import threading
import contextvars
from typing import List, Dict, Any, Optional

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

logger = logging.getLogger("CortexUsageCallback")

# ─── Context Variable ────────────────────────────────────────────────────
# Set by the orchestrator/treasury guard before pipeline runs.
# Read by the callback inside on_llm_end. Asyncio-safe per-task.
current_session: contextvars.ContextVar[str] = contextvars.ContextVar(
    "cortex_session_id", default="unknown"
)


# ─── Session Ledger ──────────────────────────────────────────────────────

class SessionLedger:
    """
    Thread-safe in-memory store for token usage records.
    
    Uses threading.Lock for safety across:
    - asyncio.gather (concurrent voters in same event loop)
    - asyncio.run (sync wrappers creating separate event loops)
    """
    _lock = threading.Lock()
    _records: Dict[str, List[Dict[str, Any]]] = {}

    @classmethod
    def record(
        cls,
        session_id: str,
        role: str,
        model_id: str,
        provider: str,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        """Append a usage record for the given session."""
        entry = {
            "role": role,
            "model_id": model_id,
            "provider": provider,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }
        with cls._lock:
            cls._records.setdefault(session_id, []).append(entry)
        logger.debug(
            f"📊 Recorded: {role}/{model_id} — "
            f"{input_tokens}in/{output_tokens}out (session={session_id})"
        )

    @classmethod
    def get_records(cls, session_id: str) -> List[Dict[str, Any]]:
        """Return a copy of all records for a session."""
        with cls._lock:
            return list(cls._records.get(session_id, []))

    @classmethod
    def clear(cls, session_id: str) -> None:
        """Remove all records for a session."""
        with cls._lock:
            cls._records.pop(session_id, None)

    @classmethod
    def clear_all(cls) -> None:
        """Remove all records (for testing)."""
        with cls._lock:
            cls._records.clear()


# ─── Database Persistence ────────────────────────────────────────────────

def _persist_to_database(model_id: str, input_tokens: int, output_tokens: int) -> None:
    """
    Synchronous write to the usage_stats table in SQLite.
    
    Uses direct sqlite3 (not asyncio) to avoid event loop issues
    in LangChain callbacks. Fire-and-forget: errors are logged but
    never propagated to avoid disrupting the LLM pipeline.
    """
    import os
    import sqlite3
    import uuid
    from datetime import datetime
    from pathlib import Path

    try:
        db_path = os.environ.get("NEXUS_DB_PATH") or str(
            Path(__file__).parent.parent / "nexus.db"
        )

        if not os.path.exists(db_path):
            return

        today = datetime.utcnow().strftime("%Y-%m-%d")
        total_tokens = input_tokens + output_tokens

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Check for existing record for today + model
        cursor.execute(
            "SELECT * FROM usage_stats WHERE date = ? AND model = ?",
            (today, model_id)
        )
        existing = cursor.fetchone()

        if existing:
            cursor.execute(
                """UPDATE usage_stats SET
                    input_tokens = input_tokens + ?,
                    output_tokens = output_tokens + ?,
                    total_tokens = total_tokens + ?,
                    request_count = request_count + 1
                WHERE id = ?""",
                (input_tokens, output_tokens, total_tokens, existing["id"])
            )
        else:
            cursor.execute(
                """INSERT INTO usage_stats (id, date, model, input_tokens, output_tokens, total_tokens, request_count)
                VALUES (?, ?, ?, ?, ?, ?, 1)""",
                (str(uuid.uuid4()), today, model_id, input_tokens, output_tokens, total_tokens)
            )

        conn.commit()
        conn.close()

    except Exception as e:
        logger.warning(f"DB persistence failed (non-fatal): {e}")


# ─── LangChain Callback ─────────────────────────────────────────────────

class CortexUsageCallback(BaseCallbackHandler):
    """
    LangChain callback that records token usage to the SessionLedger.
    
    Injected by LLMFactory._create_driver() into every model instance.
    - role/model_id/provider are stamped at creation time
    - session_id is read from contextvars at call time
    - Never raises — logs warnings on missing data
    """

    def __init__(self, role: str, model_id: str, provider: str):
        super().__init__()
        self.role = role
        self.model_id = model_id
        self.provider = provider

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """Extract usage metadata and record to ledger + database."""
        session_id = current_session.get()

        input_tokens = 0
        output_tokens = 0
        found_usage = False

        # ── Primary path: msg.usage_metadata (modern LangChain standard) ──
        # This is the most reliable across all providers including OpenAI
        # with_structured_output, Anthropic, Google, and xAI.
        if not found_usage and response.generations:
            for gen_list in response.generations:
                for gen in gen_list:
                    msg = getattr(gen, "message", None)
                    if msg is not None:
                        usage = getattr(msg, "usage_metadata", None)
                        if usage:
                            if isinstance(usage, dict):
                                input_tokens = usage.get("input_tokens", 0) or usage.get("prompt_tokens", 0)
                                output_tokens = usage.get("output_tokens", 0) or usage.get("completion_tokens", 0)
                            else:
                                input_tokens = getattr(usage, "input_tokens", 0) or getattr(usage, "prompt_tokens", 0)
                                output_tokens = getattr(usage, "output_tokens", 0) or getattr(usage, "completion_tokens", 0)
                            if input_tokens > 0 or output_tokens > 0:
                                found_usage = True
                                break
                if found_usage:
                    break

        # ── Fallback 1: llm_output.token_usage (OpenAI classic path) ──
        if not found_usage and response.llm_output:
            token_usage = response.llm_output.get("token_usage", {})
            if token_usage:
                input_tokens = token_usage.get("prompt_tokens", 0)
                output_tokens = token_usage.get("completion_tokens", 0)
                found_usage = True

        # ── Fallback 2: generation_info.usage_metadata ──
        if not found_usage and response.generations:
            for gen_list in response.generations:
                for gen in gen_list:
                    gen_info = getattr(gen, "generation_info", {}) or {}
                    usage = gen_info.get("usage_metadata", {})
                    if usage:
                        input_tokens += usage.get("input_tokens", usage.get("prompt_tokens", 0))
                        output_tokens += usage.get("output_tokens", usage.get("completion_tokens", 0))
                        found_usage = True

        # ── Fallback 3: Gemini-style keys ──
        if not found_usage and response.generations:
            for gen_list in response.generations:
                for gen in gen_list:
                    gen_info = getattr(gen, "generation_info", {}) or {}
                    usage = gen_info.get("usage_metadata", {})
                    if usage:
                        input_tokens += usage.get("prompt_token_count", 0)
                        output_tokens += usage.get("candidates_token_count", 0)
                        if input_tokens > 0 or output_tokens > 0:
                            found_usage = True
                    if not found_usage:
                        input_tokens += gen_info.get("prompt_token_count", 0)
                        output_tokens += gen_info.get("candidates_token_count", 0)
                        if input_tokens > 0 or output_tokens > 0:
                            found_usage = True

        # ── Fallback 4: llm_output.usage_metadata (Gemini alt) ──
        if not found_usage and response.llm_output:
            usage = response.llm_output.get("usage_metadata", {})
            if usage:
                input_tokens = usage.get("prompt_token_count", usage.get("input_tokens", 0))
                output_tokens = usage.get("candidates_token_count", usage.get("output_tokens", 0))
                if input_tokens > 0 or output_tokens > 0:
                    found_usage = True

        if not found_usage:
            logger.warning(
                f"⚠️ No usage_metadata for {self.role}/{self.model_id}. "
                f"Provider may not report token counts for this call type."
            )
            return

        # Record to in-memory session ledger
        SessionLedger.record(
            session_id=session_id,
            role=self.role,
            model_id=self.model_id,
            provider=self.provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

        # Persist to database for the system monitor
        _persist_to_database(self.model_id, input_tokens, output_tokens)
