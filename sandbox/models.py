"""
Pydantic models for Sandbox API request/response validation.
"""

import base64
import mimetypes
from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class Language(str, Enum):
    """Supported execution languages."""
    PYTHON = "python"
    NODEJS = "nodejs"
    R = "r"
    BASH = "bash"


class ExecutionStatus(str, Enum):
    """Execution job status."""
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    OOM_KILLED = "oom_killed"


class FileData(BaseModel):
    """Base64-encoded file for upload/download."""
    name: str = Field(..., max_length=255)
    content_b64: str = Field(..., max_length=10_000_000)  # ~7.5MB decoded
    mime_type: Optional[str] = None
    
    @classmethod
    def from_bytes(cls, name: str, data: bytes) -> "FileData":
        mime_type = mimetypes.guess_type(name)[0]
        return cls(
            name=name,
            content_b64=base64.b64encode(data).decode(),
            mime_type=mime_type
        )
    
    def to_bytes(self) -> bytes:
        return base64.b64decode(self.content_b64)


class ExecutionRequest(BaseModel):
    """Request to execute code in sandbox."""
    
    code: str = Field(
        ...,
        min_length=1,
        max_length=100_000,
        description="Code to execute"
    )
    language: Language = Field(
        default=Language.PYTHON,
        description="Programming language"
    )
    timeout: int = Field(
        default=30,
        ge=1,
        le=300,
        description="Execution timeout in seconds"
    )
    stream: bool = Field(
        default=False,
        description="Enable SSE streaming output"
    )
    requirements: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="Packages to install before execution"
    )
    input_files: list[FileData] = Field(
        default_factory=list,
        max_length=10,
        description="Files to upload to workspace"
    )
    
    @field_validator("requirements")
    @classmethod
    def validate_requirements(cls, v: list[str]) -> list[str]:
        import re
        pattern = re.compile(r'^[a-zA-Z0-9_-]+([=<>!~]+[a-zA-Z0-9._-]+)?$')
        for pkg in v:
            if not pattern.match(pkg):
                raise ValueError(f"Invalid package specification: {pkg}")
        return v


class ExecutionResult(BaseModel):
    """Result of code execution."""
    
    job_id: str = Field(..., description="Unique execution ID")
    status: ExecutionStatus
    exit_code: Optional[int] = Field(None, description="Process exit code")
    stdout: str = Field(default="", max_length=1_000_000)
    stderr: str = Field(default="", max_length=1_000_000)
    execution_time_ms: int = Field(default=0)
    images: list[FileData] = Field(default_factory=list, description="Auto-captured images")
    output_files: list[FileData] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    error: Optional[str] = None


class SessionInfo(BaseModel):
    """Session metadata."""
    id: str
    name: Optional[str] = None
    language: Language = Language.PYTHON
    status: str = "idle"
    created_at: datetime
    last_activity: datetime


class HealthResponse(BaseModel):
    """Health check response."""
    status: str = "healthy"
    version: str = "1.0.0"
    docker_available: bool = True
    executor_images: dict[str, bool] = Field(default_factory=dict)
