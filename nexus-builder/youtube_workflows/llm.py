from __future__ import annotations

import re
from typing import Literal

from cortex.llm_factory import ModelRole, get_llm_for_role


YouTubeRole = Literal[
    "youtube_router",
    "youtube_researcher",
    "youtube_strategist",
    "youtube_scriptwriter",
    "youtube_producer",
    "youtube_compliance",
]


_THOUGHT_PATTERNS = [
    re.compile(r"<\|channel\>thought\n.*?<channel\|>\s*", re.DOTALL),
    re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE),
]


def strip_thought_blocks(text: str) -> str:
    cleaned = text
    for pattern in _THOUGHT_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    return cleaned


def youtube_role_to_model_role(role: YouTubeRole) -> ModelRole:
    role_map = {
        "youtube_router": ModelRole.YOUTUBE_ROUTER,
        "youtube_researcher": ModelRole.YOUTUBE_RESEARCHER,
        "youtube_strategist": ModelRole.YOUTUBE_STRATEGIST,
        "youtube_scriptwriter": ModelRole.YOUTUBE_SCRIPTWRITER,
        "youtube_producer": ModelRole.YOUTUBE_PRODUCER,
        "youtube_compliance": ModelRole.YOUTUBE_COMPLIANCE,
    }
    return role_map[role]


def get_youtube_llm(role: YouTubeRole):
    return get_llm_for_role(youtube_role_to_model_role(role))
