"use client";

/**
 * The document's own decision, separate from feedback: "Approve document" and
 * "Request changes" record Robert's editorial decision on the exact revision
 * on screen (revision id + content hash). The server refuses a revision that
 * is no longer current (409 stale_revision); this card then says so, reloads
 * the reader onto the new revision and asks for a fresh read before deciding
 * again. Comments, feedback rounds and earlier decisions stay on the server
 * and are listed under History. A decision never sends, publishes or changes
 * the task; "Finish review" (the feedback panel) never records a decision.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, History, Loader2, ThumbsUp, Undo2 } from "lucide-react";
import {
    DocumentApiError,
    getDocumentHistory,
    newClientId,
    recordDecision,
    type DecisionKind,
    type DocumentDecision,
    type DocumentHistory,
    type DocumentResponse,
    type RevisionMeta,
} from "@/lib/document-review";
import { DocumentStatusBadge } from "./deliverable-row";

const DECISION_TEXT: Record<DecisionKind, { button: string; past: string; confirm: string }> = {
    approve: { button: "Approve document", past: "Approved", confirm: "Approve this revision" },
    request_changes: { button: "Request changes", past: "Changes requested", confirm: "Request changes on this revision" },
};

const ACTION_TEXT: Record<string, string> = {
    implement: "implementing it",
    send: "sending it",
    publish: "publishing it",
};

function formatWhen(iso: string | null | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function shortHash(hash: string | null | undefined): string {
    return hash ? hash.slice(0, 8) : "unknown";
}

function sentence(text: string): string {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Words for a refusal: what happened and that nothing was recorded. */
function refusalMessage(err: unknown): { text: string; stale: boolean; reload: boolean } {
    if (err instanceof DocumentApiError) {
        switch (err.code) {
            case "stale_revision":
                return { text: "A newer revision of this document was captured while you were reading, so nothing was recorded. The page has reloaded; read the current revision before deciding again. Your comments and history are kept.", stale: true, reload: true };
            case "operator_required":
                return { text: `${sentence(err.message)} Nothing was recorded. Reading and feedback still work in this session; record the decision from the Nexus app signed in as the operator (the phone or Windows app).`, stale: false, reload: false };
            case "authentication_required":
                return { text: "Your session has expired, so nothing was recorded. Reload the app and try again.", stale: false, reload: false };
            case "idempotency_key_reused":
                return { text: "An earlier attempt of this decision was already recorded with different details; the page now shows what is on record.", stale: false, reload: true };
            case "review_not_required":
                return { text: "This is a reference document; it does not take a decision. Nothing was recorded.", stale: false, reload: true };
            case "file_unavailable":
                return { text: sentence(err.message), stale: false, reload: true };
            case "content_mismatch":
            case "revision_not_found":
                return { text: `${sentence(err.message)} Nothing was recorded.`, stale: false, reload: true };
            default:
                return { text: err.status >= 500 && !/no decision was recorded/i.test(err.message) ? `${sentence(err.message)} No decision was recorded.` : sentence(err.message), stale: false, reload: false };
        }
    }
    // The request may have reached the server; retrying reuses the same id, so a recorded decision is answered, not duplicated.
    return { text: `${sentence(err instanceof Error ? err.message : "Request failed")} It is unclear whether the decision was recorded; trying again is safe.`, stale: false, reload: false };
}

function HistoryList({ history, currentRevisionId }: { history: DocumentHistory; currentRevisionId: string | null }) {
    const revisions = [...history.revisions].sort((a, b) => b.captured_at.localeCompare(a.captured_at));
    const decisionsByRevision = new Map<string, DocumentDecision[]>();
    for (const decision of history.decisions) {
        decisionsByRevision.set(decision.revision_id, [...(decisionsByRevision.get(decision.revision_id) ?? []), decision]);
    }
    const reviewsByRevision = new Map<string, DocumentHistory["reviews"]>();
    for (const review of history.reviews) {
        reviewsByRevision.set(review.revision_id, [...(reviewsByRevision.get(review.revision_id) ?? []), review]);
    }
    if (revisions.length === 0) return <p className="text-[11px] text-slate-500">No revisions captured yet.</p>;
    return (
        <ol className="space-y-2" data-document-history="">
            {revisions.map((revision) => (
                <li key={revision.id} className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-[11px] text-slate-400" data-history-revision={revision.id}>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-slate-200" title={revision.content_hash}>rev {shortHash(revision.content_hash)}</span>
                        <span>captured {formatWhen(revision.captured_at)}</span>
                        {revision.id === currentRevisionId && <span className="rounded-full border border-cyan-500/40 px-1.5 text-cyan-200">current</span>}
                    </div>
                    {(decisionsByRevision.get(revision.id) ?? []).map((decision) => (
                        <p key={decision.id} className="mt-1" data-history-decision={decision.decision}>
                            <span className={decision.decision === "approve" ? "text-sky-200" : "text-orange-200"}>{DECISION_TEXT[decision.decision].past}</span>
                            {" "}{formatWhen(decision.created_at)} · {decision.authority.replace(/_/g, " ")}
                            {decision.note ? <span className="text-slate-300">: {decision.note}</span> : null}
                        </p>
                    ))}
                    {(reviewsByRevision.get(revision.id) ?? []).map((review) => (
                        <p key={review.id} className="mt-1" data-history-feedback={review.status}>
                            Feedback {review.status === "submitted" ? `sent ${formatWhen(review.submitted_at)}` : "draft"} · {review.comment_count} comment{review.comment_count === 1 ? "" : "s"}
                            {review.delivery_status ? ` · delivery ${review.delivery_status}` : ""}
                        </p>
                    ))}
                </li>
            ))}
        </ol>
    );
}

