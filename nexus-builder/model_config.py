"""
Centralized Model Configuration for TheNexus LangGraph Engine

This module provides:
1. Model name constants
2. Tracked LLM factory functions (auto-track token usage)

Usage:
    from model_config import get_gemini_pro, get_claude_opus
    
    llm = get_gemini_pro()  # Returns LLM with automatic tracking
    response = llm.invoke(messages)
"""

from typing import Optional, List, Any

# ═══════════════════════════════════════════════════════════════
# MODEL NAME CONSTANTS
# ═══════════════════════════════════════════════════════════════

DEFAULT_FLASH_MODEL = 'gemini-3-flash-preview'
DEFAULT_PRO_MODEL = 'gemini-3-pro-preview'
DEFAULT_CODING_MODEL = 'claude-sonnet-4-20250514'

# Specific Agent Defaults
RESEARCHER_MODEL = DEFAULT_FLASH_MODEL
PLANNER_MODEL = DEFAULT_CODING_MODEL
CODER_MODEL = 'claude-opus-4-20250514'
REVIEWER_MODEL = DEFAULT_CODING_MODEL
SUPERVISOR_MODEL = 'claude-opus-4-5-20251101'
SUMMARIZER_MODEL = DEFAULT_FLASH_MODEL
EVALUATOR_MODEL = DEFAULT_FLASH_MODEL


# ═══════════════════════════════════════════════════════════════
# TRACKED LLM FACTORIES
# These functions return LLMs with automatic token tracking
# ═══════════════════════════════════════════════════════════════

# Lazy imports to avoid circular dependencies
_tracking_handler = None

def _get_tracking_handler():
    """Lazy-load the tracking handler to avoid import issues."""
    global _tracking_handler
    if _tracking_handler is None:
        try:
            from token_tracker import TokenTrackingHandler
            _tracking_handler = TokenTrackingHandler()
        except ImportError:
            print("[ModelConfig] Warning: token_tracker not available, tracking disabled")
            _tracking_handler = False  # Sentinel to avoid retrying
    return _tracking_handler if _tracking_handler else None


def get_gemini_flash(temperature: float = 0, callbacks: Optional[List[Any]] = None):
    """
    Returns Gemini Flash with automatic token tracking.
    Fast, cheap model for simple tasks.
    """
    from langchain_google_genai import ChatGoogleGenerativeAI
    
    cb = callbacks or []
    handler = _get_tracking_handler()
    if handler:
        cb = [handler] + cb
    
    return ChatGoogleGenerativeAI(
        model=DEFAULT_FLASH_MODEL,
        temperature=temperature,
        callbacks=cb
    )


def get_gemini_pro(temperature: float = 0.1, callbacks: Optional[List[Any]] = None):
    """
    Returns Gemini Pro with automatic token tracking.
    High reasoning, good for complex tasks.
    """
    from langchain_google_genai import ChatGoogleGenerativeAI
    
    cb = callbacks or []
    handler = _get_tracking_handler()
    if handler:
        cb = [handler] + cb
    
    return ChatGoogleGenerativeAI(
        model=DEFAULT_PRO_MODEL,
        temperature=temperature,
        callbacks=cb
    )


def get_claude_sonnet(temperature: float = 0, callbacks: Optional[List[Any]] = None):
    """
    Returns Claude Sonnet with automatic token tracking.
    Good coding model, balanced cost/quality.
    """
    from langchain_anthropic import ChatAnthropic
    
    cb = callbacks or []
    handler = _get_tracking_handler()
    if handler:
        cb = [handler] + cb
    
    return ChatAnthropic(
        model=DEFAULT_CODING_MODEL,
        temperature=temperature,
        callbacks=cb
    )


def get_claude_opus(temperature: float = 0, callbacks: Optional[List[Any]] = None, enable_caching: bool = False):
    """
    Returns Claude Opus with automatic token tracking.
    Best for complex reasoning and high-stakes decisions.
    
    Args:
        temperature: Model temperature (default 0)
        callbacks: Optional list of callbacks
        enable_caching: If True, enables prompt caching with 1-hour TTL.
                       Use cache_control in messages to mark cached content.
    """
    from langchain_anthropic import ChatAnthropic
    
    cb = callbacks or []
    handler = _get_tracking_handler()
    if handler:
        cb = [handler] + cb
    
    kwargs = {
        "model": CODER_MODEL,
        "temperature": temperature,
        "callbacks": cb
    }
    
    if enable_caching:
        kwargs["model_kwargs"] = {
            "extra_headers": {
                "anthropic-beta": "extended-cache-ttl-2025-04-11,prompt-caching-2024-07-31"
            }
        }
    
    return ChatAnthropic(**kwargs)


def get_supervisor_llm(temperature: float = 0, callbacks: Optional[List[Any]] = None):
    """
    Returns the Supervisor LLM (Claude Opus 4.5) with automatic token tracking.
    Used by Nexus Prime for high-level orchestration.
    """
    from langchain_anthropic import ChatAnthropic
    
    cb = callbacks or []
    handler = _get_tracking_handler()
    if handler:
        cb = [handler] + cb
    
    return ChatAnthropic(
        model=SUPERVISOR_MODEL,
        temperature=temperature,
        callbacks=cb
    )
