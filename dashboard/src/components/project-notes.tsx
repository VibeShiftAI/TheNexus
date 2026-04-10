"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
    getProjectNotes,
    createNote,
    updateNote,
    deleteNote,
    Note,
} from "@/lib/nexus";
import {
    StickyNote,
    Plus,
    Pin,
    PinOff,
    Trash2,
    ChevronDown,
    ChevronUp,
    Bot,
    User,
    AlertCircle,
    Lightbulb,
    Flag,
    Clock,
    Loader2,
    Send,
} from "lucide-react";

const CATEGORIES = [
    { key: "all", label: "All" },
    { key: "general", label: "General", color: "text-slate-400", bgColor: "bg-slate-500/20 border-slate-500/30", activeColor: "bg-slate-500/30 text-slate-200", icon: <StickyNote size={12} /> },
    { key: "decision", label: "Decisions", color: "text-purple-400", bgColor: "bg-purple-500/20 border-purple-500/30", activeColor: "bg-purple-500/30 text-purple-200", icon: <Lightbulb size={12} /> },
    { key: "blocker", label: "Blockers", color: "text-red-400", bgColor: "bg-red-500/20 border-red-500/30", activeColor: "bg-red-500/30 text-red-200", icon: <AlertCircle size={12} /> },
    { key: "reminder", label: "Reminders", color: "text-amber-400", bgColor: "bg-amber-500/20 border-amber-500/30", activeColor: "bg-amber-500/30 text-amber-200", icon: <Clock size={12} /> },
    { key: "daily-log", label: "Daily Log", color: "text-cyan-400", bgColor: "bg-cyan-500/20 border-cyan-500/30", activeColor: "bg-cyan-500/30 text-cyan-200", icon: <Flag size={12} /> },
] as const;

const CATEGORY_MAP: Record<string, { label: string; color: string; bgColor: string; icon: React.ReactNode }> = {
    general:   { label: "General", color: "text-slate-400", bgColor: "bg-slate-500/20 border-slate-500/30", icon: <StickyNote size={12} /> },
    decision:  { label: "Decision", color: "text-purple-400", bgColor: "bg-purple-500/20 border-purple-500/30", icon: <Lightbulb size={12} /> },
    blocker:   { label: "Blocker", color: "text-red-400", bgColor: "bg-red-500/20 border-red-500/30", icon: <AlertCircle size={12} /> },
    reminder:  { label: "Reminder", color: "text-amber-400", bgColor: "bg-amber-500/20 border-amber-500/30", icon: <Clock size={12} /> },
    "daily-log": { label: "Daily Log", color: "text-cyan-400", bgColor: "bg-cyan-500/20 border-cyan-500/30", icon: <Flag size={12} /> },
};

function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

interface ProjectNotesProps {
    projectId: string;
}

