"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    BookOpen,
    Calendar,
    ChevronDown,
    ChevronRight,
    ClipboardList,
    Download,
    FileText,
    Loader2,
    RefreshCw,
    Search,
} from "lucide-react";
import { getGlobalNotes, type Note } from "@/lib/nexus";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";

// ─── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = [
    {
        key: "ingestion-report",
        label: "Nightly Reports",
        icon: ClipboardList,
        color: "text-violet-400",
        activeColor: "bg-violet-500/20 border-violet-500/40 text-violet-200",
        description: "AI-generated summaries of each nightly knowledge sweep",
    },
    {
        key: "ingested",
        label: "Ingested Content",
        icon: Download,
        color: "text-cyan-400",
        activeColor: "bg-cyan-500/20 border-cyan-500/40 text-cyan-200",
        description: "Raw content captured from URLs, text, and transcripts",
    },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLocalDateKey(isoStr: string): string {
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateHeading(dateKey: string): string {
    const [y, m, d] = dateKey.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.floor(
        (today.getTime() - date.getTime()) / 86400000
    );

    const formatted = date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });

    if (diffDays === 0) return `Today — ${formatted}`;
    if (diffDays === 1) return `Yesterday — ${formatted}`;
    if (diffDays < 7) return `${diffDays} days ago — ${formatted}`;
    return formatted;
}

function formatTime(isoStr: string): string {
    return new Date(isoStr).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}

// ─── DateGroup: a collapsible card per date ───────────────────────────────────

interface DateGroup {
    dateKey: string;
    notes: Note[];
}

