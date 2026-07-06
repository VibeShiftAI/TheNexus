"""
Visual Interpreter — Node B6 (The Lens).

Phase 25: Multi-modal perception node that translates images into
structured text, data, and entity triplets for the Blackboard and
Graph RAG.

Four-stage pipeline:
  1. Fast Triage  — deterministic rules, zero LLM cost
  2. Optimizer    — Pillow downsample + RGB normalization
  3. Interpreter  — VLM structured output via LLMFactory

B6 is an on-demand worker invoked by B2 (Browser Agent) — it is NOT
a node in the LangGraph StateGraph.
"""

import asyncio
import io
import re
import base64
import logging
from typing import Optional, List, Tuple
from urllib.parse import urlparse

from langchain_core.messages import SystemMessage, HumanMessage

from cortex.llm_factory import LLMFactory, ModelRole
from cortex.schemas.state import (
    VisualRequest,
    VisualInterpretation,
    ExtractedEntity,
)

logger = logging.getLogger("VisualInterpreter")

llm_factory = LLMFactory()

# ─── Triage Rules ────────────────────────────────────────────────────────

# Minimum pixel dimensions — smaller images are likely icons/trackers
MIN_DIMENSION = 150

# Max aspect ratio — extremely elongated images are UI dividers/banners
MAX_ASPECT_RATIO = 10.0

# Filename / alt-text patterns that signal decorative content
DECORATIVE_PATTERNS = re.compile(
    r"(logo|icon|spacer|badge|sponsor|avatar|button|arrow|divider|"
    r"separator|caret|chevron|social|tracking|pixel)",
    re.IGNORECASE,
)


# ─── System Prompt ───────────────────────────────────────────────────────

INTERPRET_SYSTEM = """You are B6, the visual perception node for an autonomous text-based AI.
Your role is to translate visual pixels into structured, high-density text and data.

CONTEXT FROM PAGE: {surrounding_context}
DIRECTIVE: {directive}

Instructions by Modality:

- Decorative/Photo: If the image adds no concrete informational value
  (stock photo, generic graphic), set modality to "decorative",
  leave description blank, and exit.

- Charts/Graphs: Extract X/Y axis labels, overall trend, and read
  data points into a structured JSON table in extracted_data. State
  if exact numbers are illegible.

- Diagrams: Identify every architectural or flow component. Output
  the relationships as [Source, Relation, Target] triplets in entities.

- Screenshots/Documents: Extract semantic intent and key text blocks
  via OCR. Ignore boilerplate UI navigation (menus, footers).

Always set 'confidence' to reflect how certain you are (0.0 = guessing, 1.0 = definitive).
"""


# ═══════════════════════════════════════════════════════════════════════════
# Stage 1: Fast Triage (Zero Token Cost)
# ═══════════════════════════════════════════════════════════════════════════

def _triage(request: VisualRequest) -> Optional[VisualInterpretation]:
    """
    Apply deterministic rules to skip decorative images without any LLM call.

    Returns a VisualInterpretation with modality='decorative' if the image
    should be skipped, or None if it should proceed to interpretation.
    """
    decorative = VisualInterpretation(
        modality="decorative",
        description="",
        confidence=1.0,
    )

    # ── Rule 1: Semantic filename / alt-text ──
    source_path = urlparse(request.image_source).path if "://" in request.image_source else request.image_source
    if DECORATIVE_PATTERNS.search(source_path):
        logger.debug(f"Triage SKIP (filename): {source_path}")
        return decorative

    if request.alt_text is not None:
        if request.alt_text.strip() == "":
            logger.debug("Triage SKIP (empty alt-text)")
            return decorative
        if DECORATIVE_PATTERNS.search(request.alt_text):
            logger.debug(f"Triage SKIP (alt-text): {request.alt_text}")
            return decorative

    # ── Rule 2: Dimensions (requires loading image headers) ──
    try:
        width, height = _get_dimensions(request.image_source)

        if width < MIN_DIMENSION or height < MIN_DIMENSION:
            logger.debug(f"Triage SKIP (tiny {width}x{height})")
            return decorative

        ratio = max(width, height) / max(min(width, height), 1)
        if ratio > MAX_ASPECT_RATIO:
            logger.debug(f"Triage SKIP (extreme ratio {ratio:.1f}:1)")
            return decorative

    except Exception as e:
        # If we can't read dimensions, proceed anyway — let the LLM decide
        logger.debug(f"Triage: could not read dimensions: {e}")

    return None  # Proceed to optimization + interpretation


