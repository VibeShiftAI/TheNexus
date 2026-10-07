"use client";

import { useState } from "react";
import { getReviewTaskOptions, requestDocumentReview, type DocumentRecord, type DocumentBlockingTask } from "@/lib/document-review";

/** Editing a review requirement never changes a task's execution status. */
export function ReviewRequirements({ document: doc, onRefresh }: {
    document: DocumentRecord;
    onRefresh: () => Promise<void> | void;
}) {
    const [open, setOpen] = useState(false);
    const [tasks, setTasks] = useState<DocumentBlockingTask[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function edit() {
        setOpen(true); setLoading(true); setLoaded(false); setError(null); setQuery("");
        setSelected(doc.blocking_task_ids ?? []);
        try {
            const result = await getReviewTaskOptions();
            setTasks(result.tasks); setLoaded(true);
        } catch (err) { setError(err instanceof Error ? err.message : "Could not load tasks"); }
        finally { setLoading(false); }
    }
    async function save() {
        setSaving(true); setError(null);
        try {
            await requestDocumentReview(doc.id, selected);
            await onRefresh();
            setOpen(false);
        } catch (err) { setError(err instanceof Error ? err.message : "Could not save review requirements"); }
        finally { setSaving(false); }
    }
    const options = [...tasks, ...selected.filter(id => !tasks.some(t => t.id === id)).map(id => ({
        id, title: `Inactive or unavailable task (${id})`, status: "inactive", project_id: null, project_name: "",
    }))];
    const visible = options.filter(t => `${t.title} ${t.project_name || ""}`.toLowerCase().includes(query.toLowerCase()));
    const buttonStyle = "rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:border-cyan-400 disabled:opacity-50";
    return (
        <div className="mt-2" data-review-requirements="">
            {!open ? (
                <button type="button" onClick={() => void edit()} className={buttonStyle}>
                    {doc.requires_review === false ? "Move to review queue" : "Edit waiting tasks"}
                </button>
            ) : (
                <div className="rounded border border-slate-700 p-3 text-xs">
                    <p className="text-slate-200">Which tasks need this document approved before work can continue?</p>
                    <p className="mt-1 text-slate-400">Choose only tasks waiting on this review. You can also request a review with no waiting tasks.</p>
                    {loading ? <p role="status" className="mt-2 text-slate-400">Loading tasks…</p> : loaded && (
                        <>
                            <input aria-label="Find waiting tasks" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a task or project…" className="mt-2 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5" />
                            <div className="mt-2 max-h-52 space-y-2 overflow-auto">
                                {visible.map(task => (
                                    <label key={task.id} className="flex items-start gap-2 text-slate-300">
                                        <input type="checkbox" disabled={saving} checked={selected.includes(task.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} className="mt-0.5" />
                                        <span>{task.title}{task.project_name && <span className="block text-[11px] text-slate-500">{task.project_name}</span>}</span>
                                    </label>
                                ))}
                                {!visible.length && <p className="text-slate-500">No matching active tasks.</p>}
                            </div>
                            <p className="mt-2 text-slate-400">{selected.length} selected</p>
                        </>
                    )}
                    {error && <p role="alert" className="mt-2 text-rose-300">{error}</p>}
                    <div className="mt-2 flex gap-2">
                        <button type="button" onClick={() => void save()} disabled={!loaded || loading || saving || selected.length > 100} className={buttonStyle}>{saving ? "Saving…" : "Save review requirements"}</button>
                        {!loaded && !loading && <button type="button" onClick={() => void edit()} className={buttonStyle}>Retry</button>}
                        <button type="button" onClick={() => setOpen(false)} disabled={saving} className={buttonStyle}>Cancel</button>
                    </div>
                </div>
            )}
        </div>
    );
}
