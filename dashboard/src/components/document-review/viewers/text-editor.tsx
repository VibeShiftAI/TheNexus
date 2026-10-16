"use client";

/**
 * Direct editing for text media (contract §4). A plain editor that works on a
 * phone keyboard as well as a desktop: monospace for code, JSON, HTML, SVG and
 * manifests, prose for Markdown with a live split preview. Saving writes a new
 * revision pinned to the one being edited; a stale base is refused by the
 * server and shown here with the choice to reload. Nothing is saved until the
 * reviewer presses Save, and Cancel discards without a round trip.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Eye, EyeOff, Loader2, Save, X } from "lucide-react";
import { DocumentApiError, type MediaType } from "@/lib/document-review";
import { DocumentMarkdown } from "../document-markdown";

export interface TextEditorProps {
    content: string;
    mediaType: MediaType;
    baseRevisionHash: string;
    onSave: (content: string, summary: string) => Promise<void>;
    onCancel: () => void;
    /** The server refused because the file moved on: offer a reload. */
    onReload?: () => void;
}

function language(type: MediaType): string {
    switch (type) {
        case "markdown": return "Markdown";
        case "json": return "JSON";
        case "design": return "Design package manifest (JSON)";
        case "html": return "HTML";
        case "svg": return "SVG";
        case "code": return "Code";
        default: return "Text";
    }
}

export function TextEditor({ content, mediaType, baseRevisionHash, onSave, onCancel, onReload }: TextEditorProps) {
    const [text, setText] = useState(content);
    const [summary, setSummary] = useState("");
    const [preview, setPreview] = useState(mediaType === "markdown");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);
    const areaRef = useRef<HTMLTextAreaElement>(null);
    const gutterRef = useRef<HTMLDivElement>(null);
    const dirty = text !== content;
    const lines = useMemo(() => text.split("\n").length, [text]);
    const mono = mediaType !== "markdown" && mediaType !== "text";

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty && !saving) void save(); }
            if (e.key === "Escape" && !dirty) onCancel();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dirty, saving, text, summary]);

    // Soft tab for code: insert two spaces instead of leaving the field.
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== "Tab" || !mono) return;
        e.preventDefault();
        const el = e.currentTarget;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const next = `${text.slice(0, start)}  ${text.slice(end)}`;
        setText(next);
        requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
    };

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await onSave(text, summary.trim());
        } catch (err) {
            const stale = err instanceof DocumentApiError && err.code === "stale_revision";
            setError({ text: err instanceof Error ? err.message : "Save failed", stale });
        } finally {
            setSaving(false);
        }
    };

    const json = mediaType === "json" || mediaType === "design";
    const jsonError = useMemo(() => {
        if (!json) return null;
        try { JSON.parse(text); return null; } catch (err) { return err instanceof Error ? err.message : "Invalid JSON"; }
    }, [json, text]);

    return (
        <div className="rounded-xl border border-cyan-500/40 bg-slate-950/80" data-text-editor={mediaType}>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 text-[11px] text-slate-300">
                <span className="font-semibold text-cyan-100">Editing</span>
                <span className="text-slate-500">{language(mediaType)} · from rev {baseRevisionHash.slice(0, 8)} · {lines} lines</span>
                {dirty ? <span className="rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-amber-200">unsaved</span> : <span className="text-slate-500">no changes yet</span>}
                {mediaType === "markdown" && (
                    <button type="button" onClick={() => setPreview((p) => !p)} aria-pressed={preview} className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 hover:border-slate-500">
                        {preview ? <EyeOff size={12} /> : <Eye size={12} />} {preview ? "Hide preview" : "Preview"}
                    </button>
                )}
            </div>
            <div className={`grid ${preview && mediaType === "markdown" ? "lg:grid-cols-2" : ""}`}>
                <div className="relative flex min-h-[50vh]">
                    {mono && (
                        <div ref={gutterRef} aria-hidden className="select-none overflow-hidden border-r border-slate-800 bg-slate-950 px-2 py-3 text-right font-mono text-xs leading-6 text-slate-600">
                            {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
                        </div>
                    )}
                    <textarea
                        ref={areaRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onKeyDown}
                        onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
                        spellCheck={!mono}
                        aria-label="Document text"
                        className={`min-h-[50vh] w-full resize-y bg-transparent px-3 py-3 text-slate-100 outline-none ${mono ? "font-mono text-xs leading-6" : "text-[15px] leading-relaxed"}`}
                        data-editor-textarea=""
                    />
                </div>
                {preview && mediaType === "markdown" && (
                    <div className="max-h-[70vh] overflow-y-auto border-t border-slate-800 p-4 lg:border-l lg:border-t-0" data-editor-preview="">
                        <DocumentMarkdown content={text} interactive={false} />
                    </div>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 px-3 py-2">
                <input
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    placeholder="What changed (optional, kept with the revision)"
                    aria-label="Edit summary"
                    className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500/60"
                    data-editor-summary=""
                />
                {jsonError && <span className="inline-flex items-center gap-1 text-[11px] text-amber-200" data-editor-json-error=""><AlertTriangle size={12} /> {jsonError}</span>}
                <button type="button" onClick={onCancel} disabled={saving} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50" data-editor-cancel="">
                    <X size={12} /> {dirty ? "Discard" : "Close"}
                </button>
                <button type="button" onClick={() => void save()} disabled={!dirty || saving || Boolean(jsonError)} className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 disabled:opacity-50" data-editor-save="">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save as new revision
                </button>
            </div>
            {error && (
                <p role="alert" className="flex flex-wrap items-center gap-1 border-t border-rose-500/30 px-3 py-2 text-[11px] text-rose-200" data-editor-error={error.stale ? "stale" : "error"}>
                    <AlertTriangle size={12} /> {error.text}
                    {error.stale && onReload && <button type="button" onClick={onReload} className="ml-1 underline">Reload the current revision</button>}
                    {!error.stale && <span className="text-slate-400">Your text is kept here.</span>}
                </p>
            )}
            {!error && !dirty && (
                <p className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-slate-500"><Check size={11} /> Saving creates a new revision; decisions on the old one do not carry over.</p>
            )}
        </div>
    );
}