def _get_dimensions(image_source: str) -> Tuple[int, int]:
    """Get image dimensions without decoding the full image."""
    from PIL import Image

    if image_source.startswith("data:") or _is_base64(image_source):
        raw = image_source
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        img_bytes = base64.b64decode(raw)
        img = Image.open(io.BytesIO(img_bytes))
    elif "://" in image_source:
        import requests
        resp = requests.get(image_source, stream=True, timeout=10)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content))
    else:
        img = Image.open(image_source)

    return img.size  # (width, height)


def _is_base64(s: str) -> bool:
    """Check if a string looks like base64-encoded data."""
    if len(s) < 200:
        return False
    # Exclude obvious URIs and filesystem paths (but not /9j/ JPEG headers)
    if s.startswith(("http://", "https://", "./", "../")):
        return False
    # Exclude Windows/Unix absolute paths (C:\, /home/, etc.) but not base64
    if len(s) < 500 and (s[1:3] == ":\\" or s.startswith("/home") or s.startswith("/tmp")):
        return False
    try:
        base64.b64decode(s[:100], validate=True)
        return True
    except Exception:
        pass
    return False


# ═══════════════════════════════════════════════════════════════════════════
# Stage 2: Image Optimizer (Downsampling)
# ═══════════════════════════════════════════════════════════════════════════

MAX_LONG_EDGE = 1024
MAX_LONG_EDGE_DOCUMENT = 2048


def _optimize(image_source: str, directive: Optional[str] = None) -> str:
    """
    Downsample and normalize an image for VLM consumption.

    Returns a base64-encoded JPEG string ready for the LLM API.
    Token cost reduction: ~60-80% vs raw images.
    """
    from PIL import Image

    # Load the image
    if image_source.startswith("data:") or _is_base64(image_source):
        raw = image_source
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        img_bytes = base64.b64decode(raw)
        img = Image.open(io.BytesIO(img_bytes))
    elif "://" in image_source:
        import requests
        resp = requests.get(image_source, stream=True, timeout=15)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content))
    else:
        img = Image.open(image_source)

    # Convert to RGB (strip alpha channel — VLMs don't handle it well)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGB")

    # Determine max edge based on directive
    is_document = directive and any(
        kw in directive.lower() for kw in ["document", "ocr", "text", "pdf"]
    )
    max_edge = MAX_LONG_EDGE_DOCUMENT if is_document else MAX_LONG_EDGE

    # Resize if needed (maintain aspect ratio)
    w, h = img.size
    long_edge = max(w, h)
    if long_edge > max_edge:
        scale = max_edge / long_edge
        new_size = (int(w * scale), int(h * scale))
        img = img.resize(new_size, Image.LANCZOS)
        logger.debug(f"Resized {w}x{h} -> {img.size[0]}x{img.size[1]}")

    # Choose format: PNG for diagrams (sharp edges), JPEG for everything else
    is_diagram = directive and any(
        kw in directive.lower() for kw in ["diagram", "architecture", "flowchart", "wireframe", "schematic"]
    )
    fmt = "PNG" if is_diagram else "JPEG"

    buffer = io.BytesIO()
    if fmt == "JPEG":
        img.save(buffer, format="JPEG", quality=85)
    else:
        img.save(buffer, format="PNG")
    b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return b64, fmt.lower()


# ═══════════════════════════════════════════════════════════════════════════
# Stage 3: LLM Interpretation
# ═══════════════════════════════════════════════════════════════════════════

