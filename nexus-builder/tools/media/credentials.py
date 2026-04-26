"""
Credential resolution for media adapters.

Rules (Robert's direction):
  - ElevenLabs: reuse Praxis's key. Read from Praxis/.env if not already set
    in this process's environment — one key across iMessage, Telegram, YouTube.
  - Nano Banana / Veo: fall back to GOOGLE_API_KEY if the model-specific key
    isn't set (same Google project underneath in most setups).

Praxis env path: parent of PRAXIS_DATA_DIR (default /Volumes/Projects/Praxis).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


def _praxis_root() -> Path:
    data_dir = os.getenv("PRAXIS_DATA_DIR", "/Volumes/Projects/Praxis/data")
    return Path(data_dir).parent


def praxis_env(key: str) -> str:
    """Read a single key from Praxis's .env. Returns '' if file or key missing."""
    envfile = _praxis_root() / ".env"
    if not envfile.exists():
        return ""
    try:
        for line in envfile.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def resolve_elevenlabs_key() -> str:
    return os.getenv("ELEVENLABS_API_KEY", "").strip() or praxis_env("ELEVENLABS_API_KEY")


def resolve_elevenlabs_voice_id(default: str) -> str:
    return (
        os.getenv("ELEVENLABS_VOICE_ID", "").strip()
        or praxis_env("ELEVENLABS_VOICE_ID")
        or default
    )


def resolve_google_key(specific_env: Optional[str] = None) -> str:
    """Google API key: specific env var first (e.g. NANO_BANANA_API_KEY), then GOOGLE_API_KEY."""
    if specific_env:
        v = os.getenv(specific_env, "").strip()
        if v:
            return v
    return os.getenv("GOOGLE_API_KEY", "").strip()
