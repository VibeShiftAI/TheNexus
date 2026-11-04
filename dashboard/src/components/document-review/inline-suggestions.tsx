"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDraftWriter } from "@/hooks/use-draft-writer";
import {
  agentReviewRequest,
  previewSuggestions,
  type AgentChoice,
  type AgentReview,
  type AgentReviewDetail,
} from "@/lib/agent-reviews";
import {
  convertCommentToSuggestion,
  generateCommentProposal,
  type ReviewComment,
} from "@/lib/document-review";

const buttonStyle =
  "rounded border border-slate-600 px-2 py-1 text-xs disabled:opacity-40";
type Conversion = {
  text: string;
  clientRequestId: string;
  range?: { start: number; end: number; original: string };
};
type ProposalAttempt = { clientRequestId: string; retryFresh?: boolean };
type Drafts = {
  proposals: Record<string, ProposalAttempt>;
  conversions: Record<string, Conversion>;
  edits: Record<string, string>;
  applyIds: Record<string, string>;
};
/** Shared by the existing comment cards and their combined application footer. */
export function useInlineSuggestions(
  documentId: string,
  comments: ReviewComment[],
  onChanged: () => void | Promise<void>,
) {
  const reviewIds = [
    ...new Set(
      comments.map((c) => c.agent_review_id).filter((id): id is string => !!id),
    ),
  ]
    .sort()
    .join(",");
  const [details, setDetails] = useState<Record<string, AgentReviewDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [conversions, setConversions] = useState<Record<string, Conversion>>(
    {},
  );
  const [selectingFor, setSelectingFor] = useState<string | null>(null);
  const applyIds = useRef<Record<string, string>>({});
  const proposals = useRef<Record<string, ProposalAttempt>>({});
  const [generating, setGenerating] = useState<string | null>(null);
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>(
    {},
  );
  const key = `nexus:inline-suggestions:${documentId}`;
  const [restored, setRestored] = useState<string | null>(null);
  const saveDraft = useDraftWriter<Drafts>(key, (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Saved server decisions remain available. */
    }
  });
  useEffect(() => {
    setDetails({});
    setBusy(null);
    setGenerating(null);
    setProposalErrors({});
    proposals.current = {};
    setErrors({});
    setEdits({});
    setConversions({});
    setSelectingFor(null);
    applyIds.current = {};
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved) {
        setEdits(saved.edits ?? {});
        setConversions(saved.conversions ?? {});
        applyIds.current = saved.applyIds ?? {};
        proposals.current = saved.proposals ?? {};
      }
    } catch {}
    setRestored(key);
  }, [key]);
  useEffect(() => {
    if (restored === key)
      saveDraft({
        edits,
        conversions,
        applyIds: applyIds.current,
        proposals: proposals.current,
      });
  }, [edits, conversions, restored, saveDraft, key]);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [documentId]);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    if (!reviewIds) {
      setDetails({});
      return;
    }
    const results = await Promise.all(
      reviewIds.split(",").map(async (id) => {
        try {
          return [
            id,
            await agentReviewRequest<AgentReviewDetail>(
              documentId,
              `/${encodeURIComponent(id)}`,
            ),
          ] as const;
        } catch (e) {
          if (epoch === generation.current)
            setErrors((prev) => ({ ...prev, [id]: (e as Error).message }));
          return null;
        }
      }),
    );
    if (epoch !== generation.current) return;
    setDetails((prev) => ({
      ...Object.fromEntries(
        Object.entries(prev).filter(([id]) =>
          reviewIds.split(",").includes(id),
        ),
      ),
      ...Object.fromEntries(results.filter((x) => x !== null)),
    }));
  }, [documentId, reviewIds]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  async function mutate(
    id: string,
    suffix: string,
    body: unknown,
    method = "POST",
  ) {
    const epoch = ++generation.current;
    setBusy(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    try {
      const result = await agentReviewRequest<{ review: AgentReview }>(
        documentId,
        `/${encodeURIComponent(id)}${suffix}`,
        body,
        method,
      );
      if (epoch !== generation.current) return false;
      setDetails((prev) =>
        prev[id]
          ? { ...prev, [id]: { ...prev[id], review: result.review } }
          : prev,
      );
      await onChanged();
      return true;
    } catch (e) {
      if (epoch !== generation.current) return false;
      setErrors((prev) => ({
        ...prev,
        [id]:
          (e as Error).message + " Your choices and typed text are retained.",
      }));
      return false;
    } finally {
      if (epoch === generation.current) setBusy(null);
    }
  }
  async function choose(
    comment: ReviewComment,
    status: AgentChoice["status"],
    replacement?: string,
  ) {
    const id = comment.agent_review_id!;
    if (
      await mutate(
        id,
        "/choices",
        {
          choices: [
            {
              suggestion_id: comment.suggestion!.id,
              status,
              ...(replacement === undefined ? {} : { replacement }),
            },
          ],
        },
        "PATCH",
      )
    ) {
      setEdits((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
      if (comment.source_comment_id)
        setConversions((prev) => {
          const next = { ...prev };
          delete next[comment.source_comment_id!];
          return next;
        });
      delete applyIds.current[id];
    }
  }
  async function apply(id: string) {
    applyIds.current[id] ??=
      details[id]?.review.application?.client_apply_id ?? crypto.randomUUID();
    saveDraft(
      {
        edits,
        conversions,
        applyIds: applyIds.current,
        proposals: proposals.current,
      },
      true,
    );
    await mutate(id, "/apply", { client_apply_id: applyIds.current[id] });
  }
  function beginConversion(comment: ReviewComment) {
    setConversions((prev) => ({
      ...prev,
      [comment.id]: prev[comment.id] ?? {
        text: comment.provenance?.original ?? comment.quote ?? "",
        clientRequestId: crypto.randomUUID(),
      },
    }));
    if (comment.kind !== "passage") setSelectingFor(comment.id);
  }
  function selectConversionRange(range: {
    start: number;
    end: number;
    original: string;
  }) {
    if (!selectingFor) return;
    setConversions((prev) => ({
      ...prev,
      [selectingFor]: {
        ...prev[selectingFor],
        range,
        text: range.original,
        clientRequestId: crypto.randomUUID(),
      },
    }));
    setSelectingFor(null);
  }
  async function convert(comment: ReviewComment) {
    const draft = conversions[comment.id];
    if (!draft || !comment.review_id || !comment.agent_review_id) return;
    const id = comment.agent_review_id;
    const epoch = ++generation.current;
    setBusy(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    saveDraft(
      {
        edits,
        conversions,
        applyIds: applyIds.current,
        proposals: proposals.current,
      },
      true,
    );
    try {
      const result = await convertCommentToSuggestion(
        comment.review_id,
        comment.id,
        {
          client_request_id: draft.clientRequestId,
          proposed: draft.text,
          status: "accepted",
          ...draft.range,
        },
      );
      if (epoch !== generation.current) return;
      setDetails((prev) =>
        prev[id]
          ? { ...prev, [id]: { ...prev[id], review: result.review } }
          : prev,
      );
      await onChanged();
      setConversions((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    } catch (e) {
      if (epoch !== generation.current) return;
      setErrors((prev) => ({
        ...prev,
        [id]: (e as Error).message + " Your proposed text is retained.",
      }));
      if ((e as { code?: string }).code === "already_converted") {
        await onChanged();
        await refresh();
      }
    } finally {
      if (epoch === generation.current) setBusy(null);
    }
  }
  async function generate(comment: ReviewComment, retry = false) {
    if (!comment.review_id || !comment.agent_review_id) return;
    const id = comment.agent_review_id;
    const epoch = ++generation.current;
    let attempt = proposals.current[comment.id];
    if (!attempt || (retry && attempt.retryFresh))
      attempt = proposals.current[comment.id] = {
        clientRequestId: crypto.randomUUID(),
      };
    saveDraft(
      {
        edits,
        conversions,
        applyIds: applyIds.current,
        proposals: proposals.current,
      },
      true,
    );
    setGenerating(comment.id);
    setBusy(id);
    setProposalErrors((prev) => ({ ...prev, [comment.id]: "" }));
    try {
      const result = await generateCommentProposal(
        comment.review_id,
        comment.id,
        attempt.clientRequestId,
      );
      if (epoch !== generation.current) return;
      setDetails((prev) =>
        prev[id]
          ? { ...prev, [id]: { ...prev[id], review: result.review } }
          : prev,
      );
      await onChanged();
    } catch (e) {
      if (epoch !== generation.current) return;
      attempt.retryFresh =
        (e as { retryWithNewRequestId?: boolean }).retryWithNewRequestId ===
        true;
      saveDraft(
        {
          edits,
          conversions,
          applyIds: applyIds.current,
          proposals: proposals.current,
        },
        true,
      );
      setProposalErrors((prev) => ({
        ...prev,
        [comment.id]: (e as Error).message,
      }));
    } finally {
      if (epoch === generation.current) {
        setGenerating(null);
        setBusy(null);
      }
    }
  }
  return {
    details,
    generating,
    proposalErrors,
    generate,
    busy,
    errors,
    edits,
    setEdits,
    choose,
    apply,
    conversions,
    setConversions,
    selectingFor,
    setSelectingFor,
    beginConversion,
    selectConversionRange,
    convert,
  };
}
export type InlineSuggestionState = ReturnType<typeof useInlineSuggestions>;
export function InlineSuggestionControls({
  comment,
  state,
  onReply,
}: {
  comment: ReviewComment;
  state: InlineSuggestionState;
  onReply: () => void;
}) {
  const suggestion = comment.suggestion;
  if (!suggestion || !comment.agent_review_id) return null;
  const review = state.details[comment.agent_review_id]?.review;
  const choice =
    review?.choices.find((c) => c.suggestion_id === suggestion.id) ??
    comment.choice;
  const closed =
    !!review && (review.status !== "submitted" || !!review.application);
  const busy = !!state.busy;
  const editing = Object.hasOwn(state.edits, comment.id);
  const retained = comment.source_comment_id
    ? state.conversions[comment.source_comment_id]
    : null;
  return (
    <div className="space-y-2" data-inline-suggestion={suggestion.id}>
      <p className="text-xs font-semibold text-cyan-200">
        {comment.source_comment_id && comment.author?.name !== "Praxis"
          ? "Your suggested edit"
          : "Suggested edit"}{" "}
        · {choice?.status ?? "pending"}
        {closed ? " · saved in history" : ""}
      </p>
      <div
        className="flex flex-wrap items-center gap-2"
        data-comment-actions=""
        aria-label="Suggested edit actions"
      >
        {editing ? (
          <>
            <button
              className={buttonStyle}
              disabled={busy || closed}
              onClick={() =>
                void state.choose(comment, "accepted", state.edits[comment.id])
              }
            >
              Save edited choice
            </button>
            <button
              className={buttonStyle}
              onClick={() =>
                state.setEdits((prev) => {
                  const next = { ...prev };
                  delete next[comment.id];
                  return next;
                })
              }
            >
              Cancel edit
            </button>
          </>
        ) : (
          <>
            <button
              className={buttonStyle}
              disabled={busy || closed}
              onClick={() =>
                void state.choose(comment, "accepted", choice?.replacement)
              }
            >
              Accept
            </button>
            <button
              className={buttonStyle}
              disabled={busy || closed}
              onClick={() =>
                void state.choose(comment, "rejected", choice?.replacement)
              }
            >
              Reject
            </button>
            <button
              className={buttonStyle}
              disabled={busy || closed}
              onClick={() =>
                state.setEdits({
                  ...state.edits,
                  [comment.id]: choice?.replacement ?? suggestion.proposed,
                })
              }
            >
              Edit &amp; accept
            </button>
            {choice && choice.status !== "pending" && !closed && (
              <button
                className={buttonStyle}
                disabled={busy}
                onClick={() =>
                  void state.choose(comment, "pending", choice.replacement)
                }
              >
                Undo decision
              </button>
            )}
          </>
        )}
        {retained && (
          <>
            <button
              className={buttonStyle}
              disabled={busy || closed}
              onClick={() =>
                state.setEdits({ ...state.edits, [comment.id]: retained.text })
              }
            >
              Use retained text
            </button>
            <button
              className={buttonStyle}
              onClick={() =>
                state.setConversions((prev) => {
                  const next = { ...prev };
                  delete next[comment.source_comment_id!];
                  return next;
                })
              }
            >
              Discard retained text
            </button>
          </>
        )}
        <button className={buttonStyle} onClick={onReply} data-comment-reply="">
          Reply
        </button>
      </div>
      {editing ? (
        <textarea
          aria-label={`Replacement for ${suggestion.id}`}
          className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm"
          value={state.edits[comment.id]}
          onChange={(e) =>
            state.setEdits({ ...state.edits, [comment.id]: e.target.value })
          }
        />
      ) : (
        <div className="rounded border border-cyan-800/50 p-2 text-sm">
          <p className="mb-1 text-xs text-slate-400">Proposed text</p>
          <pre className="whitespace-pre-wrap">
            {(choice?.replacement ?? suggestion.proposed) ||
              "(Delete selected text)"}
          </pre>
        </div>
      )}
      {retained && (
        <div className="rounded border border-amber-600/40 p-2 text-xs text-amber-200">
          <p>
            A suggestion was already saved for this comment. Your later
            replacement draft is retained:
          </p>
          <pre className="whitespace-pre-wrap">
            {retained.text || "(Delete selected text)"}
          </pre>
        </div>
      )}
      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer">
          Rationale and original text
        </summary>
        <p className="mt-2 whitespace-pre-wrap">
          {comment.source_comment
            ? `${comment.source_comment.author?.name ?? "Original reviewer"}: ${comment.source_comment.body}`
            : comment.body}
        </p>
        <p className="mt-2 font-semibold">Original text</p>
        <pre className="whitespace-pre-wrap">
          {suggestion.original || "(Insertion)"}
        </pre>
        {choice?.actor && (
          <p className="mt-2">
            Decision by {choice.actor.name ?? choice.actor.id}
          </p>
        )}
      </details>
    </div>
  );
}
export function InlineCommentConversion({
  comment,
  state,
}: {
  comment: ReviewComment;
  state: InlineSuggestionState;
}) {
  const draft = state.conversions[comment.id];
  if (!draft) return null;
  const needsRange = comment.kind !== "passage" && !draft.range;
  return (
    <div
      className="my-2 space-y-2 rounded border border-cyan-700/50 p-2 text-xs"
      data-comment-conversion=""
    >
      {needsRange ? (
        <p>
          Select the exact passage in the document to replace. This comment will
          not replace the whole document.
        </p>
      ) : (
        <>
          <p>
            Write the replacement text. Accept edit saves your suggestion; Apply
            accepted changes updates the draft.
          </p>
          <textarea
            aria-label="Proposed replacement"
            className="min-h-24 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm"
            value={draft.text}
            onChange={(e) =>
              state.setConversions({
                ...state.conversions,
                [comment.id]: {
                  ...draft,
                  text: e.target.value,
                  clientRequestId:
                    draft.text === e.target.value
                      ? draft.clientRequestId
                      : crypto.randomUUID(),
                },
              })
            }
          />
          <details>
            <summary>Original passage</summary>
            <pre className="whitespace-pre-wrap">
              {draft.range?.original ??
                comment.provenance?.original ??
                comment.quote}
            </pre>
          </details>
        </>
      )}
      {comment.agent_review_id && state.errors[comment.agent_review_id] && (
        <p role="alert">{state.errors[comment.agent_review_id]}</p>
      )}
    </div>
  );
}
export function InlineSuggestionApplications({
  state,
  comments,
}: {
  state: InlineSuggestionState;
  comments: ReviewComment[];
}) {
  return (
    <div className="space-y-3" data-inline-applications="">
      {Object.entries(state.details).map(([id, detail]) => (
        <Application
          key={id}
          detail={detail}
          state={state}
          comments={comments}
        />
      ))}
      {Object.entries(state.errors)
        .filter(([id]) => !state.details[id])
        .map(([id, error]) => (
          <p key={id} role="alert">
            {error}
          </p>
        ))}
    </div>
  );
}
function Application({
  detail,
  state,
  comments,
}: {
  detail: AgentReviewDetail;
  state: InlineSuggestionState;
  comments: ReviewComment[];
}) {
  const review = detail.review;
  const accepted = review.choices.filter((c) => c.status === "accepted").length;
  const pending = review.suggestions.filter(
    (s) =>
      !review.choices.some(
        (c) => c.suggestion_id === s.id && c.status !== "pending",
      ),
  ).length;
  const stale = detail.current_revision_id !== review.base_revision_id;
  const preview = useMemo(() => {
    try {
      return {
        text: previewSuggestions(
          detail.revision.content,
          review.suggestions,
          review.choices,
        ),
        error: "",
      };
    } catch (e) {
      return { text: "", error: (e as Error).message };
    }
  }, [detail]);
  const editing = comments.some(
    (c) =>
      c.agent_review_id === review.id &&
      (Object.hasOwn(state.edits, c.id) ||
        Object.hasOwn(state.conversions, c.id) ||
        (!!c.source_comment_id &&
          Object.hasOwn(state.conversions, c.source_comment_id))),
  );
  return (
    <div
      className="space-y-2 rounded border border-slate-700 p-3 text-xs"
      data-suggestion-application={review.id}
    >
      <p>
        Review suggestions: {accepted} accepted · {pending} pending
      </p>
      {review.result_revision_id && (
        <p>Result revision: {review.result_revision_id}</p>
      )}
      {pending > 0 && (
        <p className="text-amber-200">
          Applying now leaves pending suggestions historical, bound to the
          original revision. A fresh review is required to apply them later.
        </p>
      )}
      {stale && (
        <p className="text-amber-200">
          This review is historical: the document changed. Choices remain saved;
          request a fresh review to apply changes.
        </p>
      )}
      {preview.error && <p role="alert">{preview.error}</p>}
      {state.errors[review.id] && <p role="alert">{state.errors[review.id]}</p>}
      <details>
        <summary className="cursor-pointer text-cyan-200">
          Combined preview
        </summary>
        <pre
          data-combined-preview=""
          className="max-h-80 overflow-auto whitespace-pre-wrap bg-slate-900 p-2"
        >
          {preview.text}
        </pre>
      </details>
      <p>
        Applying saves accepted changes to this draft. It does not approve
        publication or sending.
      </p>
      <button
        className={buttonStyle}
        disabled={
          !!state.busy ||
          review.status !== "submitted" ||
          (stale && accepted > 0) ||
          (!accepted && pending > 0) ||
          !!preview.error ||
          editing
        }
        onClick={() => void state.apply(review.id)}
      >
        {accepted ? "Apply accepted changes" : "Finish suggestions review"}
      </button>
    </div>
  );
}