async def _interpret(image_b64: str, image_fmt: str, request: VisualRequest) -> VisualInterpretation:
    """
    Send the optimized image to a vision-capable LLM for structured analysis.
    """
    model = llm_factory.get_model(ModelRole.VISUAL_INTERPRETER)
    structured = model.with_structured_output(VisualInterpretation)

    context = request.surrounding_context or "(no surrounding context)"
    directive = request.directive or "Analyze this image and extract key insights."

    prompt = INTERPRET_SYSTEM.format(
        surrounding_context=context,
        directive=directive,
    )

    mime = f"image/{image_fmt}"
    messages = [
        SystemMessage(content=prompt),
        HumanMessage(content=[
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{image_b64}"},
            },
            {
                "type": "text",
                "text": directive,
            },
        ]),
    ]

    result = await structured.ainvoke(messages)

    # Estimate token footprint (rough: 1 tile ~ 85 tokens, plus output)
    desc_tokens = len(result.description.split()) * 2  # rough word->token
    entity_tokens = len(result.entities) * 20
    result.token_footprint = desc_tokens + entity_tokens + 100  # base overhead

    return result


# ═══════════════════════════════════════════════════════════════════════════
# PDF Support (via PyMuPDF)
# ═══════════════════════════════════════════════════════════════════════════

MAX_PDF_PAGES_TO_VISION = 5


def extract_pdf_visual_pages(
    pdf_path_or_bytes: str | bytes,
    max_pages: int = MAX_PDF_PAGES_TO_VISION,
) -> List[VisualRequest]:
    """
    Extract pages from a PDF that need vision interpretation.

    Strategy:
      1. Run PyMuPDF text extraction first
      2. Only send pages with large graphical bounding boxes or
         no machine-readable text (scans) to B6
      3. Cap at max_pages to protect token budget

    Returns a list of VisualRequests (one per qualifying page).
    """
    import fitz  # PyMuPDF

    if isinstance(pdf_path_or_bytes, str):
        doc = fitz.open(pdf_path_or_bytes)
    else:
        doc = fitz.open(stream=pdf_path_or_bytes, filetype="pdf")

    visual_requests: List[VisualRequest] = []

    for page_num in range(len(doc)):
        if len(visual_requests) >= max_pages:
            break

        page = doc[page_num]
        text = page.get_text("text").strip()
        images = page.get_images(full=True)

        # Heuristic: page needs vision if it has images but little text,
        # or if it has large image bounding boxes
        has_significant_images = len(images) > 0
        is_text_sparse = len(text) < 100  # Likely a scan or diagram page

        if has_significant_images and is_text_sparse:
            # Render page as image
            mat = fitz.Matrix(2.0, 2.0)  # 2x zoom for readability
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("jpeg")
            img_b64 = base64.b64encode(img_bytes).decode("utf-8")

            visual_requests.append(VisualRequest(
                image_source=f"data:image/jpeg;base64,{img_b64}",
                directive=f"Analyze page {page_num + 1} of this PDF document.",
                surrounding_context=text[:500] if text else None,
                alt_text=f"PDF page {page_num + 1}",
            ))
            logger.info(f"PDF page {page_num + 1}: queued for vision (sparse text, has images)")
        elif is_text_sparse and not has_significant_images:
            # Possibly a scanned page with no embedded images — render it
            mat = fitz.Matrix(2.0, 2.0)
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("jpeg")
            img_b64 = base64.b64encode(img_bytes).decode("utf-8")

            visual_requests.append(VisualRequest(
                image_source=f"data:image/jpeg;base64,{img_b64}",
                directive=f"OCR and analyze page {page_num + 1} of this scanned document.",
                surrounding_context=None,
                alt_text=f"Scanned PDF page {page_num + 1}",
            ))
            logger.info(f"PDF page {page_num + 1}: queued for OCR (scanned page)")
        else:
            logger.debug(f"PDF page {page_num + 1}: skipped (has machine-readable text)")

    doc.close()
    return visual_requests


# ═══════════════════════════════════════════════════════════════════════════
# SVG Handling
# ═══════════════════════════════════════════════════════════════════════════

def extract_svg_text(svg_content: str) -> Optional[str]:
    """
    Extract text nodes from SVG XML without rasterizing.

    SVGs are vector math — sending them to a vision model is wasteful.
    Extract <text> elements and pass to a standard text LLM instead.

    Returns extracted text, or None if SVG has no text nodes.
    """
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(svg_content)
    except ET.ParseError:
        return None

    texts = []
    # Find all <text> elements (with or without namespace)
    for text_el in root.iter():
        tag = text_el.tag
        if isinstance(tag, str) and (tag.endswith("text") or tag.endswith("tspan")):
            if text_el.text and text_el.text.strip():
                texts.append(text_el.text.strip())

    if not texts:
        return None

    return " | ".join(texts)


