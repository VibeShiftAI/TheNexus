"""
Tests for the Visual Interpreter — Node B6.

Covers:
  - Triage rules (decorative detection, dimension filtering)
  - Image optimizer (downsampling, RGB conversion)
  - SVG text extraction
  - PDF visual page extraction
  - Main interpret_image pipeline (mocked LLM)
"""

import io
import base64
import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from PIL import Image

from cortex.schemas.state import (
    VisualRequest,
    VisualInterpretation,
    ExtractedEntity,
)
from cortex.agents.visual_interpreter import (
    _triage,
    _optimize,
    _is_base64,
    _get_dimensions,
    _write_to_blackboard,
    extract_svg_text,
    interpret_image,
    interpret_batch,
    extract_pdf_visual_pages,
    MIN_DIMENSION,
    MAX_ASPECT_RATIO,
    MAX_LONG_EDGE,
    DECORATIVE_PATTERNS,
)


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _make_test_image(width=400, height=300, color=(255, 0, 0), mode="RGB") -> str:
    """Create a base64-encoded test image."""
    img = Image.new(mode, (width, height), color=color)
    buffer = io.BytesIO()
    fmt = "PNG" if mode == "RGBA" else "JPEG"
    img.save(buffer, format=fmt)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _make_data_url(b64: str, mime="image/jpeg") -> str:
    return f"data:{mime};base64,{b64}"


# ═══════════════════════════════════════════════════════════════════════════
# Stage 1: Triage
# ═══════════════════════════════════════════════════════════════════════════

class TestTriage:
    """Tests for the zero-cost triage stage."""

    def test_skip_logo_by_filename(self):
        """Images with 'logo' in the URL are decorative."""
        request = VisualRequest(image_source="https://example.com/assets/logo.png")
        result = _triage(request)
        assert result is not None
        assert result.modality == "decorative"

    def test_skip_icon_by_filename(self):
        """Images with 'icon' in the path are decorative."""
        request = VisualRequest(image_source="https://cdn.site.com/icon-search.svg")
        result = _triage(request)
        assert result is not None
        assert result.modality == "decorative"

    def test_skip_by_alt_text(self):
        """Images with decorative alt-text patterns are filtered."""
        request = VisualRequest(
            image_source=_make_data_url(_make_test_image()),
            alt_text="Social media icon"
        )
        result = _triage(request)
        assert result is not None
        assert result.modality == "decorative"

    def test_skip_tiny_image(self):
        """Images below MIN_DIMENSION are decorative."""
        tiny_b64 = _make_test_image(width=50, height=50)
        request = VisualRequest(image_source=_make_data_url(tiny_b64))
        result = _triage(request)
        assert result is not None
        assert result.modality == "decorative"

    def test_skip_extreme_aspect_ratio(self):
        """Extremely elongated images (banners/dividers) are decorative."""
        banner_b64 = _make_test_image(width=2000, height=10)
        request = VisualRequest(image_source=_make_data_url(banner_b64))
        result = _triage(request)
        assert result is not None
        assert result.modality == "decorative"

    def test_passthrough_normal_image(self):
        """Normal-sized images should pass triage (return None)."""
        normal_b64 = _make_test_image(width=800, height=600)
        request = VisualRequest(image_source=_make_data_url(normal_b64))
        result = _triage(request)
        assert result is None  # Proceed to optimize + interpret

    def test_passthrough_url_without_match(self):
        """URLs without decorative patterns should pass triage dimension check."""
        normal_b64 = _make_test_image(width=800, height=600)
        request = VisualRequest(image_source=_make_data_url(normal_b64))
        result = _triage(request)
        assert result is None

    def test_dimension_check_failure_proceeds(self):
        """If dimension check fails, image still proceeds to interpretation."""
        request = VisualRequest(image_source="https://example.com/chart.png")
        # This will fail dimension check (can't fetch URL in test), but should proceed
        with patch("cortex.agents.visual_interpreter._get_dimensions",
                   side_effect=Exception("network error")):
            result = _triage(request)
        assert result is None  # Proceed despite failure

    def test_skip_empty_alt_text(self):
        """Images with empty alt-text (alt='') are decorative."""
        b64 = _make_test_image(width=800, height=600)
        request = VisualRequest(
            image_source=_make_data_url(b64),
            alt_text="",
        )
        result = _triage(request)
        assert result is not None
        assert result.modality == "decorative"

    def test_none_alt_text_passes(self):
        """Images with None alt-text should NOT be triaged as decorative."""
        b64 = _make_test_image(width=800, height=600)
        request = VisualRequest(
            image_source=_make_data_url(b64),
            alt_text=None,
        )
        result = _triage(request)
        assert result is None  # Proceed


