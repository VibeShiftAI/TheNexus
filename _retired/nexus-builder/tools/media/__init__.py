"""
Media adapters for Praxis's YouTube channel workflow.

These tools wrap external services (Nano Banana 2, Veo 3, ffmpeg, TTS, YouTube
Data API) plus a local cost ledger. They live in TheNexus — NOT in the agent
runtime — so they survive the planned Praxis -> local-model agent swap untouched.

Design notes (see ./STATUS.md for full handoff):
  - Credentials read from env vars (loaded in each module). YouTube OAuth
    refresh token persists to TheNexus/.secrets/youtube_oauth.json (gitignored).
  - Every paid-API call writes a row to the cost ledger BEFORE returning so a
    crash mid-run still leaves an audit trail.
  - Current status: tts, ffmpeg_assembler, cost_ledger are functional;
    nano_banana, veo, youtube are documented stubs awaiting credentials.
"""

from .cost_ledger import CostLedger, record_usage
from .ffmpeg_assembler import FfmpegAssembleTool
from .nano_banana import NanoBananaGenerateTool
from .tts import TTSGenerateTool
from .veo import VeoAnimateTool
from .youtube import YouTubeUploadTool


def register_tools(registry) -> None:
    """Register all media tools with the Nexus tool registry."""
    registry.register(NanoBananaGenerateTool())
    registry.register(VeoAnimateTool())
    registry.register(TTSGenerateTool())
    registry.register(FfmpegAssembleTool())
    registry.register(YouTubeUploadTool())


__all__ = [
    "CostLedger",
    "FfmpegAssembleTool",
    "NanoBananaGenerateTool",
    "TTSGenerateTool",
    "VeoAnimateTool",
    "YouTubeUploadTool",
    "record_usage",
    "register_tools",
]