# ═══════════════════════════════════════════════════════════════════════════
# Main API
# ═══════════════════════════════════════════════════════════════════════════

async def interpret_image(request: VisualRequest) -> VisualInterpretation:
    """
    Main entry point for B6 Visual Interpreter.

    Runs the three-stage pipeline: Triage -> Optimize -> Interpret.

    Args:
        request: A VisualRequest with image source and optional context.

    Returns:
        VisualInterpretation with structured analysis.
    """
    logger.info(f"[B6] Processing image: {request.image_source[:80]}...")

    # ── Stage 1: Triage ──
    triage_result = _triage(request)
    if triage_result is not None:
        logger.info("[B6] Triage: DECORATIVE -> skipped")
        return triage_result

    # ── Stage 2: Optimize ──
    try:
        image_b64, image_fmt = _optimize(request.image_source, request.directive)
    except Exception as e:
        logger.error(f"[B6] Optimization failed: {e}")
        return VisualInterpretation(
            modality="unknown",
            description=f"Image optimization failed: {e}",
            confidence=0.0,
        )

    # ── Stage 3: Interpret ──
    try:
        result = await _interpret(image_b64, image_fmt, request)
        logger.info(
            f"[B6] Interpreted as '{result.modality}' "
            f"(confidence={result.confidence:.2f}, entities={len(result.entities)})"
        )
        return result
    except Exception as e:
        logger.error(f"[B6] Interpretation failed: {e}")
        return VisualInterpretation(
            modality="unknown",
            description=f"LLM interpretation failed: {e}",
            confidence=0.0,
        )


async def interpret_batch(requests: List[VisualRequest]) -> List[VisualInterpretation]:
    """
    Process a batch of images in parallel. Used by B2 when a page has
    multiple images.

    Uses asyncio.gather for concurrent processing — triage runs
    synchronously per-image, but LLM calls run in parallel.
    """
    if not requests:
        return []

    logger.info(f"[B6] Batch processing {len(requests)} images")
    results = await asyncio.gather(
        *(interpret_image(req) for req in requests),
        return_exceptions=True,
    )

    # Convert exceptions to error interpretations
    final = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error(f"[B6] Batch item {i+1} failed: {result}")
            final.append(VisualInterpretation(
                modality="unknown",
                description=f"Batch processing failed: {result}",
                confidence=0.0,
            ))
        else:
            final.append(result)
    return final


# ═══════════════════════════════════════════════════════════════════════════
# Blackboard Integration
# ═══════════════════════════════════════════════════════════════════════════

def _write_to_blackboard(
    results: List[VisualInterpretation],
    session_id: str,
) -> None:
    """
    Write visual interpretation results to the Research Blackboard.

    Creates a structured audit trail of what B6 saw, matching the
    pattern used by all other Cortex agents.
    """
    if not session_id:
        logger.debug("[B6] No session_id — skipping Blackboard write")
        return

    try:
        from cortex.blackboard import ResearchBlackboard
    except ImportError:
        from cortex.blackboard import ResearchBlackboard

    try:
        bb = ResearchBlackboard(session_id)

        # Filter out decorative results
        meaningful = [r for r in results if r.modality != "decorative"]
        if not meaningful:
            return

        md = "## 👁️ Visual Interpreter (B6) — Findings\n\n"
        md += f"**Images Analyzed**: {len(results)} total, "
        md += f"{len(meaningful)} informational, "
        md += f"{len(results) - len(meaningful)} decorative (skipped)\n\n"

        for i, result in enumerate(meaningful, 1):
            md += f"### Visual {i}: {result.modality.title()}\n\n"
            md += f"{result.description}\n\n"
            if result.entities:
                md += "**Entities:**\n"
                for e in result.entities:
                    md += f"- {e.source_node} → {e.relationship} → {e.target_node}\n"
                md += "\n"
            md += f"*Confidence: {result.confidence:.0%} | "
            md += f"Tokens: ~{result.token_footprint}*\n\n"

        bb.append_step(agent_id="visual_interpreter", content=md)
        logger.info(f"[B6] Blackboard: wrote {len(meaningful)} visual findings")
    except Exception as e:
        logger.warning(f"[B6] Blackboard write failed (non-blocking): {e}")
