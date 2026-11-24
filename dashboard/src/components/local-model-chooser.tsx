"use client";

/**
 * The local model, chosen from LM Studio's own list (task fa032fc0). Rendered
 * inside the alias manager on the Model Control page: `local_default` is the
 * alias every local role resolves through, and this is the one place to set it.
 *
 * Choosing loads nothing. Nexus records the switch and Praxis puts it into
 * effect when no local work runs, so the panel shows a switch waiting behind
 * a running job until Nexus reports it applied. The panel refreshes from the
 * PUT/POST answers, the `model-control:local-model` socket event and the
 * window coming back into view; it never polls.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Clock, Cpu, Loader2, RotateCcw } from "lucide-react";
import {
    chooseLocalModel,
    getLocalModelPanel,
    LocalModelRequestError,
    restoreLocalModel,
    type LocalModelChoiceResult,
    type LocalModelPanel,
} from "@/lib/model-control";
import {
    LOCAL_MODEL_EVENT,
    choiceNotice,
    defaultPick,
    describeWork,
    formatWhen,
    handlingExplanation,
    optionFacts,
    praxisNote,
    surfaceLabel,
    switchOrigin,
    switchStatus,
    switchSummary,
    waitingNote,
    waitingWork,
} from "@/lib/local-model";
import { acquireLiveSocket } from "@/lib/live-socket";

interface LocalModelChooserProps {
    /** Bumped by the alias editor after it saved local_default, so the panel reads the choice it made. */
    refreshKey?: number;
    /** Called after a choice or restore was recorded, so the alias list shows the new target once it applies. */
    onChanged?: () => void;
}

type Notice = { tone: "info" | "error"; text: string };

