"use client";

/**
 * Council bench controls — who sits on each council, editable.
 *
 * The bench used to live only in Praxis's router-config.json, so changing it
 * meant editing a file and restarting. This panel reads and writes it through
 * /api/praxis/council/benches.
 *
 * Two things it deliberately shows rather than hides:
 *   - the SEAT KIND. A subscription CLI seat and a free OpenRouter seat cost
 *     completely different things and fail in completely different ways, and a
 *     bench of six identical-looking chips would say neither.
 *   - Praxis's validation message, verbatim. "refusing X: it is a PAID model"
 *     tells the operator exactly what to change; "save failed" does not.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    Check,
    Gavel,
    Loader2,
    Plus,
    RotateCcw,
    Users,
    X,
} from "lucide-react";
import {
    benchTitle,
    getCouncilBenches,
    saveCouncilBench,
    type BenchSeat,
    type CouncilBench,
    type CouncilBenchCatalog,
} from "@/lib/council";

/** Draft state per bench, so edits can be reviewed before they are written. */
interface Draft {
    references: string[];
    aggregator: string;
}

function seatTone(kind: BenchSeat["kind"]): string {
    return kind === "openrouter"
        ? "border-violet-500/40 bg-violet-500/10 text-violet-200"
        : "border-amber-500/40 bg-amber-500/10 text-amber-200";
}

