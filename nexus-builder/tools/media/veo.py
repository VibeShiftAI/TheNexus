"""
Veo 3 adapter — video animation from a source image.

IMPORTANT: Veo 3 output already INCLUDES MUSIC/AUDIO. The ffmpeg_assembler
must preserve this audio track and mix the narration on top — do not strip
it. The assembler's input contract carries `has_source_audio: True` for Veo
scenes so the amix branch kicks in.

Live-call path uses the generativelanguage long-running operations surface:

  1. POST models/{MODEL_ID}:predictLongRunning with a reference image
     (inline_data base64) + motion prompt + duration.
  2. Poll the returned operation name at `operations/{name}` until `done: true`.
  3. Response embeds a downloadable video URI (sometimes requires appending
     the API key). Fetch the MP4 bytes and write to OUTPUT_DIR.

Because the exact shape of Veo's prediction request/response evolves, both
the model ID and the response field names are defensive — we search the
response for any field resembling a video URI.

Env:
  VEO_API_KEY — Google API key with Veo enabled.
  VEO_MODEL_ID — override the model ID (default below).
  VEO_POLL_INTERVAL_S — override the poll cadence (default 6s).
  VEO_POLL_TIMEOUT_S — fail after this many seconds (default 300s).

Dry-run: silent MP4 loop of the source image; has_source_audio=False.
"""

from __future__ import annotations

import asyncio
import base64
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from ..interface import NexusTool, ToolCategory, ToolMetadata
from .cost_ledger import record_usage
from .credentials import resolve_google_key


OUTPUT_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "media" / "clips"

# Pricing constant — update when Google's Veo pricing changes.
VEO_USD_PER_SECOND = 0.30

DEFAULT_MODEL_ID = "veo-3.0-generate-preview"

_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_HTTP_TIMEOUT_S = 120.0


