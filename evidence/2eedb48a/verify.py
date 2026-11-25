"""Read back the registered design revision and compare it to the local exports."""
import hashlib
import io
import itertools
import json
from pathlib import Path
from urllib.request import urlopen

from PIL import Image

here = Path(__file__).resolve().parent
folder = here.parents[1] / "docs/design/2026-11-25-decision-other-and-chat"
manifest_file = folder / "decision-other-and-chat.design.json"
document_id = "6a4aa9d6-9975-484e-8011-5383067859f4"
revision_id = "bed3270e-9360-4823-915b-da1d642499f7"
url = "http://127.0.0.1:4000/api/documents/"
query = "?revision=" + revision_id


def get(route):
    with urlopen(url + route, timeout=20) as response:
        return response.read()


doc = json.loads(get(document_id))
ready = json.loads(get(document_id + "/readiness" + query))
manifest = get(document_id + "/raw" + query)
assert doc["document"]["deliverable_key"] == "decision-other-and-chat-design"
assert doc["document"]["requires_review"] and doc["document"]["intended_action"] == "none"
assert manifest == manifest_file.read_bytes()
assert ready["revision_id"] == revision_id and ready["ready"]
assert ready["required_ok"] == ready["required_total"] == 8
print(f'{doc["document"]["deliverable_key"]} | {revision_id} | ready=true (8/8) | raw manifest identical')

example = json.loads((here / "source.json").read_text(encoding="utf-8"))
original = json.loads(get(example["document_id"]))
assert original["revision"]["content_hash"] == example["content_hash"]
assert original["decision_items"]["revision_id"] == example["revision_id"]
ids = {q["id"] for q in example["items"]}
assert ids == {"D8", "D9", "D10"}
assert len(original["decision_items"]["items"]) == 19
assert [q for q in original["decision_items"]["items"] if q["id"] in ids] == example["items"]
print(f'Original {example["document_id"]} | 19 items | D8, D9, D10 match question, recommendation and all options')

screens = json.loads(manifest)["screens"]
expected = {"-".join(t) for t in itertools.product(("chat", "document"), ("desktop", "phone"), ("before", "after"))}
assert len(screens) == 8 and {s["id"] for s in screens} == expected
assert {folder / s["file"] for s in screens} == set(folder.rglob("*.png"))
for screen in screens:
    key = "screen:" + screen["id"]
    remote = get(document_id + "/assets/" + key + query)
    assert remote == (folder / screen["file"]).read_bytes()
    digest = hashlib.sha256(remote).hexdigest()
    assert any(c["asset_key"] == key and c["content_hash"] == digest and c["ok"] for c in ready["checks"])
    with Image.open(io.BytesIO(remote)) as image:
        image.load()
        assert image.format == "PNG" and image.width == (393 if "phone" in key else 1440)
        print(f'{key} | {image.width}x{image.height} | identical PNG | {digest}')

questions = json.loads((here / "decision-items.json").read_text(encoding="utf-8"))
assert doc["decision_items"]["revision_id"] == revision_id
assert doc["decision_items"]["items"] == questions and doc["decision_items"]["answerable"]
assert len(questions) == 4
for question in questions:
    assert question["recommendation"] and any(o["id"] == "other" for o in question["options"])
    assert all(o["action"] for o in question["options"])
print("Answerable handoff items with recommendation and Other:", ", ".join(q["id"] for q in questions))
for value in [manifest.decode("utf-8"), json.dumps(questions, ensure_ascii=False)]:
    assert all(mark not in value for mark in ("\u2014", "\ufffd", "\u00c3", "\u00c2", "\u00e2\u20ac"))
print("Exact-revision manifest and decision items: strict UTF-8, zero U+2014 or mojibake")
