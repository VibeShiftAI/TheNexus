"""
Token Tracker - Python equivalent of the Node.js token-tracker.js

Tracks AI token usage from LangChain/LangGraph agents and persists to Supabase.
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
    
    Args:
        model: The model name (e.g., 'claude-opus-4-5-20251101')
        input_tokens: Number of input/prompt tokens
        output_tokens: Number of output/completion tokens
        task: Optional task identifier for logging
    """
    try:
        supabase = get_supabase()
        if not supabase.is_configured():
            print(f"[TokenTracker] Supabase not configured, skipping tracking")
            return
        
        provider = get_provider_from_model(model)
        total_tokens = input_tokens + output_tokens
        
        # Record to database
        await supabase.record_usage(model, input_tokens, output_tokens)
        
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
    Fully synchronous token tracking using requests library.
    
    This avoids event loop issues when called from LangChain callbacks.
    """
    import os
    import requests
    from datetime import datetime
    
    try:
        supabase_url = os.environ.get("SUPABASE_URL")
        # Use service key to bypass RLS (anon key blocked by row-level security)
        supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
        
        if not supabase_url or not supabase_key:
            print(f"[TokenTracker] Supabase not configured, skipping")
            return
        
        provider = get_provider_from_model(model)
        total_tokens = input_tokens + output_tokens
        today = datetime.utcnow().strftime("%Y-%m-%d")
        
        headers = {
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
        
        # Check for existing record
        check_url = f"{supabase_url}/rest/v1/usage_stats?date=eq.{today}&model=eq.{model}"
        response = requests.get(check_url, headers=headers)
        print(f"[TokenTracker] GET {response.status_code}: {len(response.json()) if response.ok else response.text[:100]}")
        existing = response.json() if response.ok else []
        
        if existing and len(existing) > 0:
            # Update existing record
            record = existing[0]
            update_data = {
                "input_tokens": (record.get("input_tokens", 0) or 0) + input_tokens,
                "output_tokens": (record.get("output_tokens", 0) or 0) + output_tokens,
                "total_tokens": (record.get("total_tokens", 0) or 0) + total_tokens,
                "request_count": (record.get("request_count", 0) or 0) + 1
            }
            update_url = f"{supabase_url}/rest/v1/usage_stats?id=eq.{record['id']}"
            result = requests.patch(update_url, json=update_data, headers=headers)
            if not result.ok:
                print(f"[TokenTracker] DB update failed: {result.status_code} {result.text[:200]}")
                return
        else:
            # Insert new record
            insert_data = {
                "date": today,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "request_count": 1
            }
            insert_url = f"{supabase_url}/rest/v1/usage_stats"
            result = requests.post(insert_url, json=insert_data, headers=headers)
            if not result.ok:
                print(f"[TokenTracker] DB insert failed: {result.status_code} {result.text[:200]}")
                return
        
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
                            raise ValueError(f"No usage_metadata on message for {model}. Available attrs: {[a for a in dir(msg) if not a.startswith('_')]}")
                        
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