function DateGroupCard({
    group,
    defaultOpen,
}: {
    group: DateGroup;
    defaultOpen: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden transition-all">
            {/* Date Header */}
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-slate-800/30 transition-colors group"
            >
                <div className="flex items-center gap-3">
                    <div className="p-1.5 rounded-lg bg-slate-800/60 text-slate-400 group-hover:text-white transition-colors">
                        <Calendar size={14} />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-white">
                            {formatDateHeading(group.dateKey)}
                        </h3>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                            {group.notes.length}{" "}
                            {group.notes.length === 1 ? "entry" : "entries"}
                        </p>
                    </div>
                </div>
                <div className="text-slate-500 group-hover:text-slate-300 transition-colors">
                    {open ? (
                        <ChevronDown size={16} />
                    ) : (
                        <ChevronRight size={16} />
                    )}
                </div>
            </button>

            {/* Entries */}
            {open && (
                <div className="border-t border-slate-800/50">
                    {group.notes.map((note, idx) => (
                        <NoteEntry
                            key={note.id}
                            note={note}
                            showDivider={idx < group.notes.length - 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── NoteEntry: a single report or ingested item ──────────────────────────────

function NoteEntry({
    note,
    showDivider,
}: {
    note: Note;
    showDivider: boolean;
}) {
    const [expanded, setExpanded] = useState(false);

    // Extract a short title from content (first heading or first line)
    const title = useMemo(() => {
        const lines = note.content.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Markdown heading
            const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
            if (headingMatch) return headingMatch[1].replace(/[📥🧠📊]/g, "").trim();
            // Fallback: first non-empty line
            return trimmed.length > 80
                ? trimmed.substring(0, 80) + "…"
                : trimmed;
        }
        return "Untitled entry";
    }, [note.content]);

    // Preview text — first paragraph after the title
    const preview = useMemo(() => {
        const lines = note.content.split("\n");
        let pastTitle = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) {
                if (trimmed.startsWith("#")) pastTitle = true;
                continue;
            }
            if (pastTitle || !trimmed.startsWith("#")) {
                const clean = trimmed.replace(/\*\*/g, "");
                return clean.length > 160 ? clean.substring(0, 160) + "…" : clean;
            }
        }
        return "";
    }, [note.content]);

    return (
        <div
            className={`${showDivider ? "border-b border-slate-800/30" : ""}`}
        >
            {/* Collapsed summary */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full text-left px-5 py-3 hover:bg-slate-800/20 transition-colors group"
            >
                <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0 text-slate-500 group-hover:text-slate-300 transition-colors">
                        <FileText size={13} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-slate-200 truncate">
                                {title}
                            </span>
                            <span className="text-[10px] text-slate-600 shrink-0">
                                {formatTime(note.created_at)}
                            </span>
                        </div>
                        {!expanded && preview && (
                            <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2 leading-relaxed">
                                {preview}
                            </p>
                        )}
                    </div>
                    <div className="mt-1 shrink-0 text-slate-600 group-hover:text-slate-400 transition-colors">
                        {expanded ? (
                            <ChevronDown size={14} />
                        ) : (
                            <ChevronRight size={14} />
                        )}
                    </div>
                </div>
            </button>

            {/* Expanded markdown content */}
            {expanded && (
                <div className="px-5 pb-4 pt-0">
                    <div className="rounded-lg border border-slate-800/50 bg-slate-950/50 p-4 overflow-auto max-h-[600px]">
                        <div className="prose prose-invert prose-sm max-w-none prose-headings:text-white prose-headings:font-semibold prose-p:text-slate-300 prose-strong:text-slate-200 prose-li:text-slate-300 prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline prose-hr:border-slate-800 prose-code:text-cyan-300 prose-code:bg-slate-800/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-800">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {normalizeMarkdown(note.content)}
                            </ReactMarkdown>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IntakeReportsPage() {
    const [allNotes, setAllNotes] = useState<Note[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>("ingestion-report");
    const [searchQuery, setSearchQuery] = useState("");

    const loadNotes = useCallback(async () => {
        try {
            const data = await getGlobalNotes();
            setAllNotes(data);
            setError(null);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Failed to load notes"
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadNotes();
    }, [loadNotes]);

    // Filter notes by category + search
    const filteredNotes = useMemo(() => {
        let filtered = allNotes.filter(
            (n) => (n.category as string) === activeTab
        );

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            filtered = filtered.filter((n) =>
                n.content.toLowerCase().includes(q)
            );
        }

        // Sort newest first
        filtered.sort(
            (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
        );

        return filtered;
    }, [allNotes, activeTab, searchQuery]);

    // Group by date
    const dateGroups: DateGroup[] = useMemo(() => {
        const map = new Map<string, Note[]>();

        for (const note of filteredNotes) {
            const dateKey = toLocalDateKey(note.created_at);
            const existing = map.get(dateKey);
            if (existing) {
                existing.push(note);
            } else {
                map.set(dateKey, [note]);
            }
        }

        return Array.from(map.entries()).map(([dateKey, notes]) => ({
            dateKey,
            notes,
        }));
    }, [filteredNotes]);

    // Counts per tab
    const tabCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const tab of TABS) {
            counts[tab.key] = allNotes.filter(
                (n) => (n.category as string) === tab.key
            ).length;
        }
        return counts;
    }, [allNotes]);

    const currentTab = TABS.find((t) => t.key === activeTab)!;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200">
            {/* Header */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/"
                            className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                        >
                            <ArrowLeft size={20} />
                        </Link>
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-violet-500/20">
                                <BookOpen
                                    size={20}
                                    className="text-violet-300"
                                />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold tracking-tight text-white">
                                    INTAKE REPORT LOG
                                </h1>
                                <p className="text-xs text-slate-500">
                                    Daily ingestion reports &amp; captured
                                    content, sorted by date
                                </p>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={() => {
                            setLoading(true);
                            loadNotes();
                        }}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-300 transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw
                            size={16}
                            className={loading ? "animate-spin" : ""}
                        />
                    </button>
                </div>
            </header>

            <div className="container mx-auto p-6 space-y-6">
                {/* Error Banner */}
                {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                        {error}
                    </div>
                )}

                {/* Tab Bar + Search */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    {/* Tabs */}
                    <div className="flex items-center gap-2">
                        {TABS.map((tab) => {
                            const isActive = activeTab === tab.key;
                            const Icon = tab.icon;
                            const count = tabCounts[tab.key] || 0;
                            return (
                                <button
                                    key={tab.key}
                                    onClick={() => setActiveTab(tab.key)}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                                        isActive
                                            ? tab.activeColor
                                            : "border-slate-800 bg-slate-900/50 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                                    }`}
                                >
                                    <Icon size={15} />
                                    <span>{tab.label}</span>
                                    <span
                                        className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none font-mono ${
                                            isActive
                                                ? "bg-white/10"
                                                : "bg-slate-800 text-slate-500"
                                        }`}
                                    >
                                        {count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Search */}
                    <div className="relative w-full sm:w-64">
                        <Search
                            size={14}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                        />
                        <input
                            type="text"
                            placeholder="Search reports…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-slate-900/50 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all"
                        />
                    </div>
                </div>

                {/* Tab description */}
                <p className="text-xs text-slate-500 -mt-2">
                    {currentTab.description}
                </p>

                {/* Loading */}
                {loading && (
                    <div className="flex items-center justify-center py-16">
                        <Loader2
                            size={24}
                            className="animate-spin text-slate-500"
                        />
                    </div>
                )}

                {/* Empty state */}
                {!loading && filteredNotes.length === 0 && (
                    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 py-16 text-center bg-slate-900/20">
                        <div className="p-3 rounded-xl bg-slate-800/40 text-slate-500 mb-4">
                            <currentTab.icon size={28} />
                        </div>
                        <p className="text-sm text-slate-400 font-medium">
                            {searchQuery
                                ? "No matching reports found"
                                : `No ${currentTab.label.toLowerCase()} yet`}
                        </p>
                        <p className="text-xs text-slate-600 mt-1 max-w-sm">
                            {searchQuery
                                ? "Try adjusting your search terms."
                                : activeTab === "ingestion-report"
                                  ? "Nightly ingestion reports will appear here after Praxis runs its knowledge sweep."
                                  : "Ingested content from URLs, text, and transcripts will appear here."}
                        </p>
                    </div>
                )}

                {/* Date-grouped entries */}
                {!loading && dateGroups.length > 0 && (
                    <div className="space-y-4">
                        {dateGroups.map((group, idx) => (
                            <DateGroupCard
                                key={group.dateKey}
                                group={group}
                                defaultOpen={idx === 0}
                            />
                        ))}
                    </div>
                )}

                {/* Summary footer */}
                {!loading && filteredNotes.length > 0 && (
                    <div className="text-center py-4">
                        <p className="text-[10px] text-slate-600">
                            Showing {filteredNotes.length}{" "}
                            {filteredNotes.length === 1 ? "entry" : "entries"}{" "}
                            across {dateGroups.length}{" "}
                            {dateGroups.length === 1 ? "day" : "days"}
                            {searchQuery && (
                                <span>
                                    {" "}
                                    matching &quot;{searchQuery}&quot;
                                </span>
                            )}
                        </p>
                    </div>
                )}
            </div>
        </main>
    );
}
