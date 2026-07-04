"""
Token Tracker - Python equivalent of the Node.js token-tracker.js

Tracks AI token usage from LangChain/LangGraph agents and persists to SQLite.
"""

import asyncio
from typing import Optional, Any, List, Dict, Union
from supabase_client import get_supabase


# Provider derivation from model name (matching Node.js logic)
def get_provider_from_model(model: str) -> str:
    """Derive provider from model name."""
    if not model:
        return "unknown"
    
    model_lower = model.lower()
    
    if "gemini" in model_lower or "palm" in model_lower:
        return "google"
    elif "claude" in model_lower or "anthropic" in model_lower:
        return "anthropic"
    elif "gpt" in model_lower or "o1" in model_lower or "o3" in model_lower:
        return "openai"
    elif "grok" in model_lower or "xai" in model_lower:
        return "xai"
    else:
        return "unknown"


async def track_usage(
    model: str,
    input_tokens: int,
    output_tokens: int,
    task: Optional[str] = None
) -> None:
    """
    Track AI token usage asynchronously.
    
    This is a fire-and-forget call - errors are logged but don't propagate.
    """
    try:
        client = get_supabase()
        if not client.is_configured():
            print(f"[TokenTracker] SQLite not configured, skipping tracking")
            return
        
        provider = get_provider_from_model(model)
        total_tokens = input_tokens + output_tokens
        
        # Record to database
        await client.record_usage(model, input_tokens, output_tokens)
        
        # Log for visibility
        print(f"[TokenTracker] {provider}/{model}: {input_tokens}+{output_tokens}={total_tokens} tokens")
        
    except Exception as e:
        print(f"[TokenTracker] Error: {e}")


def track_usage_sync(
    model: str,
    input_tokens: int,
    output_tokens: int,
    task: Optional[str] = None
) -> None:
    """
    Fully synchronous token tracking using direct sqlite3.
    
    This avoids event loop issues when called from LangChain callbacks.
    """
    import os
    import sqlite3
    import uuid
    from datetime import datetime
    from pathlib import Path
    
    try:
        db_path = os.environ.get("NEXUS_DB_PATH") or str(Path(__file__).parent.parent / "nexus.db")
        
        if not os.path.exists(db_path):
            print(f"[TokenTracker] Database not found at {db_path}, skipping")
            return
        
        provider = get_provider_from_model(model)
        total_tokens = input_tokens + output_tokens
        today = datetime.utcnow().strftime("%Y-%m-%d")
        
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        # Check for existing record
        cursor.execute(
            "SELECT * FROM usage_stats WHERE date = ? AND model = ?",
            (today, model)
        )
        existing = cursor.fetchone()
        
        if existing:
            # Update existing record
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
            # Insert new record
            cursor.execute(
                """INSERT INTO usage_stats (id, date, model, input_tokens, output_tokens, total_tokens, request_count)
                VALUES (?, ?, ?, ?, ?, ?, 1)""",
                (str(uuid.uuid4()), today, model, input_tokens, output_tokens, total_tokens)
            )
        
        conn.commit()
        conn.close()
        
        print(f"[TokenTracker] {provider}/{model}: {input_tokens}+{output_tokens}={total_tokens} tokens")
        
    except Exception as e:
        print(f"[TokenTracker] Error saving: {e}")


# ═══════════════════════════════════════════════════════════════
# LANGCHAIN CALLBACK HANDLER
# Automatically tracks all LLM calls - add to any model or chain
# ═══════════════════════════════════════════════════════════════

try:
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.outputs import LLMResult
    
    class TokenTrackingHandler(BaseCallbackHandler):
        """
        LangChain callback handler that automatically tracks token usage.
        
        Usage:
            from token_tracker import TokenTrackingHandler
            
            # Option 1: Add to model
            llm = ChatGoogleGenerativeAI(model="...", callbacks=[TokenTrackingHandler()])
            
            # Option 2: Pass in invoke
            response = llm.invoke(messages, callbacks=[TokenTrackingHandler()])
        """
        
        def __init__(self, task: str = "langchain"):
            self.task = task
        
        def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
            """Called when LLM finishes. Extract usage from message.usage_metadata."""
            try:
                for generation in response.generations:
                    for g in generation:
                        if not hasattr(g, 'message'):
                            raise ValueError(f"Generation has no message attribute: {type(g)}")
                            
                        msg = g.message
                        meta = getattr(msg, 'response_metadata', {}) or {}
                        model = meta.get('model_name', meta.get('model', 'unknown'))
                        
                        # Check message.usage_metadata directly (LangChain standard location)
                        if not hasattr(msg, 'usage_metadata') or not msg.usage_metadata:
                            raise ValueError(f"No usage_metadata on message for {model}.")
                        
                        usage = msg.usage_metadata
                        # Handle both dict and object access
                        if isinstance(usage, dict):
                            input_tokens = usage.get('input_tokens', 0) or usage.get('prompt_tokens', 0)
                            output_tokens = usage.get('output_tokens', 0) or usage.get('completion_tokens', 0)
                        else:
                            input_tokens = getattr(usage, 'input_tokens', 0) or getattr(usage, 'prompt_tokens', 0)
                            output_tokens = getattr(usage, 'output_tokens', 0) or getattr(usage, 'completion_tokens', 0)
                        
                        if not (input_tokens or output_tokens):
                            raise ValueError(f"usage_metadata exists but has no tokens: {usage}")
                        
                        track_usage_sync(model, input_tokens, output_tokens, self.task)
                        return
                                
            except Exception as e:
                print(f"[TokenTracker] ERROR: {e}")
                import traceback
                traceback.print_exc()
                raise  # Re-raise to make it visible

    # Global handler instance for convenience
    TRACKING_HANDLER = TokenTrackingHandler()
    
except ImportError:
    # LangChain not installed - define stub
    TokenTrackingHandler = None
    TRACKING_HANDLER = None
    print("[TokenTracker] LangChain not available - callback handler disabled")
