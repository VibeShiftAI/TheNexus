"use client";

import { useState, useMemo } from "react";
import { Check, X, Pencil, ChevronDown, ChevronRight, CheckCircle2, XCircle, FileText, FilePlus } from "lucide-react";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface Hunk {
    id: string;
    start_line: number;
    original_lines: string[];
    proposed_lines: string[];
    context: string;
    status: "pending" | "approved" | "rejected" | "revise";
    revision_comment: string | null;
}

interface FileChange {
    path: string;
    action: "update" | "create";
    original: string | null;
    proposed: string;
    hunks: Hunk[];
}

interface DocChanges {
    files: FileChange[];
}

interface DocDiffReviewerProps {
    changes: DocChanges;
    onDecisionsUpdate?: (changes: DocChanges) => void;
}

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

export function DocDiffReviewer({ changes, onDecisionsUpdate }: DocDiffReviewerProps) {
    const [localChanges, setLocalChanges] = useState<DocChanges>(changes);
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
        new Set(changes.files.map(f => f.path))
    );
    const [reviseInputs, setReviseInputs] = useState<Record<string, string>>({});

    // Stats
    const stats = useMemo(() => {
        let total = 0, approved = 0, rejected = 0, revise = 0, pending = 0;
        localChanges.files.forEach(f => f.hunks.forEach(h => {
            total++;
            if (h.status === "approved") approved++;
            else if (h.status === "rejected") rejected++;
            else if (h.status === "revise") revise++;
            else pending++;
        }));
        return { total, approved, rejected, revise, pending };
    }, [localChanges]);

    // Update a single hunk's status
    const updateHunk = (filePath: string, hunkId: string, status: Hunk["status"], comment?: string) => {
        setLocalChanges(prev => {
            const updated = {
                files: prev.files.map(file => {
                    if (file.path !== filePath) return file;
                    return {
                        ...file,
                        hunks: file.hunks.map(hunk => {
                            if (hunk.id !== hunkId) return hunk;
                            return { ...hunk, status, revision_comment: comment || null };
                        })
                    };
                })
            };
            onDecisionsUpdate?.(updated);
            return updated;
        });
    };

    // Bulk actions
    const setAllStatus = (status: "approved" | "rejected") => {
        setLocalChanges(prev => {
            const updated = {
                files: prev.files.map(file => ({
                    ...file,
                    hunks: file.hunks.map(hunk => ({ ...hunk, status, revision_comment: null }))
                }))
            };
            onDecisionsUpdate?.(updated);
            return updated;
        });
    };

    const toggleFile = (path: string) => {
        setExpandedFiles(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const getStatusColor = (status: Hunk["status"]) => {
        switch (status) {
            case "approved": return "text-emerald-400";
            case "rejected": return "text-red-400";
            case "revise": return "text-amber-400";
            default: return "text-slate-400";
        }
    };

    const getStatusBg = (status: Hunk["status"]) => {
        switch (status) {
            case "approved": return "bg-emerald-500/10 border-emerald-500/30";
            case "rejected": return "bg-red-500/10 border-red-500/30";
            case "revise": return "bg-amber-500/10 border-amber-500/30";
            default: return "bg-slate-800/50 border-slate-700/50";
        }
    };

    return (
        <div className="flex flex-col gap-4 p-4">
            {/* Header with stats and bulk actions */}
            <div className="flex items-center justify-between bg-slate-800/60 rounded-lg p-3 border border-slate-700/50">
                <div className="flex items-center gap-4 text-sm">
                    <span className="text-slate-300 font-medium">
                        {localChanges.files.length} files · {stats.total} changes
                    </span>
                    {stats.approved > 0 && (
                        <span className="text-emerald-400">✓ {stats.approved}</span>
                    )}
                    {stats.rejected > 0 && (
                        <span className="text-red-400">✗ {stats.rejected}</span>
                    )}
                    {stats.revise > 0 && (
                        <span className="text-amber-400">✏ {stats.revise}</span>
                    )}
                    {stats.pending > 0 && (
                        <span className="text-slate-400">● {stats.pending} pending</span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setAllStatus("approved")}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors border border-emerald-500/30"
                    >
                        <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />
                        Approve All
                    </button>
                    <button
                        onClick={() => setAllStatus("rejected")}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors border border-red-500/30"
                    >
                        <XCircle className="w-3.5 h-3.5 inline mr-1" />
                        Reject All
                    </button>
                </div>
            </div>

            {/* File sections */}
            {localChanges.files.map(file => (
                <div key={file.path} className="rounded-lg border border-slate-700/50 overflow-hidden">
                    {/* File header */}
                    <button
                        onClick={() => toggleFile(file.path)}
                        className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800/80 hover:bg-slate-800 transition-colors text-left"
                    >
                        {expandedFiles.has(file.path)
                            ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                            : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                        }
                        {file.action === "create"
                            ? <FilePlus className="w-4 h-4 text-emerald-400 shrink-0" />
                            : <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                        }
                        <span className="text-sm text-slate-200 font-mono truncate">{file.path}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ml-auto shrink-0 ${file.action === "create"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : "bg-blue-500/20 text-blue-400"
                            }`}>
                            {file.action === "create" ? "NEW" : "UPDATE"}
                        </span>
                        <span className="text-xs text-slate-500">{file.hunks.length} hunks</span>
                    </button>

                    {/* Hunks */}
                    {expandedFiles.has(file.path) && (
                        <div className="divide-y divide-slate-700/30">
                            {file.hunks.map((hunk, idx) => (
                                <div
                                    key={hunk.id}
                                    className={`border-l-2 transition-colors ${getStatusBg(hunk.status)}`}
                                >
                                    {/* Hunk diff */}
                                    <div className="px-4 py-2">
                                        <div className="text-xs text-slate-500 mb-2 font-mono">
                                            Hunk #{idx + 1} · Line {hunk.start_line} · {hunk.context}
                                        </div>
                                        <div className="font-mono text-xs rounded bg-slate-900/80 overflow-x-auto">
                                            {/* Removed lines */}
                                            {hunk.original_lines.map((line, i) => (
                                                <div key={`del-${i}`} className="px-3 py-0.5 bg-red-500/10 text-red-300 border-l-2 border-red-500/50">
                                                    <span className="text-red-500/60 select-none mr-2">-</span>
                                                    {line || " "}
                                                </div>
                                            ))}
                                            {/* Added lines */}
                                            {hunk.proposed_lines.map((line, i) => (
                                                <div key={`add-${i}`} className="px-3 py-0.5 bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-500/50">
                                                    <span className="text-emerald-500/60 select-none mr-2">+</span>
                                                    {line || " "}
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Hunk actions */}
                                    <div className="px-4 py-2 flex items-center gap-2">
                                        <button
                                            onClick={() => updateHunk(file.path, hunk.id, "approved")}
                                            className={`px-2.5 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${hunk.status === "approved"
                                                    ? "bg-emerald-500/30 text-emerald-300 ring-1 ring-emerald-500/50"
                                                    : "bg-slate-700/50 text-slate-400 hover:bg-emerald-500/20 hover:text-emerald-400"
                                                }`}
                                        >
                                            <Check className="w-3 h-3" /> Approve
                                        </button>
                                        <button
                                            onClick={() => updateHunk(file.path, hunk.id, "rejected")}
                                            className={`px-2.5 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${hunk.status === "rejected"
                                                    ? "bg-red-500/30 text-red-300 ring-1 ring-red-500/50"
                                                    : "bg-slate-700/50 text-slate-400 hover:bg-red-500/20 hover:text-red-400"
                                                }`}
                                        >
                                            <X className="w-3 h-3" /> Reject
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (hunk.status === "revise") {
                                                    updateHunk(file.path, hunk.id, "pending");
                                                } else {
                                                    updateHunk(file.path, hunk.id, "revise", reviseInputs[hunk.id] || "");
                                                }
                                            }}
                                            className={`px-2.5 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${hunk.status === "revise"
                                                    ? "bg-amber-500/30 text-amber-300 ring-1 ring-amber-500/50"
                                                    : "bg-slate-700/50 text-slate-400 hover:bg-amber-500/20 hover:text-amber-400"
                                                }`}
                                        >
                                            <Pencil className="w-3 h-3" /> Revise
                                        </button>

                                        {/* Status indicator */}
                                        <span className={`ml-auto text-xs ${getStatusColor(hunk.status)}`}>
                                            {hunk.status}
                                        </span>
                                    </div>

                                    {/* Revision comment input */}
                                    {hunk.status === "revise" && (
                                        <div className="px-4 pb-3">
                                            <textarea
                                                value={reviseInputs[hunk.id] || hunk.revision_comment || ""}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    setReviseInputs(prev => ({ ...prev, [hunk.id]: val }));
                                                    updateHunk(file.path, hunk.id, "revise", val);
                                                }}
                                                placeholder="Describe what changes you'd like..."
                                                className="w-full px-3 py-2 text-sm bg-slate-900/80 border border-amber-500/30 rounded-md text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-none"
                                                rows={2}
                                            />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ))}

            {/* Footer summary */}
            {stats.pending === 0 && stats.total > 0 && (
                <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/50 text-sm text-center">
                    <span className="text-slate-300">
                        All changes reviewed: {stats.approved} approved, {stats.rejected} rejected
                        {stats.revise > 0 && `, ${stats.revise} for revision`}
                    </span>
                </div>
            )}
        </div>
    );
}
