"""
Workspace Utility — Local file context for the Vibe Coding OS.

Manages a `.nexus/` directory in the project root to store:
  - preferences.md  — User's tech preferences (framework, CSS, etc.)
  - context.md      — Project-specific context injected into the Architect

Replaces the Neo4j graph for project context with simple, editable files.
"""

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_PREFERENCES = """# Nexus Project Preferences

## Tech Stack
- Framework: (e.g., Next.js, Vite, Express)
- CSS: (e.g., Tailwind, vanilla CSS, Chakra UI)
- Database: (e.g., Supabase, PostgreSQL, Firebase)
- Auth: (e.g., Supabase Auth, NextAuth, Clerk)

## Conventions
- Component style: (e.g., functional React, class-based)
- File naming: (e.g., kebab-case, PascalCase)
- Testing: (e.g., Jest, Vitest, Playwright)

## Notes
Add any preferences here. The AI Architect will read this file
before drafting project plans.
"""


class WorkspaceContext:
    """
    Reads and manages the .nexus/ directory for project-level context.
    
    Usage:
        ctx = WorkspaceContext("/path/to/project")
        preferences = ctx.read_preferences()
        full_context = ctx.get_full_context()
    """

    def __init__(self, project_root: str):
        self.root = Path(project_root)
        self.nexus_dir = self.root / ".nexus"

    def ensure_nexus_dir(self) -> Path:
        """Create .nexus/ directory if it doesn't exist."""
        self.nexus_dir.mkdir(parents=True, exist_ok=True)
        return self.nexus_dir

    def read_preferences(self) -> str:
        """
        Read .nexus/preferences.md. Returns empty string if not found.
        """
        prefs_path = self.nexus_dir / "preferences.md"
        if prefs_path.exists():
            content = prefs_path.read_text(encoding="utf-8")
            logger.info(f"📋 Read preferences: {len(content)} chars from {prefs_path}")
            return content
        return ""

    def write_preferences(self, content: str) -> None:
        """Write or update .nexus/preferences.md."""
        self.ensure_nexus_dir()
        prefs_path = self.nexus_dir / "preferences.md"
        prefs_path.write_text(content, encoding="utf-8")
        logger.info(f"📋 Wrote preferences: {len(content)} chars to {prefs_path}")

    def scaffold_preferences(self) -> str:
        """Create a default preferences.md if none exists. Returns the content."""
        prefs_path = self.nexus_dir / "preferences.md"
        if not prefs_path.exists():
            self.ensure_nexus_dir()
            prefs_path.write_text(DEFAULT_PREFERENCES, encoding="utf-8")
            logger.info(f"📋 Scaffolded default preferences at {prefs_path}")
            return DEFAULT_PREFERENCES
        return self.read_preferences()

    def read_context(self) -> str:
        """Read .nexus/context.md (project-specific notes). Returns empty string if not found."""
        ctx_path = self.nexus_dir / "context.md"
        if ctx_path.exists():
            return ctx_path.read_text(encoding="utf-8")
        return ""

    def write_context(self, content: str) -> None:
        """Write or update .nexus/context.md."""
        self.ensure_nexus_dir()
        ctx_path = self.nexus_dir / "context.md"
        ctx_path.write_text(content, encoding="utf-8")

    def get_full_context(self) -> str:
        """
        Combine preferences + context into a single string for Architect injection.
        Returns empty string if no .nexus/ directory exists.
        """
        if not self.nexus_dir.exists():
            return ""

        parts = []
        prefs = self.read_preferences()
        if prefs:
            parts.append(f"## User Preferences\n{prefs}")

        ctx = self.read_context()
        if ctx:
            parts.append(f"## Project Context\n{ctx}")

        return "\n\n".join(parts)
