import {
  DocumentApiError,
  openReview,
  getDocument,
  retryDelivery,
  finishReview,
  rawDocumentUrl,
  type DocumentRecord,
  type DocumentOutgoing,
} from "./document-review";
export type DraftFolder = "drafts" | "cancelled";
export type DraftCounts = { drafts: number; cancelled: number };
/**
 * The approved HTML document revision Praxis bound to a prepared email as its
 * HTML part, as recorded on the review document (`metadata.html_body`). The
 * preview reads exactly that revision and checks its bytes against the
 * binding; Praxis re-verifies the approval, revision and bytes again before
 * delivery and refuses to send on any mismatch.
 */
export type BoundHtmlBody = {
  document_id: string;
  revision_id: string;
  sha256: string;
  byte_length?: number;
  decision_id?: string;
};
export type MailDraft = {
  id: string;
  key: string;
  source: "document" | "runtime";
  subject: string;
  body: string;
  /**
   * The HTML part the runtime sends beside the plain-text body (stakeholder
   * status reports carry one). Praxis drops it when the text is edited, so a
   * draft either previews both parts or sends plain text only.
   */
  html?: string | null;
  /**
   * For a prepared (document) email, the approved HTML revision bound as its
   * HTML part; the preview reads it through `getBoundHtml`.
   */
  htmlBody?: BoundHtmlBody | null;
  to: string[];
  cc: string[];
  project?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  taskName?: string | null;
  status: string;
  version?: string;
  aliases?: string[];
  revisionId?: string;
  envelopeHash?: string;
  createdAt: string;
  updatedAt: string;
  blocked?: string | null;
  feedback?: {
    comments: string;
    returned_at?: string;
    status?: string;
    delivery?: string;
  } | null;
};
type RuntimeDraft = Omit<MailDraft, "source" | "key" | "to" | "feedback"> & {
  to: string;
  source: { kind: string; id: string };
  feedback?: Array<{ comments: string; createdAt: string; delivery: string }>;
};
type DocumentDraft = {
  document: DocumentRecord;
  outgoing: DocumentOutgoing & { feedback?: MailDraft["feedback"] };
  project_name?: string;
  task_name?: string;
};
/** The `html_body` binding Praxis records on a review document, or null when the email is plain text. */
function boundHtmlBody(metadata: unknown): BoundHtmlBody | null {
  const h = (metadata as { html_body?: unknown } | null | undefined)?.html_body;
  if (!h || typeof h !== "object") return null;
  const { document_id, revision_id, sha256, byte_length, decision_id } =
    h as Record<string, unknown>;
  if (
    typeof document_id !== "string" ||
    typeof revision_id !== "string" ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    return null;
  return {
    document_id,
    revision_id,
    sha256,
    ...(typeof byte_length === "number" ? { byte_length } : {}),
    ...(typeof decision_id === "string" ? { decision_id } : {}),
  };
}
/**
 * The bound HTML part, read from the exact approved revision (never the
 * document's current one) and checked against the binding's size and SHA-256
 * before it is previewed. A mismatch is an error, never a different preview.
 */
export async function getBoundHtml(
  bound: BoundHtmlBody,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    rawDocumentUrl(bound.document_id, { revision: bound.revision_id }),
    { credentials: "include", cache: "no-store", signal },
  );
  if (!response.ok)
    throw new DocumentApiError(
      `the approved HTML revision could not be read (${response.status})`,
      response.status,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bound.byte_length !== undefined && bytes.byteLength !== bound.byte_length)
    throw new Error(
      `the HTML revision is ${bytes.byteLength} bytes where the approval names ${bound.byte_length}`,
    );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== bound.sha256)
    throw new Error("the HTML revision's bytes differ from the approved binding");
  // ignoreBOM keeps a leading byte-order mark, as Praxis does for the sent part.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