# ═══════════════════════════════════════════════════════════════════════════
# Stage 2: Optimizer
# ═══════════════════════════════════════════════════════════════════════════

class TestOptimizer:
    """Tests for the image downsampling / normalization stage."""

    def test_downsample_large_image(self):
        """Images larger than MAX_LONG_EDGE should be downsampled."""
        large_b64 = _make_test_image(width=3000, height=2000)
        result_b64, result_fmt = _optimize(_make_data_url(large_b64))

        # Decode result and check dimensions
        result_bytes = base64.b64decode(result_b64)
        result_img = Image.open(io.BytesIO(result_bytes))
        assert max(result_img.size) <= MAX_LONG_EDGE
        assert result_fmt == "jpeg"

    def test_small_image_unchanged(self):
        """Images smaller than MAX_LONG_EDGE should not be resized."""
        small_b64 = _make_test_image(width=500, height=400)
        result_b64, result_fmt = _optimize(_make_data_url(small_b64))

        result_bytes = base64.b64decode(result_b64)
        result_img = Image.open(io.BytesIO(result_bytes))
        # Should be same dimensions (or very close — JPEG recompression)
        assert result_img.size[0] == 500
        assert result_img.size[1] == 400
        assert result_fmt == "jpeg"

    def test_rgba_converted_to_rgb(self):
        """RGBA images should be converted to RGB."""
        rgba_b64 = _make_test_image(width=400, height=300, mode="RGBA")
        result_b64, _ = _optimize(_make_data_url(rgba_b64, "image/png"))

        result_bytes = base64.b64decode(result_b64)
        result_img = Image.open(io.BytesIO(result_bytes))
        assert result_img.mode == "RGB"

    def test_document_directive_higher_resolution(self):
        """Document directives should use MAX_LONG_EDGE_DOCUMENT."""
        large_b64 = _make_test_image(width=3000, height=2000)
        result_b64, _ = _optimize(
            _make_data_url(large_b64),
            directive="Extract text from this PDF document"
        )

        result_bytes = base64.b64decode(result_b64)
        result_img = Image.open(io.BytesIO(result_bytes))
        # Should use the higher 2048 limit
        assert max(result_img.size) <= 2048
        assert max(result_img.size) > MAX_LONG_EDGE  # Would've been 1024 without directive

    def test_output_is_valid_base64(self):
        """Output should be valid base64 that decodes to a JPEG."""
        b64 = _make_test_image(width=400, height=300)
        result_b64, result_fmt = _optimize(_make_data_url(b64))

        # Should decode without error
        decoded = base64.b64decode(result_b64)
        img = Image.open(io.BytesIO(decoded))
        assert img.format == "JPEG"
        assert result_fmt == "jpeg"

    def test_raw_base64_input(self):
        """Should handle raw base64 string (without data: prefix)."""
        b64 = _make_test_image(width=400, height=300)
        result_b64, _ = _optimize(b64)
        decoded = base64.b64decode(result_b64)
        img = Image.open(io.BytesIO(decoded))
        assert img.format == "JPEG"

    def test_diagram_directive_outputs_png(self):
        """Diagram directives should produce PNG output for sharp edges."""
        b64 = _make_test_image(width=400, height=300)
        result_b64, result_fmt = _optimize(
            _make_data_url(b64),
            directive="Analyze this architecture diagram"
        )
        assert result_fmt == "png"
        decoded = base64.b64decode(result_b64)
        img = Image.open(io.BytesIO(decoded))
        assert img.format == "PNG"

    def test_flowchart_directive_outputs_png(self):
        """Flowchart directives should also produce PNG."""
        b64 = _make_test_image(width=400, height=300)
        _, result_fmt = _optimize(_make_data_url(b64), directive="Read this flowchart")
        assert result_fmt == "png"

    def test_photo_directive_outputs_jpeg(self):
        """Non-diagram directives should produce JPEG."""
        b64 = _make_test_image(width=400, height=300)
        _, result_fmt = _optimize(_make_data_url(b64), directive="Describe this photo")
        assert result_fmt == "jpeg"


