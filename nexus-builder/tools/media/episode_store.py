"""
Python-side access to Praxis's `youtube_episodes` SQLite table.

Why this exists: the LangGraph workflow needs to read the episode backlog,
count published episodes (for the cadence gate), and write row updates when
an episode is picked / published / measured. We chose direct file access
over an HTTP bridge to Praxis — the table lives at
`Praxis/data/youtube.db` and we open it in WAL mode so concurrent reads
from Praxis (the agent) and this Python service are safe.

Mirrors the TypeScript API in `Praxis/src/youtube/persistence.ts`. If either
side changes the schema, update both.

Path resolution:
  - PRAXIS_DATA_DIR env var, if set
  - else default "/Volumes/Projects/Praxis/data"
  (Override in TheNexus/.env for non-default layouts.)

Status: FUNCTIONAL. Schema creation is idempotent so this file safely
bootstraps the DB if Praxis hasn't opened it yet.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

EpisodeKind = Literal["intro", "deep_dive"]
EpisodeStatus = Literal["upcoming", "in_progress", "published", "rejected"]

_DEFAULT_PRAXIS_DATA = Path("/Volumes/Projects/Praxis/data")
_DB_PATH = Path(os.getenv("PRAXIS_DATA_DIR", str(_DEFAULT_PRAXIS_DATA))) / "youtube.db"
_LOCK = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def _open() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False, isolation_level=None)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode = WAL")
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS youtube_episodes (
          slug TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('intro','deep_dive')),
          title TEXT NOT NULL,
          angle TEXT,
          status TEXT NOT NULL CHECK(status IN ('upcoming','in_progress','published','rejected')),
          youtube_video_id TEXT,
          published_at TEXT,
          views INTEGER,
          avg_retention_pct REAL,
          subs_delta INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_youtube_episodes_status ON youtube_episodes(status)")
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_youtube_episodes_published_at ON youtube_episodes(published_at)")
    return _conn


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "slug": row["slug"],
        "kind": row["kind"],
        "title": row["title"],
        "angle": row["angle"],
        "status": row["status"],
        "youtube_video_id": row["youtube_video_id"],
        "published_at": row["published_at"],
        "views": row["views"],
        "avg_retention_pct": row["avg_retention_pct"],
        "subs_delta": row["subs_delta"],
        "created_at": row["created_at"],
    }


def upsert_episode(
    *,
    slug: str,
    kind: EpisodeKind,
    title: str,
    angle: Optional[str] = None,
    status: EpisodeStatus = "upcoming",
) -> None:
    with _LOCK:
        _open().execute(
            """
            INSERT INTO youtube_episodes (slug, kind, title, angle, status)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              kind = excluded.kind,
              title = excluded.title,
              angle = excluded.angle,
              status = COALESCE(excluded.status, youtube_episodes.status)
            """,
            (slug, kind, title, angle, status),
        )


def get_episode(slug: str) -> Optional[Dict[str, Any]]:
    row = _open().execute("SELECT * FROM youtube_episodes WHERE slug = ?", (slug,)).fetchone()
    return _row_to_dict(row) if row else None


def list_episodes(
    status: Optional[EpisodeStatus] = None, kind: Optional[EpisodeKind] = None,
) -> List[Dict[str, Any]]:
    clauses, params = [], []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if kind:
        clauses.append("kind = ?")
        params.append(kind)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = _open().execute(
        f"SELECT * FROM youtube_episodes {where} ORDER BY created_at ASC",
        params,
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def published_count() -> int:
    row = _open().execute(
        "SELECT COUNT(*) AS n FROM youtube_episodes WHERE status = 'published'"
    ).fetchone()
    return int(row["n"])


def mark_in_progress(slug: str) -> None:
    with _LOCK:
        _open().execute(
            "UPDATE youtube_episodes SET status = 'in_progress' WHERE slug = ?", (slug,),
        )


def mark_rejected(slug: str) -> None:
    with _LOCK:
        _open().execute(
            "UPDATE youtube_episodes SET status = 'rejected' WHERE slug = ?", (slug,),
        )


def record_published(
    slug: str, youtube_video_id: str, published_at: Optional[str] = None,
) -> None:
    with _LOCK:
        _open().execute(
            """
            UPDATE youtube_episodes
               SET status = 'published',
                   youtube_video_id = ?,
                   published_at = COALESCE(?, datetime('now'))
             WHERE slug = ?
            """,
            (youtube_video_id, published_at, slug),
        )


def record_metrics(
    slug: str,
    *,
    views: Optional[int] = None,
    avg_retention_pct: Optional[float] = None,
    subs_delta: Optional[int] = None,
) -> None:
    with _LOCK:
        _open().execute(
            """
            UPDATE youtube_episodes
               SET views = COALESCE(?, views),
                   avg_retention_pct = COALESCE(?, avg_retention_pct),
                   subs_delta = COALESCE(?, subs_delta)
             WHERE slug = ?
            """,
            (views, avg_retention_pct, subs_delta, slug),
        )


def db_path() -> Path:
    """For diagnostics and test setup."""
    return _DB_PATH


def _close_for_tests() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None
