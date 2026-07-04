"""
Nano Banana 2 adapter — image generation via Google's Gemini image model.

Live-call path uses the generativelanguage REST surface:

  POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL_ID}:generateContent?key={API_KEY}

Request body follows the standard generateContent shape; the response contains
one or more `parts` with `inline_data` (base64 PNG/JPEG). We pick the first
inline_data part, decode, and write it out.

Env:
  NANO_BANANA_API_KEY — Google API key with the Gemini image model enabled.
  NANO_BANANA_MODEL_ID — override the model ID (default below).

Why the model ID is env-overridable: Google rotates image-gen model IDs
frequently (preview → stable → next-gen). Keep NANO_BANANA_USD_PER_IMAGE in
sync with the currently-selected model.

Fallback: when no API key is set OR dry_run=True, writes a tiny grey PNG
placeholder so the pipeline can run end-to-end without paid calls.
"""

from __future__ import annotations

import base64
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from ..interface import NexusTool, ToolCategory, ToolMetadata
from .cost_ledger import record_usage
from .credentials import resolve_google_key


OUTPUT_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "media" / "stills"

# Pricing constant — update when Google's Gemini image pricing changes.
# Rough placeholder; verify against current rate card before enabling live calls.
NANO_BANANA_USD_PER_IMAGE = 0.03

# Default model ID. Override via NANO_BANANA_MODEL_ID if Google rotates it.
DEFAULT_MODEL_ID = "gemini-2.5-flash-image"

_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_TIMEOUT_S = 120.0


class NanoBananaGenerateTool(NexusTool):
    """Generate a still image via Nano Banana 2."""

    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="nano_banana_generate",
            description="Generate a still image from a prompt using Nano Banana 2.",
            category=ToolCategory.MEDIA,
            can_auto_execute=False,
            requires_permission=True,
            estimated_cost="low",
            tags=["image", "nano-banana", "google", "generation"],
        )

    async def execute(
        self,
        context: Dict[str, Any],
        prompt: str,
        episode_slug: Optional[str] = None,
        scene_id: Optional[str] = None,
        image_id: Optional[str] = None,
        aspect_ratio: str = "16:9",
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """
        Args:
            prompt: Text description of the image to generate.
            episode_slug, scene_id, image_id: For cost-ledger attribution.
            aspect_ratio: "16:9" (YouTube default), "1:1", "9:16".
            dry_run: If True, skip the API call and return a placeholder path.

        Returns (on success):
            {"success": True, "result": {
                "image_path": "/abs/path/to.png",
                "prompt": "...",
                "model": "<model-id>",
                "dry_run": bool,
            }}
        """
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        api_key = resolve_google_key("NANO_BANANA_API_KEY")
        model_id = os.getenv("NANO_BANANA_MODEL_ID", DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID

        if dry_run or not api_key:
            placeholder = OUTPUT_DIR / f"placeholder_{uuid.uuid4().hex[:8]}.png"
            _write_placeholder_png(placeholder, prompt)
            return {
                "success": True,
                "result": {
                    "image_path": str(placeholder),
                    "prompt": prompt,
                    "model": model_id,
                    "dry_run": True,
                    "note": (
                        "DRY RUN: placeholder PNG written (no API key or dry_run=True)."
                    ),
                },
            }

        out_path = OUTPUT_DIR / f"{episode_slug or 'adhoc'}_{scene_id or 'scene'}_{uuid.uuid4().hex[:6]}.png"
        prompt_with_aspect = (
            f"{prompt}\n\n"
            f"Output a single image. Target aspect ratio: {aspect_ratio}. "
            f"No borders, no text overlays unless requested."
        )

        body = {
            "contents": [
                {"role": "user", "parts": [{"text": prompt_with_aspect}]}
            ],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
            },
        }
        url = f"{_API_BASE}/models/{model_id}:generateContent"

        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                resp = await client.post(url, params={"key": api_key}, json=body)
        except httpx.HTTPError as e:
            return {"success": False, "error": f"Nano Banana HTTP error: {e}"}

        if resp.status_code != 200:
            return {
                "success": False,
                "error": f"Nano Banana {resp.status_code}: {resp.text[:500]}",
            }

        try:
            data = resp.json()
            img_bytes = _extract_inline_image(data)
        except (ValueError, KeyError) as e:
            return {"success": False, "error": f"Nano Banana response parse failed: {e}"}

        if img_bytes is None:
            return {
                "success": False,
                "error": "Nano Banana response contained no inline image data",
            }

        out_path.write_bytes(img_bytes)

        record_usage(
            model=model_id,
            operation="generate_image",
            units=1,
            unit_label="image",
            usd=NANO_BANANA_USD_PER_IMAGE,
            episode_slug=episode_slug,
            scene_id=scene_id,
            metadata={"aspect_ratio": aspect_ratio, "image_id": image_id},
        )

        return {
            "success": True,
            "result": {
                "image_path": str(out_path),
                "prompt": prompt,
                "model": model_id,
                "dry_run": False,
            },
        }


def _extract_inline_image(data: Dict[str, Any]) -> Optional[bytes]:
    """Pull the first inline_data image payload from a generateContent response."""
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            inline = part.get("inline_data") or part.get("inlineData")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    return None


def _write_placeholder_png(path: Path, caption: str) -> None:
    """
    Tiny PNG placeholder so downstream nodes (Veo, ffmpeg) can still operate.
    Writes a 16x9 solid-grey PNG using stdlib only. ffmpeg's scale filter
    upscales to the target resolution during assembly.
    """
    import struct, zlib

    width, height = 16, 9
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes([128, 128, 128]) * width
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    path.write_bytes(png)
