"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LocalOperatorSignIn } from "./local-operator-sign-in";
import {
  actOnDraft,
  getBoundHtml,
  getMailDrafts,
  submitDraftFeedback,
  type DraftCounts,
  type DraftFolder,
  type MailDraft,
} from "@/lib/mail-drafts";
const button =
  "rounded-lg border border-slate-600 px-3 py-2 text-sm text-cyan-100 hover:border-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed";
const field =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 disabled:opacity-70";
const status: Record<string, string> = {
  draft: "Awaiting approval",
  approved: "Approved · awaiting delivery",
  delivering: "Delivery in progress",
  sent: "Sent",
  uncertain: "Delivery uncertain · automatic retry blocked",
  cancelled: "Cancelled permanently",
  changes_requested: "Changes requested",
  pending: "Awaiting approval",
  returned: "Changes requested · sending held",
  attempting: "Delivery in progress",
};
function date(value: string) {
  return new Date(value).toLocaleString();
}
export function MailDrafts({
  folder,
  onCounts,
}: {
  folder: DraftFolder;
  onCounts: (counts: DraftCounts | null) => void;
}) {
  const [items, setItems] = useState<MailDraft[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const countsRef = useRef(onCounts);
  countsRef.current = onCounts;
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const data = await getMailDrafts(folder, next.signal);
      if (next.signal.aborted) return;
      setItems(data.items);
      setErrors(data.errors);
      countsRef.current(data.counts);
      setSelected(
        (current) =>
          current ??
          data.items.find((d) =>
            [d.id, ...(d.aliases ?? [])].includes(
              new URLSearchParams(window.location.search).get("draft") ?? "",
            ),
          )?.key ??
          null,
      );
    } finally {
      if (!next.signal.aborted) setLoading(false);
    }
  }, [folder]);
  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, [refresh]);
  useEffect(() => {
    if (
      !items.some(
        (d) =>
          ["approved", "delivering", "attempting"].includes(d.status) ||
          d.feedback?.delivery === "pending",
      )
    )
      return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [items, refresh]);
  const draft = items.find((d) => d.key === selected);
  return (
    <section aria-label={folder === "drafts" ? "Drafts" : "Cancelled mail"}>
      <LocalOperatorSignIn />
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-slate-400">
          {folder === "drafts"
            ? "Review the exact message before authorizing one delivery."
            : "Cancelled messages cannot be sent again."}
        </p>
        <button className={button} onClick={() => void refresh()}>
          Refresh drafts
        </button>
      </div>
      {errors.map((error) => (
        <p
          key={error}
          role="alert"
          className="mb-3 rounded border border-amber-500/40 p-3 text-amber-200"
        >
          {error} Available results may be incomplete.
        </p>
      ))}
      {loading ? (
        <p role="status">Loading drafts…</p>
      ) : (
        <div className="grid overflow-hidden rounded-xl border border-slate-800 bg-slate-900/35 lg:grid-cols-[minmax(17rem,0.85fr)_minmax(0,1.8fr)]">
          <div
            aria-label="Draft list"
            className={`border-slate-800 lg:border-r ${draft ? "hidden lg:block" : ""}`}
          >
            {items.length === 0 && errors.length === 0 && (
              <p className="p-6 text-slate-400">
                {folder === "drafts"
                  ? "No drafts awaiting review."
                  : "No cancelled mail."}
              </p>
            )}
            {items.map((item) => (
              <button
                key={item.key}
                data-draft-id={item.key}
                aria-pressed={selected === item.key}
                className={`block w-full border-b border-slate-800 p-4 text-left hover:bg-slate-800/50 ${selected === item.key ? "bg-cyan-400/10" : ""}`}
                onClick={() => setSelected(item.key)}
              >
                <span className="block text-xs text-cyan-300">
                  {item.project || "No project"} ·{" "}
                  {item.source === "document"
                    ? "Prepared email"
                    : "Praxis outreach"}
                </span>
                <span className="mt-2 block font-medium">
                  {item.subject || "(No subject)"}
                </span>
                <span className="mt-2 block break-words text-xs text-slate-400">
                  To {item.to.join(", ")} ·{" "}
                  {item.blocked && item.status !== "cancelled" ? "Held" : status[item.status] || item.status}
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  Updated {date(item.updatedAt)}
                </span>
              </button>
            ))}
          </div>
          {draft ? (
            <div className="min-w-0">
              <button
                className={`${button} m-4 lg:hidden`}
                onClick={() => setSelected(null)}
              >
                Back to drafts
              </button>
              <DraftEditor
                key={`${draft.key}:${draft.envelopeHash ?? draft.version}`}
                draft={draft}
                onRefresh={refresh}
              />
            </div>
          ) : (
            <p className="hidden p-8 text-slate-400 lg:block">
              Select a message to review it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
function DraftEditor({
  draft,
  onRefresh,
}: {
  draft: MailDraft;
  onRefresh: () => Promise<void>;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [phoneWidth, setPhoneWidth] = useState(true);
  const [html, setHtml] = useState<string | null>(draft.html ?? null);
  const [htmlIssue, setHtmlIssue] = useState<string | null>(null);
  const loadedHtml = useRef<string | null>(null);
  useEffect(() => {
    // A prepared email bound to an approved HTML revision previews exactly
    // that revision: read once per binding and checked against its digest.
    const bound = draft.htmlBody;
    if (draft.html || !bound) return;
    const key = `${bound.document_id}:${bound.revision_id}:${bound.sha256}`;
    if (loadedHtml.current === key) return;
    loadedHtml.current = key;
    const controller = new AbortController();
    let done = false;
    getBoundHtml(bound, controller.signal).then(
      (text) => {
        done = true;
        if (!controller.signal.aborted) setHtml(text);
      },
      (error) => {
        done = true;
        if (controller.signal.aborted) return;
        loadedHtml.current = null;
        setHtmlIssue(
          error instanceof Error ? error.message : "it could not be read",
        );
      },
    );
    return () => {
      if (!done) {
        loadedHtml.current = null;
        controller.abort();
      }
    };
  }, [draft]);
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [feedbackPending, setFeedbackPending] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const dirty = subject !== draft.subject || body !== draft.body;
  const editable = [
    "draft",
    "pending",
    "approved",
    "changes_requested",
    "returned",
  ].includes(draft.status);
  const blocked = Boolean(draft.blocked) || needsRefresh;
  async function perform(
    action:
      | "edit"
      | "approve_send"
      | "cancel"
      | "return_to_praxis"
      | "retry_feedback",
  ) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await actOnDraft(
        draft,
        action,
        action === "edit"
          ? { subject, body }
          : action === "return_to_praxis"
            ? { comments: comments.trim() }
            : {},
      );
      if (action === "return_to_praxis" && draft.source === "document") {
        setFeedbackPending(comments.trim());
        try {
          await submitDraftFeedback(draft, comments.trim());
          setFeedbackPending(null);
        } catch (error) {
          setNotice(
            `Sending is held and comments are saved, but feedback submission failed: ${error instanceof Error ? error.message : "Unknown error"}. Retry feedback below.`,
          );
          return;
        }
      }
      setNotice(
        action === "cancel"
          ? "Send cancelled permanently."
          : action === "approve_send"
            ? "Approval recorded for this exact message."
            : action === "edit"
              ? "Changes saved. Review before approving."
              : "Returned to Praxis. Sending is held.",
      );
      await onRefresh();
    } catch (error) {
      setNeedsRefresh(true);
      setNotice(
        `${error instanceof Error ? error.message : "Request failed"}. Refresh and review the current state before another action.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function retryFeedback(savedComments = feedbackPending) {
    if (!savedComments) return;
    setBusy(true);
    try {
      await submitDraftFeedback(draft, savedComments);
      setFeedbackPending(null);
      setNotice("Feedback submitted to Praxis. Sending remains held.");
      await onRefresh();
    } catch (error) {
      setNotice(
        `Feedback submission failed: ${error instanceof Error ? error.message : "Unknown error"}. Sending remains held.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article aria-label="Draft detail" className="min-w-0 space-y-4 p-5">
      <p className="text-sm text-cyan-200">
        {status[draft.status] || draft.status} ·{" "}
        {draft.source === "document" ? "Prepared email" : "Praxis outreach"}
      </p>
      <p className="text-sm">
        {draft.project || "No project"}
        {draft.taskId && (
          <>
            {" "}
            ·{" "}
            <Link
              className="text-cyan-300 underline"
              href={`/task/${encodeURIComponent(draft.taskId)}`}
            >
              {draft.taskName || "Linked task"}
            </Link>
          </>
        )}
        {draft.source === "document" && (
          <>
            {" "}
            ·{" "}
            <Link
              className="text-cyan-300 underline"
              href={`/documents/${encodeURIComponent(draft.id)}`}
            >
              Source document
            </Link>
          </>
        )}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 break-words text-sm">
        <dt>To</dt>
        <dd>{draft.to.join(", ") || "None"}</dd>
        <dt>CC</dt>
        <dd>{draft.cc.join(", ") || "None"}</dd>
        <dt>Created</dt>
        <dd>{date(draft.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{date(draft.updatedAt)}</dd>
      </dl>
      <label className="block text-sm">
        Subject
        <input
          aria-label="Subject"
          className={field}
          value={subject}
          disabled={!editable || busy || !!feedbackPending}
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      {htmlIssue && (
        <p
          role="alert"
          className="rounded border border-amber-500/40 p-3 text-sm text-amber-200"
        >
          The approved HTML part is not shown: {htmlIssue}. Praxis makes the
          same check before delivery and will not send a part that fails it.
        </p>
      )}
      {!html && !htmlIssue && draft.htmlBody && (
        <p role="status" className="text-sm text-slate-400">
          Loading the approved HTML part…
        </p>
      )}
      {html && (
        <section aria-label="HTML message" className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>HTML message, as the reader&apos;s mail app shows it</span>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                aria-label="Phone width"
                checked={phoneWidth}
                onChange={(e) => setPhoneWidth(e.target.checked)}
              />
              Phone width (375 px)
            </label>
          </div>
          <iframe
            title="HTML preview"
            sandbox=""
            srcDoc={html}
            className="block max-w-full rounded-lg border border-slate-700 bg-white"
            style={{ width: phoneWidth ? "375px" : "100%", height: "640px" }}
          />
        </section>
      )}
      <label className="block text-sm">
        {html ? "Plain-text alternative" : "Message"}
        <textarea
          aria-label="Message body"
          className={`${field} min-h-64`}
          value={body}
          disabled={!editable || busy || !!feedbackPending}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {html && editable && (
        <p className="text-xs text-slate-400">
          {draft.source === "document"
            ? "Saving a text edit does not change the bound HTML part; Praxis re-verifies that approval and the exact revision before anything sends, and refuses the send if they no longer match."
            : "Saving a text edit sends plain text only; the HTML rendering is dropped."}
        </p>
      )}
      {draft.feedback && (
        <div className="rounded border border-amber-500/30 p-3 text-sm">
          <p>
            Changes requested
            {draft.feedback.returned_at
              ? ` · ${date(draft.feedback.returned_at)}`
              : ""}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{draft.feedback.comments}</p>
          {draft.feedback.delivery === "failed" && (
            <p role="alert" className="mt-2 text-amber-200">
              Comments are saved, but delivery to Praxis failed. Retry the saved
              feedback below; sending remains held.
            </p>
          )}
        </div>
      )}
      {draft.blocked && (
        <p role="alert" className="text-amber-200">
          {draft.blocked}
        </p>
      )}
      {notice && (
        <p role="status" className="text-amber-100">
          {notice}
        </p>
      )}
      {draft.source === "runtime" && draft.feedback?.delivery === "failed" && (
        <button
          className={button}
          disabled={busy}
          onClick={() => void perform("retry_feedback")}
        >
          Retry feedback submission
        </button>
      )}
      {draft.source === "document" && draft.feedback && !feedbackPending && (
        <button
          className={button}
          disabled={busy}
          onClick={() => void retryFeedback(draft.feedback!.comments)}
        >
          Resubmit saved feedback
        </button>
      )}
      {needsRefresh && (
        <button
          className={button}
          onClick={async () => {
            await onRefresh();
            setNeedsRefresh(false);
          }}
        >
          Reload current draft
        </button>
      )}
      {feedbackPending ? (
        <button
          className={button}
          disabled={busy}
          onClick={() => void retryFeedback()}
        >
          Retry feedback submission
        </button>
      ) : (
        editable && (
          <>
            <div className="flex flex-wrap gap-3">
              <button
                className={button}
                disabled={busy || !dirty || blocked}
                onClick={() => void perform("edit")}
              >
                Save changes
              </button>
              <button
                className={button}
                disabled={
                  busy ||
                  dirty ||
                  blocked ||
                  draft.status === "approved" ||
                  draft.status === "returned" ||
                  (draft.source === "document" && !!draft.feedback)
                }
                onClick={() => void perform("approve_send")}
              >
                Approve and send
              </button>
              <button
                className={button}
                disabled={busy || needsRefresh}
                onClick={() => void perform("cancel")}
              >
                Cancel send
              </button>
            </div>
            <p className="text-xs text-slate-400">
              {dirty ? "Save your changes before approving. " : ""}Cancellation
              is permanent. Approval authorizes one delivery of this exact
              message.
            </p>
            <label className="block text-sm">
              Comments for Praxis
              <textarea
                aria-label="Comments for Praxis"
                className={field}
                value={comments}
                disabled={busy}
                onChange={(e) => setComments(e.target.value)}
              />
            </label>
            <button
              className={button}
              disabled={busy || dirty || !comments.trim() || needsRefresh}
              onClick={() => void perform("return_to_praxis")}
            >
              Return to Praxis
            </button>
          </>
        )
      )}
    </article>
  );
}
