"""
Executor - Handles code execution within containers with streaming and image capture.
"""

import asyncio
import base64
import io
import logging
import os
import tarfile
import time
import uuid
from pathlib import Path
from typing import AsyncIterator, Optional

import anyio
from docker.models.containers import Container

from .models import (
    ExecutionRequest,
    ExecutionResult,
    ExecutionStatus,
    FileData,
    Language,
)
from .sessions import get_session_manager

logger = logging.getLogger(__name__)


# Image file extensions to auto-capture
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg", ".pdf", ".gif"}

# Matplotlib preamble to auto-save plots
MATPLOTLIB_PREAMBLE = '''
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import os
_plot_counter = [0]
_orig_show = plt.show
def _patched_show(*args, **kwargs):
    _plot_counter[0] += 1
    plt.savefig(f'/workspace/_plot_{_plot_counter[0]}.png', dpi=150, bbox_inches='tight')
plt.show = _patched_show
'''


def _create_tar_bytes(filename: str, content: bytes) -> bytes:
    """Create a tar archive containing a single file."""
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode='w') as tar:
        file_data = io.BytesIO(content)
        info = tarfile.TarInfo(name=filename)
        info.size = len(content)
        tar.addfile(info, file_data)
    tar_buffer.seek(0)
    return tar_buffer.read()


def _extract_tar(tar_bytes: bytes) -> list[tuple[str, bytes]]:
    """Extract files from a tar archive."""
    files = []
    tar_buffer = io.BytesIO(tar_bytes)
    with tarfile.open(fileobj=tar_buffer, mode='r') as tar:
        for member in tar.getmembers():
            if member.isfile():
                f = tar.extractfile(member)
                if f:
                    files.append((member.name, f.read()))
    return files


