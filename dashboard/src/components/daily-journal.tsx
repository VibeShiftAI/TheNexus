"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
    getGlobalNotes,
    createNote,
    deleteNote,
    Note,
} from "@/lib/nexus";
import {
    BookOpen,
    Bot,
    User,
    Plus,
    Trash2,
    Loader2,
    Send,
    ChevronDown,
    ChevronUp,
    StickyNote,
    Lightbulb,
    AlertCircle,
    Clock,
    Flag,
} from "lucide-react";

const JOURNAL_TABS = [
    { key: "all", label: "All" },
    { key: "daily-log", label: "Daily Log", color: "text-cyan-400", activeColor: "bg-cyan-500/30 text-cyan-200", icon: <Flag size={11} /> },
    { key: "general", label: "General", color: "text-slate-400", activeColor: "bg-slate-500/30 text-slate-200", icon: <StickyNote size={11} /> },
    { key: "decision", label: "Decisions", color: "text-purple-400", activeColor: "bg-purple-500/30 text-purple-200", icon: <Lightbulb size={11} /> },
    { key: "blocker", label: "Blockers", color: "text-red-400", activeColor: "bg-red-500/30 text-red-200", icon: <AlertCircle size={11} /> },
    { key: "reminder", label: "Reminders", color: "text-amber-400", activeColor: "bg-amber-500/30 text-amber-200", icon: <Clock size={11} /> },
] as const;

function formatDateHeading(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const noteDay = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
    );
    const diffDays = Math.floor(
        (today.getTime() - noteDay.getTime()) / 86400000
    );

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
}

function formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}

const CATEGORY_BADGE: Record<string, { label: string; color: string }> = {
    "daily-log": { label: "Log", color: "text-cyan-400 bg-cyan-500/10" },
    general: { label: "General", color: "text-slate-400 bg-slate-500/10" },
    decision: { label: "Decision", color: "text-purple-400 bg-purple-500/10" },
    blocker: { label: "Blocker", color: "text-red-400 bg-red-500/10" },
    reminder: { label: "Reminder", color: "text-amber-400 bg-amber-500/10" },
};

