"use client";

/**
 * One registered document as a row: title, purpose, current version, the
 * document's own editorial status, the caller's feedback state and a direct
 * Open into the shared reviewer at /documents/<id>. The Reviews queue, the
 * bridge's "Ready for your review" section, task Deliverables and project
 * Deliverables all render the same registry record through this, so a
 * document reads the same wherever it is found. Every link is a relative,
 * same-origin route: the desktop app never hands a document to an external
 * (unauthenticated) browser.
 */

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
    documentHref,
    documentStatusLabel,
    reviewStateLabel,
    type DocumentListEntry,
    type DocumentReviewStatus,
} from "@/lib/document-review";

export function DocumentStatusBadge({ status, prefix = false }: { status: DocumentReviewStatus | undefined; prefix?: boolean }) {
    const label = documentStatusLabel(status);
    if (!label) return null;
    return (
        <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 ${label.tone}`}
            data-document-status={status}
            title="Your editorial decision on this document. Task status and QA verdicts are tracked separately."
        >
            {prefix ? `Document: ${label.text.replace(/^Document /, "").toLowerCase()}` : label.text}
        </span>
    );
}

function fileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
}

function formatWhen(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export interface DeliverableRowProps {
    entry: DocumentListEntry;
    /** Project names by id, for a readable project link; falls back to "project". */
    projectNames?: Record<string, string>;
    /** Hide the task / project links where the surrounding screen already is that task or project. */
    showTask?: boolean;
    showProject?: boolean;
    /** Home rail: title, purpose, status and Open only. */
    compact?: boolean;
}

export function DeliverableRow({ entry, projectNames, showTask = true, showProject = true, compact = false }: DeliverableRowProps) {
    const href = documentHref(entry.id);
    const feedback = reviewStateLabel(entry);
    const captured = formatWhen(entry.current_revision?.captured_at);
    const action = entry.requires_review && entry.intended_action && entry.intended_action !== "none" ? entry.intended_action : null;
    const projectName = entry.project_id ? projectNames?.[entry.project_id] : null;

    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5" data-document-id={entry.id}>
            <div className="min-w-0 flex-1 basis-56">
                <Link href={href} className="block truncate text-sm font-medium text-slate-100 hover:text-cyan-200" title={entry.title}>
                    {entry.title}
                </Link>
                {entry.purpose && (
                    <p className={`mt-0.5 text-[12px] leading-snug text-slate-400 ${compact ? "line-clamp-1" : "line-clamp-2"}`} data-document-purpose="">
                        {entry.purpose}
                    </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    <DocumentStatusBadge status={entry.review_status} />
                    {!compact && <span className="uppercase tracking-wide">{entry.kind}</span>}
                    {!compact && <span className="max-w-[16rem] truncate font-mono" title={entry.path}>{fileName(entry.path)}</span>}
                    {entry.current_revision && (
                        <span title={entry.current_revision.content_hash} data-document-version="">
                            rev {entry.current_revision.content_hash.slice(0, 8)}{captured && !compact ? ` · ${captured}` : ""}
                        </span>
                    )}
                    {action && (
                        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-400" title="What happens after approval, done separately by its owner; approving here never does it">
                            then: {action}
                        </span>
                    )}
                    {showTask && entry.task_id && (
                        <Link href={`/task/${encodeURIComponent(entry.task_id)}`} className="text-cyan-300 hover:underline">from task</Link>
                    )}
                    {showProject && entry.project_id && (
                        <Link href={`/project/${encodeURIComponent(entry.project_id)}`} className="text-cyan-300 hover:underline">{projectName || "project"}</Link>
                    )}
                    {!compact && <span className={`rounded-full border px-2 py-0.5 ${feedback.tone}`} data-feedback-state="">{feedback.text}</span>}
                </div>
            </div>
            <Link
                href={href}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20"
                data-review-link=""
                aria-label={`Open ${entry.title}`}
            >
                Open <ArrowRight size={13} />
            </Link>
        </li>
    );
}
