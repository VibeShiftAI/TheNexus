"use client";

/**
 * A chat turn's working steps: the live panel under the pending reply, and the
 * single expandable line a finished turn folds into. Step text is rendered as
 * plain text, never as markdown or links.
 */

import { memo, useEffect, useId, useReducer, useState } from "react";
import { AlertTriangle, Brain, Check, ChevronRight, CircleDashed, Loader2, X } from "lucide-react";
import Link from "next/link";

import {
    chatTurnSteps, foldedLabel, formatElapsed, hiddenStepCount,
    type FoldedTurn, type TurnStep, type TurnStepStatus,
} from "@/lib/chat-turn-steps";

const STATUS_LABEL: Record<TurnStepStatus, string> = {
    running: "running", done: "done", failed: "failed", unfinished: "did not finish",
};

function StepIcon({ step }: { step: TurnStep }) {
    const className = "mt-0.5 shrink-0";
    if (step.status === "running") return <Loader2 aria-hidden size={13} className={`${className} animate-spin text-cyan-400`} />;
    if (step.status === "failed") return <X aria-hidden size={13} className={`${className} text-red-400`} />;
    if (step.status === "unfinished") return <CircleDashed aria-hidden size={13} className={`${className} text-amber-300`} />;
    if (step.kind === "reasoning") return <Brain aria-hidden size={13} className={`${className} text-violet-300`} />;
    return <Check aria-hidden size={13} className={`${className} text-emerald-400`} />;
}

/** Memoized: a long turn re-renders only the row that changed. */
const TurnStepRow = memo(function TurnStepRow({ step }: { step: TurnStep }) {
    return (
        <li data-step-status={step.status} className="flex items-start gap-2 text-xs leading-5 text-slate-300">
            <StepIcon step={step} />
            <span className={`min-w-0 [overflow-wrap:anywhere] ${step.kind === "reasoning" ? "whitespace-pre-wrap italic text-slate-400" : ""}`}>
                {step.kind === "reasoning" && <span className="sr-only">Reasoning: </span>}
                {step.text}
            </span>
            {step.status === "failed" || step.status === "unfinished"
                ? <span className={`shrink-0 ${step.status === "failed" ? "text-red-300" : "text-amber-200"}`}>{STATUS_LABEL[step.status]}</span>
                : <span className="sr-only">{STATUS_LABEL[step.status]}</span>}
        </li>
    );
});

export function TurnStepList({ steps, hiddenSteps = 0 }: { steps: readonly TurnStep[]; hiddenSteps?: number }) {
    return (
        <ol aria-label="Working steps" className="mt-1.5 space-y-1">
            {hiddenSteps > 0 && (
                <li className="text-xs text-slate-500">
                    {hiddenSteps} {hiddenSteps === 1 ? "step" : "steps"} did not reach this page.
                </li>
            )}
            {steps.map(step => <TurnStepRow key={step.id} step={step} />)}
        </ol>
    );
}

/** Counts up on its own so the transcript never re-renders for the clock. */
function Elapsed({ startedAt }: { startedAt: number }) {
    const [now, setNow] = useState(() => chatTurnSteps.now());
    useEffect(() => {
        setNow(chatTurnSteps.now());
        const timer = setInterval(() => setNow(chatTurnSteps.now()), 1000);
        return () => clearInterval(timer);
    }, [startedAt]);
    return <span data-turn-elapsed className="shrink-0 text-xs tabular-nums text-slate-500">{formatElapsed(now - startedAt)}</span>;
}

/**
 * Follows the store with an ordinary state update, so a burst of steps batches
 * into one render. useSyncExternalStore would commit synchronously for every
 * step, and a long list makes each of those commits expensive.
 */
function useLiveTurn(conversationId: string | null) {
    const [, noteChange] = useReducer((version: number) => version + 1, 0);
    useEffect(() => {
        // Catches a step that landed between the first render and this subscription.
        noteChange();
        return chatTurnSteps.subscribe(noteChange);
    }, []);
    return chatTurnSteps.live(conversationId);
}

