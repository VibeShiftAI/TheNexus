/**
 * Photo attachments on inbox answers (task 0df94949, 2026-10-24).
 *
 * The inbox card lets Robert attach a photo or screenshot to an answer. The
 * file goes through the chat upload API that already exists
 * (POST /api/chat/files/upload, served back at /api/chat/files/:fileId) and
 * the returned reference rides on the resolve body as
 * `payload.attachments`. The Nexus server rebuilds every reference from its
 * store before Praxis sees it (server/services/hitl-answer-attachments.js),
 * so the browser's job is only to pick, show, remove, upload and send.
 *
 * Pure helpers live here so the limits and the failure wording are testable
 * without mounting the card.
 */

/** Mirrors the upload route's multer cap and the server guard. */
export const HITL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const HITL_ATTACHMENT_MAX_COUNT = 4;

/** The reference the upload API returns and the resolve body carries. */
export interface HitlAnswerAttachment {
  fileId: string;
  url: string;
  mimeType: string;
  originalName: string;
  size: number;
}

/** A photo picked in the card: on the device until Send uploads it. */
export interface PendingHitlAttachment {
  key: string;
  file: File;
  previewUrl?: string;
  /** Set once the upload succeeded, so a failed send never re-uploads. */
  uploaded?: HitlAnswerAttachment;
}

const PHOTO_EXTENSION_RE = /\.(png|jpe?g|gif|webp|heic|heif)$/i;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Photos and screenshots only. Browsers report an empty type for HEIC on
 * some devices, so the extension counts too.
 */
export function isSupportedPhoto(file: { name: string; type: string }): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  return PHOTO_EXTENSION_RE.test(file.name ?? "");
}

/**
 * Why a picked file cannot be attached, in the words the card shows, or null
 * when it can. `currentCount` is how many photos are already on the answer.
 */
export function refuseHitlAttachment(
  file: { name: string; size: number; type: string },
  currentCount: number,
): string | null {
  if (currentCount >= HITL_ATTACHMENT_MAX_COUNT) {
    return `Up to ${HITL_ATTACHMENT_MAX_COUNT} photos can be attached to one answer.`;
  }
  if (!isSupportedPhoto(file)) {
    return `"${file.name}" is not a photo or screenshot. Attach a PNG, JPEG, WebP, GIF or HEIC image.`;
  }
  if (file.size > HITL_ATTACHMENT_MAX_BYTES) {
    return `"${file.name}" is ${formatBytes(file.size)}; photos up to ${formatBytes(HITL_ATTACHMENT_MAX_BYTES)} can be attached.`;
  }
  return null;
}

const STILL_HERE = "Your answer and photo are still here; try again.";

/**
 * Upload one photo through the chat upload API. Throws an Error whose message
 * is ready to show; the caller keeps the typed answer and the photo.
 */
export async function uploadHitlAttachment(
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<HitlAnswerAttachment> {
  const form = new FormData();
  form.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetchImpl("/api/chat/files/upload", { method: "POST", credentials: "include", body: form });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new Error(`Upload of "${file.name}" failed (${reason}). ${STILL_HERE}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (typeof body?.error === "string") detail = `: ${body.error}`;
    } catch {
      /* no JSON body */
    }
    throw new Error(`Upload of "${file.name}" failed (${response.status}${detail}). ${STILL_HERE}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Upload of "${file.name}" returned no file reference. ${STILL_HERE}`);
  }
  const reference = parseAttachment(body);
  if (!reference) throw new Error(`Upload of "${file.name}" returned no file reference. ${STILL_HERE}`);
  return reference;
}

function parseAttachment(value: unknown): HitlAnswerAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fileId !== "string" || !record.fileId) return null;
  const url = typeof record.url === "string" && record.url.startsWith("/api/chat/files/")
    ? record.url
    : `/api/chat/files/${record.fileId}`;
  return {
    fileId: record.fileId,
    url,
    mimeType: typeof record.mimeType === "string" ? record.mimeType : "",
    originalName: typeof record.originalName === "string" && record.originalName ? record.originalName : record.fileId,
    size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0,
  };
}

/** The photos saved on a resolved request, for history rows; [] when none. */
export function answerAttachments(resolution: unknown): HitlAnswerAttachment[] {
  if (!resolution || typeof resolution !== "object") return [];
  const payload = (resolution as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return [];
  const list = (payload as { attachments?: unknown }).attachments;
  if (!Array.isArray(list)) return [];
  return list.map(parseAttachment).filter((item): item is HitlAnswerAttachment => item !== null);
}
