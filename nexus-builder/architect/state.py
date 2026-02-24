from typing import Annotated, List, TypedDict, Literal, Optional, Any
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


class FileOperation(BaseModel):
    """A single file operation in the manifest."""
    path: str = Field(description="Relative path to the file.")
    operation: Literal["NEW", "MODIFY", "DELETE"] = Field(
        description="NEW: create file. MODIFY: edit existing. DELETE: remove."
    )
    rationale: str = Field(description="Why this operation type was chosen.")


class ArchitectState(TypedDict):
    messages: Annotated[List[Any], add_messages]
    user_request: str
    
    # Enhanced context fields
    task_title: str  # High-level task name
    task_description: str  # Original user intent (before research interpretation)
    project_context: str  # Combined markdown from supervisor/*.md
    
    # PROJECT ROOT: Absolute path to the project being worked on
    project_root: str
    
    # KNOWLEDGE: The 'Ground Truth' file list (Potentially huge)
    repo_structure: str 
    
    # INTERNAL: Gemini Pro's reasoning trace (prevents lobotomy)
    thought_signature: Optional[str]
    
    # DRAFTS
    draft_spec: Optional[str]
    draft_manifest: Optional[List[dict]]  # List of FileOperation dicts
    
    # VALIDATED OUTPUTS
    final_spec: Optional[str]
    final_manifest: Optional[List[dict]]
    definition_of_done: Optional[dict]
    
    # FEEDBACK LOOP
    grounding_errors: List[str]
    loop_count: int
    
    # DIALOGUE CONTEXT - tracks conversation between drafter and grounder
    dialogue_history: Optional[List[dict]]  # [{role: "drafter"|"grounder", content: str}]


class ProjectBlueprint(BaseModel):
    spec_markdown: str = Field(description="The detailed implementation guide with function signatures.")
    target_files: List[FileOperation] = Field(
        description="Manifest of file operations. Each entry specifies path, operation type (NEW/MODIFY/DELETE), and rationale."
    )
    acceptance_criteria: List[str] = Field(description="Verifiable 'Definition of Done' for the Auditor.")


class GroundingReport(BaseModel):
    is_valid: bool
    issues: List[str] = Field(
        default_factory=list,
        description="Specific issues found during validation."
    )
    suggestions: List[str] = Field(
        default_factory=list,
        description="Actionable suggestions for fixing each issue."
    )
    understood_intent: str = Field(
        description="Grounder's understanding of what the drafter intended. Critical for preventing miscommunication."
    )

