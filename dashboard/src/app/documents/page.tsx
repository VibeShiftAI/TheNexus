"use client";

/**
 * Reviews: /documents.
 *
 * The Dashboard's queue of every Markdown document the Nexus API has
 * registered (reports, specs, plans, drafts Praxis delivers for Robert),
 * opening on "Needs your review". Status, search, project, task and kind are
 * filtered by the server, which also returns the truthful total and the
 * per-status counts (contract docs/contracts/document-review-deliverables.md
 * §4), so the queue pages through any number of documents. Reference
 * documents never count as pending and stay listed under All and Reference.
 *
 * Reached from the bridge header's Reviews button, the navigation menu, the
 * reviewer's crumb and task/project Deliverables; everything here is a
 * same-origin Next route served through the Dashboard's session and /api
 * proxy, so no separate sign-in is ever involved (2026-09-10, task 762637e6;
 * queue 2026-10-02, task 75de5032).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, FileCheck2, Loader2, RefreshCw, Search, X } from "lucide-react";
import {
    DOCUMENT_KINDS,
    countDocuments,
    listDocumentsPage,
    stepBackOffset,
    type DocumentCounts,
    type DocumentPage,
    type DocumentStatusFilter,
} from "@/lib/document-review";
import { getProjects, getTasks } from "@/lib/nexus";
import { DeliverableRow } from "@/components/document-review/deliverable-row";

const POLL_MS = 30_000;
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

const STATUS_TABS: { key: DocumentStatusFilter; label: string }[] = [
    { key: "needs_review", label: "Needs your review" },
    { key: "changes_requested", label: "Changes requested" },
    { key: "approved", label: "Approved" },
    { key: "reference", label: "Reference" },
    { key: "all", label: "All" },
];
const STATUS_KEYS = new Set<string>(STATUS_TABS.map((tab) => tab.key));

interface QueueFilters {
    status: DocumentStatusFilter;
    q: string;
    project_id: string;
    task_id: string;
    kind: string;
    offset: number;
}

const DEFAULT_FILTERS: QueueFilters = { status: "needs_review", q: "", project_id: "", task_id: "", kind: "", offset: 0 };

/** Filters from the address bar, so task/project links and a reload land on the same view. */
function filtersFromLocation(): QueueFilters {
    if (typeof window === "undefined") return DEFAULT_FILTERS;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status") || "";
    const offset = Number(params.get("offset") || 0);
    return {
        status: STATUS_KEYS.has(status) ? (status as DocumentStatusFilter) : DEFAULT_FILTERS.status,
        q: params.get("q") || "",
        project_id: params.get("project_id") || "",
        task_id: params.get("task_id") || "",
        kind: (DOCUMENT_KINDS as readonly string[]).includes(params.get("kind") || "") ? (params.get("kind") as string) : "",
        offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    };
}

function writeLocation(filters: QueueFilters) {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (filters.status !== DEFAULT_FILTERS.status) params.set("status", filters.status);
    if (filters.q) params.set("q", filters.q);
    if (filters.project_id) params.set("project_id", filters.project_id);
    if (filters.task_id) params.set("task_id", filters.task_id);
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.offset) params.set("offset", String(filters.offset));
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
}

