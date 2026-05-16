import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from youtube_workflows.llm import strip_thought_blocks, youtube_role_to_model_role


def test_strip_thought_blocks_removes_gemma_thought_channel():
    text = "<|channel>thought\nprivate notes<channel|>\nFinal answer"
    assert strip_thought_blocks(text).strip() == "Final answer"


def test_strip_thought_blocks_removes_xml_think_block():
    text = "<think>private notes</think>\nVisible"
    assert strip_thought_blocks(text).strip() == "Visible"


def test_youtube_roles_use_local_first_registry_roles():
    assert youtube_role_to_model_role("youtube_scriptwriter").value == "youtube_scriptwriter"
    assert youtube_role_to_model_role("youtube_compliance").value == "youtube_compliance"
