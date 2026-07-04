"""
Doc Drafter Node - Generates documentation changes with per-hunk diffs.

Produces a doc_changes artifact containing file-level changes broken
into individual hunks for granular review.

Supports iterative completion: if the LLM response is truncated,
recovered entries are stored and the drafter is re-invoked to
complete the remaining files.
"""

import os
import json
import re
import uuid
import difflib
from typing import Any, Dict, List

from ..core.base import AtomicNode, NodeExecutionContext, NodeExecutionData


def _generate_hunks(original: str, proposed: str) -> list:
    """Generate diff hunks between original and proposed content."""
    if original is None:
        return [{
            "id": f"h-{uuid.uuid4().hex[:8]}",
            "start_line": 1,
            "original_lines": [],
            "proposed_lines": proposed.splitlines(),
            "context": "New file",
            "status": "pending",
            "revision_comment": None,
        }]

    orig_lines = original.splitlines()
    prop_lines = proposed.splitlines()
    matcher = difflib.SequenceMatcher(None, orig_lines, prop_lines)
    hunks = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        hunks.append({
            "id": f"h-{uuid.uuid4().hex[:8]}",
            "start_line": i1 + 1,
            "original_lines": orig_lines[i1:i2],
            "proposed_lines": prop_lines[j1:j2],
            "context": f"{tag}: lines {i1+1}-{i2} → {j1+1}-{j2}",
            "status": "pending",
            "revision_comment": None,
        })

    return hunks