class VeoAnimateTool(NexusTool):
    """Animate a still into a short clip via Veo 3."""

    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="veo_animate",
            description="Animate a still image into a short video clip using Veo 3.",
            category=ToolCategory.MEDIA,
            can_auto_execute=False,
            requires_permission=True,
            estimated_cost="high",
            tags=["video", "veo", "google", "animation"],
        )

    async def execute(
        self,
        context: Dict[str, Any],
        source_image_path: str,
        motion_prompt: str,
        duration_s: float = 5.0,
        episode_slug: Optional[str] = None,
        scene_id: Optional[str] = None,
        clip_id: Optional[str] = None,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        src = Path(source_image_path)
        if not src.exists():
            return {"success": False, "error": f"source_image_path not found: {src}"}

        api_key = resolve_google_key("VEO_API_KEY")
        model_id = os.getenv("VEO_MODEL_ID", DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID

        if dry_run or not api_key:
            out_path = OUTPUT_DIR / f"placeholder_{uuid.uuid4().hex[:8]}.mp4"
            ok, err = await _loop_still_as_clip(src, out_path, duration_s)
            if not ok:
                return {"success": False, "error": err}
            return {
                "success": True,
                "result": {
                    "video_path": str(out_path),
                    "duration_s": duration_s,
                    "has_source_audio": False,
                    "model": model_id,
                    "dry_run": True,
                    "note": (
                        "DRY RUN: silent loop of source image. Real Veo 3 output "
                        "will include music (has_source_audio=True)."
                    ),
                },
            }

        poll_interval = float(os.getenv("VEO_POLL_INTERVAL_S", "6") or 6)
        poll_timeout = float(os.getenv("VEO_POLL_TIMEOUT_S", "300") or 300)

        mime = _guess_image_mime(src)
        image_b64 = base64.b64encode(src.read_bytes()).decode("ascii")

        body = {
            "instances": [
                {
                    "prompt": motion_prompt,
                    "image": {"bytesBase64Encoded": image_b64, "mimeType": mime},
                }
            ],
            "parameters": {
                "durationSeconds": int(round(duration_s)),
                "aspectRatio": "16:9",
            },
        }
        start_url = f"{_API_BASE}/models/{model_id}:predictLongRunning"

        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
            try:
                start = await client.post(start_url, params={"key": api_key}, json=body)
            except httpx.HTTPError as e:
                return {"success": False, "error": f"Veo start HTTP error: {e}"}
            if start.status_code != 200:
                return {"success": False, "error": f"Veo start {start.status_code}: {start.text[:500]}"}
            op = start.json()
            op_name = op.get("name")
            if not op_name:
                return {"success": False, "error": f"Veo start: no operation name in response: {str(op)[:300]}"}

            waited = 0.0
            final = op
            while not final.get("done"):
                if waited >= poll_timeout:
                    return {"success": False, "error": f"Veo poll timed out after {poll_timeout}s"}
                await asyncio.sleep(poll_interval)
                waited += poll_interval
                try:
                    poll = await client.get(f"{_API_BASE}/{op_name}", params={"key": api_key})
                except httpx.HTTPError as e:
                    return {"success": False, "error": f"Veo poll HTTP error: {e}"}
                if poll.status_code != 200:
                    return {"success": False, "error": f"Veo poll {poll.status_code}: {poll.text[:500]}"}
                final = poll.json()

            if "error" in final:
                return {"success": False, "error": f"Veo operation failed: {str(final['error'])[:500]}"}

            video_uri = _find_video_uri(final.get("response", {}))
            inline_video = _find_inline_video(final.get("response", {}))
            out_path = OUTPUT_DIR / f"{episode_slug or 'adhoc'}_{scene_id or 'scene'}_{uuid.uuid4().hex[:6]}.mp4"

            if inline_video is not None:
                out_path.write_bytes(inline_video)
            elif video_uri:
                try:
                    dl = await client.get(video_uri, params={"key": api_key})
                except httpx.HTTPError as e:
                    return {"success": False, "error": f"Veo download HTTP error: {e}"}
                if dl.status_code != 200:
                    return {"success": False, "error": f"Veo download {dl.status_code}: {dl.text[:200]}"}
                out_path.write_bytes(dl.content)
            else:
                return {
                    "success": False,
                    "error": f"Veo response contained no video URI or inline data: {str(final)[:500]}",
                }

        record_usage(
            model=model_id,
            operation="animate_clip",
            units=duration_s,
            unit_label="seconds",
            usd=VEO_USD_PER_SECOND * duration_s,
            episode_slug=episode_slug,
            scene_id=scene_id,
            metadata={"clip_id": clip_id},
        )

        return {
            "success": True,
            "result": {
                "video_path": str(out_path),
                "duration_s": duration_s,
                "has_source_audio": True,
                "model": model_id,
                "dry_run": False,
            },
        }


def _guess_image_mime(p: Path) -> str:
    ext = p.suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(ext, "image/png")


def _find_video_uri(obj: Any) -> Optional[str]:
    """Walk the response object looking for a downloadable video URI."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k.lower() in {"uri", "videouri", "video_uri", "gcsuri", "downloaduri"}:
                if v.startswith("http"):
                    return v
            found = _find_video_uri(v)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_video_uri(item)
            if found:
                return found
    return None


def _find_inline_video(obj: Any) -> Optional[bytes]:
    """Walk the response looking for inline base64 video bytes."""
    if isinstance(obj, dict):
        inline = obj.get("inline_data") or obj.get("inlineData") or obj.get("bytesBase64Encoded")
        if isinstance(inline, dict) and inline.get("data"):
            mime = (inline.get("mime_type") or inline.get("mimeType") or "").lower()
            if "video" in mime or not mime:
                try:
                    return base64.b64decode(inline["data"])
                except Exception:
                    pass
        if isinstance(inline, str):
            try:
                return base64.b64decode(inline)
            except Exception:
                pass
        for v in obj.values():
            found = _find_inline_video(v)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_inline_video(item)
            if found:
                return found
    return None


async def _loop_still_as_clip(src: Path, out: Path, duration_s: float) -> tuple[bool, str]:
    if shutil.which("ffmpeg") is None:
        return False, "ffmpeg not on PATH — can't produce dry-run clip"
    cmd = [
        "ffmpeg", "-y", "-loop", "1", "-i", str(src),
        "-t", f"{duration_s}", "-r", "30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        return False, f"ffmpeg failed: {stderr.decode(errors='replace')[:300]}"
    return True, ""
