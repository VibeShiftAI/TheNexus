"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Loader2, MonitorSmartphone, Plus, Save, Trash2 } from "lucide-react";
import { getTravelTabs, saveTravelTabs, TravelTab } from "@/lib/nexus";

/**
 * Roster editor for the Windows travel shell's tabs — which projects appear,
 * their order, labels, and accent colors. Saves to /api/tabs; the shell
 * pulls the roster on its next launch, so changes need no rebuild.
 * Self-contained section inside the SettingsModal (own load/save cycle,
 * like ArchivedProjectsList).
 */

function slugify(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function TravelTabsEditor({ reloadKey }: { reloadKey: boolean }) {
    const [tabs, setTabs] = useState<TravelTab[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setError(null);
            setTabs(await getTravelTabs());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load tabs");
        }
    }, []);

    useEffect(() => {
        if (reloadKey) {
            load();
            setSaved(false);
        }
    }, [reloadKey, load]);

    const update = (index: number, patch: Partial<TravelTab>) => {
        setTabs((prev) => prev ? prev.map((t, i) => (i === index ? { ...t, ...patch } : t)) : prev);
        setSaved(false);
    };

    const move = (index: number, delta: number) => {
        setTabs((prev) => {
            if (!prev) return prev;
            const target = index + delta;
            if (target < 0 || target >= prev.length) return prev;
            const next = [...prev];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
        setSaved(false);
    };

    const remove = (index: number) => {
        setTabs((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
        setSaved(false);
    };

    const addTab = () => {
        setTabs((prev) => [
            ...(prev ?? []),
            { id: "", label: "", url: "https://", accent: "#22d3ee", enabled: true },
        ]);
        setSaved(false);
    };

    const handleSave = async () => {
        if (!tabs) return;
        try {
            setSaving(true);
            setError(null);
            // Fill ids for new rows from the label; keep existing ids stable
            // so the shell's active-tab bookkeeping survives edits.
            const used = new Set(tabs.map((t) => t.id).filter(Boolean));
            const prepared = tabs.map((t) => {
                if (t.id) return t;
                let id = slugify(t.label) || "tab";
                while (used.has(id)) id = `${id}-2`.slice(0, 32);
                used.add(id);
                return { ...t, id };
            });
            setTabs(await saveTravelTabs(prepared));
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save tabs");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            {/* Divider */}
            <div className="flex items-center gap-3 pt-2 mb-3">
                <div className="h-px flex-1 bg-slate-800" />
                <span className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                    <MonitorSmartphone size={12} />
                    Travel Shell Tabs
                </span>
                <div className="h-px flex-1 bg-slate-800" />
            </div>

            {tabs === null && !error ? (
                <div className="flex items-center justify-center py-6">
                    <Loader2 className="animate-spin text-cyan-400" size={20} />
                </div>
            ) : (
                <div className="space-y-2">
                    {(tabs ?? []).map((tab, index) => (
                        <div
                            key={`${tab.id || "new"}-${index}`}
                            className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-all ${
                                tab.enabled ? "border-slate-700 bg-slate-800/60" : "border-slate-800 bg-slate-900/40 opacity-60"
                            }`}
                        >
                            <input
                                type="checkbox"
                                checked={tab.enabled}
                                onChange={(e) => update(index, { enabled: e.target.checked })}
                                title={tab.enabled ? "Shown in the shell" : "Hidden from the shell"}
                                className="accent-cyan-500 shrink-0"
                            />
                            <input
                                type="color"
                                value={tab.accent}
                                onChange={(e) => update(index, { accent: e.target.value })}
                                title="Accent color"
                                className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                            />
                            <input
                                type="text"
                                value={tab.label}
                                onChange={(e) => update(index, { label: e.target.value.toUpperCase() })}
                                placeholder="LABEL"
                                maxLength={28}
                                className="w-32 shrink-0 rounded bg-slate-950/60 border border-slate-700 px-2 py-1 text-xs font-semibold tracking-wider text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                            />
                            <input
                                type="text"
                                value={tab.url}
                                onChange={(e) => update(index, { url: e.target.value })}
                                placeholder="https://…"
                                className="min-w-0 flex-1 rounded bg-slate-950/60 border border-slate-700 px-2 py-1 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                            />
                            <button onClick={() => move(index, -1)} disabled={index === 0}
                                className="p-1 text-slate-500 hover:text-white disabled:opacity-30" title="Move up">
                                <ArrowUp size={13} />
                            </button>
                            <button onClick={() => move(index, 1)} disabled={index === (tabs?.length ?? 0) - 1}
                                className="p-1 text-slate-500 hover:text-white disabled:opacity-30" title="Move down">
                                <ArrowDown size={13} />
                            </button>
                            <button onClick={() => remove(index)}
                                className="p-1 text-slate-500 hover:text-red-400" title="Remove tab">
                                <Trash2 size={13} />
                            </button>
                        </div>
                    ))}

                    <div className="flex items-center justify-between pt-1">
                        <button
                            onClick={addTab}
                            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
                        >
                            <Plus size={13} />
                            Add tab
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving || !tabs}
                            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                                saved
                                    ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-400"
                                    : "border border-cyan-500/40 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"
                            }`}
                        >
                            {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <CheckCircle2 size={13} /> : <Save size={13} />}
                            {saving ? "Saving…" : saved ? "Saved" : "Save tabs"}
                        </button>
                    </div>

                    {error && (
                        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                            {error}
                        </div>
                    )}
                    <p className="text-xs text-slate-500">
                        The travel laptop picks up roster changes on its next app launch.
                    </p>
                </div>
            )}
        </div>
    );
}