export default function DocumentsPage() {
    const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
    const [ready, setReady] = useState(false);
    const [searchText, setSearchText] = useState("");
    const [page, setPage] = useState<DocumentPage | null>(null);
    const [counts, setCounts] = useState<DocumentCounts | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
    const [tasks, setTasks] = useState<{ id: string; title: string }[]>([]);
    const requestSeq = useRef(0);

    // Read the address bar once on mount (not during render: the static
    // prerender has no location).
    useEffect(() => {
        const initial = filtersFromLocation();
        setFilters(initial);
        setSearchText(initial.q);
        setReady(true);
    }, []);

    useEffect(() => {
        let active = true;
        getProjects()
            .then((list) => { if (active) setProjects((list || []).map((p) => ({ id: p.id, name: p.name }))); })
            .catch(() => { /* the project filter falls back to ids; the queue itself is unaffected */ });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        if (!filters.project_id) { setTasks([]); return; }
        let active = true;
        getTasks(filters.project_id)
            .then((res) => { if (active) setTasks((res.tasks || []).map((t) => ({ id: t.id, title: t.title || t.id }))); })
            .catch(() => { if (active) setTasks([]); });
        return () => { active = false; };
    }, [filters.project_id]);

    const load = useCallback(async (current: QueueFilters) => {
        const seq = ++requestSeq.current;
        setLoading(true);
        const scope = { q: current.q, project_id: current.project_id, task_id: current.task_id, kind: current.kind };
        const [pageResult, countResult] = await Promise.allSettled([
            listDocumentsPage({ ...scope, status: current.status, limit: PAGE_SIZE, offset: current.offset }),
            countDocuments(scope),
        ]);
        if (seq !== requestSeq.current) return; // a newer filter change owns the screen
        if (pageResult.status === "fulfilled") {
            setPage(pageResult.value);
            setError(null);
        } else {
            const reason = pageResult.reason;
            setError(reason instanceof Error ? reason.message : "Failed to load documents");
        }
        // Counts are shown only when the server actually computed them; a
        // failed count is left blank rather than shown as zero.
        setCounts(countResult.status === "fulfilled" ? countResult.value : null);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (!ready) return;
        writeLocation(filters);
        void load(filters);
        const timer = window.setInterval(() => void load(filters), POLL_MS);
        return () => window.clearInterval(timer);
    }, [ready, filters, load]);

    // Server-driven search: debounce typing, then refilter from the first page.
    useEffect(() => {
        if (!ready) return;
        const value = searchText.trim();
        if (value === filters.q) return;
        const timer = window.setTimeout(() => setFilters((prev) => ({ ...prev, q: value, offset: 0 })), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [searchText, filters.q, ready]);

    // A page can empty under the reader (decisions move documents out of the
    // view): step back to the last page that still has documents rather than
    // calling a non-empty view empty.
    const stepBack = stepBackOffset(page, PAGE_SIZE);
    useEffect(() => {
        if (stepBack === null) return;
        setFilters((prev) => (prev.offset > stepBack ? { ...prev, offset: stepBack } : prev));
    }, [stepBack]);

    const update = (patch: Partial<QueueFilters>) => setFilters((prev) => ({ ...prev, offset: 0, ...patch }));
    const clearFilters = () => { setSearchText(""); setFilters((prev) => ({ ...DEFAULT_FILTERS, status: prev.status })); };

    const projectNames = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
    const legacy = Boolean(page?.legacy);
    const narrowed = Boolean(filters.q || filters.project_id || filters.task_id || filters.kind);
    const documents = page?.documents ?? [];
    const total = page?.total ?? 0;
    const firstShown = documents.length ? (page?.offset ?? 0) + 1 : 0;
    const lastShown = (page?.offset ?? 0) + documents.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageNumber = Math.floor((page?.offset ?? 0) / PAGE_SIZE) + 1;
    const taskTitle = tasks.find((t) => t.id === filters.task_id)?.title;
    const statusLabel = STATUS_TABS.find((tab) => tab.key === filters.status)?.label ?? "All";

    const emptyMessage = (() => {
        if (legacy) return "No documents registered yet.";
        if (counts && counts.all === 0 && !narrowed) return "No documents registered yet. When Praxis delivers a document for you, it appears here, on its task and in your Praxis conversation.";
        if (narrowed) return "No documents match these filters.";
        if (filters.status === "needs_review") return "Nothing is waiting for your review.";
        if (filters.status === "changes_requested") return "No documents are waiting on requested changes.";
        if (filters.status === "approved") return "No approved documents yet.";
        if (filters.status === "reference") return "No reference documents.";
        return "No documents registered yet.";
    })();

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200" data-documents-index="">
            <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
                <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <Link href="/" className="flex shrink-0 items-center gap-1.5 text-sm text-slate-400 hover:text-white">
                        <ArrowLeft size={16} /> Bridge
                    </Link>
                    <div className="hidden h-5 w-px bg-slate-700 sm:block" />
                    <div className="order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-0">
                        <h1 className="flex items-center gap-2 text-base font-semibold text-white">
                            <FileCheck2 size={16} className="text-cyan-300" /> Reviews
                        </h1>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                            Documents Praxis delivered for you. Open one to read it, comment on passages, then Approve document or Request changes. Finish review only sends your comments to Praxis; nothing here sends or publishes.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void load(filters)}
                        disabled={loading}
                        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-60"
                        aria-label="Refresh documents"
                    >
                        <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
                    </button>
                </div>
            </header>

            <div className="mx-auto max-w-[1100px] px-4 py-5">
                {legacy && (
                    <div role="status" className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-100" data-legacy-notice="">
                        The Nexus API is still running the previous document registry, so review status, filters, search and pending counts are unavailable until it restarts. Showing every registered document it returned.
                    </div>
                )}

                <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Review status">
                    {STATUS_TABS.map((tab) => {
                        const count = counts && !legacy ? counts[tab.key] : null;
                        const active = filters.status === tab.key;
                        return (
                            <button
                                key={tab.key}
                                type="button"
                                aria-pressed={active}
                                disabled={legacy}
                                onClick={() => update({ status: tab.key })}
                                data-status-tab={tab.key}
                                className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-50 ${active && !legacy ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"}`}
                            >
                                {tab.label}
                                {typeof count === "number" && <span className={`ml-1.5 tabular-nums ${tab.key === "needs_review" && count > 0 ? "font-semibold text-amber-200" : ""}`} data-status-count="">{count}</span>}
                            </button>
                        );
                    })}
                </div>

                <div className="mb-4 flex flex-wrap items-center gap-2" data-review-filters="">
                    <label className="relative block w-full sm:w-auto sm:min-w-[12rem] sm:flex-1">
                        <span className="sr-only">Search documents</span>
                        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input
                            type="search"
                            value={searchText}
                            disabled={legacy}
                            onChange={(e) => setSearchText(e.target.value)}
                            placeholder="Search title, purpose or path"
                            aria-label="Search documents"
                            className="w-full rounded-md border border-slate-700 bg-slate-900 py-1.5 pl-8 pr-2 text-xs text-slate-100 outline-none focus:border-cyan-500/60 disabled:opacity-50"
                        />
                    </label>
                    <select
                        value={filters.project_id}
                        disabled={legacy}
                        onChange={(e) => update({ project_id: e.target.value, task_id: "" })}
                        aria-label="Filter by project"
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                    >
                        <option value="">All projects</option>
                        {filters.project_id && !projectNames[filters.project_id] && <option value={filters.project_id}>{filters.project_id}</option>}
                        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {(filters.project_id || filters.task_id) && (
                        <select
                            value={filters.task_id}
                            disabled={legacy}
                            onChange={(e) => update({ task_id: e.target.value })}
                            aria-label="Filter by task"
                            className="max-w-[16rem] rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                        >
                            <option value="">All tasks</option>
                            {filters.task_id && !taskTitle && <option value={filters.task_id}>Task {filters.task_id.slice(0, 8)}</option>}
                            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                        </select>
                    )}
                    <select
                        value={filters.kind}
                        disabled={legacy}
                        onChange={(e) => update({ kind: e.target.value })}
                        aria-label="Filter by kind"
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                    >
                        <option value="">All kinds</option>
                        {DOCUMENT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                    </select>
                    {narrowed && (
                        <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:border-slate-500">
                            <X size={12} /> Clear filters
                        </button>
                    )}
                </div>

                {error && (
                    <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200" data-documents-error="">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>Could not load documents: {error}{page ? " Showing the last loaded results." : ""}</span>
                        <button type="button" onClick={() => void load(filters)} className="ml-auto underline">Retry</button>
                    </div>
                )}

                {page === null && !error ? (
                    <div className="flex items-center gap-2 text-sm text-slate-400" data-documents-loading="">
                        <Loader2 size={16} className="animate-spin text-cyan-300" /> Loading documents…
                    </div>
                ) : page === null ? null : (
                    <>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500" data-documents-summary="" aria-live="polite">
                            <span>
                                {legacy
                                    ? `Showing the ${documents.length} registered documents this API returned`
                                    : total === 0
                                        ? `0 documents · ${statusLabel}`
                                        : stepBack !== null
                                            ? `${total} documents · ${statusLabel}`
                                            : `Showing ${firstShown}–${lastShown} of ${total} · ${statusLabel}`}
                                {loading && <Loader2 size={11} className="ml-1.5 inline animate-spin text-cyan-300" />}
                            </span>
                            {!legacy && total > PAGE_SIZE && stepBack === null && <span>Page {pageNumber} of {pageCount}</span>}
                        </div>
                        {stepBack !== null ? (
                            error ? null : (
                                <div role="status" className="flex items-center gap-2 text-sm text-slate-400" data-documents-stepping-back="">
                                    <Loader2 size={16} className="animate-spin text-cyan-300" /> This page emptied; loading the last page of the {total} remaining…
                                </div>
                            )
                        ) : documents.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500" data-documents-empty="">
                                <p>{emptyMessage}</p>
                                {!legacy && filters.status !== "all" && counts && counts.all > 0 && !narrowed && (
                                    <button type="button" onClick={() => update({ status: "all" })} className="mt-2 text-xs text-cyan-300 hover:underline">
                                        Show all {counts.all} documents
                                    </button>
                                )}
                                {narrowed && (
                                    <button type="button" onClick={clearFilters} className="mt-2 text-xs text-cyan-300 hover:underline">Clear filters</button>
                                )}
                            </div>
                        ) : (
                            <ul className="space-y-2" aria-busy={loading}>
                                {documents.map((entry) => (
                                    <DeliverableRow key={entry.id} entry={entry} projectNames={projectNames} />
                                ))}
                            </ul>
                        )}
                        {!legacy && total > PAGE_SIZE && stepBack === null && (
                            <nav className="mt-4 flex items-center justify-between gap-2" aria-label="Pages" data-documents-pager="">
                                <button
                                    type="button"
                                    disabled={(page.offset ?? 0) === 0 || loading}
                                    onClick={() => setFilters((prev) => ({ ...prev, offset: Math.max(0, prev.offset - PAGE_SIZE) }))}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
                                >
                                    <ChevronLeft size={13} /> Previous
                                </button>
                                <span className="text-[11px] text-slate-500">Page {pageNumber} of {pageCount}</span>
                                <button
                                    type="button"
                                    disabled={!page.has_more || loading}
                                    onClick={() => setFilters((prev) => ({ ...prev, offset: prev.offset + PAGE_SIZE }))}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
                                >
                                    Next <ChevronRight size={13} />
                                </button>
                            </nav>
                        )}
                    </>
                )}
            </div>
        </main>
    );
}