export interface DecisionCardProps {
    data: DocumentResponse;
    /** The revision on screen; decisions are pinned to it. */
    viewedRevision: RevisionMeta | null;
    /** False while the reader shows an older revision pinned to a feedback round. */
    viewingCurrent: boolean;
    /** Reload the reader (document, revision, review) after a decision or a conflict. */
    onRefresh: () => Promise<void> | void;
}

export function DecisionCard({ data, viewedRevision, viewingCurrent, onRefresh }: DecisionCardProps) {
    const doc = data.document;
    const status = data.review_status;
    const current = data.current_decision ?? null;
    const [confirm, setConfirm] = useState<{ kind: DecisionKind; clientId: string } | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<{ tone: "ok" | "error" | "stale"; text: string } | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [history, setHistory] = useState<DocumentHistory | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const historySeq = useRef(0);

    const loadHistory = useCallback(async () => {
        const mine = ++historySeq.current;
        try {
            const next = await getDocumentHistory(doc.id);
            if (mine !== historySeq.current) return;
            setHistory(next);
            setHistoryError(null);
        } catch (err) {
            if (mine === historySeq.current) setHistoryError(err instanceof Error ? err.message : "Failed to load history");
        }
    }, [doc.id]);

    // History follows the reader: a new revision, decision or feedback round reloads it while it is open.
    const historyKey = `${data.revision?.id ?? ""}|${current?.id ?? ""}|${data.review?.id ?? ""}|${data.review?.status ?? ""}`;
    useEffect(() => {
        if (historyOpen) void loadHistory();
    }, [historyOpen, historyKey, loadHistory]);

    // A pre-contract API returns no review_status: say so instead of offering decisions it cannot take.
    if (!status) {
        return (
            <section role="status" className="mb-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-400" data-decision-card="unavailable">
                Document decisions are unavailable until the Nexus API restarts on the new document registry. Reading and feedback work as usual.
            </section>
        );
    }

    const appliesNow = Boolean(current?.applies_to_current_revision);
    const purpose = doc.purpose?.trim();
    const action = doc.intended_action && doc.intended_action !== "none" ? ACTION_TEXT[doc.intended_action] ?? doc.intended_action : null;
    const blocked = !viewingCurrent
        ? "You are viewing the revision your feedback was pinned to. Switch to the current file to decide; a decision applies to the revision on screen."
        : data.file_state !== "ok"
            ? "The file cannot be confirmed right now, so no decision can be recorded until it can."
            : !viewedRevision
                ? "No captured revision to decide on yet."
                : null;

    const open = (kind: DecisionKind) => {
        setNotice(null);
        // One id per attempt: a retry after a lost response is answered from the record instead of recorded twice.
        setConfirm((prev) => (prev && prev.kind === kind ? prev : { kind, clientId: newClientId() }));
    };

    const submit = async () => {
        if (!confirm || !viewedRevision) return;
        setBusy(true);
        setNotice(null);
        try {
            const result = await recordDecision(doc.id, {
                decision: confirm.kind,
                revision_id: viewedRevision.id,
                content_hash: viewedRevision.content_hash,
                note: note.trim() || undefined,
                client_decision_id: confirm.clientId,
            });
            setNotice({ tone: "ok", text: `${DECISION_TEXT[result.decision.decision].past} rev ${shortHash(result.decision.content_hash)}${result.duplicate ? " (already on record)" : ""}. Nothing was sent or published.` });
            setConfirm(null);
            setNote("");
            await onRefresh();
        } catch (err) {
            const refusal = refusalMessage(err);
            setNotice({ tone: refusal.stale ? "stale" : "error", text: refusal.text });
            if (refusal.reload) {
                // The decision was refused for good: the next attempt is a new decision with a new id; the note is kept.
                setConfirm(null);
                await onRefresh();
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/50 p-3" data-decision-card={status}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-slate-200">Your decision</span>
                <DocumentStatusBadge status={status} prefix />
                {current && (
                    <span className="text-[11px] text-slate-400" data-current-decision={current.decision}>
                        {DECISION_TEXT[current.decision].past} rev {shortHash(current.content_hash)} {formatWhen(current.created_at)}
                        {appliesNow ? "" : "; the document has changed since, so its current revision needs a fresh decision"}
                    </span>
                )}
            </div>
            {purpose && <p className="mt-1.5 text-xs text-slate-300" data-decision-purpose="">Purpose: {purpose}</p>}
            {status !== "reference" && (
                <p className="mt-1 text-[11px] text-slate-500">
                    Records your decision on rev {shortHash(viewedRevision?.content_hash)}.{action ? ` Approval is what allows ${action}, by its owner, separately.` : ""}{" "}
                    Nothing is sent or published from here, and the task&apos;s own status and QA verdict are not changed.
                </p>
            )}
            {status === "reference" ? (
                <p className="mt-1.5 text-[11px] text-slate-500">Reference document: kept for reading, no decision needed.</p>
            ) : blocked ? (
                <p className="mt-2 text-[11px] text-amber-200" data-decision-blocked="">{blocked}</p>
            ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => open("approve")}
                        disabled={busy || (appliesNow && current?.decision === "approve")}
                        title={appliesNow && current?.decision === "approve" ? "This revision is already approved" : undefined}
                        aria-expanded={confirm?.kind === "approve"}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-400/50 bg-sky-400/10 px-3 py-1.5 text-xs font-semibold text-sky-100 hover:bg-sky-400/20 disabled:opacity-40"
                        data-decision-button="approve"
                    >
                        <ThumbsUp size={13} /> {DECISION_TEXT.approve.button}
                    </button>
                    <button
                        type="button"
                        onClick={() => open("request_changes")}
                        disabled={busy || (appliesNow && current?.decision === "request_changes")}
                        title={appliesNow && current?.decision === "request_changes" ? "Changes are already requested on this revision" : undefined}
                        aria-expanded={confirm?.kind === "request_changes"}
                        className="inline-flex items-center gap-1 rounded-md border border-orange-500/50 bg-orange-500/10 px-3 py-1.5 text-xs font-semibold text-orange-100 hover:bg-orange-500/20 disabled:opacity-40"
                        data-decision-button="request_changes"
                    >
                        <Undo2 size={13} /> {DECISION_TEXT.request_changes.button}
                    </button>
                </div>
            )}
            {confirm && !blocked && (
                <div className="mt-2 rounded-md border border-slate-700 bg-slate-950 p-2.5" data-decision-confirm={confirm.kind}>
                    <p className="text-[11px] text-slate-300">
                        {confirm.kind === "approve"
                            ? `Approve rev ${shortHash(viewedRevision?.content_hash)} exactly as shown.`
                            : `Request changes on rev ${shortHash(viewedRevision?.content_hash)}. To tell Praxis what to change, add comments and use Finish review.`}
                    </p>
                    <label className="mt-2 block text-[11px] font-semibold text-slate-300" htmlFor="decision-note">Note (optional, kept with the decision)</label>
                    <textarea
                        id="decision-note"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="mt-1 h-16 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                        <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Cancel</button>
                        <button type="button" onClick={() => void submit()} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 disabled:opacity-50" data-decision-submit="">
                            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {DECISION_TEXT[confirm.kind].confirm}
                        </button>
                    </div>
                </div>
            )}
            {notice && (
                <p
                    role={notice.tone === "ok" ? "status" : "alert"}
                    className={`mt-2 flex items-start gap-1 text-[11px] ${notice.tone === "ok" ? "text-sky-200" : notice.tone === "stale" ? "text-amber-200" : "text-rose-200"}`}
                    data-decision-notice={notice.tone}
                >
                    {notice.tone === "ok" ? <Check size={12} className="mt-0.5 shrink-0" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0" />} {notice.text}
                </p>
            )}
            <button type="button" onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen} className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200" data-history-toggle="">
                {historyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <History size={12} /> History: revisions, decisions and feedback
            </button>
            {historyOpen && (
                <div className="mt-2">
                    {historyError ? (
                        <p role="alert" className="text-[11px] text-rose-200">Could not load history: {historyError} <button type="button" onClick={() => void loadHistory()} className="underline">Retry</button></p>
                    ) : history ? (
                        <HistoryList history={history} currentRevisionId={history.current_revision_id} />
                    ) : (
                        <p className="flex items-center gap-1 text-[11px] text-slate-500"><Loader2 size={12} className="animate-spin" /> Loading history…</p>
                    )}
                </div>
            )}
        </section>
    );
}