async function request<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    credentials: "include",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new DocumentApiError(
      data?.message ||
        data?.error ||
        `Mail request failed (${response.status})`,
      response.status,
    );
  if (!data) throw new Error("Unreadable mail response");
  return data;
}
export async function getMailDrafts(folder: DraftFolder, signal?: AbortSignal) {
  const results = await Promise.allSettled([
    request<{ items: DocumentDraft[]; counts: DraftCounts }>(
      `/api/documents/mail-drafts?folder=${folder}`,
      undefined,
      signal,
    ),
    request<{ items: RuntimeDraft[]; counts: DraftCounts }>(
      `/api/praxis/mailbox/drafts-review?folder=${folder}`,
      undefined,
      signal,
    ),
  ]);
  const items: MailDraft[] = [];
  const errors: string[] = [];
  const counts = { drafts: 0, cancelled: 0 };
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      errors.push(
        `${index === 0 ? "Prepared mail" : "Praxis outreach"}: ${result.reason instanceof Error ? result.reason.message : "Unavailable"}`,
      );
      return;
    }
    const page = result.value;
    if (!Array.isArray(page.items) || !page.counts) {
      errors.push(
        `${index === 0 ? "Prepared mail" : "Praxis outreach"}: incompatible response. Refresh after the service is updated.`,
      );
      return;
    }
    counts.drafts += page.counts.drafts;
    counts.cancelled += page.counts.cancelled;
    if (index === 0)
      for (const {
        document: d,
        outgoing: o,
        project_name,
        task_name,
      } of page.items as DocumentDraft[])
        items.push({
          id: d.id,
          key: `document:${d.id}`,
          source: "document",
          subject: o.envelope.subject,
          body: o.envelope.text,
          htmlBody: boundHtmlBody(d.metadata),
          to: [o.envelope.to],
          cc: o.envelope.cc,
          project: project_name || d.project_id,
          taskId: d.task_id,
          taskName: task_name,
          status: o.status,
          revisionId: o.revision_id,
          envelopeHash: o.envelope_hash,
          createdAt: o.created_at,
          updatedAt: o.updated_at,
          feedback: o.feedback,
          blocked: o.invalidated_at
            ? "The document changed. Praxis must prepare a new message."
            : !o.envelope.cc.length
              ? "Operator copy is missing."
              : null,
        });
    else
      for (const item of page.items as RuntimeDraft[]) {
        const feedback = item.feedback?.at(-1);
        items.push({
          ...item,
          project: item.project || item.projectId,
          to: [item.to],
          feedback: feedback
            ? {
                comments: feedback.comments,
                returned_at: feedback.createdAt,
                delivery: feedback.delivery,
              }
            : null,
          aliases: [item.source?.id].filter(Boolean),
          source: "runtime",
          key: `runtime:${item.id}`,
        });
      }
  });
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { items, counts: errors.length ? null : counts, errors };
}
export async function actOnDraft(
  draft: MailDraft,
  action:
    "edit" | "approve_send" | "cancel" | "return_to_praxis" | "retry_feedback",
  changes: { subject?: string; body?: string; comments?: string } = {},
) {
  if (draft.source === "runtime")
    return request(
      `/api/praxis/mailbox/drafts-review/${encodeURIComponent(draft.id)}`,
      { action, version: draft.version, ...changes },
    );
  const identity = {
    revision_id: draft.revisionId,
    envelope_hash: draft.envelopeHash,
  };
  return request(
    `/api/documents/${encodeURIComponent(draft.id)}/outgoing/${action === "edit" ? "edit" : "decision"}`,
    action === "edit"
      ? { ...identity, subject: changes.subject, text: changes.body }
      : {
          ...identity,
          decision: action,
          ...(changes.comments ? { comments: changes.comments } : {}),
        },
  );
}
export async function submitDraftFeedback(draft: MailDraft, comments: string) {
  const current = await getDocument(draft.id);
  const existing = current.review;
  if (
    existing?.status === "submitted" &&
    existing.summary === comments &&
    (!draft.feedback?.returned_at ||
      (existing.submitted_at &&
        existing.submitted_at >= draft.feedback.returned_at))
  ) {
    if (existing.submission?.delivery_status === "failed")
      await retryDelivery(existing.id);
    return;
  }
  const review =
    existing?.status === "draft" ? existing : await openReview(draft.id);
  await finishReview(review.id, comments);
}
