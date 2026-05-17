from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def resolve_executable(name: str) -> Optional[str]:
    found = shutil.which(name)
    if found:
        return found

    if name == "ffmpeg":
        bundled = project_root() / "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg"
        if bundled.exists():
            return str(bundled)

    return None
