import test from "node:test";
import assert from "node:assert/strict";
import {
  HITL_ATTACHMENT_MAX_BYTES,
  HITL_ATTACHMENT_MAX_COUNT,
  answerAttachments,
  formatBytes,
  isSupportedPhoto,
  refuseHitlAttachment,
  uploadHitlAttachment,
} from "../hitl-attachments.ts";

test("photos and screenshots are accepted by type or by extension, other files are named in the refusal", () => {
  assert.equal(isSupportedPhoto({ name: "IMG_0001.HEIC", type: "" }), true);
  assert.equal(isSupportedPhoto({ name: "Screenshot.png", type: "image/png" }), true);
  assert.equal(isSupportedPhoto({ name: "notes.pdf", type: "application/pdf" }), false);
  assert.equal(refuseHitlAttachment({ name: "shot.png", size: 1024, type: "image/png" }, 0), null);
  assert.match(refuseHitlAttachment({ name: "notes.pdf", size: 10, type: "application/pdf" }, 0) ?? "", /"notes\.pdf" is not a photo or screenshot/);
  assert.match(
    refuseHitlAttachment({ name: "huge.png", size: HITL_ATTACHMENT_MAX_BYTES + 1, type: "image/png" }, 0) ?? "",
    /"huge\.png" is 25\.0 MB; photos up to 25\.0 MB can be attached/,
  );
  assert.match(refuseHitlAttachment({ name: "fifth.png", size: 1, type: "image/png" }, HITL_ATTACHMENT_MAX_COUNT) ?? "", /Up to 4 photos/);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1536 * 1024), "1.5 MB");
});

test("the upload helper returns the server reference and turns failures into recoverable messages", async () => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "gmail.png", { type: "image/png" });
  const seen: { url: string; name: string | undefined }[] = [];
  const reference = await uploadHitlAttachment(file, (async (url: string, init?: RequestInit) => {
    const form = init?.body as FormData;
    const sent = form.get("file") as File;
    seen.push({ url, name: sent?.name });
    return Response.json({ fileId: "11111111-2222-4333-8444-555555555555", url: "/api/chat/files/11111111-2222-4333-8444-555555555555", mimeType: "image/png", originalName: "gmail.png", size: 4 });
  }) as typeof fetch);
  assert.deepEqual(seen, [{ url: "/api/chat/files/upload", name: "gmail.png" }]);
  assert.equal(reference.fileId, "11111111-2222-4333-8444-555555555555");

  await assert.rejects(
    uploadHitlAttachment(file, (async () => new Response(JSON.stringify({ error: "File too large" }), { status: 413 })) as typeof fetch),
    /Upload of "gmail\.png" failed \(413: File too large\)\. Your answer and photo are still here; try again\./,
  );
  await assert.rejects(
    uploadHitlAttachment(file, (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch),
    /failed \(Failed to fetch\)/,
  );
  await assert.rejects(
    uploadHitlAttachment(file, (async () => Response.json({ ok: true })) as typeof fetch),
    /returned no file reference/,
  );
});

test("saved photos are read back from the resolution payload and junk is ignored", () => {
  assert.deepEqual(answerAttachments(undefined), []);
  assert.deepEqual(answerAttachments({ freeText: "yes" }), []);
  assert.deepEqual(answerAttachments({ payload: { attachments: "nope" } }), []);
  const photos = answerAttachments({
    payload: { attachments: [{ fileId: "abc", url: "javascript:alert(1)", originalName: "x.png", mimeType: "image/png", size: 3 }, null, { url: "/api/chat/files/no-id" }] },
  });
  assert.deepEqual(photos, [{ fileId: "abc", url: "/api/chat/files/abc", originalName: "x.png", mimeType: "image/png", size: 3 }]);
});