class Executor:
    """
    Executes code in sandbox containers.
    
    Features:
    - Sync and streaming execution
    - Auto image capture
    - File upload/download
    - Timeout enforcement
    """
    
    def __init__(self):
        self.session_manager = get_session_manager()
    
    def _prepare_code(self, request: ExecutionRequest) -> str:
        """Prepare code for execution, adding preambles as needed."""
        code = request.code
        
        # Add matplotlib preamble for Python
        if request.language == Language.PYTHON:
            if "matplotlib" in code or "plt." in code:
                code = MATPLOTLIB_PREAMBLE + "\n" + code
        
        return code
    
    def _build_command(self, request: ExecutionRequest) -> list[str]:
        """Build the execution command for the given language."""
        if request.language == Language.PYTHON:
            return ["python3", "-c", self._prepare_code(request)]
        elif request.language == Language.NODEJS:
            return ["node", "-e", request.code]
        elif request.language == Language.R:
            return ["Rscript", "-e", request.code]
        elif request.language == Language.BASH:
            return ["bash", "-c", request.code]
        else:
            raise ValueError(f"Unsupported language: {request.language}")
    
    async def _upload_files(self, container: Container, files: list[FileData]):
        """Upload files to container workspace."""
        for f in files:
            tar_data = _create_tar_bytes(f.name, f.to_bytes())
            container.put_archive("/workspace", tar_data)
            logger.debug(f"Uploaded {f.name} to container")
    
    async def _collect_images(self, container: Container) -> list[FileData]:
        """Collect auto-captured images from workspace."""
        images = []
        try:
            # Get workspace contents
            bits, _ = container.get_archive("/workspace/")
            tar_bytes = b"".join(bits)
            
            for name, data in _extract_tar(tar_bytes):
                suffix = Path(name).suffix.lower()
                if suffix in IMAGE_EXTENSIONS:
                    images.append(FileData.from_bytes(Path(name).name, data))
                    logger.debug(f"Captured image: {name}")
                    
        except Exception as e:
            logger.warning(f"Failed to collect images: {e}")
        
        return images
    
    async def execute(
        self,
        session_id: str,
        request: ExecutionRequest,
    ) -> ExecutionResult:
        """
        Execute code in a container (non-streaming).
        """
        job_id = str(uuid.uuid4())[:12]
        start_time = time.monotonic()
        
        try:
            container = await self.session_manager.get_executor(
                session_id, request.language
            )
            
            # Upload input files
            if request.input_files:
                await self._upload_files(container, request.input_files)
            
            # Build and run command
            command = self._build_command(request)
            
            # Run in thread pool to avoid blocking
            def blocking_exec():
                return container.exec_run(
                    command,
                    workdir="/workspace",
                    demux=True,
                )
            
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(blocking_exec),
                    timeout=request.timeout
                )
            except asyncio.TimeoutError:
                return ExecutionResult(
                    job_id=job_id,
                    status=ExecutionStatus.TIMEOUT,
                    stderr=f"Execution timed out after {request.timeout}s",
                    execution_time_ms=int((time.monotonic() - start_time) * 1000),
                )
            
            exit_code = result.exit_code
            stdout_raw, stderr_raw = result.output
            
            stdout = (stdout_raw or b"").decode("utf-8", errors="replace")
            stderr = (stderr_raw or b"").decode("utf-8", errors="replace")
            
            # Collect images
            images = await self._collect_images(container)
            
            execution_time_ms = int((time.monotonic() - start_time) * 1000)
            
            return ExecutionResult(
                job_id=job_id,
                status=ExecutionStatus.COMPLETED,
                exit_code=exit_code,
                stdout=stdout[:1_000_000],
                stderr=stderr[:1_000_000],
                images=images,
                execution_time_ms=execution_time_ms,
            )
            
        except Exception as e:
            logger.exception(f"Execution failed: {e}")
            return ExecutionResult(
                job_id=job_id,
                status=ExecutionStatus.FAILED,
                error=str(e),
                execution_time_ms=int((time.monotonic() - start_time) * 1000),
            )
    
    async def execute_stream(
        self,
        session_id: str,
        request: ExecutionRequest,
    ) -> AsyncIterator[dict]:
        """
        Execute code with streaming output (for SSE).
        """
        job_id = str(uuid.uuid4())[:12]
        start_time = time.monotonic()
        
        try:
            container = await self.session_manager.get_executor(
                session_id, request.language
            )
            
            # Upload input files
            if request.input_files:
                await self._upload_files(container, request.input_files)
            
            command = self._build_command(request)
            
            # Create streaming exec
            def create_exec():
                return container.client.api.exec_create(
                    container.id,
                    command,
                    workdir="/workspace",
                    stdout=True,
                    stderr=True,
                )
            
            exec_id = await asyncio.to_thread(create_exec)
            
            def start_exec():
                return container.client.api.exec_start(
                    exec_id["Id"],
                    stream=True,
                    demux=True,
                )
            
            stream = await asyncio.to_thread(start_exec)
            
            # Stream output — iterate sync generator in thread to avoid blocking
            import queue
            output_queue: queue.Queue = queue.Queue()
            
            def drain_stream():
                try:
                    for stdout, stderr in stream:
                        if stdout:
                            output_queue.put({"stdout": stdout.decode("utf-8", errors="replace")})
                        if stderr:
                            output_queue.put({"stderr": stderr.decode("utf-8", errors="replace")})
                finally:
                    output_queue.put(None)  # Sentinel
            
            # Start drain in background thread
            drain_task = asyncio.get_event_loop().run_in_executor(None, drain_stream)
            
            while True:
                chunk = await asyncio.to_thread(output_queue.get)
                if chunk is None:
                    break
                yield chunk
            
            await drain_task
            
            # Collect images at end
            images = await self._collect_images(container)
            
            yield {
                "done": True,
                "job_id": job_id,
                "images": [img.model_dump() for img in images],
                "execution_time_ms": int((time.monotonic() - start_time) * 1000),
            }
            
        except Exception as e:
            logger.exception(f"Streaming execution failed: {e}")
            yield {"error": str(e), "done": True}


# Singleton
_executor: Optional[Executor] = None

def get_executor() -> Executor:
    global _executor
    if _executor is None:
        _executor = Executor()
    return _executor
