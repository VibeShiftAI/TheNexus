"""
Unit tests for HashtagManager.

Tests cover:
- Bidirectional normalization (entity → hashtag, hashtag → search term)
- Manifest persistence (load/save)
- extract_hashtags() from text
- validate_hashtags() against manifest
- register_hashtag() manual registration
- get_node_id() lookup
- get_search_terms() batch conversion
"""
import json
import pytest
from pathlib import Path

from cortex.blackboard.hashtag_manager import (
    HashtagManager,
    _normalize_to_hashtag,
    _hashtag_to_search_term,
)


# ────────────────────────────────────────────────────────────
# Normalization Functions
# ────────────────────────────────────────────────────────────

class TestNormalization:
    """Bidirectional normalization helpers."""

    def test_normalize_entity_with_spaces(self):
        assert _normalize_to_hashtag("Entity Extraction") == "#entity_extraction"

    def test_normalize_entity_with_mixed_case(self):
        assert _normalize_to_hashtag("Neo4j Database") == "#neo4j_database"

    def test_normalize_acronym(self):
        assert _normalize_to_hashtag("LLM") == "#llm"

    def test_normalize_with_special_chars(self):
        assert _normalize_to_hashtag("Hello-World!") == "#hello_world"

    def test_hashtag_to_search_simple(self):
        assert _hashtag_to_search_term("#entity_extraction") == "entity extraction"

    def test_hashtag_to_search_single_word(self):
        assert _hashtag_to_search_term("#llm") == "llm"

    def test_roundtrip_entity(self):
        """Entity → hashtag → search term should produce searchable form."""
        original = "Knowledge Graph"
        hashtag = _normalize_to_hashtag(original)
        search = _hashtag_to_search_term(hashtag)
        assert search == "knowledge graph"


# ────────────────────────────────────────────────────────────
# Manifest Persistence
# ────────────────────────────────────────────────────────────

class TestManifest:
    """Loading and saving the hashtags.json manifest."""

    def test_create_manifest(self, tmp_path):
        """New manifest is created on first save."""
        path = tmp_path / "hashtags.json"
        mgr = HashtagManager(manifest_path=path)
        mgr.register_hashtag("#test", "uuid-123", "Test Entity")

        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert "#test" in data["hashtags"]

    def test_load_existing_manifest(self, tmp_path):
        """Existing manifest is loaded on init."""
        path = tmp_path / "hashtags.json"
        data = {
            "hashtags": {
                "#foo": {"node_id": "id1", "entity_name": "Foo", "last_synced": "2025-01-01"}
            },
            "count": 1,
        }
        path.write_text(json.dumps(data), encoding="utf-8")

        mgr = HashtagManager(manifest_path=path)
        assert "#foo" in mgr.available_hashtags
        assert mgr.count == 1

    def test_empty_init(self, tmp_path):
        """No manifest file starts with empty mappings."""
        path = tmp_path / "nonexistent.json"
        mgr = HashtagManager(manifest_path=path)
        assert mgr.count == 0


# ────────────────────────────────────────────────────────────
# Extraction & Validation
# ────────────────────────────────────────────────────────────

class TestExtraction:
    """Extracting and validating hashtags from text."""

    def test_extract_from_text(self, tmp_path):
        mgr = HashtagManager(manifest_path=tmp_path / "h.json")
        tags = mgr.extract_hashtags("Use #entity_extraction and #neo4j")
        assert "#entity_extraction" in tags
        assert "#neo4j" in tags

    def test_extract_deduplicates(self, tmp_path):
        mgr = HashtagManager(manifest_path=tmp_path / "h.json")
        tags = mgr.extract_hashtags("#foo #bar #foo")
        assert len(tags) == 2

    def test_validate_known_tags(self, tmp_path):
        mgr = HashtagManager(manifest_path=tmp_path / "h.json")
        mgr.register_hashtag("#known", "id1")
        result = mgr.validate_hashtags(["#known", "#unknown"])
        assert result["#known"] is True
        assert result["#unknown"] is False


# ────────────────────────────────────────────────────────────
# Registration & Lookup
# ────────────────────────────────────────────────────────────

class TestRegistration:
    """Manual hashtag registration and node ID lookup."""

    def test_register_and_lookup(self, tmp_path):
        mgr = HashtagManager(manifest_path=tmp_path / "h.json")
        mgr.register_hashtag("#test_entity", "uuid-456", "Test Entity")

        assert mgr.get_node_id("#test_entity") == "uuid-456"

    def test_lookup_missing_returns_none(self, tmp_path):
        mgr = HashtagManager(manifest_path=tmp_path / "h.json")
        assert mgr.get_node_id("#nonexistent") is None

    def test_get_search_terms(self, tmp_path):
        mgr = HashtagManager(manifest_path=tmp_path / "h.json")
        terms = mgr.get_search_terms(["#entity_extraction", "#neo4j_database"])
        assert terms == ["entity extraction", "neo4j database"]