export function ProjectNotes({ projectId }: ProjectNotesProps) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);
    const [activeTab, setActiveTab] = useState("all");
    const [showInput, setShowInput] = useState(false);
    const [newContent, setNewContent] = useState("");
    const [newCategory, setNewCategory] = useState("general");
    const [submitting, setSubmitting] = useState(false);

    const loadNotes = useCallback(async () => {
        try {
            const data = await getProjectNotes(projectId);
            setNotes(data);
        } catch (err) {
            console.error("[ProjectNotes] Failed to load:", err);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        loadNotes();
    }, [loadNotes]);

    // Compute counts per category for tab badges
    const categoryCounts = useMemo(() => {
        const counts: Record<string, number> = { all: notes.length };
        for (const note of notes) {
            counts[note.category] = (counts[note.category] || 0) + 1;
        }
        return counts;
    }, [notes]);

    // Filter notes by active tab, pinned first
    const filteredNotes = useMemo(() => {
        const filtered = activeTab === "all"
            ? notes
            : notes.filter((n) => n.category === activeTab);
        // Pinned notes float to top
        return [...filtered].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
    }, [notes, activeTab]);

    const handleCreate = async () => {
        if (!newContent.trim()) return;
        setSubmitting(true);
        try {
            await createNote(newContent.trim(), newCategory, projectId);
            setNewContent("");
            setNewCategory("general");
            setShowInput(false);
            await loadNotes();
        } catch (err) {
            console.error("[ProjectNotes] Failed to create:", err);
        } finally {
            setSubmitting(false);
        }
    };

    const handlePin = async (note: Note) => {
        try {
            await updateNote(note.id, { pinned: note.pinned ? 0 : 1 });
            await loadNotes();
        } catch (err) {
            console.error("[ProjectNotes] Failed to toggle pin:", err);
        }
    };

    const handleDelete = async (noteId: string) => {
        try {
            await deleteNote(noteId);
            await loadNotes();
        } catch (err) {
            console.error("[ProjectNotes] Failed to delete:", err);
        }
    };

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
            {/* Header */}
            <div
                role="button"
                tabIndex={0}
                onClick={() => setCollapsed(!collapsed)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(!collapsed); } }}
                className="w-full flex items-center justify-between p-4 hover:bg-slate-800/30 transition-colors cursor-pointer"
            >
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                        <StickyNote size={18} />
                    </div>
                    <div className="text-left">
                        <h3 className="text-sm font-bold text-white">
                            Project Notes
                        </h3>
                        <p className="text-xs text-slate-500">
                            {notes.length === 0
                                ? "No notes yet"
                                : `${notes.length} note${notes.length !== 1 ? "s" : ""}`}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowInput(true);
                            setCollapsed(false);
                        }}
                        className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-amber-400 transition-colors"
                        title="Add Note"
                    >
                        <Plus size={16} />
                    </button>
                    {collapsed ? (
                        <ChevronDown size={16} className="text-slate-500" />
                    ) : (
                        <ChevronUp size={16} className="text-slate-500" />
                    )}
                </div>
            </div>

            {!collapsed && (
                <div className="px-4 pb-4 space-y-3">
                    {/* Category Tabs */}
                    <div className="flex items-center gap-1 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
                        {CATEGORIES.map((cat) => {
                            const count = categoryCounts[cat.key] || 0;
                            const isActive = activeTab === cat.key;
                            return (
                                <button
                                    key={cat.key}
                                    onClick={() => setActiveTab(cat.key)}
                                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                                        isActive
                                            ? cat.key === "all"
                                                ? "bg-slate-700 text-white"
                                                : (cat as typeof CATEGORIES[number] & { activeColor?: string }).activeColor || "bg-slate-700 text-white"
                                            : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                                    }`}
                                >
                                    {cat.key !== "all" && (cat as typeof CATEGORIES[number] & { icon?: React.ReactNode }).icon}
                                    {cat.label}
                                    {count > 0 && (
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                            isActive ? "bg-white/10" : "bg-slate-800"
                                        }`}>
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* New Note Input */}
                    {showInput && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                            <textarea
                                value={newContent}
                                onChange={(e) => setNewContent(e.target.value)}
                                placeholder="Write a note..."
                                rows={3}
                                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-none"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                        handleCreate();
                                    }
                                }}
                            />
                            <div className="flex items-center justify-between">
                                <select
                                    value={newCategory}
                                    onChange={(e) => setNewCategory(e.target.value)}
                                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none"
                                >
                                    <option value="general">General</option>
                                    <option value="decision">Decision</option>
                                    <option value="blocker">Blocker</option>
                                    <option value="reminder">Reminder</option>
                                </select>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => {
                                            setShowInput(false);
                                            setNewContent("");
                                        }}
                                        className="px-3 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleCreate}
                                        disabled={!newContent.trim() || submitting}
                                        className="flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-medium hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                    >
                                        {submitting ? (
                                            <Loader2 size={12} className="animate-spin" />
                                        ) : (
                                            <Send size={12} />
                                        )}
                                        Save
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Loading */}
                    {loading && (
                        <div className="flex items-center justify-center py-4">
                            <Loader2 size={16} className="animate-spin text-slate-500" />
                        </div>
                    )}

                    {/* Empty state */}
                    {!loading && filteredNotes.length === 0 && !showInput && (
                        <p className="text-xs text-slate-600 text-center py-4 italic">
                            {activeTab === "all"
                                ? "Praxis hasn\u2019t left any notes on this project yet."
                                : `No ${CATEGORY_MAP[activeTab]?.label.toLowerCase() || activeTab} notes yet.`}
                        </p>
                    )}

                    {/* Notes List */}
                    {filteredNotes.map((note) => {
                        const cat = CATEGORY_MAP[note.category] || CATEGORY_MAP.general;
                        return (
                            <div
                                key={note.id}
                                className={`group relative rounded-lg border p-3 transition-colors ${
                                    note.pinned
                                        ? "border-amber-500/30 bg-amber-500/5"
                                        : "border-slate-800 bg-slate-800/30 hover:bg-slate-800/50"
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2 mb-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span
                                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${cat.bgColor} ${cat.color}`}
                                        >
                                            {cat.icon} {cat.label}
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                                            {note.source === "praxis" ? (
                                                <Bot size={10} />
                                            ) : (
                                                <User size={10} />
                                            )}
                                            {note.source === "praxis" ? "Praxis" : "You"}
                                        </span>
                                        {note.pinned ? (
                                            <Pin size={10} className="text-amber-400" />
                                        ) : null}
                                    </div>
                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                        <button
                                            onClick={() => handlePin(note)}
                                            className="p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-amber-400 transition-colors"
                                            title={note.pinned ? "Unpin" : "Pin"}
                                        >
                                            {note.pinned ? (
                                                <PinOff size={12} />
                                            ) : (
                                                <Pin size={12} />
                                            )}
                                        </button>
                                        <button
                                            onClick={() => handleDelete(note.id)}
                                            className="p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-red-400 transition-colors"
                                            title="Delete"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                </div>
                                <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                                    {note.content}
                                </p>
                                <p className="text-[10px] text-slate-600 mt-2">
                                    {formatRelativeTime(note.created_at)}
                                </p>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
