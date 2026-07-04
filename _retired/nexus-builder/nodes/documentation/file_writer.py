"""
Doc File Writer Node - Writes approved documentation hunks to disk.

Only writes files where at least one hunk is approved.
Reconstructs content from approved hunks when partial approval.
"""

import os
import json
from typing import Any, Dict, List

from ..core.base import AtomicNode, NodeExecutionContext, NodeExecutionData


class DocFileWriterNode(AtomicNode):
    """Write approved documentation changes to the filesystem."""

    type_id = "doc_file_writer"
    display_name = "Doc File Writer"
    description = "Writes approved documentation hunks to disk, supporting partial approval and backup"
    category = "documentation"
    icon = "💾"
    version = 1.0
    levels = ["project", "task"]
    node_type = "atomic"

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Dry Run",
                "name": "dry_run",
                "type": "boolean",
                "default": False,
                "description": "Preview changes without writing files to disk",
            },
            {
                "displayName": "Backup Originals",
                "name": "backup_originals",
                "type": "boolean",
                "default": False,
                "description": "Save .bak copies of original files before overwriting",
            },
        ]

    async def execute(
        self, ctx: NodeExecutionContext, items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        input_payload = items[0].json if items else {}
        outputs = input_payload.get("outputs", {})
        doc_changes = outputs.get("doc_changes", {})
        
        # Check for user-reviewed hunk decisions from the interrupt/resume flow
        # These override the graph-state doc_changes (which still has "pending" hunks)
        from shared_state import get_hunk_decisions
        run_id = input_payload.get("context", {}).get("run_id")
        user_decisions = get_hunk_decisions(run_id) if run_id else None
        if user_decisions:
            print(f"[DocFileWriter] Using user-reviewed hunk decisions from interrupt flow")
            doc_changes = user_decisions
        
        dry_run = ctx.get_node_parameter("dry_run", False)
        backup = ctx.get_node_parameter("backup_originals", False)

        written_files = []
        skipped_files = []

        for file_entry in doc_changes.get("files", []):
            path = file_entry.get("path", "")
            
            # Sanitize: collapse doubled .context/ segments
            # LLM sometimes produces paths like /project/.context/.context/tech-stack.md
            while '/.context/.context/' in path or '\\.context\\.context\\' in path:
                path = path.replace('/.context/.context/', '/.context/')
                path = path.replace('\\.context\\.context\\', '\\.context\\')
            
            hunks = file_entry.get("hunks", [])
            statuses = [h.get("status", "unknown") for h in hunks]
            print(f"[DocFileWriter] File: {path}, {len(hunks)} hunks, statuses: {statuses}")

            approved_hunks = [h for h in hunks if h.get("status") == "approved"]
            rejected_all = all(h.get("status") == "rejected" for h in hunks)

            if rejected_all or not approved_hunks:
                skipped_files.append(path)
                continue

            # Determine content to write
            if len(approved_hunks) == len(hunks):
                content = file_entry.get("proposed", "")
            else:
                # Partial approval: reconstruct from original
                original = file_entry.get("original", "") or ""
                orig_lines = original.splitlines()
                result_lines = list(orig_lines)

                for hunk in sorted(approved_hunks, key=lambda h: h.get("start_line", 0), reverse=True):
                    start = hunk["start_line"] - 1
                    orig_len = len(hunk.get("original_lines", []))
                    result_lines[start:start + orig_len] = hunk.get("proposed_lines", [])

                content = "\n".join(result_lines)

            if dry_run:
                print(f"[DocFileWriter] DRY RUN — would write: {path} ({len(content)} chars)")
                written_files.append(f"{path} (dry-run)")
                continue

            try:
                if backup and os.path.isfile(path):
                    import shutil
                    shutil.copy2(path, f"{path}.bak")

                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                written_files.append(path)
                print(f"[DocFileWriter] ✅ Wrote: {path}")
            except Exception as e:
                print(f"[DocFileWriter] ❌ Failed to write {path}: {e}")
                skipped_files.append(path)

        summary = f"Wrote {len(written_files)} files"
        if skipped_files:
            summary += f", skipped {len(skipped_files)}"

        # ── Sync context to DB if any .context/ files were written ──
        context_files_written = [f for f in written_files if ".context" in f or os.sep + ".context" + os.sep in f]
        if context_files_written:
            project_id = input_payload.get("context", {}).get("project_id")
            if project_id:
                try:
                    import aiohttp
                    async with aiohttp.ClientSession() as session:
                        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
                        sync_url = f"{nodejs_url}/api/projects/{project_id}/context/sync"
                        async with session.post(sync_url) as resp:
                            if resp.status == 200:
                                sync_result = await resp.json()
                                print(f"[DocFileWriter] ✅ Context synced: {sync_result.get('synced', 0)} files")
                            else:
                                print(f"[DocFileWriter] ⚠ Context sync returned {resp.status}")
                except ImportError:
                    # Fallback to requests if aiohttp not available
                    try:
                        import requests as req_lib
                        nodejs_url = os.getenv("NODEJS_BACKEND_URL", "http://localhost:4000")
                        sync_url = f"{nodejs_url}/api/projects/{project_id}/context/sync"
                        resp = req_lib.post(sync_url, timeout=10)
                        if resp.ok:
                            sync_result = resp.json()
                            print(f"[DocFileWriter] ✅ Context synced: {sync_result.get('synced', 0)} files")
                        else:
                            print(f"[DocFileWriter] ⚠ Context sync returned {resp.status_code}")
                    except Exception as e:
                        print(f"[DocFileWriter] ⚠ Context sync failed: {e}")
                except Exception as e:
                    print(f"[DocFileWriter] ⚠ Context sync failed: {e}")
            else:
                print(f"[DocFileWriter] ⚠ No project_id in context, skipping context sync")

        return [[NodeExecutionData(json={
            **input_payload,
            "outputs": {
                **input_payload.get("outputs", {}),
                "doc_result": {
                    "written": written_files,
                    "skipped": skipped_files,
                },
            },
            "messages": input_payload.get("messages", []) + [
                {"role": "assistant", "content": f"[Doc File Writer] ✅ {summary}"}
            ],
        })]]