# ═══════════════════════════════════════════════════════════════════════════
# Utility Functions
# ═══════════════════════════════════════════════════════════════════════════

class TestUtilities:
    """Tests for helper functions."""

    def test_is_base64_true(self):
        """Long base64-like strings should be detected."""
        b64 = _make_test_image(width=100, height=100)  # Will be > 200 chars
        assert _is_base64(b64) is True

    def test_is_base64_false_for_urls(self):
        """URLs should not be detected as base64."""
        assert _is_base64("https://example.com/image.png") is False

    def test_is_base64_false_for_paths(self):
        """File paths should not be detected as base64."""
        assert _is_base64("/home/user/image.png") is False

    def test_is_base64_false_for_short_strings(self):
        """Short strings should not be detected as base64."""
        assert _is_base64("abc123") is False

    def test_get_dimensions_base64(self):
        """Should get correct dimensions from base64 image."""
        b64 = _make_test_image(width=640, height=480)
        w, h = _get_dimensions(_make_data_url(b64))
        assert w == 640
        assert h == 480

    def test_decorative_patterns_match(self):
        """Known decorative patterns should match."""
        assert DECORATIVE_PATTERNS.search("logo") is not None
        assert DECORATIVE_PATTERNS.search("my-icon.png") is not None
        assert DECORATIVE_PATTERNS.search("tracking-pixel") is not None
        assert DECORATIVE_PATTERNS.search("social-share") is not None

    def test_decorative_patterns_no_false_positives(self):
        """Non-decorative filenames should not match."""
        assert DECORATIVE_PATTERNS.search("revenue-chart.png") is None
        assert DECORATIVE_PATTERNS.search("architecture-diagram.svg") is None
        assert DECORATIVE_PATTERNS.search("screenshot-2024.jpg") is None


# ═══════════════════════════════════════════════════════════════════════════
# SVG Handling
# ═══════════════════════════════════════════════════════════════════════════

