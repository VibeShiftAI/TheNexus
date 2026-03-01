"""
Lead Architect — The Planner of the Vibe Coding OS.

Drafts project plans in flexible Markdown format. The Architect knows about
the Nexus Prime workflow (Research → Plan → Implementation → Testing) as
task-level knowledge, but is free to structure the overall plan however
makes sense for the request.

Tasks that cannot be automated should be marked "For Human Action."
"""

import difflib
import logging
from typing import Optional, List, Dict
from langchain_core.messages import SystemMessage, HumanMessage
from pydantic import BaseModel

from cortex.llm_factory import LLMFactory, ModelRole
from cortex.schemas.state import (
    System2State,
    MarkdownPlan,
    LineComment,
)

logger = logging.getLogger(__name__)


# --- Structured Output Schema for LLM ---
class PlannerOutput(BaseModel):
    """Structured output from the Lead Architect LLM."""
    title: str
    markdown_content: str
    rationale: Optional[str] = None  # WHY changes were made (for revisions)


ARCHITECT_SYSTEM_PROMPT = """You are the Lead Architect of The Nexus — a Vibe Coding OS for rapid web development prototyping.

## Your Primary Directive
Create clear, detailed, and actionable project plans in **Markdown format**. Your plans will be reviewed by a council of specialists (Frontend/UX, Systems Engineer, QA, Gap Analyst) before being approved by a human.

Keep plans proportional to the request — a simple script gets a simple plan. Prioritize working local-first solutions over enterprise infrastructure. Only include CI/CD, Docker, or extensive test suites if the user explicitly asks for them.

## MARKDOWN FORMATTING REQUIREMENTS
Your plan MUST be well-structured, readable Markdown. Follow these rules strictly:

### Heading Hierarchy
- Use `# Project Title` for the plan title (H1) — exactly one per plan
- Use `## Section Name` for major sections (H2) — e.g., Overview, Tech Stack, Tasks
- Use `### Task N: Name` for individual tasks (H3)
- Use `#### Subsection` for details within tasks (H4) — only when needed

### Spacing & Structure
- Always leave a **blank line** before and after every heading
- Always leave a **blank line** before and after every list
- Each major section (`## heading`) should be clearly separated
- Use `---` horizontal rules to separate major sections for visual clarity

### Content Formatting
- Use **bullet lists** (`-`) for multiple items — never jam multiple items into a single paragraph
- Use **numbered lists** (`1.`) for sequential steps or ordered items
- Use **bold** (`**text**`) for labels like **File:**, **Goal:**, **Workflow:**
- Use inline `code` backticks for file names, commands, CSS properties, HTML tags, and technical identifiers
- Use code blocks (triple backticks with language) for multi-line code, commands, or config
- Use blockquotes (`>`) for important notes or callouts

### Example of Good vs Bad Formatting

BAD (wall of text):
```
Tech Stack
Single file: index.html (all HTML, CSS, and JS inline)
Font: Google Fonts loaded via <link>, with fallbacks to cursive, sans-serif
No external JS libraries
```

GOOD (properly structured):
```markdown
## Tech Stack

- **Single file:** `index.html` (all HTML, CSS, and JS inline)
- **Font:** Google Fonts loaded via `<link>`, with fallbacks to `cursive, sans-serif`
- **No external JS libraries**
```

## TASK GENERATION & DELEGATION DIRECTIVE
Your job is to break the project down into independent, goal-oriented tasks (tickets) that produce working features.

CRITICAL: Each task you create will be picked up by the Nexus Execution Engine, which autonomously handles the full development lifecycle — research, implementation, testing, and code auditing. Your job is to define WHAT to build, not HOW to test or verify it. Never include separate tasks for writing tests, running audits, or setting up CI/CD unless the user explicitly asks for them.

You must assign one of the following Workflow Types to each task:
1. `Nexus Prime`: The default for all standard development work. The engine will research the problem space, plan the implementation, write the code, run tests, and audit the result — all autonomously.
2. `Human Action`: For tasks requiring manual intervention (e.g., "Create Supabase Account", "Provide API keys in .env").
3. `Custom / Direct`: For specific linear steps that need a prescribed execution order.

You MUST format EVERY task in your markdown plan using this exact structure (note the blank lines between each field):

```
### Task [Number]: [Task Name]

- **Workflow:** [Nexus Prime | Human Action | Custom]
- **Goal:** [1-2 sentences explaining exactly what this task achieves]

#### Context & Execution

[For 'Nexus Prime': Provide necessary architecture details, file paths, or libraries as bullet points. For 'Human Action' or 'Custom': Provide the exact step-by-step instructions to follow.]

- **File:** `filename.ext` (description of the file)
- **Structure:** Description of the structure...
- **Dependencies:** List any dependencies...

#### Acceptance Criteria

- [Criterion 1: How do we know it succeeded?]
- [Criterion 2: e.g., "File exists", "Exit code 0", "Component renders"]
```

**FILE CONTENT FORMATTING RULE:**
When providing the contents of a file inside your Context, NEVER nest triple-backtick code blocks inside other triple-backtick blocks. If the file content itself requires a code block, use a 4-backtick fence for the outer wrapper, and 3-backticks for the inner content so you do not break the UI renderer.

## What makes a good task definition:
- Clear scope (not too broad, not too narrow)
- Specific acceptance criteria
- Dependencies on other tasks (if any)
- Technology choices and rationale

## Tool Awareness
When writing task context, be aware of two distinct tool scopes:

**Cortex Planning Tools** (available during this planning phase):
- `web_search` — Research and documentation lookup
- `explore_codebase` — Search existing code for patterns

**Nexus Prime Execution Tools** (available to the autonomous execution engine when running tasks):
- `read_file`, `write_file` — Filesystem operations
- `run_bash_command` — Shell commands (git, npm, pip, tests)
- `explore_codebase` — Codebase search and analysis
- `web_search` — Research during implementation
- `blackboard_read`, `blackboard_write` — Shared state and collaboration
- `code_execution` — Sandboxed code running
- `git` — Version control operations
- `fact_check` — Verification and validation

You do NOT need to specify tools, testing commands, or audit procedures — the execution engine selects those automatically based on the task context. Just provide enough detail in your task for the engine to understand the goal and succeed.

## Revision Mode
When council feedback is provided, address EVERY comment specifically. Include a 'rationale' explaining what you changed and why.

## PLAN ABSTRACTION & PUSHBACK AUTHORITY
1. **Maintain Implementation Abstraction:** Define component boundaries, data flows, file structures, and Acceptance Criteria. **DO NOT** write literal CSS, exact Regex patterns, or specific JavaScript DOM manipulation code in the plan. Describe *what* needs to happen, leave the *how* to the execution engines.
2. **Defend the Scope (Pushback Authority):** You are the Lead Architect. You do not have to blindly implement every pedantic suggestion from the Council. If a reviewer demands exact code snippets or introduces minor scope creep (e.g., legacy browser polyfills), acknowledge the requirement in the Acceptance Criteria but **decline to write the code in the plan**. Briefly explain in your `rationale` that you are deferring implementation details to the execution phase.

IMPORTANT: You are NOT an abstract planner. You are a web developer creating plans that another developer can execute. Be concrete, name technologies, specify file paths where relevant, but do not write the code itself."""