export function DailyJournal() {
    const [notes, setNotes] = useState<Note[]>([]);
    const [loading, setLoading] = useState(true);
    const [showInput, setShowInput] = useState(false);
    const [newContent, setNewContent] = useState("");
    const [newCategory, setNewCategory] = useState("daily-log");
    const [submitting, setSubmitting] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState("all");

    const loadNotes = useCallback(async () => {
        try {
            const data = await getGlobalNotes();
            setNotes(data);
        } catch (err) {
            console.error("[DailyJournal] Failed to load:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadNotes();
    }, [loadNotes]);

    // Counts per category
    const categoryCounts = useMemo(() => {
        const counts: Record<string, number> = { all: notes.length };
        for (const note of notes) {
            counts[note.category] = (counts[note.category] || 0) + 1;
        }
        return counts;
    }, [notes]);

    // Filter by active tab
    const filteredNotes = useMemo(() => {
        return activeTab === "all"
            ? notes
            : notes.filter((n) => n.category === activeTab);
    }, [notes, activeTab]);

    const handleCreate = async () => {
        if (!newContent.trim()) return;
        setSubmitting(true);
        try {
            await createNote(newContent.trim(), newCategory);
            setNewContent("");
            setNewCategory("daily-log");
            setShowInput(false);
            await loadNotes();
        } catch (err) {
            console.error("[DailyJournal] Failed to create:", err);
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (noteId: string) => {
        try {
            await deleteNote(noteId);
            await loadNotes();
        } catch (err) {
            console.error("[DailyJournal] Failed to delete:", err);
        }
    };

    // Group by date
    const grouped: { label: string; notes: Note[] }[] = [];
    const seen = new Map<string, number>();

    for (const note of filteredNotes) {
        const label = formatDateHeading(note.created_at);
        if (seen.has(label)) {
            grouped[seen.get(label)!].notes.push(note);
        } else {
            seen.set(label, grouped.length);
            grouped.push({ label, notes: [note] });
        }
    }

    const displayGroups = expanded ? grouped : grouped.slice(0, 2);
    const hasMore = grouped.length > 2;

    return (
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-slate-800/50">
                <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                        <BookOpen size={16} />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-white">
                            Praxis Journal
                        </h3>
                        <p className="text-[10px] text-slate-500">
                            Daily notes &amp; observations
                        </p>
                    </div>
                </div>
                <button
                    onClick={() => setShowInput(!showInput)}
                    className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-amber-400 transition-colors"
                    title="Add Note"
                >
                    <Plus size={14} />
                </button>
            </div>

            {/* Category Tabs */}
            <div className="flex items-center gap-0.5 px-3 pt-2 pb-1 overflow-x-auto scrollbar-none">
                {JOURNAL_TABS.map((tab) => {
                    const count = categoryCounts[tab.key] || 0;
                    const isActive = activeTab === tab.key;
                    return (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium whitespace-nowrap transition-all ${
                                isActive
                                    ? tab.key === "all"
                                        ? "bg-slate-700 text-white"
                                        : (tab as typeof JOURNAL_TABS[number] & { activeColor?: string }).activeColor || "bg-slate-700 text-white"
                                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                            }`}
                        >
                            {tab.key !== "all" && (tab as typeof JOURNAL_TABS[number] & { icon?: React.ReactNode }).icon}
                            {tab.label}
                            {count > 0 && (
                                <span className={`text-[9px] px-1 py-0.5 rounded-full leading-none ${
                                    isActive ? "bg-white/10" : "bg-slate-800"
                                }`}>
                                    {count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="p-3 space-y-3">
                {/* New Note Input */}
                {showInput && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2">
                        <textarea
                            value={newContent}
                            onChange={(e) => setNewContent(e.target.value)}
                            placeholder="Add a journal entry..."
                            rows={2}
                            className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-none"
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
                                className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none"
                            >
                                <option value="daily-log">Daily Log</option>
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
                                    className="px-2 py-1 rounded text-[10px] text-slate-400 hover:text-slate-200 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleCreate}
                                    disabled={!newContent.trim() || submitting}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-400 text-[10px] font-medium hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    {submitting ? (
                                        <Loader2 size={10} className="animate-spin" />
                                    ) : (
                                        <Send size={10} />
                                    )}
                                    Save
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Loading */}
                {loading && (
                    <div className="flex items-center justify-center py-3">
                        <Loader2 size={14} className="animate-spin text-slate-500" />
                    </div>
                )}

                {/* Empty state */}
                {!loading && filteredNotes.length === 0 && !showInput && (
                    <p className="text-[10px] text-slate-600 text-center py-3 italic">
                        {activeTab === "all"
                            ? "No journal entries yet."
                            : `No ${activeTab.replace("-", " ")} entries yet.`}
                    </p>
                )}

                {/* Grouped Notes */}
                {displayGroups.map((group) => (
                    <div key={group.label}>
                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                            {group.label}
                        </p>
                        <div className="space-y-1.5">
                            {group.notes.map((note) => {
                                const badge = CATEGORY_BADGE[note.category] || CATEGORY_BADGE.general;
                                return (
                                    <div
                                        key={note.id}
                                        className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800/40 transition-colors"
                                    >
                                        <div className="mt-0.5 shrink-0">
                                            {note.source === "praxis" ? (
                                                <Bot size={12} className="text-cyan-500" />
                                            ) : (
                                                <User size={12} className="text-emerald-500" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            {/* Show category badge when in "all" tab */}
                                            {activeTab === "all" && note.category !== "daily-log" && (
                                                <span className={`inline-block text-[9px] font-medium px-1 py-0.5 rounded mb-0.5 ${badge.color}`}>
                                                    {badge.label}
                                                </span>
                                            )}
                                            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
                                                {note.content}
                                            </p>
                                            <p className="text-[10px] text-slate-600 mt-0.5">
                                                {formatTime(note.created_at)}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => handleDelete(note.id)}
                                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-700 text-slate-600 hover:text-red-400 transition-all shrink-0"
                                            title="Delete"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}

                {/* Expand/Collapse */}
                {hasMore && (
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="w-full flex items-center justify-center gap-1 py-1.5 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                    >
                        {expanded ? (
                            <>
                                <ChevronUp size={10} />
                                Show Less
                            </>
                        ) : (
                            <>
                                <ChevronDown size={10} />
                                Show Older ({grouped.length - 2} more)
                            </>
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}
