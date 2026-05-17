from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import httpx

from tools import get_registry
from tools.interface import ToolCategory, ToolMetadata

from .models import ResearchBrief, ResearchEvidence


MAX_EVIDENCE_ITEMS = 12
MAX_EXCERPT_CHARS = 500
DEFAULT_NEXUS_CHAT_URL = "http://127.0.0.1:4000/api/ai/chat"


def default_project_root() -> Path:
    cwd = Path.cwd().resolve()
    if cwd.name == "nexus-builder":
        return cwd.parent
    return cwd


def _compact(text: Any, limit: int = MAX_EXCERPT_CHARS) -> str:
    compacted = " ".join(str(text).replace("\x00", "").split())
    if len(compacted) <= limit:
        return compacted
    return compacted[: limit - 3].rstrip() + "..."


def _tool_registry_evidence() -> tuple[ResearchEvidence, List[str]]:
    registry = get_registry()
    tools = registry.list_tools()
    categories = {
        ToolCategory.RESEARCH,
        ToolCategory.CODE_ANALYSIS,
        ToolCategory.WORKFLOW,
        ToolCategory.BLACKBOARD,
        ToolCategory.MEDIA,
        ToolCategory.GIT,
    }
    relevant: List[ToolMetadata] = [
        tool
        for tool in tools
        if tool.category in categories or tool.name.startswith(("git_", "youtube_", "veo_", "tts_"))
    ]
    priority = {
        "get_project_context": 0,
        "search_codebase": 1,
        "query_knowledge_graph": 2,
        "git_log": 3,
        "search_nodes": 4,
        "get_node_details": 5,
        "veo_animate": 6,
        "tts_generate": 7,
        "ffmpeg_assemble": 8,
        "youtube_upload": 9,
    }
    relevant.sort(key=lambda tool: (priority.get(tool.name, 100), tool.name))
    names = ", ".join(tool.name for tool in relevant[:24])
    claim = (
        "Praxis can research himself through internal tools for project context, code search, "
        "workflow inspection, memory/blackboard state, git history, and media production."
    )
    return (
        ResearchEvidence(
            source_type="tool_registry",
            title="Praxis tool registry",
            excerpt=_compact(names or "No relevant internal tools were discovered."),
            metadata={
                "tool_count": len(tools),
                "relevant_tool_count": len(relevant),
                "categories": sorted({tool.category.value for tool in relevant}),
            },
        ),
        [claim],
    )


async def _execute_tool(name: str, context: Dict[str, Any], **kwargs) -> Optional[Any]:
    tool = get_registry().get(name)
    if tool is None:
        return None
    result = await tool.execute(context, **kwargs)
    if not result.get("success"):
        return None
    return result.get("result")


async def _context_evidence(project_root: Path) -> List[ResearchEvidence]:
    items: List[ResearchEvidence] = []
    context = {"project_root": str(project_root)}
    result = await _execute_tool("get_project_context", context)
    if isinstance(result, str) and result.strip():
        items.append(
            ResearchEvidence(
                source_type="context",
                title="Project context documents",
                path=".context",
                excerpt=_compact(result),
            )
        )

    context_dir = project_root / ".context"
    if not items and context_dir.exists():
        for path in sorted(context_dir.glob("*.md"))[:3]:
            try:
                items.append(
                    ResearchEvidence(
                        source_type="context",
                        title=path.name,
                        path=str(path.relative_to(project_root)),
                        excerpt=_compact(path.read_text(encoding="utf-8", errors="ignore")),
                    )
                )
            except OSError:
                continue
    return items


async def _codebase_evidence(project_root: Path, prompt: str) -> tuple[List[ResearchEvidence], List[str]]:
    context = {"project_root": str(project_root)}
    queries = ["Praxis", "youtube-production|youtube_workflows|LangGraph|workflow"]
    if "praxis" not in prompt.lower():
        queries.append(prompt[:80])

    items: List[ResearchEvidence] = []
    for query in queries:
        result = await _execute_tool("search_codebase", context, query=query, path=str(project_root))
        if not isinstance(result, list):
            continue
        for match in result[:3]:
            file_path = match.get("file", "unknown")
            line = match.get("line")
            content = match.get("content", "")
            items.append(
                ResearchEvidence(
                    source_type="codebase",
                    title=f"{file_path}:{line}" if line else file_path,
                    path=file_path,
                    excerpt=_compact(content),
                    metadata={"query": query, "line": line},
                )
            )
            if len(items) >= 6:
                break
        if len(items) >= 6:
            break

    claims = []
    if items:
        claims.append("Praxis has code-level evidence for the requested video topic.")
    return items, claims


async def _git_evidence(project_root: Path) -> List[ResearchEvidence]:
    result = await _execute_tool("git_log", {"project_root": str(project_root)}, count=6)
    if not isinstance(result, list) or not result:
        return []
    excerpt = "; ".join(f"{commit.get('hash')}: {commit.get('message')}" for commit in result)
    return [
        ResearchEvidence(
            source_type="git",
            title="Recent project history",
            excerpt=_compact(excerpt),
            metadata={"commit_count": len(result)},
        )
    ]