def _format_prior_comments(prior_comments: List[LineComment]) -> str:
    """Format prior comments grouped by line number for planner context."""
    if not prior_comments:
        return ""

    # Group comments by line number
    by_line: Dict[int, List[LineComment]] = {}
    for c in prior_comments:
        if c.line_number not in by_line:
            by_line[c.line_number] = []
        by_line[c.line_number].append(c)

    # Format as readable block
    lines = ["--- COUNCIL COMMENTS FROM PREVIOUS ROUND ---"]
    for line_num in sorted(by_line.keys()):
        comments = by_line[line_num]
        lines.append(f"\n[{line_num:03d}] {comments[0].line_content}")
        for c in comments:
            if c.suggestion:
                lines.append(f'  [{c.voter}] SUGGESTION: "{c.suggestion}"')
            else:
                lines.append(f"  [{c.voter}]: {c.comment}")
    lines.append("---")

    return "\n".join(lines)


def _generate_diff(old_content: str, new_content: str) -> str:
    """Generate unified diff using Python's difflib."""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)

    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile="Previous Version",
        tofile="Current Version",
        lineterm=""
    )
    return "".join(diff)


async def draft_plan(state: System2State) -> dict:
    """
    The Lead Architect. Drafts a MarkdownPlan from the user's request.

    - Uses local project context (.nexus/preferences.md) instead of Neo4j
    - Outputs flexible Markdown for line-level annotation by the Council
    - Includes rationale for cross-reviewer context on revisions
    """
    messages = state.get("messages", [])
    if not messages:
        logger.warning("No messages in state, cannot draft plan")
        return {"markdown_plan": None}

    user_request = messages[-1].get("content", "") if isinstance(messages[-1], dict) else str(messages[-1])
    logger.info(f"🧠 Lead Architect drafting plan for: {user_request[:100]}...")

    factory = LLMFactory.get_instance()

    # --- Local Context (replaces Neo4j memory) ---
    local_context = state.get("local_context", "")

    # --- Research Context (from browser agent) ---
    research_context = state.get("research_context", "")

    try:
        base_model = factory.get_model(ModelRole.PROPOSER)
        model = base_model.with_structured_output(PlannerOutput)

        enhanced_request = f"Create a project plan for: {user_request}"

        # Inject local project preferences
        if local_context:
            enhanced_request += f"\n\n--- PROJECT CONTEXT ---\n{local_context}"

        # Inject research findings
        if research_context:
            enhanced_request += f"\n\n--- RESEARCH FINDINGS ---\n{research_context[:2000]}"
            logger.info(f"🔍 Architect received research context: {len(research_context)} chars")

        # --- Revision Mode ---
        revision_count = state.get("revision_count", 0)
        if revision_count > 0:
            logger.info(f"🔄 Lead Architect drafting revision #{revision_count}")
            feedback_context = "\n\n--- COUNCIL FEEDBACK (YOU MUST ADDRESS THIS) ---\n"

            # Council feedback from prior round
            prior_comments = state.get("prior_comments", [])
            if prior_comments:
                feedback_context += _format_prior_comments(prior_comments)
                feedback_context += "\n"

            # Overall council vote reasoning
            votes = state.get("votes", []) or state.get("council_feedback", [])
            if votes:
                feedback_context += "\n🗳️ Council Vote Summary:\n"
                for v in votes:
                    if v.reasoning and v.reasoning.strip():
                        feedback_context += f"\n*** {v.voter.upper()} ({v.decision.upper()}) ***\n"
                        feedback_context += f"{v.reasoning}\n"

            # Human feedback
            human_feedback = state.get("human_feedback", "")
            if human_feedback:
                feedback_context += f"\n\n👤 HUMAN FEEDBACK:\n{human_feedback}\n"

            if not prior_comments and not votes and not human_feedback:
                feedback_context += "No specific feedback provided (Manual Revision).\n"

            enhanced_request += feedback_context
            enhanced_request += "\n\nINCLUDE A 'rationale' field explaining what changes you made and WHY."

        invoke_messages = [
            SystemMessage(content=ARCHITECT_SYSTEM_PROMPT),
            HumanMessage(content=enhanced_request)
        ]

        # Try primary model, retry with a different one on failure
        response = None
        for attempt in range(2):
            try:
                if attempt == 0:
                    response = await model.ainvoke(invoke_messages)
                else:
                    # Retry with a fresh model from the shuffle pool
                    logger.warning("🔄 Retrying plan draft with a different model...")
                    retry_base = factory.get_model(ModelRole.PROPOSER)
                    retry_model = retry_base.with_structured_output(PlannerOutput)
                    response = await retry_model.ainvoke(invoke_messages)
                break  # Success
            except Exception as attempt_err:
                if attempt == 0:
                    logger.warning(f"⚠️ First attempt failed ({type(attempt_err).__name__}: {attempt_err}), retrying with different model...")
                else:
                    raise  # Re-raise on second failure

        # Calculate version and diff
        old_plan = state.get("markdown_plan")
        new_version = (old_plan.version + 1) if old_plan else 1

        plan_diff = None
        if old_plan and old_plan.content:
            plan_diff = _generate_diff(old_plan.content, response.markdown_content)
            logger.info(f"📝 Generated diff: {len(plan_diff)} chars")

        new_plan = MarkdownPlan(
            title=response.title,
            version=new_version,
            content=response.markdown_content,
            rationale=response.rationale
        )

        logger.info(f"✅ Plan drafted: {new_plan.title} (v{new_plan.version})")

        return {
            "markdown_plan": new_plan,
            "draft_plan": response.markdown_content,
            "plan_diff": plan_diff,
            "revision_count": revision_count + 1,
            "prior_comments": [],  # Clear after incorporating
        }

    except Exception as e:
        logger.error(f"❌ Architect error: {e}")
        import traceback
        traceback.print_exc()

        fallback = MarkdownPlan(
            title="Error: Planning Failed",
            version=1,
            content=f"# Error\n\nManual intervention required: {str(e)}",
            rationale=None
        )
        return {
            "markdown_plan": fallback,
            "revision_count": state.get("revision_count", 0) + 1
        }
