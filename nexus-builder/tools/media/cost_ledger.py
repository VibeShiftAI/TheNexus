"""
Cost ledger — records every paid-API call made by a media adapter.

One SQLite file at TheNexus/nexus-builder/data/media_cost_ledger.db (outside the
repo if nexus-builder/data/ is gitignored; verify before first production use).

Rows are append-only. Rollups per episode slug happen on demand via
`summarize_episode(slug)`. The workflow calls this at Gate 3 so the final
approval UI can show actual-vs-estimate spend.

Why SQLite and not just JSON: concurrent writes from multiple nodes (Nano Banana
2 generating 10 stills in parallel, Veo 3 animating 3 clips in parallel) would
race on a JSON file. SQLite's WAL mode handles this cleanly.

Status: FUNCTIONAL — safe to call from any adapter.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, Optional

_DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "media_cost_ledger.db"
_LOCK = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def _open() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False, isolation_level=None)
    _conn.execute("PRAGMA journal_mode = WAL")
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS media_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          episode_slug TEXT,
          scene_id TEXT,
          model TEXT NOT NULL,
          operation TEXT NOT NULL,
          units REAL NOT NULL,
          unit_label TEXT NOT NULL,
          usd REAL NOT NULL,
          metadata_json TEXT
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_media_usage_episode ON media_usage(episode_slug)")
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_media_usage_model ON media_usage(model)")
    return _conn


def record_usage(
    *,
    model: str,
    operation: str,
    units: float,
    unit_label: str,
    usd: float,
    episode_slug: Optional[str] = None,
    scene_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> int:
    """
    Append a usage row. Returns the inserted row id.

    model: "nano-banana-2" | "veo-3" | "elevenlabs" | ...
    operation: "generate_image" | "animate_clip" | "tts" | ...
    units + unit_label: e.g. 1 + "image", 5 + "seconds", 1500 + "characters"
    usd: dollar cost for THIS single call (adapter is responsible for
         computing from current model pricing).
    """
    import json

    with _LOCK:
        cur = _open().execute(
            """
            INSERT INTO media_usage
              (episode_slug, scene_id, model, operation, units, unit_label, usd, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                episode_slug,
                scene_id,
                model,
                operation,
                units,
                unit_label,
                usd,
                json.dumps(metadata) if metadata else None,
            ),
        )
        return int(cur.lastrowid or 0)


def summarize_episode(slug: str) -> Dict[str, Any]:
    """Return per-model totals and overall USD for a given episode."""
    conn = _open()
    rows = conn.execute(
        """
        SELECT model, SUM(units) AS total_units, unit_label, SUM(usd) AS total_usd, COUNT(*) AS calls
          FROM media_usage
         WHERE episode_slug = ?
         GROUP BY model, unit_label
        """,
        (slug,),
    ).fetchall()
    breakdown = [
        {
            "model": r[0],
            "units": r[1],
            "unit_label": r[2],
            "usd": round(r[3], 4),
            "calls": r[4],
        }
        for r in rows
    ]
    total = round(sum(r["usd"] for r in breakdown), 4)
    return {"slug": slug, "breakdown": breakdown, "total_usd": total}


class CostLedger:
    """OO wrapper for callers that prefer a handle over module-level functions."""

    @staticmethod
    def record(**kwargs: Any) -> int:
        return record_usage(**kwargs)

    @staticmethod
    def summarize(slug: str) -> Dict[str, Any]:
        return summarize_episode(slug)


def _close_for_tests() -> None:
    """Test-only: reset the module-level connection."""
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None
