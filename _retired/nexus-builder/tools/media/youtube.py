"""
YouTube Data API adapter — upload the assembled MP4 as a PRIVATE video.

Locked design decision: privacyStatus is HARDCODED to "private". Robert flips
the video to public manually in YouTube Studio. No flag overrides this.

Env:
  YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET — OAuth 2.0 Desktop client creds.
Refresh token persists to: TheNexus/.secrets/youtube_oauth.json (gitignored).

One-time consent: run
  python -m tools.media.youtube --authorize
from nexus-builder/. It starts a local server, opens the consent URL, and
writes the refresh token file. After that, uploads run unattended.

Deps (listed commented in requirements.txt — uncomment before first live upload):
  google-api-python-client, google-auth-oauthlib, google-auth-httplib2

Cost: API calls are quota-limited but not priced. We still log to the ledger
for audit (usd=0.0).
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..interface import NexusTool, ToolCategory, ToolMetadata
from .cost_ledger import record_usage


LOCKED_PRIVACY = "private"  # DO NOT CHANGE without explicit user decision.
SECRETS_DIR = Path(__file__).resolve().parent.parent.parent.parent / ".secrets"
OAUTH_PATH = SECRETS_DIR / "youtube_oauth.json"

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
]

# Science & Technology — matches channel positioning.
DEFAULT_CATEGORY_ID = "28"


class YouTubeUploadTool(NexusTool):
    """Upload an assembled MP4 to YouTube as a private video."""

    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="youtube_upload",
            description=(
                "Upload an assembled MP4 to YouTube. ALWAYS uploads as 'private' — "
                "user flips to public manually in YouTube Studio."
            ),
            category=ToolCategory.MEDIA,
            can_auto_execute=False,
            requires_permission=True,
            estimated_cost="free",
            tags=["youtube", "upload", "publish"],
        )

    async def execute(
        self,
        context: Dict[str, Any],
        video_path: str,
        title: str,
        description: str,
        tags: Optional[List[str]] = None,
        thumbnail_path: Optional[str] = None,
        episode_slug: Optional[str] = None,
        category_id: str = DEFAULT_CATEGORY_ID,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        vid = Path(video_path)
        if not vid.exists():
            return {"success": False, "error": f"video_path not found: {vid}"}

        client_id = os.getenv("YOUTUBE_CLIENT_ID", "").strip()
        client_secret = os.getenv("YOUTUBE_CLIENT_SECRET", "").strip()
        oauth_exists = OAUTH_PATH.exists()

        if dry_run or not (client_id and client_secret and oauth_exists):
            fake_id = f"dryrun_{uuid.uuid4().hex[:11]}"
            record_usage(
                model="youtube-data-api",
                operation="upload",
                units=1, unit_label="video", usd=0.0,
                episode_slug=episode_slug,
                metadata={"dry_run": True, "title": title},
            )
            reason = (
                "dry_run=True" if dry_run
                else "missing OAuth" if not oauth_exists
                else "missing client creds"
            )
            return {
                "success": True,
                "result": {
                    "video_id": fake_id,
                    "url": f"https://youtu.be/{fake_id}",
                    "privacy": LOCKED_PRIVACY,
                    "dry_run": True,
                    "note": f"DRY RUN ({reason}). Run `python -m tools.media.youtube --authorize` once to enable live uploads.",
                },
            }

        # Real upload path — sync googleapiclient on a worker thread.
        try:
            result = await asyncio.to_thread(
                _upload_sync,
                video_path=str(vid),
                title=title,
                description=description,
                tags=tags or [],
                thumbnail_path=thumbnail_path,
                category_id=category_id,
            )
        except Exception as e:
            return {"success": False, "error": f"YouTube upload failed: {e}"}

        if not result.get("video_id"):
            return {"success": False, "error": f"Upload returned no video_id: {result}"}

        record_usage(
            model="youtube-data-api",
            operation="upload",
            units=1, unit_label="video", usd=0.0,
            episode_slug=episode_slug,
            metadata={"title": title, "video_id": result["video_id"]},
        )

        return {
            "success": True,
            "result": {
                "video_id": result["video_id"],
                "url": f"https://youtu.be/{result['video_id']}",
                "privacy": LOCKED_PRIVACY,
                "thumbnail_set": result.get("thumbnail_set", False),
                "dry_run": False,
            },
        }


def _load_credentials():
    """Load stored refresh token and mint an access token. Runs in a worker thread."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    creds = Credentials.from_authorized_user_file(str(OAUTH_PATH), SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            OAUTH_PATH.write_text(creds.to_json())
        else:
            raise RuntimeError(
                "Stored YouTube credentials are invalid and can't be refreshed. "
                "Re-run `python -m tools.media.youtube --authorize`."
            )
    return creds


def _upload_sync(
    *,
    video_path: str,
    title: str,
    description: str,
    tags: List[str],
    thumbnail_path: Optional[str],
    category_id: str,
) -> Dict[str, Any]:
    """Blocking upload via google-api-python-client. Called via asyncio.to_thread."""
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload

    creds = _load_credentials()
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "tags": tags[:30],
            "categoryId": category_id,
        },
        "status": {
            "privacyStatus": LOCKED_PRIVACY,
            "selfDeclaredMadeForKids": False,
            "embeddable": True,
        },
    }

    media = MediaFileUpload(video_path, mimetype="video/mp4", resumable=True, chunksize=8 * 1024 * 1024)
    req = yt.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    while response is None:
        _, response = req.next_chunk()

    video_id = response.get("id")
    thumbnail_set = False
    if video_id and thumbnail_path and Path(thumbnail_path).exists():
        try:
            yt.thumbnails().set(
                videoId=video_id,
                media_body=MediaFileUpload(thumbnail_path, mimetype="image/jpeg"),
            ).execute()
            thumbnail_set = True
        except Exception:
            thumbnail_set = False

    return {"video_id": video_id, "thumbnail_set": thumbnail_set}


def _authorize_cli() -> None:
    """One-time consent flow. Writes refresh token to OAUTH_PATH."""
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print(
            "google-auth-oauthlib not installed. Uncomment the google-* lines in "
            "requirements.txt and `pip install -r requirements.txt` first.",
            file=sys.stderr,
        )
        sys.exit(1)

    client_id = os.getenv("YOUTUBE_CLIENT_ID", "").strip()
    client_secret = os.getenv("YOUTUBE_CLIENT_SECRET", "").strip()
    if not (client_id and client_secret):
        print("YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in .env", file=sys.stderr)
        sys.exit(1)

    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }
    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    OAUTH_PATH.write_text(creds.to_json())
    print(f"Saved refresh token to {OAUTH_PATH}")


if __name__ == "__main__":
    if "--authorize" in sys.argv:
        _authorize_cli()
    else:
        print("Usage: python -m tools.media.youtube --authorize")
