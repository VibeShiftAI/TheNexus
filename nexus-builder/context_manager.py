"""
Context Manager - Python Port from Node.js src/scheduler/ContextManager.js

Phase 6: Memory & Context Systems
Handles:
- Context reconstruction between executions
- System prompt generation
- User preference management
- Context serialization/deserialization

This replaces the Node.js push-model with a Python implementation
that integrates with the atomic node execution engine.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional
from pathlib import Path


# ═══════════════════════════════════════════════════════════════════════════
# TYPE DEFINITIONS
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class UserPreferences:
    """User preferences for agent execution."""
    notification_level: str = "important"  # 'all' | 'important' | 'critical' | 'none'
    ignored_issue_types: List[str] = field(default_factory=list)
    thresholds: Dict[str, int] = field(default_factory=lambda: {
        "critical_vulnerabilities": 0,
        "high_vulnerabilities": 3,
        "major_outdated_packages": 5,
        "todo_count": 50
    })
    timezone: str = "UTC"
    language: str = "en"


@dataclass
class TaskInfo:
    """Task information for context."""
    id: str
    name: str
    description: Optional[str] = None
    agent_type: Optional[str] = None
    cron_expression: Optional[str] = None
    project_path: Optional[str] = None
    configuration: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ProjectInfo:
    """Project information for context."""
    id: Optional[str] = None
    path: Optional[str] = None
    name: str = "Unknown"


@dataclass
class PreviousRun:
    """Information about the previous run."""
    timestamp: str
    status: str
    summary: Optional[str] = None
    duration_ms: int = 0


@dataclass
class Memory:
    """A single memory entry."""
    type: str
    content: str
    created_at: str


@dataclass
class ExecutionContext:
    """Complete execution context for an agent."""
    task: TaskInfo
    project: ProjectInfo
    previous_run: Optional[PreviousRun] = None
    memories: List[Memory] = field(default_factory=list)
    user_preferences: UserPreferences = field(default_factory=UserPreferences)
    system_prompt: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)


# ═══════════════════════════════════════════════════════════════════════════
# CONTEXT MANAGER CLASS
# ═══════════════════════════════════════════════════════════════════════════

class ContextManager:
    """
    Build and manage execution context for agents.
    
    Python port of src/scheduler/ContextManager.js
    Phase 6: Memory & Context Systems
    """
    
    # Memory type display formatting
    MEMORY_TYPE_FORMATS = {
        "decision": "Past Decisions",
        "observation": "Observations",
        "user_feedback": "User Feedback",
        "error": "Past Errors",
        "insight": "Insights"
    }
    
    MEMORY_TYPE_ICONS = {
        "decision": "🎯",
        "observation": "👁️",
        "user_feedback": "💬",
        "error": "❌",
        "insight": "💡"
    }
    
    def __init__(self, supabase_client=None):
        """
        Initialize context manager.
        
        Args:
            supabase_client: Optional Supabase client for database access
        """
        self.supabase = supabase_client
        self.default_preferences = UserPreferences()
    
    async def build_context(
        self,
        task_id: str,
        project_id: Optional[str] = None,
        project_path: Optional[str] = None,
        task_title: Optional[str] = None,
        task_description: Optional[str] = None
    ) -> ExecutionContext:
        """
        Build execution context for a task.
        
        Args:
            task_id: Task ID
            project_id: Optional project ID
            project_path: Optional project path
            task_title: Task title
            task_description: Task description
        
        Returns:
            ExecutionContext with all relevant data
        """
        # Build task info
        task = TaskInfo(
            id=task_id,
            name=task_title or "Untitled Task",
            description=task_description,
            project_path=project_path
        )
        
        # Build project info
        project = ProjectInfo(
            id=project_id,
            path=project_path,
            name=Path(project_path).name if project_path else "Unknown"
        )
        
        # Get previous execution (if available)
        previous_run = await self._get_previous_run(task_id)
        
        # Get relevant memories
        memories = await self._retrieve_memories(task_id, task.name, limit=15)
        
        # Get user preferences
        user_preferences = await self.get_user_preferences(None)
        
        # Build context
        context = ExecutionContext(
            task=task,
            project=project,
            previous_run=previous_run,
            memories=memories,
            user_preferences=user_preferences,
            metadata={
                "current_time": datetime.utcnow().isoformat(),
                "execution_number": await self._get_execution_count(task_id) + 1
            }
        )
        
        # Generate system prompt
        context.system_prompt = self.build_system_prompt(context)
        
        return context
    
    async def _get_previous_run(self, task_id: str) -> Optional[PreviousRun]:
        """Get the previous execution run for a task."""
        if not self.supabase:
            return None
        
        try:
            # Query for last successful execution
            result = self.supabase.client.table("task_executions").select("*").eq(
                "task_id", task_id
            ).eq("status", "success").order("started_at", desc=True).limit(1).execute()
            
            if result.data and len(result.data) > 0:
                row = result.data[0]
                return PreviousRun(
                    timestamp=row.get("started_at"),
                    status=row.get("status"),
                    summary=row.get("result_summary"),
                    duration_ms=row.get("execution_duration_ms", 0)
                )
        except Exception as e:
            print(f"[ContextManager] Error getting previous run: {e}")
        
        return None
    
    async def _retrieve_memories(
        self,
        task_id: str,
        query: str,
        limit: int = 15
    ) -> List[Memory]:
        """Retrieve relevant memories for a task."""
        if not self.supabase:
            return []
        
        try:
            # Query for memories related to this task
            result = self.supabase.client.table("agent_memories").select("*").eq(
                "task_id", task_id
            ).order("created_at", desc=True).limit(limit).execute()
            
            if result.data:
                return [
                    Memory(
                        type=row.get("memory_type", "observation"),
                        content=row.get("content", ""),
                        created_at=row.get("created_at")
                    )
                    for row in result.data
                ]
        except Exception as e:
            print(f"[ContextManager] Error retrieving memories: {e}")
        
        return []
    
    async def _get_execution_count(self, task_id: str) -> int:
        """Get total execution count for a task."""
        if not self.supabase:
            return 0
        
        try:
            result = self.supabase.client.table("task_executions").select(
                "id", count="exact"
            ).eq("task_id", task_id).execute()
            return result.count or 0
        except Exception:
            return 0
    
    async def get_user_preferences(self, user_id: Optional[str]) -> UserPreferences:
        """Get user preferences (returns defaults for now)."""
        # TODO: Implement database lookup for user preferences
        return self.default_preferences
    
    def build_system_prompt(self, context: ExecutionContext) -> str:
        """
        Build the system prompt for an agent.
        
        Args:
            context: The execution context
        
        Returns:
            Formatted system prompt string
        """
        lines = []
        task = context.task
        project = context.project
        previous_run = context.previous_run
        memories = context.memories
        user_prefs = context.user_preferences
        metadata = context.metadata
        
        # Header
        lines.append("# Scheduled Agent Task Execution")
        lines.append("")
        lines.append(f'You are an autonomous agent executing the scheduled task: "{task.name}"')
        lines.append(f"Current time: {metadata.get('current_time')}")
        lines.append(f"Execution #{metadata.get('execution_number')}")
        lines.append("")
        
        # Task details
        lines.append("## Task Configuration")
        if task.agent_type:
            lines.append(f"- **Agent Type**: {task.agent_type}")
        if task.cron_expression:
            lines.append(f"- **Schedule**: {task.cron_expression}")
        if task.description:
            lines.append(f"- **Description**: {task.description}")
        lines.append("")
        
        # Project information
        lines.append("## Project")
        lines.append(f"- **Path**: {project.path or 'Not specified'}")
        lines.append(f"- **Name**: {project.name}")
        lines.append("")
        
        # Agent configuration
        if task.configuration:
            lines.append("## Agent Settings")
            lines.append("```json")
            lines.append(json.dumps(task.configuration, indent=2))
            lines.append("```")
            lines.append("")
        
        # Previous run information
        if previous_run:
            lines.append("## Previous Execution")
            lines.append(f"- **When**: {previous_run.timestamp}")
            lines.append(f"- **Status**: {previous_run.status}")
            lines.append(f"- **Duration**: {round(previous_run.duration_ms / 1000)}s")
            if previous_run.summary:
                summary = previous_run.summary[:300]
                if len(previous_run.summary) > 300:
                    summary += "..."
                lines.append(f"- **Summary**: {summary}")
            lines.append("")
        
        # Memory context
        if memories:
            lines.append("## Historical Context")
            lines.append("Key information from previous executions:")
            lines.append("")
            
            # Group by type
            by_type: Dict[str, List[Memory]] = {}
            for memory in memories:
                if memory.type not in by_type:
                    by_type[memory.type] = []
                by_type[memory.type].append(memory)
            
            for mem_type, items in by_type.items():
                icon = self.MEMORY_TYPE_ICONS.get(mem_type, "📝")
                formatted_type = self.MEMORY_TYPE_FORMATS.get(mem_type, mem_type)
                lines.append(f"### {icon} {formatted_type}")
                
                for item in items[:3]:
                    date = item.created_at[:10] if item.created_at else "Unknown"
                    content = item.content[:150]
                    if len(item.content) > 150:
                        content += "..."
                    lines.append(f"- [{date}] {content}")
                lines.append("")
        
        # User preferences
        lines.append("## User Preferences")
        lines.append(f"- **Notification Level**: {user_prefs.notification_level}")
        if user_prefs.ignored_issue_types:
            lines.append(f"- **Ignored Issues**: {', '.join(user_prefs.ignored_issue_types)}")
        lines.append("")
        
        # Guidelines
        lines.append("## Guidelines")
        lines.append("")
        lines.append("1. **Compare with Previous Runs**: Identify what has changed since the last execution")
        lines.append("2. **Prioritize Actionable Insights**: Focus on information that requires attention")
        lines.append("3. **Respect User Preferences**: Honor ignored issue types and notification thresholds")
        lines.append("4. **Be Concise**: Provide clear, actionable summaries")
        lines.append("5. **Record Important Findings**: Store significant observations for future context")
        lines.append("6. **Handle Errors Gracefully**: Log errors but continue with available information")
        lines.append("")
        
        # Output format
        lines.append("## Expected Output")
        lines.append("")
        lines.append("Your response should include:")
        lines.append("1. A brief summary of current state")
        lines.append("2. Changes since last run (if applicable)")
        lines.append("3. Issues requiring attention (prioritized)")
        lines.append("4. Recommended actions")
        lines.append("5. Memories to store for future context")
        lines.append("")
        
        return "\n".join(lines)
    
    def serialize_context(self, context: ExecutionContext) -> str:
        """Serialize context for storage."""
        from dataclasses import asdict
        data = asdict(context)
        data["serialized_at"] = datetime.utcnow().isoformat()
        return json.dumps(data)
    
    def deserialize_context(self, serialized: str) -> Dict[str, Any]:
        """Deserialize stored context."""
        data = json.loads(serialized)
        data.pop("serialized_at", None)
        return data
    
    async def build_minimal_context(
        self,
        task_id: str,
        task_title: Optional[str] = None,
        project_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create a minimal context for lightweight operations.
        
        Args:
            task_id: Task ID
            task_title: Task title
            project_path: Project path
        
        Returns:
            Minimal context dict
        """
        return {
            "task": {
                "id": task_id,
                "name": task_title or "Untitled Task"
            },
            "project": {
                "path": project_path,
                "name": Path(project_path).name if project_path else "Unknown"
            }
        }
    
    def compare_contexts(
        self,
        old_context: ExecutionContext,
        new_context: ExecutionContext
    ) -> Dict[str, Any]:
        """
        Generate a diff summary between two contexts.
        
        Args:
            old_context: Previous context
            new_context: Current context
        
        Returns:
            Dict with changes summary
        """
        changes = []
        
        # Compare task configuration
        if old_context.task.configuration != new_context.task.configuration:
            changes.append({
                "type": "configuration",
                "description": "Task configuration has changed"
            })
        
        # Compare memory counts
        old_count = len(old_context.memories)
        new_count = len(new_context.memories)
        if new_count > old_count:
            changes.append({
                "type": "memories",
                "description": f"{new_count - old_count} new memories added"
            })
        
        # Compare preferences
        old_prefs = old_context.user_preferences
        new_prefs = new_context.user_preferences
        if old_prefs.notification_level != new_prefs.notification_level:
            changes.append({
                "type": "preferences",
                "description": "User preferences have changed"
            })
        
        return {
            "has_changes": len(changes) > 0,
            "changes": changes,
            "summary": (
                f"{len(changes)} changes detected: {', '.join(c['type'] for c in changes)}"
                if changes else "No changes detected"
            )
        }
