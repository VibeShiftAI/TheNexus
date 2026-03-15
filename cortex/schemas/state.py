"""
System 2 State Definitions — Vibe Coding OS.

Slimmed down from the original Praxis cognitive engine to support
the Web Dev Council workflow:

  Chat Router → Architect → Council Review → Human Review → Compiler → Executor

Kept:
  - MarkdownPlan, LineComment, VoteReceipt (code review voting)
  - ProjectPlan, WorkflowNode (compiler output)
  - BrowseSession, BrowserResult (recursive browser agent)
  - VisualRequest, VisualInterpretation, ExtractedEntity (visual interpreter)

Added:
  - local_context, draft_plan, council_feedback, final_plan
  - route (chat vs build) and human_decision/human_feedback
"""

from enum import Enum
from typing import TypedDict, Annotated, List, Optional, Literal, Dict
from langgraph.graph.message import add_messages
from pydantic import BaseModel


# ═══════════════════════════════════════════════════════════════════════════
# Core Plan Schemas
# ═══════════════════════════════════════════════════════════════════════════

class WorkflowNode(BaseModel):
    """A task ticket in a project plan."""
    id: str
    type: Literal["reasoning", "tool", "human"]
    description: str
    workflow: Literal["nexus_prime", "human_action", "custom"] = "nexus_prime"
    template_id: Optional[str] = None  # LangGraph template ID (e.g., "doc-writer", "research-report")
    goal: str = ""  # 1-2 sentence goal for the task
    context: str = ""  # Architecture details, file paths, or step-by-step instructions
    acceptance_criteria: List[str] = []  # How we know the task succeeded


class ProjectPlan(BaseModel):
    """A structured plan for execution (output of Compiler Node)."""
    title: str
    goal: str = ""
    nodes: List[WorkflowNode]
    status: Literal["draft", "approved", "rejected"] = "draft"


# ═══════════════════════════════════════════════════════════════════════════
# Code Review Voting Schemas
# ═══════════════════════════════════════════════════════════════════════════

class LineComment(BaseModel):
    """A comment from a council reviewer on a specific line in the plan."""
    voter: str
    line_number: int
    line_content: str
    comment: str
    suggestion: Optional[str] = None  # Proposed alternative text


class MarkdownPlan(BaseModel):
    """A plan represented as Markdown for line-level annotation."""
    title: str
    version: int = 1
    content: str  # The full Markdown text
    rationale: Optional[str] = None  # WHY changes were made (for cross-reviewer context)


class VoteReceipt(BaseModel):
    """A review from a member of the Web Dev Council."""
    voter: str
    decision: Literal["approve", "reject", "request_info"]
    reasoning: str  # Overall summary
    line_comments: List[LineComment] = []  # Line-specific feedback


# ═══════════════════════════════════════════════════════════════════════════
# Browser Agent Schemas (kept — browser.py is surviving)
# ═══════════════════════════════════════════════════════════════════════════

class BrowserResult(BaseModel):
    """A single page visited during a browse session."""
    url: str
    title: str
    content: str  # Clean Markdown text
    relevance: Literal["relevant", "partial", "irrelevant"]


class BrowseSession(BaseModel):
    """State of a recursive browser agent session."""
    query: str
    urls_visited: List[str] = []
    results: List[BrowserResult] = []
    final_answer: Optional[str] = None
    iterations: int = 0


# ═══════════════════════════════════════════════════════════════════════════
# Visual Interpreter Schemas (kept — visual_interpreter.py is surviving)
# ═══════════════════════════════════════════════════════════════════════════

class VisualRequest(BaseModel):
    """Input request for B6 Visual Interpreter."""
    image_source: str = ""  # URL, local file path, or Base64 string
    directive: Optional[str] = "Analyze this image and extract key insights."
    surrounding_context: Optional[str] = None
    alt_text: Optional[str] = None


class ExtractedEntity(BaseModel):
    """A relationship triplet extracted from a visual."""
    source_node: str = ""
    relationship: str = ""
    target_node: str = ""


class VisualInterpretation(BaseModel):
    """Structured output from B6 Visual Interpreter."""
    modality: Literal["photo", "chart", "diagram", "screenshot",
                       "document", "decorative", "unknown"] = "unknown"
    description: str = ""
    extracted_data: Optional[Dict[str, object]] = {}
    entities: List[ExtractedEntity] = []
    confidence: float = 0.0
    token_footprint: int = 0


# ═══════════════════════════════════════════════════════════════════════════
# LangGraph State
# ═══════════════════════════════════════════════════════════════════════════

class System2State(TypedDict):
    """
    The state passed through the Vibe Coding OS LangGraph.

    Supports the simplified workflow:
      Chat Router → Architect → Council Review → Human Review → Compiler → Executor
    """
    # Standard LangGraph message history
    messages: Annotated[List[dict], add_messages]

    # Blackboard session identifier
    session_id: str

    # Chat router decision
    route: Optional[Literal["chat", "build"]]

    # Local project context (.nexus/preferences.md contents)
    local_context: Optional[str]

    # Architect output
    markdown_plan: Optional[MarkdownPlan]
    draft_plan: Optional[str]  # Raw architect draft (pre-review)

    # Council feedback
    council_feedback: Optional[List[VoteReceipt]]
    votes: List[VoteReceipt]  # Keep for backward compat
    prior_comments: List[LineComment]

    # Plan versioning
    plan_diff: Optional[str]
    revision_count: int

    # Compiled output
    compiled_plan: Optional[ProjectPlan]
    final_plan: Optional[ProjectPlan]

    # Human review
    human_decision: Optional[Literal["approve", "reject"]]
    human_feedback: Optional[str]

    # Browser Agent
    browse_session: Optional[BrowseSession]

    # Research context (from browser or external sources)
    research_context: Optional[str]