class DocDrafterNode(AtomicNode):
    """Draft documentation changes with per-hunk diff generation."""

    type_id = "doc_drafter"
    display_name = "Doc Drafter"
    description = "Generates documentation changes and produces a diff-based review artifact with per-hunk granularity"
    category = "documentation"
    icon = "✍️"
    version = 1.0
    levels = ["project", "task"]
    node_type = "atomic"
    default_model = "gemini-2.5-pro"

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Model",
                "name": "model",
                "type": "options",
                "default": "gemini-pro",
                "options": [
                    {"name": "Gemini Pro", "value": "gemini-pro"},
                    {"name": "Gemini Flash", "value": "gemini-flash"},
                ],
                "description": "LLM model used for drafting documentation",
            },
            {
                "displayName": "Temperature",
                "name": "temperature",
                "type": "number",
                "default": 0.2,
                "description": "Creativity level for documentation generation (0-1)",
                "typeOptions": {"minValue": 0, "maxValue": 1, "numberPrecision": 1},
            },
            {
                "displayName": "Scope",
                "name": "scope",
                "type": "options",
                "default": "all-md",
                "options": [
                    {"name": "Context Only (.context/)", "value": "context-only"},
                    {"name": "All Markdown", "value": "all-md"},
                ],
                "description": "Which files are in scope for updates",
            },
        ]

    async def execute(
        self, ctx: NodeExecutionContext, items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        from langchain_core.messages import HumanMessage
        from model_config import get_gemini_pro, get_gemini_flash

        input_payload = items[0].json if items else {}
        context = input_payload.get("context", {})
        outputs = input_payload.get("outputs", {})
        exploration = outputs.get("doc_exploration", {})
        existing_files = exploration.get("existing_files", {})
        exploration_summary = exploration.get("summary", "")
        task_description = context.get("task_description", "Update documentation")
        project_path = context.get("project_path", context.get("project_root", "."))

        model_choice = ctx.get_node_parameter("model", "gemini-pro")
        temperature = ctx.get_node_parameter("temperature", 0.2)
        llm = get_gemini_pro(temperature=temperature) if model_choice == "gemini-pro" else get_gemini_flash(temperature=temperature)

        # ── Check for revision loop ────────────────────────────
        previous_changes = outputs.get("doc_changes", {}).get("files", [])
        revision_hunks = []
        for file_entry in previous_changes:
            for hunk in file_entry.get("hunks", []):
                if hunk.get("status") == "revise":
                    revision_hunks.append({
                        "file_path": file_entry["path"],
                        "hunk": hunk,
                    })

        # ── Check for continuation loop (partial recovery) ────
        completed_files = outputs.get("completed_files", [])
        is_continuation = len(completed_files) > 0 and not revision_hunks

        if revision_hunks:
            revision_context = "\n".join([
                f"File: {rh['file_path']}, Hunk {rh['hunk']['id']}:\n"
                f"  Original: {rh['hunk']['original_lines']}\n"
                f"  Previous proposal: {rh['hunk']['proposed_lines']}\n"
                f"  Revision request: {rh['hunk']['revision_comment']}"
                for rh in revision_hunks
            ])
            prompt = f"""You previously drafted documentation changes that need revision.

REVISION REQUESTS:
{revision_context}

For each hunk that needs revision, provide the corrected proposed_lines.
Return a JSON array of objects: [{{"hunk_id": "...", "proposed_lines": [...]}}]
Return ONLY the JSON array, no other text.
"""
        elif is_continuation:
            # Continuation: we already got some files, need the rest
            completed_paths = [f["path"] for f in completed_files]
            completed_list = "\n".join(f"  ✓ {p}" for p in completed_paths)
            print(f"[DocDrafter] Continuation mode: {len(completed_files)} files already completed")

            prompt = f"""You are a documentation writer continuing a partially completed task.

TASK: {task_description}
PROJECT ROOT: {project_path}

EXPLORATION SUMMARY:
{exploration_summary[:3000]}

FILES ALREADY COMPLETED (do NOT include these):
{completed_list}

INSTRUCTIONS:
1. Draft ONLY the files that are NOT in the completed list above.
2. If all needed files are already completed, return an empty array: []
3. For each remaining file, produce the full content.
4. Only modify .context/ and .md files.
5. Keep each file's content concise — avoid unnecessary padding.

Return a JSON array of objects:
[
  {{
    "path": "absolute/path/to/file.md",
    "action": "update" or "create",
    "content": "full file content here"
  }}
]

Return ONLY the JSON array, no other text.
"""
        else:
            existing_docs_text = "\n\n---\n\n".join([
                f"FILE: {path}\n```\n{content}\n```"
                for path, content in existing_files.items()
            ]) or "No existing documentation found."

            prompt = f"""You are a documentation writer for a software project.

TASK: {task_description}
PROJECT ROOT: {project_path}

EXPLORATION SUMMARY:
{exploration_summary[:3000]}

EXISTING DOCUMENTATION:
{existing_docs_text[:8000]}

INSTRUCTIONS:
1. Generate the updated documentation content for each file that needs changes.
2. For existing files, produce the COMPLETE updated file content (not just the changed parts).
3. For new files, produce the full file content.
4. Only modify .context/ and .md files.
5. Keep content concise and well-structured — focus on accuracy over length.

Return a JSON array of objects:
[
  {{
    "path": "absolute/path/to/file.md",
    "action": "update" or "create",
    "content": "full file content here"
  }}
]

Return ONLY the JSON array, no other text.
"""

        from token_tracker import TRACKING_HANDLER
        callbacks = [TRACKING_HANDLER] if TRACKING_HANDLER else []
        response = await llm.ainvoke([HumanMessage(content=prompt)], config={"callbacks": callbacks})
        response_text = response.content if hasattr(response, "content") else str(response)

        # Gemini can return content as a list of parts instead of a string
        if isinstance(response_text, list):
            text_parts = []
            for part in response_text:
                if isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(part["text"])
                elif isinstance(part, str):
                    text_parts.append(part)
            response_text = "\n".join(text_parts)

        # Extract JSON — try multiple strategies
        # IMPORTANT: Strategy order matters. Looking for bare JSON array first
        # avoids the problem where embedded ``` in markdown content breaks
        # the code-fence regex.
        json_text = None

        # Strategy 1: Find the JSON array directly (most reliable)
        # Look for the outermost [ ... ] that starts on its own line
        bracket_start = response_text.find('[')
        if bracket_start >= 0:
            # Find matching closing bracket by counting depth
            depth = 0
            in_string = False
            escape_next = False
            last_valid = -1
            for i in range(bracket_start, len(response_text)):
                ch = response_text[i]
                if escape_next:
                    escape_next = False
                    continue
                if ch == '\\' and in_string:
                    escape_next = True
                    continue
                if ch == '"' and not escape_next:
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if ch == '[':
                    depth += 1
                elif ch == ']':
                    depth -= 1
                    if depth == 0:
                        json_text = response_text[bracket_start:i+1]
                        break

        # Strategy 2: If no balanced array found, try code-fenced block
        # Use GREEDY match to find the LAST ``` (avoids embedded ``` in content)
        if not json_text:
            json_match = re.search(r'```(?:json)?\s*([\s\S]*)\s*```', response_text)
            if json_match:
                json_text = json_match.group(1).strip()

        # Strategy 3: The entire response might be JSON
        if not json_text:
            json_text = response_text.strip()

        print(f"[DocDrafter] Response length: {len(response_text)} chars")
        print(f"[DocDrafter] Extracted JSON length: {len(json_text)} chars")
        print(f"[DocDrafter] JSON preview: {json_text[:300]}...")

        partial_recovery = False
        try:
            parsed = json.loads(json_text)
            print(f"[DocDrafter] Parsed {len(parsed)} file entries from LLM response")
        except json.JSONDecodeError as e:
            print(f"[DocDrafter] ❌ Failed to parse JSON: {e}")
            print(f"[DocDrafter] Attempting JSON repair...")

            # Try to repair truncated JSON by finding the last complete object
            repaired = None
            try:
                last_brace = json_text.rfind('}')
                while last_brace > 0:
                    candidate = json_text[:last_brace + 1] + ']'
                    try:
                        repaired = json.loads(candidate)
                        print(f"[DocDrafter] ✓ Repaired JSON: recovered {len(repaired)} entries")
                        partial_recovery = True
                        break
                    except json.JSONDecodeError:
                        last_brace = json_text.rfind('}', 0, last_brace)
            except Exception as repair_err:
                print(f"[DocDrafter] Repair also failed: {repair_err}")

            parsed = repaired if repaired else []
            if not parsed:
                print(f"[DocDrafter] Raw response (first 500 chars): {response_text[:500]}")

        if revision_hunks and parsed:
            revision_map = {item["hunk_id"]: item["proposed_lines"] for item in parsed}
            for file_entry in previous_changes:
                for hunk in file_entry.get("hunks", []):
                    if hunk["id"] in revision_map:
                        hunk["proposed_lines"] = revision_map[hunk["id"]]
                        hunk["status"] = "pending"
                        hunk["revision_comment"] = None
            doc_changes = {"files": previous_changes}
            all_completed_files = []
        else:
            # Build file entries from this batch
            new_files = []
            for item in parsed:
                file_path = item.get("path", "")
                action = item.get("action", "update")
                proposed_content = item.get("content", "")
                original_content = existing_files.get(file_path)
                hunks = _generate_hunks(original_content, proposed_content)
                new_files.append({
                    "path": file_path,
                    "action": action,
                    "original": original_content,
                    "proposed": proposed_content,
                    "hunks": hunks,
                })

            # Merge with previously completed files from continuation loop
            if is_continuation and completed_files:
                all_files = completed_files + new_files
                print(f"[DocDrafter] Merged: {len(completed_files)} previous + {len(new_files)} new = {len(all_files)} total files")
            else:
                all_files = new_files

            doc_changes = {"files": all_files}

            # Track completed files for potential next iteration
            all_completed_files = [
                {"path": f["path"], "action": f["action"], "original": f.get("original"),
                 "proposed": f.get("proposed"), "hunks": f.get("hunks", [])}
                for f in all_files
            ]

        total_hunks = sum(len(f.get("hunks", [])) for f in doc_changes["files"])
        total_files = len(doc_changes["files"])

        result_outputs = {
            **input_payload.get("outputs", {}),
            "doc_changes": doc_changes,
        }

        # If this was a partial recovery, store completed files so the next iteration
        # can pick up where we left off
        if partial_recovery and all_completed_files:
            result_outputs["completed_files"] = all_completed_files
            result_outputs["partial_recovery"] = True
            print(f"[DocDrafter] Partial recovery: {len(all_completed_files)} files completed, will continue on next iteration")
        else:
            # Clear continuation markers on successful full parse
            result_outputs.pop("completed_files", None)
            result_outputs.pop("partial_recovery", None)

        status_msg = f"[Doc Drafter] Drafted {total_hunks} changes across {total_files} files."
        if partial_recovery:
            status_msg += f" (partial — will continue)"

        return [[NodeExecutionData(json={
            **input_payload,
            "outputs": result_outputs,
            "messages": input_payload.get("messages", []) + [
                {"role": "assistant", "content": status_msg}
            ],
        })]]