/** Memoized: the terminal re-renders for every live board event, and this list can be long. */
export const LiveTurnSteps = memo(function LiveTurnSteps({ conversationId, busy, onGrow }: {
    conversationId: string | null;
    /** The terminal is busy with something that is not a chat turn. */
    busy: boolean;
    onGrow: () => void;
}) {
    const turn = useLiveTurn(conversationId);

    // Steps grow the transcript without changing a message; keep the newest in view.
    useEffect(() => { if (turn) onGrow(); }, [turn, onGrow]);

    if (!turn && !busy) return null;
    return (
        <div data-turn-steps="live" className="flex gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-purple-400">
                <Loader2 size={16} className="animate-spin" />
            </div>
            <div className="min-w-0 max-w-[92%] rounded-lg bg-slate-800 px-4 py-2">
                {turn && (
                    <div className="flex flex-wrap items-baseline gap-x-2">
                        <p role="status" className="min-w-0 text-sm text-slate-300">{turn.status}</p>
                        <Elapsed startedAt={turn.startedAt} />
                    </div>
                )}
                {turn?.warning && (
                    <p role="alert" className="mt-1 flex items-start gap-1.5 text-sm text-amber-300">
                        <AlertTriangle aria-hidden size={14} className="mt-0.5 shrink-0" />
                        <span className="min-w-0">{turn.warning}</span>
                    </p>
                )}
                {turn?.lostContact && (
                    <p role="alert" className="mt-1 flex items-start gap-1.5 text-sm text-amber-300">
                        <AlertTriangle aria-hidden size={14} className="mt-0.5 shrink-0" />
                        <span className="min-w-0">
                            Lost contact with Praxis, so this turn may still be running.{" "}
                            <Link className="underline" href={`/chat/turns/${encodeURIComponent(turn.id)}`}>Check this saved turn</Link>
                        </span>
                    </p>
                )}
                {turn && turn.steps.length > 0
                    ? <TurnStepList steps={turn.steps} hiddenSteps={hiddenStepCount(turn)} />
                    : (
                        <div className={`flex gap-1 ${turn ? "mt-2" : ""}`}>
                            <span className="h-2 w-2 animate-bounce rounded-full bg-slate-500" style={{ animationDelay: "0ms" }} />
                            <span className="h-2 w-2 animate-bounce rounded-full bg-slate-500" style={{ animationDelay: "150ms" }} />
                            <span className="h-2 w-2 animate-bounce rounded-full bg-slate-500" style={{ animationDelay: "300ms" }} />
                        </div>
                    )}
            </div>
        </div>
    );
});

/** A followed turn is over and no reply reached this page, so the panel cannot just vanish. */
export function UnconfirmedTurnNotice({ turnId }: { turnId: string }) {
    return (
        <p role="alert" data-turn-unconfirmed className="flex items-start gap-1.5 pl-11 text-sm text-amber-300">
            <AlertTriangle aria-hidden size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
                This message ended without a confirmed reply.{" "}
                <Link className="underline" href={`/chat/turns/${encodeURIComponent(turnId)}`}>Check this saved turn</Link>
            </span>
        </p>
    );
}

export const FoldedTurnSteps = memo(function FoldedTurnSteps({ turn }: { turn: FoldedTurn }) {
    const [open, setOpen] = useState(false);
    const listId = useId();
    return (
        <div data-turn-steps="folded" className="min-w-0 pl-11">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                onClick={() => setOpen(value => !value)}
                className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded text-left text-xs text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-cyan-300 sm:min-h-7"
            >
                <ChevronRight aria-hidden size={14} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
                <span className="min-w-0">{foldedLabel(turn)}</span>
            </button>
            {open && (
                <div id={listId} className="pb-1 pl-5">
                    <TurnStepList steps={turn.steps} hiddenSteps={hiddenStepCount(turn)} />
                </div>
            )}
        </div>
    );
});