def _workflow_file_evidence(project_root: Path) -> List[ResearchEvidence]:
    paths = [
        project_root / "config/templates/workflows/youtube-production.json",
        project_root / "nexus-builder/youtube_workflows/graph.py",
        project_root / "nexus-builder/nodes/youtube_production.py",
    ]
    items: List[ResearchEvidence] = []
    for path in paths:
        if not path.exists():
            continue
        try:
            items.append(
                ResearchEvidence(
                    source_type="workflow",
                    title=path.name,
                    path=str(path.relative_to(project_root)),
                    excerpt=_compact(path.read_text(encoding="utf-8", errors="ignore")),
                )
            )
        except OSError:
            continue
    return items


def _build_summary(prompt: str, evidence: Iterable[ResearchEvidence]) -> str:
    source_types = sorted({item.source_type for item in evidence})
    sources = ", ".join(source_types) if source_types else "fallback notes"
    return (
        f"Praxis researched '{prompt}' using internal Praxis evidence from {sources}. "
        "The brief is designed for a YouTube concept about what Praxis can actually do, "
        "grounded in local project context instead of generic external claims."
    )


def _research_chat_prompt(prompt: str) -> str:
    return f"""
Praxis, this is the research phase for a YouTube workflow about you.

User video request:
{prompt}

Please use your regular tools and faculties to research what this episode should say about Praxis.
Focus on internal, verifiable evidence: your capabilities, available tools, project/workflow context,
memory where relevant, and anything in The Nexus that would help make the video truthful.

Return a concise research brief with:
- summary
- strongest evidence or findings
- claims that are safe to make
- gaps or things that need human review
- angle notes for the later concept writer

Do not draft the video concept yet. This is only the research handoff.
""".strip()


def _parse_praxis_response(raw_response: str) -> Dict[str, Any]:
    cleaned = raw_response.strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return {"summary": cleaned}


async def gather_praxis_chat_research(prompt: str, project_root: Optional[Path] = None) -> ResearchBrief:
    chat_url = os.getenv("NEXUS_PRAXIS_CHAT_URL", DEFAULT_NEXUS_CHAT_URL)
    root = (project_root or default_project_root()).resolve()
    payload = {
        "message": _research_chat_prompt(prompt),
        "mode": "praxis",
        "projectId": str(root),
        "history": [],
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=1200.0) as client:
        response = await client.post(chat_url, json=payload)
        response.raise_for_status()
        data = response.json()

    raw_response = str(data.get("response") or data.get("message") or "").strip()
    parsed = _parse_praxis_response(raw_response)
    summary = _compact(parsed.get("summary") or raw_response, 1200)
    findings = parsed.get("findings") or parsed.get("evidence") or parsed.get("strongest_evidence") or []
    if isinstance(findings, str):
        findings = [findings]
    if not isinstance(findings, list):
        findings = []

    evidence = [
        ResearchEvidence(
            source_type="praxis_chat",
            title="Praxis chat research response",
            excerpt=_compact(raw_response),
            metadata={
                "conversation_id": data.get("conversationId"),
                "assistant_message_id": data.get("assistantMessageId"),
                "chat_url": chat_url,
            },
        )
    ]
    for index, item in enumerate(findings[:5], start=1):
        evidence.append(
            ResearchEvidence(
                source_type="praxis_chat",
                title=f"Praxis chat finding {index}",
                excerpt=_compact(item),
            )
        )

    claims = parsed.get("claims") or []
    gaps = parsed.get("gaps") or []
    angle_notes = parsed.get("angle_notes") or parsed.get("angles") or []
    return ResearchBrief(
        summary=summary,
        evidence=evidence,
        claims=claims if isinstance(claims, list) else [str(claims)],
        gaps=gaps if isinstance(gaps, list) else [str(gaps)],
        angle_notes=angle_notes if isinstance(angle_notes, list) else [str(angle_notes)],
    )


async def gather_praxis_research(
    prompt: str,
    project_root: Optional[Path] = None,
    *,
    via_chat: bool = False,
) -> ResearchBrief:
    if via_chat:
        try:
            return await gather_praxis_chat_research(prompt, project_root)
        except Exception as exc:
            fallback = await gather_praxis_research(prompt, project_root, via_chat=False)
            fallback.gaps.append(f"Praxis chat research failed: {exc}")
            return fallback

    root = (project_root or default_project_root()).resolve()
    evidence: List[ResearchEvidence] = []
    claims: List[str] = []

    tool_item, tool_claims = _tool_registry_evidence()
    evidence.append(tool_item)
    claims.extend(tool_claims)

    evidence.extend(await _context_evidence(root))
    code_items, code_claims = await _codebase_evidence(root, prompt)
    evidence.extend(code_items)
    claims.extend(code_claims)
    evidence.extend(await _git_evidence(root))
    evidence.extend(_workflow_file_evidence(root))

    if not evidence:
        evidence.append(
            ResearchEvidence(
                source_type="fallback",
                title="Praxis internal research fallback",
                excerpt="No internal evidence sources were available during this run.",
            )
        )

    gaps = []
    if not any(item.source_type == "context" for item in evidence):
        gaps.append("No .context documentation was available to ground channel positioning.")
    if not any(item.source_type == "memory" for item in evidence):
        gaps.append("Persistent memory was not queried in this first research pass.")

    return ResearchBrief(
        summary=_build_summary(prompt, evidence),
        evidence=evidence[:MAX_EVIDENCE_ITEMS],
        claims=claims[:8],
        gaps=gaps,
        angle_notes=[
            "Frame Praxis as the subject and researcher, not as a generic automation tool.",
            "Use evidence-backed feature claims and reserve speculative claims for review notes.",
        ],
    )