class TestSVGExtraction:
    """Tests for SVG text extraction."""

    def test_extract_text_from_svg(self):
        """Should extract text nodes from SVG content."""
        svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
            <text x="10" y="20">Hello World</text>
            <text x="10" y="40">Second Line</text>
        </svg>'''
        result = extract_svg_text(svg)
        assert result is not None
        assert "Hello World" in result
        assert "Second Line" in result

    def test_extract_tspan_text(self):
        """Should also extract text from <tspan> elements."""
        svg = '''<svg xmlns="http://www.w3.org/2000/svg">
            <text><tspan>Label One</tspan><tspan>Label Two</tspan></text>
        </svg>'''
        result = extract_svg_text(svg)
        assert result is not None
        assert "Label One" in result
        assert "Label Two" in result

    def test_no_text_returns_none(self):
        """SVGs without text elements should return None."""
        svg = '''<svg xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="40"/>
        </svg>'''
        result = extract_svg_text(svg)
        assert result is None

    def test_invalid_xml_returns_none(self):
        """Invalid XML should return None (not raise)."""
        result = extract_svg_text("not valid xml at all <><>123")
        assert result is None

    def test_empty_text_nodes_ignored(self):
        """Text nodes with only whitespace should be ignored."""
        svg = '''<svg xmlns="http://www.w3.org/2000/svg">
            <text>   </text>
            <text>Actual Content</text>
        </svg>'''
        result = extract_svg_text(svg)
        assert result is not None
        assert "Actual Content" in result


# ═══════════════════════════════════════════════════════════════════════════
# Main Pipeline (LLM mocked)
# ═══════════════════════════════════════════════════════════════════════════

class TestInterpretImage:
    """Tests for the main interpret_image pipeline."""

    @pytest.mark.asyncio
    async def test_decorative_image_skips_llm(self):
        """Triage-decorative images should never reach the LLM."""
        request = VisualRequest(
            image_source="https://example.com/assets/logo-small.png",
            alt_text="Company logo"
        )
        result = await interpret_image(request)
        assert result.modality == "decorative"
        assert result.confidence == 1.0

    @pytest.mark.asyncio
    async def test_normal_image_calls_llm(self):
        """Normal images should flow through optimize and interpret stages."""
        test_b64 = _make_test_image(width=800, height=600)
        mock_interpretation = VisualInterpretation(
            modality="chart",
            description="A bar chart showing quarterly revenue",
            entities=[
                ExtractedEntity(
                    source_node="Q1 Revenue",
                    relationship="increased to",
                    target_node="$2.5M"
                )
            ],
            confidence=0.85,
        )

        with patch("cortex.agents.visual_interpreter._interpret",
                   new_callable=AsyncMock, return_value=mock_interpretation):
            result = await interpret_image(VisualRequest(
                image_source=_make_data_url(test_b64),
                directive="Analyze this chart",
            ))

        assert result.modality == "chart"
        assert result.confidence == 0.85
        assert len(result.entities) == 1
        assert result.entities[0].source_node == "Q1 Revenue"

    @pytest.mark.asyncio
    async def test_optimize_failure_returns_unknown(self):
        """If optimization fails, should return unknown with error."""
        with patch("cortex.agents.visual_interpreter._optimize",
                   side_effect=Exception("corrupt image")):
            result = await interpret_image(VisualRequest(
                image_source="https://example.com/corrupt.png",
            ))

        assert result.modality == "unknown"
        assert "corrupt image" in result.description
        assert result.confidence == 0.0

    @pytest.mark.asyncio
    async def test_interpret_failure_returns_unknown(self):
        """If LLM interpretation fails, should return unknown with error."""
        test_b64 = _make_test_image(width=800, height=600)

        with patch("cortex.agents.visual_interpreter._interpret",
                   new_callable=AsyncMock,
                   side_effect=Exception("LLM timeout")):
            result = await interpret_image(VisualRequest(
                image_source=_make_data_url(test_b64),
            ))

        assert result.modality == "unknown"
        assert "LLM timeout" in result.description


class TestInterpretBatch:
    """Tests for batch image processing."""

    @pytest.mark.asyncio
    async def test_batch_processes_all(self):
        """Batch should process all images sequentially."""
        test_b64 = _make_test_image(width=800, height=600)
        mock_result = VisualInterpretation(
            modality="diagram",
            description="Architecture diagram",
            confidence=0.9,
        )

        requests = [
            VisualRequest(
                image_source=_make_data_url(test_b64),
                directive=f"Analyze image {i}"
            )
            for i in range(3)
        ]

        with patch("cortex.agents.visual_interpreter._interpret",
                   new_callable=AsyncMock, return_value=mock_result):
            results = await interpret_batch(requests)

        assert len(results) == 3
        assert all(r.modality == "diagram" for r in results)

    @pytest.mark.asyncio
    async def test_batch_includes_triage_skips(self):
        """Batch should correctly triage decorative images."""
        normal_b64 = _make_test_image(width=800, height=600)
        mock_result = VisualInterpretation(
            modality="screenshot",
            description="Dashboard screenshot",
            confidence=0.8,
        )

        requests = [
            VisualRequest(
                image_source="https://example.com/logo.png",
                alt_text="Site logo",
            ),
            VisualRequest(
                image_source=_make_data_url(normal_b64),
                directive="Analyze this screenshot",
            ),
        ]

        with patch("cortex.agents.visual_interpreter._interpret",
                   new_callable=AsyncMock, return_value=mock_result):
            results = await interpret_batch(requests)

        assert len(results) == 2
        assert results[0].modality == "decorative"  # Logo skipped
        assert results[1].modality == "screenshot"   # Normal processed


# ═══════════════════════════════════════════════════════════════════════════
# Schema Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestSchemas:
    """Tests for B6 Pydantic schemas."""

    def test_visual_request_defaults(self):
        """VisualRequest should have sensible defaults."""
        req = VisualRequest()
        assert req.image_source == ""
        assert req.directive == "Analyze this image and extract key insights."
        assert req.surrounding_context is None
        assert req.alt_text is None

    def test_visual_interpretation_defaults(self):
        """VisualInterpretation should have sensible defaults."""
        interp = VisualInterpretation()
        assert interp.modality == "unknown"
        assert interp.description == ""
        assert interp.entities == []
        assert interp.confidence == 0.0
        assert interp.token_footprint == 0

    def test_extracted_entity_creation(self):
        """ExtractedEntity should accept relationship triplets."""
        entity = ExtractedEntity(
            source_node="Database",
            relationship="connects to",
            target_node="API Server",
        )
        assert entity.source_node == "Database"
        assert entity.relationship == "connects to"
        assert entity.target_node == "API Server"

    def test_visual_interpretation_modality_literals(self):
        """Modality should accept all valid literal values."""
        for modality in ["photo", "chart", "diagram", "screenshot",
                         "document", "decorative", "unknown"]:
            interp = VisualInterpretation(modality=modality)
            assert interp.modality == modality


# ═══════════════════════════════════════════════════════════════════════════
# Blackboard Integration
# ═══════════════════════════════════════════════════════════════════════════

class TestBlackboardWrite:
    """Tests for _write_to_blackboard."""

    def test_no_session_id_skips(self):
        """Without session_id, write should be silently skipped."""
        results = [VisualInterpretation(modality="chart", description="test")]
        # Should not raise
        _write_to_blackboard(results, session_id="")

    def test_all_decorative_skips(self):
        """If all results are decorative, no Blackboard write."""
        results = [
            VisualInterpretation(modality="decorative"),
            VisualInterpretation(modality="decorative"),
        ]
        mock_bb_instance = MagicMock()
        mock_bb_class = MagicMock(return_value=mock_bb_instance)
        with patch.dict("sys.modules", {
            "cortex.blackboard": MagicMock(ResearchBlackboard=mock_bb_class),
            "cortex.blackboard": MagicMock(ResearchBlackboard=mock_bb_class),
        }):
            _write_to_blackboard(results, session_id="test-session")
            mock_bb_instance.append_step.assert_not_called()

    def test_writes_meaningful_results(self):
        """Meaningful results should be written to Blackboard."""
        results = [
            VisualInterpretation(modality="decorative"),
            VisualInterpretation(
                modality="chart",
                description="Revenue growth chart",
                entities=[ExtractedEntity(
                    source_node="Q1",
                    relationship="grew to",
                    target_node="$2M",
                )],
                confidence=0.9,
                token_footprint=150,
            ),
        ]
        mock_bb_instance = MagicMock()
        mock_bb_class = MagicMock(return_value=mock_bb_instance)
        with patch.dict("sys.modules", {
            "cortex.blackboard": MagicMock(ResearchBlackboard=mock_bb_class),
            "cortex.blackboard": MagicMock(ResearchBlackboard=mock_bb_class),
        }):
            _write_to_blackboard(results, session_id="test-session")
            mock_bb_instance.append_step.assert_called_once()
            call_kwargs = mock_bb_instance.append_step.call_args
            assert "visual_interpreter" in str(call_kwargs)


# ═══════════════════════════════════════════════════════════════════════════
# Batch Parallelism
# ═══════════════════════════════════════════════════════════════════════════

class TestBatchParallelism:
    """Tests for async batch processing."""

    @pytest.mark.asyncio
    async def test_empty_batch_returns_empty(self):
        """Empty batch should return empty list without errors."""
        results = await interpret_batch([])
        assert results == []

    @pytest.mark.asyncio
    async def test_batch_exception_handling(self):
        """Individual failures in a batch should not crash the whole batch."""
        test_b64 = _make_test_image(width=800, height=600)

        call_count = 0
        async def flaky_interpret(image_b64, image_fmt, request):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise Exception("transient failure")
            return VisualInterpretation(
                modality="chart",
                description="success",
                confidence=0.9,
            )

        requests = [
            VisualRequest(image_source=_make_data_url(test_b64)),
            VisualRequest(image_source=_make_data_url(test_b64)),
            VisualRequest(image_source=_make_data_url(test_b64)),
        ]

        with patch("cortex.agents.visual_interpreter._interpret",
                   side_effect=flaky_interpret):
            results = await interpret_batch(requests)

        assert len(results) == 3
        assert results[0].modality == "chart"
        assert results[1].modality == "unknown"  # Failed, converted to error
        assert "transient failure" in results[1].description
        assert results[2].modality == "chart"


# ═══════════════════════════════════════════════════════════════════════════
# B2 ↔ B6 Integration (browser.py)
# ═══════════════════════════════════════════════════════════════════════════

class TestBrowserIntegration:
    """Tests for the B2 browser agent's visual processing integration."""

    def test_extract_images_markdown_syntax(self):
        """Should extract images from Markdown ![alt](url) syntax."""
        from cortex.agents.browser import _extract_images_from_content

        content = 'Check the chart below:\n![Revenue chart](https://example.com/chart.png)\nMore text.'
        requests = _extract_images_from_content(content, "https://example.com")
        assert len(requests) == 1
        assert requests[0].image_source == "https://example.com/chart.png"
        assert requests[0].alt_text == "Revenue chart"

    def test_extract_images_html_img_tag(self):
        """Should extract images from HTML <img> tags."""
        from cortex.agents.browser import _extract_images_from_content

        content = '<p>Look at this:</p><img src="https://cdn.site.com/diagram.jpg" alt="Arch diagram"/>'
        requests = _extract_images_from_content(content, "https://example.com")
        assert len(requests) == 1
        assert requests[0].image_source == "https://cdn.site.com/diagram.jpg"

    def test_extract_images_no_images(self):
        """Content with no images should return empty list."""
        from cortex.agents.browser import _extract_images_from_content

        content = 'Just plain text with no images at all.'
        requests = _extract_images_from_content(content, "https://example.com")
        assert len(requests) == 0

    @pytest.mark.asyncio
    async def test_process_visuals_no_images_passthrough(self):
        """Content without images should pass through unchanged."""
        from cortex.agents.browser import _process_visuals

        content = "Plain text content with no images."
        result = await _process_visuals(content, "https://example.com")
        assert result == content

    @pytest.mark.asyncio
    async def test_process_visuals_injects_insights(self):
        """Visual insights should be appended to content."""
        from cortex.agents.browser import _process_visuals

        content = 'Some text ![chart](https://example.com/chart.png) more text'

        mock_result = VisualInterpretation(
            modality="chart",
            description="Revenue growth Q1-Q4",
            confidence=0.85,
        )
        mock_batch = AsyncMock(return_value=[mock_result])
        mock_bb = MagicMock()

        with patch("cortex.agents.visual_interpreter.interpret_batch", mock_batch):
            with patch("cortex.agents.visual_interpreter._write_to_blackboard", mock_bb):
                result = await _process_visuals(content, "https://example.com")

        assert "[!VISUAL_INSIGHT: chart]" in result
        assert "Revenue growth Q1-Q4" in result
        assert "--- Visual Analysis ---" in result

    @pytest.mark.asyncio
    async def test_process_visuals_skips_decorative(self):
        """Decorative results should NOT appear in injected insights."""
        from cortex.agents.browser import _process_visuals

        content = 'Text ![logo](https://example.com/logo.png) end'

        mock_result = VisualInterpretation(
            modality="decorative",
            description="",
            confidence=1.0,
        )
        mock_batch = AsyncMock(return_value=[mock_result])
        mock_bb = MagicMock()

        with patch("cortex.agents.visual_interpreter.interpret_batch", mock_batch):
            with patch("cortex.agents.visual_interpreter._write_to_blackboard", mock_bb):
                result = await _process_visuals(content, "https://example.com")

        assert "[!VISUAL_INSIGHT" not in result
        assert "--- Visual Analysis ---" not in result

    @pytest.mark.asyncio
    async def test_process_visuals_graceful_on_import_failure(self):
        """If B6 fails, content should pass through unchanged."""
        from cortex.agents.browser import _process_visuals

        content = 'Text ![img](https://example.com/img.png) end'

        mock_batch = AsyncMock(side_effect=Exception("module not found"))
        mock_bb = MagicMock()

        with patch("cortex.agents.visual_interpreter.interpret_batch", mock_batch):
            with patch("cortex.agents.visual_interpreter._write_to_blackboard", mock_bb):
                result = await _process_visuals(content, "https://example.com")

        # Should return original content on failure
        assert result == content
