"""
Cortex Usage Callback — Phase 24: Treasury Guard Infrastructure

Provides automatic token usage tracking for every LLM call that goes through
the LLMFactory. Two key components:

1. SessionLedger: Thread-safe in-memory store, keyed by session_id
2. CortexUsageCallback: LangChain BaseCallbackHandler injected into every model

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
        """Extract usage metadata and record to ledger."""
        session_id = current_session.get()

        # Try to extract token usage from response
        input_tokens = 0
        output_tokens = 0
        found_usage = False

        # LangChain stores usage in llm_output or in generation metadata
        if response.llm_output:
            token_usage = response.llm_output.get("token_usage", {})
            if token_usage:
                input_tokens = token_usage.get("prompt_tokens", 0)
                output_tokens = token_usage.get("completion_tokens", 0)
                found_usage = True

        # Fallback: check generation-level metadata (some providers put it here)
        if not found_usage and response.generations:
            for gen_list in response.generations:
                for gen in gen_list:
                    gen_info = getattr(gen, "generation_info", {}) or {}
                    usage = gen_info.get("usage_metadata", {})
                    if usage:
                        input_tokens += usage.get("input_tokens", usage.get("prompt_tokens", 0))
                        output_tokens += usage.get("output_tokens", usage.get("completion_tokens", 0))
                        found_usage = True

        # Fallback 3: Gemini uses different key names (prompt_token_count, candidates_token_count)
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
                    # Also check top-level generation_info for Gemini
                    if not found_usage:
                        input_tokens += gen_info.get("prompt_token_count", 0)
                        output_tokens += gen_info.get("candidates_token_count", 0)
                        if input_tokens > 0 or output_tokens > 0:
                            found_usage = True

        # Fallback 4: Check llm_output for Gemini-style keys
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

        SessionLedger.record(
            session_id=session_id,
            role=self.role,
            model_id=self.model_id,
            provider=self.provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
