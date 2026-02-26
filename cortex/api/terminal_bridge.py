"""
AI Terminal Bridge — Connects AI Terminal requests to the Vibe Coding OS.

Invokes the System 2 LangGraph orchestrator with:
  Chat Router → Architect → Council → Human Review → Compiler → Executor

Streams Glass Box artifacts back to the AI Terminal.
"""

import asyncio
import uuid
from typing import Dict, Any, Optional, List, AsyncGenerator
from cortex.core.orchestrator import build_system2_graph
from cortex.core.persistence import CheckpointFactory
from cortex.interface.nexus_client import nexus


class CortexBrainBridge:
    """
    Singleton bridge to invoke the Cortex Brain from the AI Terminal.
    """

    _instance = None
    _brain = None
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def initialize(self):
        """Async initialization - call once at startup."""
        if self._initialized:
            return

        print("🧠 [CortexBridge] Initializing Vibe Coding OS Brain...")
        checkpointer = await CheckpointFactory.get_saver()
        self._brain = build_system2_graph(checkpointer=checkpointer)
        self._initialized = True
        print("✅ [CortexBridge] Brain ready for AI Terminal requests")

    async def process_request(
        self,
        user_request: str,
        session_id: Optional[str] = None,
        files: Optional[List[Dict[str, Any]]] = None,
        stream_artifacts: bool = True
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Process a user request through the Vibe Coding OS Brain.

        Streaming generator that yields Glass Box artifacts as produced.
        """
        if not self._initialized:
            await self.initialize()

        # Prepare content with attached files
        content = user_request
        if files:
            file_sections = []
            for f in files:
                file_sections.append(f"\n--- FILE: {f['name']} ---\n{f['content']}\n--- END FILE ---")
            content = f"{user_request}\n\nATTACHED FILES:{''.join(file_sections)}"

        # Generate unique thread_id
        unique_id = session_id if session_id else str(uuid.uuid4())[:8]
        thread_id = f"terminal_{unique_id}"
        print(f"\n{'='*60}")
        print(f"🧠 [CortexBridge] VIBE CODING OS ACTIVATED")
        print(f"   Thread: {thread_id}")
        print(f"   Request: {user_request[:100]}...")
        print(f"   Files: {len(files) if files else 0}")
        print(f"{'='*60}")

        # Initial state for the new orchestrator
        initial_state = {
            "messages": [{"role": "user", "content": content}],
            "session_id": thread_id,
            "route": None,
            "local_context": None,
            "markdown_plan": None,
            "draft_plan": None,
            "compiled_plan": None,
            "final_plan": None,
            "votes": [],
            "council_feedback": None,
            "prior_comments": [],
            "plan_diff": None,
            "revision_count": 0,
            "human_decision": None,
            "human_feedback": None,
            "browse_session": None,
            "research_context": None,
        }

        config = {"configurable": {"thread_id": thread_id}}

        # Check for paused thread (awaiting human review)
        existing_state = await self._brain.aget_state(config)
        is_paused_for_review = (
            existing_state and
            existing_state.next and
            len(existing_state.next) > 0 and
            "human_review" in existing_state.next
        )

        # Detect approval/rejection signals
        approval_signals = ["approve", "approved", "proceed", "go ahead", "looks good", "lgtm", "yes", "confirm"]
        rejection_signals = ["reject", "revise", "change", "modify", "no", "stop", "cancel"]
        user_lower = user_request.lower()
        is_explicit_feedback = any(sig in user_lower for sig in approval_signals + rejection_signals)
        is_approval = any(sig in user_lower for sig in approval_signals)

        is_resuming = is_paused_for_review and is_explicit_feedback

        if is_paused_for_review and not is_explicit_feedback:
            print(f"⚠️ [CortexBridge] Found paused thread but message doesn't look like feedback. Starting fresh.")

        if is_resuming:
            print(f"🔄 [CortexBridge] RESUMING paused thread at node: {existing_state.next}")
            # Inject the human decision
            human_decision = "approve" if is_approval else "reject"
            human_feedback = user_request if not is_approval else None
            await self._brain.aupdate_state(
                config,
                {
                    "messages": [{"role": "user", "content": content}],
                    "human_decision": human_decision,
                    "human_feedback": human_feedback,
                }
            )

        # Yield initial status
        status_payload = {
            "status": "resuming" if is_resuming else "thinking",
            "message": "🔄 Resuming from your feedback..." if is_resuming else "🧠 Activating Vibe Coding OS...",
            "thread_id": thread_id
        }
        await nexus.push_artifact("STATUS_UPDATE", status_payload)
        yield {"artifact_type": "STATUS_UPDATE", "payload": status_payload}

        final_response = None
        council_votes = []  # Track council votes as they stream through

        try:
            stream_input = None if is_resuming else initial_state
            async for event in self._brain.astream(stream_input, config):
                node_names = list(event.keys())
                print(f"   🔄 Graph Event: {node_names}")

                for node_name in node_names:
                    node_data = event[node_name]

                    # CHAT ROUTER: Intent classification
                    if node_name == "chat_router":
                        route = node_data.get("route", "chat")
                        route_msg = "🔀 Intent: build — spinning up the Architect..." if route == "build" else f"💬 Responding directly..."
                        status_payload = {
                            "status": "routing",
                            "message": route_msg,
                            "thread_id": thread_id
                        }
                        if stream_artifacts:
                            await nexus.push_artifact("STATUS_UPDATE", status_payload)
                        yield {"artifact_type": "STATUS_UPDATE", "payload": status_payload}

                    # CHAT RESPONSE: Direct LLM reply (bypass)
                    elif node_name == "chat_response":
                        msgs = node_data.get("messages", [])
                        if msgs:
                            response_content = msgs[-1].content if hasattr(msgs[-1], "content") else str(msgs[-1])
                            final_response = response_content
                            yield {
                                "artifact_type": "CHAT_RESPONSE",
                                "payload": {
                                    "response": response_content,
                                    "thread_id": thread_id
                                }
                            }

                    # ARCHITECT: Plan drafted or revised
                    elif node_name == "architect":
                        plan_data = node_data.get("markdown_plan")
                        plan_diff = node_data.get("plan_diff")
                        if plan_data:
                            is_revision = plan_data.version > 1
                            if is_revision:
                                print(f"🔄 Architect revised: {plan_data.title} (v{plan_data.version})")
                                status_msg = f"🔄 Architect revising plan based on council feedback → {plan_data.title} (v{plan_data.version})"
                            else:
                                print(f"📋 Architect produced: {plan_data.title} (v{plan_data.version})")
                                status_msg = f"📐 Plan drafted: {plan_data.title} (v{plan_data.version})"
                            # Status: Architect finished
                            status_payload = {
                                "status": "architect_done",
                                "message": status_msg,
                                "thread_id": thread_id
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("STATUS_UPDATE", status_payload)
                            yield {"artifact_type": "STATUS_UPDATE", "payload": status_payload}
                            artifact = {
                                "artifact_type": "PLAN_DRAFT",
                                "payload": {
                                    "title": plan_data.title,
                                    "version": plan_data.version,
                                    "markdown": plan_data.content,
                                    "rationale": plan_data.rationale,
                                    "diff": plan_diff,
                                    "thread_id": thread_id,
                                    "is_final": False
                                }
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("PLAN_DRAFT", artifact["payload"])
                            yield artifact
                            # Status: Council assembling with details
                            council_payload = {
                                "status": "council_assembling",
                                "message": (
                                    "🗳️ Council assembled — 4 specialist reviewers analyzing the plan in parallel...\n"
                                    "   👤 Frontend/UX Specialist • 🔧 Systems Engineer • 🧪 QA Strategist • 🔍 Gap Analyst"
                                ),
                                "thread_id": thread_id
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("STATUS_UPDATE", council_payload)
                            yield {"artifact_type": "STATUS_UPDATE", "payload": council_payload}

                    # COUNCIL REVIEW: Parallel critique
                    elif node_name == "council_review":
                        votes = node_data.get("votes", [])
                        if votes:
                            council_votes = votes  # Capture for READY_FOR_REVIEW
                            total_comments = sum(len(v.line_comments) for v in votes if v.line_comments)
                            print(f"🗳️ Council: {len(votes)} reviews, {total_comments} line comments")
                            # Status: Detailed council results with individual votes
                            approvals = sum(1 for v in votes if v.decision == "approve")
                            rejections = sum(1 for v in votes if v.decision == "reject")
                            concerns = sum(1 for v in votes if v.decision == "request_info")
                            
                            # Build per-voter summary lines
                            vote_icons = {"approve": "✅", "reject": "❌", "request_info": "❓"}
                            voter_lines = []
                            for v in votes:
                                icon = vote_icons.get(v.decision, "❓")
                                comment_count = len(v.line_comments) if v.line_comments else 0
                                comment_note = f" ({comment_count} comments)" if comment_count > 0 else ""
                                voter_lines.append(f"   {icon} {v.voter}{comment_note}")
                            
                            # Header line
                            if approvals > (len(votes) * 0.75):
                                council_header = f"✅ Council: {approvals}/{len(votes)} approved — plan proceeding to review"
                            elif approvals > 0:
                                council_header = f"⚠️ Council: {approvals}/{len(votes)} approved, {concerns} requesting changes — revision needed"
                            else:
                                council_header = f"❌ Council: {rejections} rejected, {concerns} concerns — major revision needed"
                            
                            if total_comments > 0:
                                council_header += f" • {total_comments} line comments total"
                            
                            council_summary = council_header + "\n" + "\n".join(voter_lines)
                            
                            council_status = {
                                "status": "council_done",
                                "message": council_summary,
                                "thread_id": thread_id
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("STATUS_UPDATE", council_status)
                            yield {"artifact_type": "STATUS_UPDATE", "payload": council_status}
                            vote_summary = [
                                {
                                    "voter": v.voter,
                                    "decision": v.decision,
                                    "reasoning": v.reasoning,
                                    "line_comments": [c.model_dump() for c in v.line_comments] if v.line_comments else []
                                }
                                for v in votes
                            ]
                            artifact = {
                                "artifact_type": "COUNCIL_REVIEW",
                                "payload": {
                                    "votes": vote_summary,
                                    "thread_id": thread_id
                                }
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("COUNCIL_REVIEW", artifact["payload"])
                            yield artifact

                    # PLAN REVISION: Architect applies council line comments
                    elif node_name == "plan_revision":
                        plan_data = node_data.get("markdown_plan") if node_data else None
                        plan_diff = node_data.get("plan_diff") if node_data else None
                        if plan_data:
                            prior_comments = len(node_data.get("prior_comments", [])) if node_data else 0
                            print(f"📝 Plan revised: {plan_data.title} (v{plan_data.version})")
                            revision_status = {
                                "status": "revision_done",
                                "message": f"📝 Plan revised: {plan_data.title} (v{plan_data.version}) — addressed {prior_comments} council comments",
                                "thread_id": thread_id
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("STATUS_UPDATE", revision_status)
                            yield {"artifact_type": "STATUS_UPDATE", "payload": revision_status}
                            artifact = {
                                "artifact_type": "PLAN_REVISED",
                                "payload": {
                                    "title": plan_data.title,
                                    "version": plan_data.version,
                                    "markdown": plan_data.content,
                                    "rationale": plan_data.rationale,
                                    "diff": plan_diff,
                                    "thread_id": thread_id,
                                    "is_final": True
                                }
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("PLAN_REVISED", artifact["payload"])
                            yield artifact
                        else:
                            print(f"[PlanRevision] No line comments - plan unchanged")
                            skip_status = {
                                "status": "revision_skip",
                                "message": "📝 No revisions needed — plan passed review cleanly",
                                "thread_id": thread_id
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("STATUS_UPDATE", skip_status)
                            yield {"artifact_type": "STATUS_UPDATE", "payload": skip_status}

                    # COMPILER: Markdown → JSON
                    elif node_name == "compiler":
                        compiled = node_data.get("compiled_plan")
                        if compiled:
                            print(f"🔧 Compiler: {compiled.title} ({len(compiled.nodes)} nodes)")
                            compile_status = {
                                "status": "compiling",
                                "message": f"🔧 Compiling plan → {len(compiled.nodes)} executable tasks",
                                "thread_id": thread_id
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("STATUS_UPDATE", compile_status)
                            yield {"artifact_type": "STATUS_UPDATE", "payload": compile_status}
                            artifact = {
                                "artifact_type": "COMPILED_PLAN",
                                "payload": {
                                    "title": compiled.title,
                                    "goal": compiled.goal,
                                    "nodes": [n.model_dump() for n in compiled.nodes],
                                    "thread_id": thread_id
                                }
                            }
                            if stream_artifacts:
                                await nexus.push_artifact("COMPILED_PLAN", artifact["payload"])
                            yield artifact

                    # EXECUTOR: Project created
                    elif node_name == "executor":
                        print(f"✅ Execution complete")
                        exec_status = {
                            "status": "executing",
                            "message": "🚀 Creating project and tasks...",
                            "thread_id": thread_id
                        }
                        if stream_artifacts:
                            await nexus.push_artifact("STATUS_UPDATE", exec_status)
                        yield {"artifact_type": "STATUS_UPDATE", "payload": exec_status}
                        if node_data is None:
                            print(f"⚠️ [CortexBridge] Executor returned None state — skipping plan extraction")
                            compiled = None
                        else:
                            compiled = node_data.get("compiled_plan") or node_data.get("final_plan")
                        if compiled:
                            final_response = f"## Project Created: {compiled.title}\n\n**Goal:** {compiled.goal}\n\n**Tasks:**\n"
                            for i, node in enumerate(compiled.nodes, 1):
                                final_response += f"{i}. {node.description}\n"

            # Yield final response
            if final_response:
                yield {
                    "artifact_type": "FINAL_RESPONSE",
                    "payload": {
                        "response": final_response,
                        "thread_id": thread_id
                    }
                }
            else:
                # Graph paused for human review — check captured council votes
                has_concerns = any(
                    v.decision == "request_info" for v in council_votes
                ) if council_votes else False

                review_message = "Plan reviewed by council. Ready for your approval."
                if has_concerns:
                    concern_count = sum(1 for v in council_votes if v.decision == "request_info")
                    review_message = (
                        f"⚠️ The Council compiled this plan, but had {concern_count} "
                        f"unresolved concern(s). Review carefully.\n\n"
                        f"Plan reviewed by council. Ready for your approval."
                    )

                ready_artifact = {
                    "artifact_type": "READY_FOR_REVIEW",
                    "payload": {
                        "thread_id": thread_id,
                        "message": review_message,
                        "has_concerns": has_concerns,
                    }
                }
                if stream_artifacts:
                    await nexus.push_artifact("READY_FOR_REVIEW", ready_artifact["payload"])
                yield ready_artifact

                yield {
                    "artifact_type": "AWAITING_HUMAN",
                    "payload": {
                        "status": "awaiting_human_review",
                        "message": "The plan is ready for your review. Approve or modify?",
                        "thread_id": thread_id
                    }
                }

        except Exception as e:
            print(f"❌ [CortexBridge] Error: {e}")
            import traceback
            traceback.print_exc()
            yield {
                "artifact_type": "ERROR",
                "payload": {"error": str(e), "thread_id": thread_id}
            }

        print(f"{'='*60}")
        print(f"🏁 [CortexBridge] Processing complete for thread {thread_id}")
        print(f"{'='*60}\n")


# Singleton instance
cortex_bridge = CortexBrainBridge()


async def invoke_cortex_brain(
    user_request: str,
    session_id: Optional[str] = None,
    files: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Convenience function to invoke the Cortex Brain and collect all artifacts.
    """
    artifacts = []
    final_response = ""

    async for artifact in cortex_bridge.process_request(
        user_request=user_request,
        session_id=session_id,
        files=files,
        stream_artifacts=True
    ):
        artifacts.append(artifact)

        if artifact["artifact_type"] == "FINAL_RESPONSE":
            final_response = artifact["payload"].get("response", "")
        elif artifact["artifact_type"] == "CHAT_RESPONSE":
            final_response = artifact["payload"].get("response", "")
        elif artifact["artifact_type"] == "AWAITING_HUMAN":
            final_response = artifact["payload"].get("message", "Awaiting review...")
        elif artifact["artifact_type"] == "ERROR":
            final_response = f"Error: {artifact['payload'].get('error', 'Unknown error')}"

    return {
        "response": final_response,
        "artifacts": artifacts
    }
