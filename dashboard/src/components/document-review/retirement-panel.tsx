"use client";

/**
 * Retiring replaced documents on the review page (task d9f46e2f, contract §13).
 *
 * RetirementBanner: on a retired document, what replaced it (a link), when, why, from which task, and how to put it
 * back. A manual close of 2026-11-18/19 (metadata.review_closed) renders in exactly the same form.
 * ReplacesPanel: on the replacing document, every document it named as replaced, with the outcome and every reason a
 * name retired nothing (yet). NamedAsReplacedNotice: on a document another one named but left waiting.
 *
 * Read-only. Nothing here approves, requests changes or reopens anything; "Move to review queue" in the review panel
 * is the one way back (the existing request-review call).
 */
import Link from "next/link";
import { Archive } from "lucide-react";
import {
    documentHref,
    type DocumentRetirement,
    type DocumentRetirementRef,
    type DocumentSupersession,
    type ReplacedName,
    type SupersessionOutcome,
} from "@/lib/document-review";

const STATUS_WORDS: Record<string, string> = {
    needs_review: "Needs your review",
    changes_requested: "Changes requested",
    approved: "Approved",
    reference: "Reference",
    in_progress: "In progress",
};

/** Outcome chips: what happened to one name. */
const OUTCOME_LABELS: Record<SupersessionOutcome, { text: string; tone: string }> = {
    retired: { text: "Moved to Reference", tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" },
    pending: { text: "Not applied yet", tone: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" },
    left_waiting: { text: "Left waiting", tone: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
    not_found: { text: "Not found", tone: "border-slate-600 bg-slate-800/60 text-slate-300" },
    not_waiting: { text: "Already out of the queue", tone: "border-slate-600 bg-slate-800/60 text-slate-300" },
    self: { text: "Names this document", tone: "border-slate-600 bg-slate-800/60 text-slate-300" },
    ambiguous: { text: "Path names several documents", tone: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
};

function formatWhen(iso: string | null | undefined): string {
    if (!iso) return "an unknown time";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function nameText(named: ReplacedName | null): string {
    if (!named) return "";
    const [field, value] = Object.entries(named)[0] ?? [];
    if (!field || !value) return "";
    return `${field === "document_id" ? "document id" : field === "deliverable_key" ? "deliverable key" : "path"} ${value}`;
}

/** A link to a document in a retirement record, by its title (its id when it no longer exists). */
function DocumentLink({ doc, attr }: { doc: DocumentRetirementRef; attr: string }) {
    if (!doc.exists) return <span className="font-mono" {...{ [attr]: doc.document_id }}>{doc.document_id} (no longer registered)</span>;
    return (
        <Link href={documentHref(doc.document_id)} className="underline decoration-slate-500 underline-offset-2 hover:text-white" {...{ [attr]: doc.document_id }}>
            {doc.title || doc.document_id}
        </Link>
    );
}

function TaskLink({ taskId, attr }: { taskId: string; attr: string }) {
    return <Link href={`/task/${encodeURIComponent(taskId)}`} className="underline decoration-slate-500 underline-offset-2" {...{ [attr]: taskId }}>task {taskId.slice(0, 8)}</Link>;
}

/** The retirement in force on this document, in one form for a registration's retirement and a manual close alike. */
export function RetirementBanner({ retirement }: { retirement: DocumentRetirement }) {
    const manual = retirement.source === "manual";
    const earlier = retirement.previous?.review_status ? STATUS_WORDS[retirement.previous.review_status] ?? retirement.previous.review_status : null;
    return (
        <div role="status" className="mb-4 flex flex-wrap items-start gap-2 rounded-lg border border-slate-600 bg-slate-900/70 p-3 text-xs text-slate-200" data-retirement-banner={retirement.source}>
            <Archive size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-1">
                <p>
                    <span className="mr-2 inline-flex items-center rounded-full border border-slate-500 px-1.5 py-px text-[11px] text-slate-300">{manual ? "Closed by hand" : "Retired"}</span>
                    <strong className="font-semibold">Moved to Reference {formatWhen(retirement.retired_at)}</strong>
                </p>
                {(retirement.replaced_by || manual) && <p data-retirement-replaced-by="">
                    {retirement.replaced_by
                        ? <>Replaced by <DocumentLink doc={retirement.replaced_by} attr="data-retirement-replacement-link" />.</>
                        : <>No replacing document was recorded.</>}
                </p>}
                <p data-retirement-reason="">Reason: {retirement.reason}</p>
                {(retirement.task_id || retirement.registration_id) && (
                    <p className="text-slate-400">
                        {retirement.task_id ? <>From <TaskLink taskId={retirement.task_id} attr="data-retirement-task-link" /></> : "From a registration"}
                        {retirement.registration_id ? <>, registration <span className="font-mono">{retirement.registration_id.slice(0, 8)}</span></> : null}
                        {retirement.named_as ? <>, which named it by {nameText(retirement.named_as)}</> : null}.
                    </p>
                )}
                <p className="text-slate-400">
                    No decision was recorded and nothing was carried out. Move to review queue (in the review panel) puts it back{earlier ? <>, where it was: {earlier}</> : null}.
                </p>
            </div>
        </div>
    );
}

function NameRow({ item }: { item: DocumentSupersession }) {
    const label = OUTCOME_LABELS[item.outcome] ?? { text: item.outcome, tone: "border-slate-600 text-slate-300" };
    const reopened = item.retirement?.state === "reopened";
    return (
        <li className="rounded-md border border-slate-800 bg-slate-950/40 p-2" data-replaces-row={item.outcome} data-replaces-source={item.source}>
            <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[11px] ${label.tone}`}>{label.text}</span>
                <span className="min-w-0 break-words">
                    {item.target ? <DocumentLink doc={item.target} attr="data-replaces-target-link" /> : <span className="font-mono text-slate-300">{nameText(item.named_as) || "unnamed"}</span>}
                    {item.target && item.named_as ? <span className="text-slate-500"> (named by {nameText(item.named_as)})</span> : null}
                    {item.source === "manual" ? <span className="text-slate-500"> (closed by hand)</span> : null}
                </span>
            </div>
            {item.outcome === "retired" && item.retirement && (
                <p className="mt-1 text-slate-400">
                    Moved to Reference {formatWhen(item.retirement.retired_at)}
                    {reopened
                        ? item.retirement.reopened_via === "registration"
                            ? <>; new bytes registered for its review brought it back {formatWhen(item.retirement.reopened_at)}, so this name does not retire it again</>
                            : <>; it was put back in the queue with Move to review queue {formatWhen(item.retirement.reopened_at)}, so this name does not retire it again</>
                        : null}.
                </p>
            )}
            {item.reasons.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-300" data-replaces-reasons="">
                    {item.reasons.map((reason, i) => <li key={`${reason.code}-${i}`} data-reason-code={reason.code}>{reason.message}</li>)}
                </ul>
            )}
            {item.candidates.length > 0 && (
                <p className="mt-1 text-slate-400">
                    Registered as: {item.candidates.map((c, i) => <span key={c.document_id}>{i ? ", " : ""}<DocumentLink doc={c} attr="data-replaces-candidate-link" /></span>)}.
                </p>
            )}
        </li>
    );
}

/** Every document this one names as replaced, each with its outcome and reasons; all of them, never a sample. */
export function ReplacesPanel({ replaces }: { replaces: DocumentSupersession[] }) {
    if (!replaces.length) return null;
    const retired = replaces.filter(r => r.outcome === "retired").length;
    return (
        <section className="mb-4 rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-xs text-slate-200" aria-label="Documents this replaces" data-replaces-panel="">
            <h2 className="font-semibold text-slate-100">Replaces</h2>
            <p className="mt-0.5 text-slate-400">
                This document names {replaces.length} document{replaces.length === 1 ? "" : "s"} it replaces; {retired} moved to Reference. Names apply only while this document is waiting for your review and ready to view, and never by title, project or age.
            </p>
            <ul className="mt-2 space-y-2">
                {replaces.map((item, i) => <NameRow key={item.id ?? `${item.source}-${item.target?.document_id ?? i}`} item={item} />)}
            </ul>
        </section>
    );
}

/** Other documents that named this one as replaced, while it stays in the queue: who, and why it stays. */
export function NamedAsReplacedNotice({ items }: { items: DocumentSupersession[] }) {
    if (!items.length) return null;
    return (
        <div role="status" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" data-named-as-replaced="">
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <li key={item.id ?? i} data-named-as-replaced-row={item.outcome}>
                        {item.replacing ? <DocumentLink doc={item.replacing} attr="data-named-by-link" /> : "Another document"} names this document as replaced
                        {item.outcome === "pending"
                            ? <>. Not applied yet; it is checked again once that document is waiting for your review and ready to view:</>
                            : <>, but it stays in your queue:</>}
                        {item.reasons.length > 0 && (
                            <ul className="mt-0.5 list-disc pl-4">
                                {item.reasons.map((reason, j) => <li key={`${reason.code}-${j}`} data-reason-code={reason.code}>{reason.message}</li>)}
                            </ul>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