export function LocalModelChooser({ refreshKey = 0, onChanged }: LocalModelChooserProps) {
    const [panel, setPanel] = useState<LocalModelPanel | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    const [busy, setBusy] = useState<"choose" | "restore" | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const mounted = useRef(false);
    const touched = useRef(false);
    const inFlight = useRef<Promise<void> | null>(null);
    const again = useRef(false);

    const adopt = useCallback((next: LocalModelPanel) => {
        setPanel(next);
        setLoadError(null);
        setPicked(previous => (
            touched.current && previous && next.options.some(option => option.key === previous && option.selectable)
                ? previous
                : defaultPick(next)
        ));
    }, []);

    // One read at a time; a request that arrives during a read runs once after it.
    const refresh = useCallback((): Promise<void> => {
        if (inFlight.current) {
            again.current = true;
            return inFlight.current;
        }
        const run = (async () => {
            try {
                do {
                    again.current = false;
                    try {
                        const next = await getLocalModelPanel();
                        if (mounted.current) adopt(next);
                    } catch (error) {
                        if (mounted.current) setLoadError(error instanceof Error ? error.message : String(error));
                    }
                } while (again.current && mounted.current);
            } finally {
                inFlight.current = null;
            }
        })();
        inFlight.current = run;
        return run;
    }, [adopt]);

    useEffect(() => {
        mounted.current = true;
        void refresh();
        const handle = acquireLiveSocket();
        const onEvent = () => { void refresh(); };
        const onVisible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        handle?.socket.on(LOCAL_MODEL_EVENT, onEvent);
        window.addEventListener("focus", onEvent);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            mounted.current = false;
            handle?.socket.off(LOCAL_MODEL_EVENT, onEvent);
            handle?.release();
            window.removeEventListener("focus", onEvent);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [refresh]);

    useEffect(() => {
        if (refreshKey > 0) void refresh();
    }, [refreshKey, refresh]);

    const settle = async (action: "choose" | "restore", label: string, send: () => Promise<LocalModelChoiceResult>) => {
        setBusy(action);
        setNotice(null);
        try {
            const result = await send();
            touched.current = false;
            if (result.panel) adopt(result.panel);
            else await refresh();
            setNotice({ tone: "info", text: choiceNotice(result, label) });
            onChanged?.();
        } catch (error) {
            setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
            if (error instanceof LocalModelRequestError && error.code === "superseded") {
                touched.current = false;
                await refresh();
            }
        } finally {
            setBusy(null);
        }
    };

    if (!panel) {
        return (
            <section aria-labelledby="local-model-heading" className="mb-4 rounded border border-slate-800 bg-slate-950/40 p-3" data-local-model="">
                <Heading />
                {loadError ? (
                    <div className="mt-2 space-y-2 text-[11px] text-rose-300" role="alert">
                        <p>{loadError}</p>
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            className="rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-200 hover:border-cyan-500"
                        >
                            Try again
                        </button>
                    </div>
                ) : (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                        <Loader2 size={12} className="animate-spin" /> Reading LM Studio&rsquo;s list of models&hellip;
                    </p>
                )}
            </section>
        );
    }

    const { active, waiting, options, hidden, history, restore, listing } = panel;
    const pickedOption = options.find(option => option.key === picked) || null;
    const selectedKey = waiting?.model ?? active?.model ?? null;
    const dropsWaiting = !!waiting && !!pickedOption && pickedOption.key === active?.model;
    const canChoose = !!pickedOption && pickedOption.selectable && pickedOption.key !== selectedKey && busy === null;
    const work = waitingWork(panel);
    const note = waitingNote(panel);
    const praxisLine = praxisNote(panel);

    return (
        <section aria-labelledby="local-model-heading" className="mb-4 rounded border border-slate-800 bg-slate-950/40 p-3" data-local-model="">
            <Heading />
            <p className="mt-1 text-[11px] text-slate-500">
                Praxis, Studio jobs and TheCortex call this LM Studio model. Choosing one loads nothing and restarts nothing.
            </p>

            <div className="mt-2 rounded border border-slate-800 bg-slate-900/40 px-2 py-1.5" data-local-model-active="">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">In effect</div>
                {active ? (
                    <>
                        <div className="break-words text-sm font-medium text-white">{active.label}</div>
                        <div className="break-all font-mono text-[10px] text-slate-500">{active.model}</div>
                    </>
                ) : (
                    <div className="text-xs text-amber-200">No local model: local_default does not name an active LM Studio model. Choose one below.</div>
                )}
                {panel.selection?.status === "applied" && panel.selection.appliedAt && (
                    <div className="mt-0.5 text-[10px] text-slate-500">
                        {panel.selection.action === "restore" ? "Restored" : "Chosen"} under {surfaceLabel(panel.selection.surface)}, in effect from {formatWhen(panel.selection.appliedAt)}
                    </div>
                )}
                {praxisLine && <div className="mt-1 text-[11px] text-amber-200">{praxisLine}</div>}
            </div>

            {waiting && (
                <div role="status" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-2 text-[11px] text-amber-100" data-local-model-waiting="">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                        <Clock size={12} className="shrink-0" />
                        <span>Switch to {waiting.label} is waiting</span>
                    </div>
                    <p className="mt-1 text-amber-100/80">
                        {waiting.requestedAt && formatWhen(waiting.requestedAt) ? `Chosen ${formatWhen(waiting.requestedAt)}. ` : ""}
                        Running local work keeps {active?.label || "its model"} until it finishes; nothing is interrupted and nothing is loaded now.
                    </p>
                    {work.length > 0 && (
                        <>
                            <div className="mt-1.5 font-medium">Waiting for</div>
                            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                                {work.map((item, index) => (
                                    <li key={`${item.kind}-${item.id || index}`}>{describeWork(item)}</li>
                                ))}
                            </ul>
                        </>
                    )}
                    {note && <p className="mt-1.5">{note}</p>}
                </div>
            )}

            {!listing.ok && (
                <div role="alert" className="mt-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
                    LM Studio&rsquo;s list of models could not be read at {listing.url} ({listing.error || "no reply"}). The model in effect stays; choosing another waits until LM Studio answers.
                </div>
            )}

            {options.length > 0 && (
                <fieldset className="mt-3" disabled={busy !== null}>
                    <legend className="mb-1 text-[11px] font-medium text-slate-400">
                        Downloaded chat models in LM Studio ({options.length})
                    </legend>
                    <div className="space-y-1">
                        {options.map(option => {
                            const reasonId = `local-model-reason-${option.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
                            const isPicked = picked === option.key;
                            return (
                                <label
                                    key={option.key}
                                    data-local-model-option={option.key}
                                    className={`flex items-start gap-2 rounded border px-2 py-2 ${option.selectable ? "cursor-pointer" : "cursor-not-allowed"} ${isPicked ? "border-cyan-500/50 bg-cyan-500/10" : "border-slate-800 bg-slate-950/40"} ${option.selectable ? "" : "opacity-80"}`}
                                >
                                    <input
                                        type="radio"
                                        name="local-model"
                                        value={option.key}
                                        checked={isPicked}
                                        disabled={!option.selectable}
                                        aria-describedby={option.selectable ? undefined : reasonId}
                                        onChange={() => {
                                            touched.current = true;
                                            setPicked(option.key);
                                            setNotice(null);
                                        }}
                                        className="mt-0.5 shrink-0 accent-cyan-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-1">
                                            <span className="break-words text-xs font-medium text-slate-200">{option.label}</span>
                                            {option.active && <Badge tone="emerald">in effect</Badge>}
                                            {option.waiting && <Badge tone="amber">waiting</Badge>}
                                            {option.loaded && <Badge tone="slate">loaded in LM Studio</Badge>}
                                        </span>
                                        <span className="block text-[11px] text-slate-500" title={handlingExplanation(option.handling)}>
                                            {optionFacts(option)}
                                        </span>
                                        {!option.selectable && option.unavailableReason && (
                                            <span id={reasonId} className="mt-0.5 block text-[11px] text-rose-300">
                                                Cannot be chosen. {option.unavailableReason}
                                            </span>
                                        )}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                </fieldset>
            )}
            {listing.ok && options.length === 0 && (
                <p className="mt-3 text-[11px] text-slate-500">LM Studio lists no downloaded chat models.</p>
            )}

            {options.length > 0 && (
                <button
                    type="button"
                    onClick={() => pickedOption && void settle("choose", pickedOption.label, () => chooseLocalModel({ model: pickedOption.key, selectionId: panel.selection?.selectionId ?? null }))}
                    disabled={!canChoose}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-2 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy === "choose" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                    {!pickedOption
                        ? "Pick a model above"
                        : pickedOption.key === selectedKey
                            ? `${pickedOption.label} is ${waiting ? "the waiting choice" : "in effect"}`
                            : dropsWaiting
                                ? `Keep ${pickedOption.label}, drop the waiting switch`
                                : `Use ${pickedOption.label}`}
                </button>
            )}
            <p className="mt-1 text-[10px] text-slate-500">
                The switch takes effect at the next local call once no local work runs. The model loads only when a call needs it, under the memory gate and local-lane hours; the old one is released by the usual swap and idle unload.
            </p>

            {notice && (
                <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-2 text-[11px] ${notice.tone === "error" ? "text-rose-300" : "text-emerald-300"}`}>
                    {notice.text}
                </p>
            )}

            {restore && (
                <div className="mt-3">
                    <button
                        type="button"
                        onClick={() => void settle("restore", restore.label, () => restoreLocalModel({ selectionId: panel.selection?.selectionId ?? null }))}
                        disabled={!restore.available || busy !== null}
                        aria-describedby={restore.available ? undefined : "local-model-restore-reason"}
                        className="flex w-full items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy === "restore" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                        Restore {restore.label}
                    </button>
                    {!restore.available && restore.reason && (
                        <p id="local-model-restore-reason" className="mt-1 text-[11px] text-rose-300">{restore.reason}</p>
                    )}
                </div>
            )}

            {hidden.length > 0 && (
                <details className="mt-3 text-[11px] text-slate-400">
                    <summary className="cursor-pointer select-none">Not offered ({hidden.length})</summary>
                    <ul className="mt-1 space-y-1">
                        {hidden.map((row, index) => (
                            <li key={`${row.key || "row"}-${index}`} className="rounded border border-slate-800 px-2 py-1">
                                <div className="break-words text-slate-300">{row.label}</div>
                                <div className="text-slate-500">{row.reason}</div>
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {history.length > 0 && (
                <details className="mt-2 text-[11px] text-slate-400" data-local-model-history="">
                    <summary className="cursor-pointer select-none">Switch history ({history.length})</summary>
                    <ol className="mt-1 space-y-1">
                        {history.map(row => (
                            <li key={row.id} className="rounded border border-slate-800 px-2 py-1">
                                <div className="break-words text-slate-300">{switchSummary(row)}</div>
                                <div className="text-slate-500">{switchOrigin(row)} · {switchStatus(row)}</div>
                            </li>
                        ))}
                    </ol>
                </details>
            )}
        </section>
    );
}

function Heading() {
    return (
        <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
                <Cpu size={14} className="text-teal-300" />
                <h4 id="local-model-heading" className="text-sm font-semibold text-slate-200">Local model</h4>
            </div>
            <span className="font-mono text-[10px] text-slate-500">@local_default</span>
        </div>
    );
}

function Badge({ tone, children }: { tone: "emerald" | "amber" | "slate"; children: ReactNode }) {
    const tones = {
        emerald: "bg-emerald-500/10 text-emerald-200",
        amber: "bg-amber-500/15 text-amber-200",
        slate: "bg-slate-700/40 text-slate-300",
    } as const;
    return <span className={`rounded px-1.5 py-0.5 text-[10px] ${tones[tone]}`}>{children}</span>;
}