function formatContext(tokens?: number): string | null {
    if (!tokens) return null;
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`;
    return `${Math.round(tokens / 1000)}K ctx`;
}

function SeatChip({
    seat,
    onRemove,
}: {
    seat: BenchSeat;
    onRemove?: () => void;
}) {
    const ctx = formatContext(seat.contextWindow);
    return (
        <span
            className={`group inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${seatTone(seat.kind)}`}
            title={seat.id}
        >
            <span className="font-semibold">{seat.label}</span>
            <span className="text-[10px] uppercase tracking-wide opacity-60">
                {seat.kind === "openrouter" ? "free" : "sub"}
            </span>
            {ctx && <span className="text-[10px] opacity-50">{ctx}</span>}
            {seat.cloaked && (
                <span
                    className="text-[10px] opacity-60"
                    title="Lineage undisclosed — seated as an independent model"
                >
                    cloaked
                </span>
            )}
            {onRemove && (
                <button
                    onClick={onRemove}
                    className="rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
                    title={`Remove ${seat.label}`}
                    aria-label={`Remove ${seat.label}`}
                >
                    <X size={12} />
                </button>
            )}
        </span>
    );
}

function BenchCard({
    bench,
    catalog,
    draft,
    dirty,
    saving,
    error,
    onChange,
    onSave,
    onReset,
}: {
    bench: CouncilBench;
    catalog: CouncilBenchCatalog;
    draft: Draft;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    onChange: (next: Draft) => void;
    onSave: () => void;
    onReset: () => void;
}) {
    const known = useMemo(() => {
        const map = new Map<string, BenchSeat>();
        for (const seat of [...catalog.cli, ...catalog.openrouter, ...bench.references, bench.aggregator]) {
            map.set(seat.id, seat);
        }
        return map;
    }, [catalog, bench]);

    const describe = useCallback(
        (id: string): BenchSeat =>
            known.get(id) ?? { id, kind: id.startsWith("cli:") ? "cli" : "openrouter", label: id },
        [known],
    );

    const unseated = useMemo(() => {
        const seated = new Set(draft.references);
        return {
            cli: catalog.cli.filter((s) => !seated.has(s.id)),
            openrouter: catalog.openrouter.filter((s) => !seated.has(s.id)),
        };
    }, [catalog, draft.references]);

    const addable = unseated.cli.length + unseated.openrouter.length > 0;

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold tracking-tight text-white">{benchTitle(bench.name)}</h3>
                    {bench.isDefault && (
                        <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                            default
                        </span>
                    )}
                    <span className="text-[11px] text-slate-600">{bench.name}</span>
                </div>
                <span className="text-[11px] text-slate-500">
                    {draft.references.length} seat{draft.references.length === 1 ? "" : "s"}
                </span>
            </div>

            {/* Reference seats */}
            <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <Users size={12} /> Reference seats
                </div>
                <div className="flex flex-wrap gap-2">
                    {draft.references.map((id) => (
                        <SeatChip
                            key={id}
                            seat={describe(id)}
                            onRemove={
                                draft.references.length > 1
                                    ? () =>
                                          onChange({
                                              ...draft,
                                              references: draft.references.filter((r) => r !== id),
                                          })
                                    : undefined
                            }
                        />
                    ))}
                    {draft.references.length === 1 && (
                        <span className="self-center text-[10px] text-slate-600">
                            a bench needs at least one seat
                        </span>
                    )}
                </div>

                {addable && (
                    <div className="flex items-center gap-2 pt-1">
                        <Plus size={12} className="text-slate-600" />
                        <select
                            value=""
                            onChange={(e) => {
                                if (!e.target.value) return;
                                onChange({ ...draft, references: [...draft.references, e.target.value] });
                            }}
                            className="rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1.5 text-xs text-slate-200 outline-none transition-colors focus:border-amber-500/70"
                        >
                            <option value="">Add a seat…</option>
                            {unseated.cli.length > 0 && (
                                <optgroup label="Subscription CLI">
                                    {unseated.cli.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.label}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                            {unseated.openrouter.length > 0 && (
                                <optgroup label="OpenRouter (free)">
                                    {unseated.openrouter.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.label}
                                            {formatContext(s.contextWindow) ? ` · ${formatContext(s.contextWindow)}` : ""}
                                        </option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                    </div>
                )}
            </div>

            {/* Aggregator */}
            <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <Gavel size={12} /> Aggregator — writes the verdict
                </div>
                <select
                    value={draft.aggregator}
                    onChange={(e) => onChange({ ...draft, aggregator: e.target.value })}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950/70 px-2.5 py-2 text-xs text-slate-200 outline-none transition-colors focus:border-amber-500/70 md:max-w-sm"
                >
                    {[...catalog.cli, ...catalog.openrouter].map((s) => (
                        <option key={s.id} value={s.id}>
                            {s.label} {s.kind === "openrouter" ? "(free)" : "(subscription)"}
                        </option>
                    ))}
                    {/* A configured aggregator outside the menu must not vanish on save. */}
                    {![...catalog.cli, ...catalog.openrouter].some((s) => s.id === draft.aggregator) && (
                        <option value={draft.aggregator}>{draft.aggregator}</option>
                    )}
                </select>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span className="whitespace-pre-wrap">{error}</span>
                </div>
            )}

            <div className="flex items-center gap-2 pt-1">
                <button
                    onClick={onSave}
                    disabled={!dirty || saving}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/60 disabled:text-slate-500"
                >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    {saving ? "Saving" : "Save bench"}
                </button>
                {dirty && !saving && (
                    <button
                        onClick={onReset}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200"
                    >
                        <RotateCcw size={12} /> Revert
                    </button>
                )}
                {dirty && <span className="text-[11px] text-amber-400/80">unsaved changes</span>}
            </div>
        </div>
    );
}

export function CouncilBenchControls() {
    const [benches, setBenches] = useState<CouncilBench[] | null>(null);
    const [catalog, setCatalog] = useState<CouncilBenchCatalog | null>(null);
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [saving, setSaving] = useState<string | null>(null);
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    const [loadError, setLoadError] = useState<string | null>(null);

    const adopt = useCallback((next: { benches: CouncilBench[]; catalog: CouncilBenchCatalog }) => {
        setBenches(next.benches);
        setCatalog(next.catalog);
        setDrafts(
            Object.fromEntries(
                next.benches.map((b) => [
                    b.name,
                    { references: b.references.map((r) => r.id), aggregator: b.aggregator.id },
                ]),
            ),
        );
    }, []);

    useEffect(() => {
        let cancelled = false;
        getCouncilBenches()
            .then((state) => {
                if (!cancelled) adopt(state);
            })
            .catch((err: unknown) => {
                if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [adopt]);

    const save = useCallback(
        async (name: string) => {
            const draft = drafts[name];
            if (!draft) return;
            setSaving(name);
            setErrors((e) => ({ ...e, [name]: null }));
            try {
                adopt(await saveCouncilBench(name, draft));
            } catch (err: unknown) {
                setErrors((e) => ({ ...e, [name]: err instanceof Error ? err.message : String(err) }));
            } finally {
                setSaving(null);
            }
        },
        [drafts, adopt],
    );

    if (loadError) {
        return (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                    <AlertTriangle size={13} /> Bench configuration unavailable — {loadError}
                </div>
            </section>
        );
    }
    if (!benches || !catalog) {
        return (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 size={13} className="animate-spin" /> Loading benches…
                </div>
            </section>
        );
    }

    return (
        <section className="rounded-2xl border border-amber-500/25 bg-slate-900/50 overflow-hidden">
            <div className="border-b border-slate-800 px-4 py-3">
                <div className="flex items-center gap-2">
                    <Users size={15} className="text-amber-300" />
                    <h2 className="text-sm font-bold uppercase tracking-wider text-amber-200">Council Benches</h2>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                    Who sits on each council. Subscription CLI seats spend a plan; OpenRouter seats are free —
                    a paid model is refused rather than quietly billed.
                </p>
            </div>
            <div className="grid gap-4 p-4 lg:grid-cols-2">
                {benches.map((bench) => {
                    const draft = drafts[bench.name] ?? {
                        references: bench.references.map((r) => r.id),
                        aggregator: bench.aggregator.id,
                    };
                    const dirty =
                        draft.aggregator !== bench.aggregator.id ||
                        draft.references.join("|") !== bench.references.map((r) => r.id).join("|");
                    return (
                        <BenchCard
                            key={bench.name}
                            bench={bench}
                            catalog={catalog}
                            draft={draft}
                            dirty={dirty}
                            saving={saving === bench.name}
                            error={errors[bench.name] ?? null}
                            onChange={(next) => setDrafts((d) => ({ ...d, [bench.name]: next }))}
                            onSave={() => save(bench.name)}
                            onReset={() =>
                                setDrafts((d) => ({
                                    ...d,
                                    [bench.name]: {
                                        references: bench.references.map((r) => r.id),
                                        aggregator: bench.aggregator.id,
                                    },
                                }))
                            }
                        />
                    );
                })}
            </div>
        </section>
    );
}
