"""
ffmpeg assembler — mux per-scene visuals + narration into a final MP4, keeping
any music/audio baked into scene visuals (Veo 3 output includes music).

Input contract (matches what the workflow's `assemble_video` node will build):
  scenes: [
    {
      "scene_id": "s1",
      "visual_path": "/abs/path/to/clip_or_still.{mp4,png,jpg}",
      "audio_path":  "/abs/path/to/narration.{mp3,aiff}",  # optional per-scene TTS
      "duration_s":  5.0,
      "has_source_audio": True,  # True for Veo 3 clips (music baked in)
    }, ...
  ]

Strategy (every scene re-encoded to matching codecs so concat works):
  1. For each scene, produce a normalized MP4 of exactly `duration_s` seconds
     with video track (libx264, target resolution, 30 fps) AND an audio track
     (AAC 44.1 kHz stereo). Audio source:
       - has_source_audio=True:  keep the visual's own audio (Veo's music)
       - has_source_audio=False OR image input: silent audio via anullsrc
  2. Concat the per-scene MP4s (demuxer, stream copy) into video+music track.
  3. Concat per-scene narration (or use global_audio_path) into narration track.
  4. Mix narration over music with filter_complex amix (narration 1.0, music 0.25).
  5. Thumbnail: grab frame at `thumbnail_at_s`.

Tunables:
  VOLUME_NARRATION, VOLUME_MUSIC — override defaults if narration gets buried
  or music sounds too loud in review.

Status: FUNCTIONAL when ffmpeg is installed. No paid-API spend.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..interface import NexusTool, ToolCategory, ToolMetadata


OUTPUT_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "media" / "assembled"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}

# Mix levels. Narration must stay intelligible over Veo's music.
VOLUME_NARRATION = 1.0
VOLUME_MUSIC = 0.25


class FfmpegAssembleTool(NexusTool):
    """Mux per-scene visuals + narration into a final MP4 plus a thumbnail."""

    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="ffmpeg_assemble",
            description=(
                "Assemble per-scene visuals (preserving Veo 3 music) + narration "
                "into a final MP4 and extract a thumbnail."
            ),
            category=ToolCategory.MEDIA,
            can_auto_execute=True,
            requires_permission=False,
            estimated_cost="free",
            tags=["ffmpeg", "video", "assembly"],
        )

    async def execute(
        self,
        context: Dict[str, Any],
        scenes: List[Dict[str, Any]],
        episode_slug: str,
        global_audio_path: Optional[str] = None,
        thumbnail_at_s: float = 2.0,
        resolution: str = "1920x1080",
        fps: int = 30,
    ) -> Dict[str, Any]:
        if shutil.which("ffmpeg") is None:
            return {"success": False, "error": "ffmpeg not found on PATH"}
        if not scenes:
            return {"success": False, "error": "No scenes provided"}

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        run_id = str(uuid.uuid4())[:8]
        final_path = OUTPUT_DIR / f"{episode_slug}_{run_id}.mp4"
        thumb_path = OUTPUT_DIR / f"{episode_slug}_{run_id}_thumb.jpg"

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)

            # 1. Per-scene normalized MP4s (video + music-or-silence audio)
            scene_clips: List[Path] = []
            for idx, sc in enumerate(scenes):
                out_clip = tmp_dir / f"scene_{idx:03d}.mp4"
                ok, err = await _render_scene(sc, out_clip, resolution, fps)
                if not ok:
                    return {"success": False, "error": f"scene {idx} render failed: {err[:300]}"}
                scene_clips.append(out_clip)

            # 2. Concat scene MP4s (stream copy — all scenes share codec params)
            video_music_track = tmp_dir / "video_music.mp4"
            ok, err = await _concat_mp4s(scene_clips, video_music_track)
            if not ok:
                return {"success": False, "error": f"concat failed: {err[:300]}"}

            # 3. Narration track (optional)
            narration_track: Optional[Path] = None
            if global_audio_path:
                narration_track = Path(global_audio_path)
            else:
                per_scene_narration = [Path(sc["audio_path"]) for sc in scenes if sc.get("audio_path")]
                if per_scene_narration:
                    narration_track = tmp_dir / "narration.m4a"
                    ok, err = await _concat_audio(per_scene_narration, narration_track)
                    if not ok:
                        return {"success": False, "error": f"narration concat failed: {err[:300]}"}

            # 4. Final mux — mix narration over music, or passthrough if no narration
            if narration_track:
                ok, err = await _mix_narration_over_music(
                    video_music_track, narration_track, final_path,
                )
                if not ok:
                    return {"success": False, "error": f"mix failed: {err[:300]}"}
            else:
                shutil.copy(video_music_track, final_path)

            # 5. Thumbnail
            ok, err = await _grab_thumbnail(final_path, thumb_path, thumbnail_at_s)
            if not ok:
                return {"success": False, "error": f"thumbnail failed: {err[:300]}"}

        return {
            "success": True,
            "result": {
                "video_path": str(final_path),
                "thumbnail_path": str(thumb_path),
                "resolution": resolution,
                "fps": fps,
                "scene_count": len(scenes),
                "had_music": any(sc.get("has_source_audio") for sc in scenes),
                "had_narration": narration_track is not None,
            },
        }


async def _render_scene(sc: Dict[str, Any], out: Path, resolution: str, fps: int) -> tuple[bool, str]:
    """
    Normalize one scene to a fixed-codec MP4 with both video and audio streams.

    Audio source depends on has_source_audio:
      True  -> keep the visual's own audio track (Veo's music)
      False -> anullsrc silent stereo at 44.1 kHz
    """
    visual = Path(sc["visual_path"])
    dur = float(sc.get("duration_s", 5.0))
    has_src_audio = bool(sc.get("has_source_audio")) and visual.suffix.lower() not in IMAGE_EXTS
    is_image = visual.suffix.lower() in IMAGE_EXTS

    scale_filter = (
        f"scale={resolution}:force_original_aspect_ratio=decrease,"
        f"pad={resolution}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}"
    )

    if is_image:
        cmd = [
            "ffmpeg", "-y",
            "-loop", "1", "-i", str(visual),
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-t", f"{dur}",
            "-vf", scale_filter,
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "44100", "-ac", "2",
            "-shortest",
            str(out),
        ]
    elif has_src_audio:
        cmd = [
            "ffmpeg", "-y",
            "-i", str(visual),
            "-t", f"{dur}",
            "-vf", scale_filter,
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "44100", "-ac", "2",
            str(out),
        ]
    else:
        cmd = [
            "ffmpeg", "-y",
            "-i", str(visual),
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-t", f"{dur}",
            "-map", "0:v:0", "-map", "1:a:0",
            "-vf", scale_filter,
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "44100", "-ac", "2",
            "-shortest",
            str(out),
        ]

    return await _run(cmd)


async def _concat_mp4s(clips: List[Path], out: Path) -> tuple[bool, str]:
    list_file = out.parent / f"concat_{out.stem}.txt"
    list_file.write_text("".join(f"file '{p}'\n" for p in clips))
    return await _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(list_file), "-c", "copy", str(out),
    ])


async def _concat_audio(tracks: List[Path], out: Path) -> tuple[bool, str]:
    list_file = out.parent / f"concat_audio_{out.stem}.txt"
    list_file.write_text("".join(f"file '{p}'\n" for p in tracks))
    return await _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(list_file), "-c:a", "aac", "-ar", "44100", "-ac", "2", str(out),
    ])


async def _mix_narration_over_music(
    video_music: Path, narration: Path, out: Path,
) -> tuple[bool, str]:
    filter_complex = (
        f"[0:a]volume={VOLUME_MUSIC}[music];"
        f"[1:a]volume={VOLUME_NARRATION}[voice];"
        f"[music][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]"
    )
    return await _run([
        "ffmpeg", "-y",
        "-i", str(video_music),
        "-i", str(narration),
        "-filter_complex", filter_complex,
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        str(out),
    ])


async def _grab_thumbnail(video: Path, out: Path, at_s: float) -> tuple[bool, str]:
    return await _run([
        "ffmpeg", "-y", "-ss", f"{at_s}", "-i", str(video),
        "-frames:v", "1", "-q:v", "2", str(out),
    ])


async def _run(cmd: List[str]) -> tuple[bool, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if (proc.returncode or 0) != 0:
        return False, stderr.decode(errors="replace")
    return True, ""
