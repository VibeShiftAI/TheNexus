from pathlib import Path

import yaml

from youtube_workflows.llm import strip_thought_blocks, youtube_role_to_model_role


def test_strip_thought_blocks_removes_gemma_thought_channel():
    text = "<|channel>thought\nprivate notes<channel|>\nFinal answer"
    assert strip_thought_blocks(text).strip() == "Final answer"


def test_strip_thought_blocks_handles_channel_whitespace_and_case():
    text = "<|CHANNEL> thought\r\nprivate notes<channel|>\nVisible"
    assert strip_thought_blocks(text).strip() == "Visible"


def test_strip_thought_blocks_removes_xml_think_block():
    text = "<think>private notes</think>\nVisible"
    assert strip_thought_blocks(text).strip() == "Visible"


def test_youtube_roles_use_local_first_registry_roles():
    assert youtube_role_to_model_role("youtube_scriptwriter").value == "youtube_scriptwriter"
    assert youtube_role_to_model_role("youtube_compliance").value == "youtube_compliance"


def test_youtube_writer_roles_are_configured_for_local_provider():
    registry_path = Path(__file__).resolve().parents[3] / "config" / "model_registry.yaml"
    registry = yaml.safe_load(registry_path.read_text())

    for role in ("youtube_strategist", "youtube_scriptwriter"):
        model_id = registry["roles"][role]["model"]
        assert model_id == "local-default"
        assert registry["models"][model_id]["provider"] == "local"
