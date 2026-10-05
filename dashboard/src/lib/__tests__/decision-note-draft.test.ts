import test from "node:test";
import assert from "node:assert/strict";

import {
    clearDecisionNoteDraft,
    decisionNoteDraftKey,
    readDecisionNoteDraft,
    writeDecisionNoteDraft,
    type DecisionNoteDraft,
} from "../decision-note-draft";

function memoryStorage(): Storage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        get length() { return map.size; },
        key: (i: number) => [...map.keys()][i] ?? null,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
        clear: () => map.clear(),
    };
}

const draft: DecisionNoteDraft = {
    kind: "request_changes",
    revision_id: "rev-2",
    content_hash: "b".repeat(64),
    origin_revision_id: "rev-1",
    origin_content_hash: "a".repeat(64),
    note: 'Change the "identity" column in the table below to be a summary of the documents instead of just listing what documents are available.',
    client_decision_id: "attempt-1",
    saved_at: "2026-10-04T17:05:00.000Z",
};

test("a draft round-trips per document with its kind, note, attempt id and both revision attributions", () => {
    const storage = memoryStorage();
    writeDecisionNoteDraft("doc-1", draft, storage);
    assert.deepEqual(readDecisionNoteDraft("doc-1", storage), draft);
    assert.equal(readDecisionNoteDraft("doc-2", storage), null, "another document has no draft");
    assert.equal(storage.map.size, 1);
    assert.ok(storage.map.has(decisionNoteDraftKey("doc-1")));
    clearDecisionNoteDraft("doc-1", storage);
    assert.equal(readDecisionNoteDraft("doc-1", storage), null);
});

test("a blank note removes the draft instead of storing an empty one", () => {
    const storage = memoryStorage();
    writeDecisionNoteDraft("doc-1", draft, storage);
    writeDecisionNoteDraft("doc-1", { ...draft, note: "   " }, storage);
    assert.equal(storage.map.size, 0);
});

test("an unusable stored value reads as no draft, and an older record without origin fields takes its revision as the origin", () => {
    const storage = memoryStorage();
    storage.setItem(decisionNoteDraftKey("doc-1"), "{not json");
    assert.equal(readDecisionNoteDraft("doc-1", storage), null);
    storage.setItem(decisionNoteDraftKey("doc-1"), JSON.stringify({ kind: "publish", note: "x", revision_id: "r", content_hash: "h", client_decision_id: "c", saved_at: "s" }));
    assert.equal(readDecisionNoteDraft("doc-1", storage), null, "unknown decision kinds are not restored");
    storage.setItem(decisionNoteDraftKey("doc-1"), JSON.stringify({ kind: "approve", note: "Looks right.", revision_id: "rev-1", content_hash: "a".repeat(64), client_decision_id: "c1", saved_at: "2026-10-04T17:05:00.000Z" }));
    assert.deepEqual(readDecisionNoteDraft("doc-1", storage), {
        kind: "approve", note: "Looks right.", revision_id: "rev-1", content_hash: "a".repeat(64),
        origin_revision_id: "rev-1", origin_content_hash: "a".repeat(64), client_decision_id: "c1", saved_at: "2026-10-04T17:05:00.000Z",
    });
});

test("storage that throws or is missing never breaks the caller", () => {
    const broken = {
        getItem: () => { throw new Error("disabled"); },
        setItem: () => { throw new Error("quota"); },
        removeItem: () => { throw new Error("disabled"); },
    };
    assert.equal(writeDecisionNoteDraft("doc-1", draft, broken), false);
    assert.equal(readDecisionNoteDraft("doc-1", broken), null);
    assert.doesNotThrow(() => clearDecisionNoteDraft("doc-1", broken));
    assert.equal(writeDecisionNoteDraft("doc-1", draft, null), false);
    assert.equal(readDecisionNoteDraft("doc-1", null), null);
});

test("quota fallback replaces an older local draft, reports success, and clears both stores", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    const stores = [local, session];
    assert.equal(writeDecisionNoteDraft("doc-1", draft, stores), true);
    local.setItem = () => { throw new Error("QuotaExceededError"); };
    const updated = { ...draft, note: "Updated note", saved_at: "2026-10-04T17:06:00.000Z" };
    assert.equal(writeDecisionNoteDraft("doc-1", updated, stores), true);
    assert.deepEqual(readDecisionNoteDraft("doc-1", stores), updated);
    assert.equal(local.getItem(decisionNoteDraftKey("doc-1")), null);
    assert.equal(writeDecisionNoteDraft("doc-1", { ...updated, note: "" }, stores), true);
    assert.equal(readDecisionNoteDraft("doc-1", stores), null);
});

test("fallback reads survive inaccessible local storage and prefer the latest retained copy", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    writeDecisionNoteDraft("doc-1", draft, local);
    local.setItem = () => { throw new Error("quota"); };
    local.removeItem = () => { throw new Error("disabled"); };
    const newer = { ...draft, note: "Newest note", saved_at: "2026-10-04T17:07:00.000Z" };
    assert.equal(writeDecisionNoteDraft("doc-1", newer, [local, session]), true);
    assert.deepEqual(readDecisionNoteDraft("doc-1", [local, session]), newer);
    local.getItem = () => { throw new Error("disabled"); };
    assert.deepEqual(readDecisionNoteDraft("doc-1", [local, session]), newer);
});

test("local storage recovery clears the older fallback copy", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    writeDecisionNoteDraft("doc-1", draft, session);
    const newer = { ...draft, note: "Local works again", saved_at: "2026-10-04T17:08:00.000Z" };
    assert.equal(writeDecisionNoteDraft("doc-1", newer, [local, session]), true);
    assert.equal(session.getItem(decisionNoteDraftKey("doc-1")), null);
    assert.deepEqual(readDecisionNoteDraft("doc-1", [local, session]), newer);
});
