/**
 * The attachment-list reducer: what the composer accepts, what it caps, and
 * which preview object URLs have to be revoked when an item leaves the list.
 *
 * P2-27 lifted this out of ai-terminal.tsx's inline handlers so the limits
 * (25 MB per file, 5 files) and the revoke discipline are provable without
 * mounting the terminal.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    attachmentsReducer,
    EMPTY_ATTACHMENTS,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_BYTES,
    type AttachmentState,
} from "../use-file-attachments.ts";

/** A File of a given size without allocating the bytes. */
function fakeFile(name: string, type: string, size: number): File {
    const f = new File([], name, { type });
    Object.defineProperty(f, "size", { value: size });
    return f;
}

let urlSeq = 0;
const stubUrl = () => `blob:stub-${++urlSeq}`;

function add(state: AttachmentState, files: File[]) {
    return attachmentsReducer(state, { type: "add", files }, stubUrl);
}

test("files are accepted with their name, size and type", () => {
    const png = fakeFile("shot.png", "image/png", 2048);
    const { state, revoked } = add(EMPTY_ATTACHMENTS, [png]);
    assert.deepEqual(revoked, []);
    assert.equal(state.files.length, 1);
    assert.equal(state.previews[0].name, "shot.png");
    assert.equal(state.previews[0].size, 2048);
    assert.equal(state.previews[0].type, "image/png");
});

test("only image/* files get a preview thumbnail URL", () => {
    const { state } = add(EMPTY_ATTACHMENTS, [
        fakeFile("a.png", "image/png", 10),
        fakeFile("b.md", "text/markdown", 10),
    ]);
    assert.ok(state.previews[0].previewUrl?.startsWith("blob:"));
    assert.equal(state.previews[1].previewUrl, undefined);
});

test("files over 25 MB are dropped, the rest of the drop still lands", () => {
    assert.equal(MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024);
    const { state } = add(EMPTY_ATTACHMENTS, [
        fakeFile("huge.mov", "video/quicktime", MAX_ATTACHMENT_BYTES + 1),
        fakeFile("ok.mov", "video/quicktime", MAX_ATTACHMENT_BYTES),
    ]);
    assert.deepEqual(state.files.map((f) => f.name), ["ok.mov"]);
    assert.equal(state.previews.length, 1);
});

test("the list caps at 5 and the HEAD wins — already-picked files are never evicted", () => {
    assert.equal(MAX_ATTACHMENTS, 5);
    const first = add(EMPTY_ATTACHMENTS, [1, 2, 3].map((n) => fakeFile(`f${n}.txt`, "text/plain", 10)));
    const second = add(first.state, [4, 5, 6, 7].map((n) => fakeFile(`f${n}.txt`, "text/plain", 10)));
    assert.deepEqual(
        second.state.files.map((f) => f.name),
        ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"],
    );
    assert.equal(second.state.previews.length, 5);
});

test("previews for overflowed files are revoked rather than leaked", () => {
    const four = add(EMPTY_ATTACHMENTS, [1, 2, 3, 4].map((n) => fakeFile(`i${n}.png`, "image/png", 10)));
    const overflow = add(four.state, [5, 6].map((n) => fakeFile(`i${n}.png`, "image/png", 10)));
    assert.equal(overflow.state.files.length, 5);
    // i6.png never reached the DOM — its thumbnail URL comes back to revoke.
    assert.equal(overflow.revoked.length, 1);
    assert.ok(overflow.revoked[0].startsWith("blob:"));
});

test("removing an attachment removes both lists at the same index and revokes its URL", () => {
    const { state } = add(EMPTY_ATTACHMENTS, [
        fakeFile("a.png", "image/png", 10),
        fakeFile("b.png", "image/png", 10),
        fakeFile("c.txt", "text/plain", 10),
    ]);
    const removed = attachmentsReducer(state, { type: "remove", index: 1 }, stubUrl);
    assert.deepEqual(removed.state.files.map((f) => f.name), ["a.png", "c.txt"]);
    assert.deepEqual(removed.state.previews.map((p) => p.name), ["a.png", "c.txt"]);
    assert.deepEqual(removed.revoked, [state.previews[1].previewUrl]);
});

test("removing a non-image revokes nothing", () => {
    const { state } = add(EMPTY_ATTACHMENTS, [fakeFile("n.txt", "text/plain", 10)]);
    assert.deepEqual(attachmentsReducer(state, { type: "remove", index: 0 }, stubUrl).revoked, []);
});

test("clear (the post-send reset) empties the list and revokes every thumbnail", () => {
    const { state } = add(EMPTY_ATTACHMENTS, [
        fakeFile("a.png", "image/png", 10),
        fakeFile("b.txt", "text/plain", 10),
        fakeFile("c.png", "image/png", 10),
    ]);
    const cleared = attachmentsReducer(state, { type: "clear" }, stubUrl);
    assert.deepEqual(cleared.state, EMPTY_ATTACHMENTS);
    assert.deepEqual(cleared.revoked, [state.previews[0].previewUrl, state.previews[2].previewUrl]);
});

test("a drop of nothing but oversized files leaves the state identity untouched", () => {
    const { state } = add(EMPTY_ATTACHMENTS, [fakeFile("a.png", "image/png", 10)]);
    const noop = add(state, [fakeFile("huge.bin", "application/octet-stream", MAX_ATTACHMENT_BYTES + 1)]);
    assert.equal(noop.state, state);
    assert.deepEqual(noop.revoked, []);
});
