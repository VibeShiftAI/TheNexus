"""
Text-to-speech adapter.

Primary: ElevenLabs (same voice Praxis uses elsewhere, so the YouTube channel
sounds like him across iMessage / Telegram / YouTube). Mirrors the API contract
of Praxis/src/voice/elevenlabs.ts — keeps voice consistent across the agent
swap because both sides hit the same REST endpoint with the same voice_id.

Fallback: macOS `say` — offline / dev-mode only. Useful for pipeline smoke
tests when you don't want to burn ElevenLabs characters.

Selection:
  - If provider="elevenlabs" (default) and ELEVENLABS_API_KEY is set, use it.
  - If provider="macos_say" OR no key set, fall back to `say`.
  - Anything else -> error.

Cost accounting:
  - ElevenLabs: logged to cost_ledger using ELEVENLABS_USD_PER_CHAR env var
    (default 0.00003 — rough Turbo-tier figure; override to match your plan).
  - macOS say: logged with usd=0.0.

Status: FUNCTIONAL for both branches. ElevenLabs is the default.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from ..interface import NexusTool, ToolCategory, ToolMetadata
from .cost_ledger import record_usage
from .credentials import resolve_elevenlabs_key, resolve_elevenlabs_voice_id


OUTPUT_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "media" / "tts"

# Praxis's voice (Daniel, British male). Keep in sync with
# Praxis/src/voice/elevenlabs.ts so channels sound identical.
DEFAULT_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"
DEFAULT_MODEL_ID = "eleven_turbo_v2_5"
ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1"

# Pricing constant — ElevenLabs Turbo tier, ~ $0.00003 / character at time of writing.
# Update this when your ElevenLabs plan changes.
ELEVENLABS_USD_PER_CHAR = 0.00003


class TTSGenerateTool(NexusTool):
    """Generate a voiceover audio file from narration text."""

    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="tts_generate",
            description=(
                "Generate a voiceover audio file. Defaults to ElevenLabs "
                "(Praxis's voice); falls back to macOS `say` in dev."
            ),
            category=ToolCategory.MEDIA,
            can_auto_execute=True,
            requires_permission=False,
            estimated_cost="low",
            tags=["tts", "voice", "audio", "elevenlabs"],
        )

    async def execute(
        self,
        context: Dict[str, Any],
        text: str,
        episode_slug: Optional[str] = None,
        scene_id: Optional[str] = None,
        provider: str = "elevenlabs",
        voice_id: Optional[str] = None,
        model_id: Optional[str] = None,
        voice: str = "Alex",
    ) -> Dict[str, Any]:
        """
        Args:
            text: Narration to synthesize.
            episode_slug, scene_id: For cost-ledger attribution.
            provider: "elevenlabs" (default) | "macos_say".
            voice_id: ElevenLabs voice; defaults to Praxis's voice.
            model_id: ElevenLabs model; defaults to eleven_turbo_v2_5.
            voice: macOS `say` voice name, only used when provider='macos_say'.

        Returns:
            {"success": True, "result": {
                "audio_path": "/abs/path/to/file.{mp3,aiff}",
                "duration_s": float,
                "provider": str,
                "alignment": None,  # future: word-level timings from ElevenLabs v2 endpoints
            }}
        """
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        call_id = str(uuid.uuid4())[:8]

        if provider == "elevenlabs":
            api_key = resolve_elevenlabs_key()
            if not api_key:
                return {
                    "success": False,
                    "error": (
                        "ELEVENLABS_API_KEY not found in this env or in Praxis/.env. "
                        "Pass provider='macos_say' for a local fallback."
                    ),
                }
            return await _synthesize_elevenlabs(
                text=text,
                api_key=api_key,
                voice_id=voice_id or resolve_elevenlabs_voice_id(DEFAULT_VOICE_ID),
                model_id=model_id or DEFAULT_MODEL_ID,
                episode_slug=episode_slug,
                scene_id=scene_id,
                out_path=OUTPUT_DIR / f"{episode_slug or 'scratch'}_{scene_id or 'x'}_{call_id}.mp3",
            )

        if provider == "macos_say":
            return await _synthesize_macos_say(
                text=text,
                voice=voice,
                episode_slug=episode_slug,
                scene_id=scene_id,
                out_path=OUTPUT_DIR / f"{episode_slug or 'scratch'}_{scene_id or 'x'}_{call_id}.aiff",
            )

        return {"success": False, "error": f"Unknown TTS provider: {provider}"}


async def _synthesize_elevenlabs(
    *,
    text: str,
    api_key: str,
    voice_id: str,
    model_id: str,
    episode_slug: Optional[str],
    scene_id: Optional[str],
    out_path: Path,
) -> Dict[str, Any]:
    url = f"{ELEVENLABS_API_BASE}/text-to-speech/{voice_id}"
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
            "use_speaker_boost": True,
            "speed": 1.2,
        },
    }
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
    except httpx.HTTPError as e:
        return {"success": False, "error": f"ElevenLabs request failed: {e}"}

    if resp.status_code != 200:
        body = resp.text[:500]
        return {"success": False, "error": f"ElevenLabs error {resp.status_code}: {body}"}

    out_path.write_bytes(resp.content)
    duration_s = _probe_duration_s(out_path)

    usd = round(ELEVENLABS_USD_PER_CHAR * len(text), 6)
    record_usage(
        model="elevenlabs",
        operation="tts",
        units=float(len(text)),
        unit_label="characters",
        usd=usd,
        episode_slug=episode_slug,
        scene_id=scene_id,
        metadata={
            "voice_id": voice_id,
            "model_id": model_id,
            "duration_s": duration_s,
            "usd_per_char": ELEVENLABS_USD_PER_CHAR,
        },
    )

    return {
        "success": True,
        "result": {
            "audio_path": str(out_path),
            "duration_s": duration_s,
            "provider": "elevenlabs",
            "alignment": None,
        },
    }


async def _synthesize_macos_say(
    *,
    text: str,
    voice: str,
    episode_slug: Optional[str],
    scene_id: Optional[str],
    out_path: Path,
) -> Dict[str, Any]:
    if shutil.which("say") is None:
        return {
            "success": False,
            "error": "`say` command not found — macOS only. Use provider='elevenlabs' with a valid API key.",
        }

    proc = await asyncio.create_subprocess_exec(
        "say", "-v", voice, "-o", str(out_path), text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        return {
            "success": False,
            "error": f"say failed (rc={proc.returncode}): {stderr.decode(errors='replace')[:500]}",
        }

    duration_s = _probe_duration_s(out_path)
    record_usage(
        model="macos-say",
        operation="tts",
        units=float(len(text)),
        unit_label="characters",
        usd=0.0,
        episode_slug=episode_slug,
        scene_id=scene_id,
        metadata={"voice": voice, "duration_s": duration_s},
    )
    return {
        "success": True,
        "result": {
            "audio_path": str(out_path),
            "duration_s": duration_s,
            "provider": "macos_say",
            "alignment": None,
        },
    }


def _probe_duration_s(path: Path) -> float:
    if shutil.which("ffprobe") is None:
        return 0.0
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            capture_output=True, text=True, timeout=10,
        )
        return float(out.stdout.strip() or 0.0)
    except Exception:
        return 0.0
