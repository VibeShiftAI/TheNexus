"""
LLM Utility Functions — Cortex

Provider-agnostic helpers for working with LangChain LLM responses.
"""

from typing import Any


def extract_text(response: Any) -> str:
    """
    Extract plain text from an LLM response, handling provider differences.

    Gemini returns response.content as a list of content blocks,
    while OpenAI returns a plain string. This normalizes both to a string.

    Args:
        response: A LangChain AIMessage or similar response object.

    Returns:
        The response text as a plain string.
    """
    content = response.content if hasattr(response, "content") else response

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                parts.append(block.get("text", str(block)))
            elif isinstance(block, str):
                parts.append(block)
            else:
                parts.append(str(block))
        return " ".join(parts)

    return str(content)
