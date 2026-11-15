"use client";

/**
 * The decisions Robert is asked to make about a document, at the top of the
 * viewer (task 50aa5747; contract Praxis/docs/document-decisions.md). Each
 * decision shows its question, the producer's recommendation and the answers
 * it offers with the action each one calls for, or a free-text answer. An
 * answer is saved on Robert's draft review and goes to Praxis with Finish
 * review; it is separate from Approve / Request changes and never edits,
 * publishes or sends the document.
 */
import { useState } from "react";
import { AlertTriangle, Check, ListChecks, Loader2, Send } from "lucide-react";
import type { DecisionAnswer, DecisionItem, DecisionItems, StaleDecisionAnswer } from "@/lib/document-review";
import { answerFor, staleAnswerLabel, staleReasonText, type ChoicesView } from "@/lib/document-choices";

interface DocumentChoicesProps {
    decisions: DecisionItems;
    view: ChoicesView;
    /** Saved answers on an open round that Finish would refuse; each listed decision asks to be answered again or cleared. */
    stale?: StaleDecisionAnswer[];
    /** Save one answer; rejects with a message to show beside the decision. */
    onSave: (decisionId: string, answer: string) => Promise<void>;
    onClear: (decisionId: string) => Promise<void>;
    /** Open Finish review, which sends the answers with the review. */
    onSend: () => void;
    /** Open a new review round on this version (after a sent round left decisions unanswered). */
    onNewRound?: () => void;
}

function errorText(err: unknown): string {
    return err instanceof Error && err.message ? err.message : "Could not save the answer";
}

export function DocumentChoices({ decisions, view, stale = [], onSave, onClear, onSend, onNewRound }: DocumentChoicesProps) {
    const items = decisions.items;
    const answered = items.filter((item) => answerFor(view.answers, item.id)).length;
    const editable = view.state === "open";
    return (
        <section aria-label="Decisions" className="mb-4 max-w-3xl rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-3" data-document-choices={view.state}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                    <ListChecks size={15} className="shrink-0 text-cyan-300" aria-hidden="true" />
                    {items.length === 1 ? "A decision for you" : `${items.length} decisions for you`}
                </h2>
                {view.showItems && <span className="text-[11px] text-slate-400" data-choices-progress="">{answered} of {items.length} answered</span>}
            </div>
            {view.note && <p role="status" className="mt-1 text-[11px] text-slate-300" data-choices-note="">{view.note}</p>}
            {view.showItems && (
                <ol className="mt-2 space-y-2.5">
                    {items.map((item, index) => (
                        <ChoiceItem key={item.id} item={item} index={index} saved={answerFor(view.answers, item.id)} sentEarlier={answerFor(view.sentAnswers, item.id)} stale={editable ? stale.find((s) => s.decision_id === item.id) ?? null : null} editable={editable} sent={view.state === "sent"} onSave={onSave} onClear={onClear} />
                    ))}
                </ol>
            )}
            {editable && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 text-[11px] text-slate-400" data-choices-scope="">
                        Answers are saved on your review and go to Praxis when you send it. Praxis carries out the action you choose; an answer does not approve, edit, publish or send this document.
                    </p>
                    <button type="button" onClick={onSend} disabled={answered === 0} className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50 max-lg:min-h-11" data-choices-send="">
                        <Send size={12} aria-hidden="true" /> Send answers to Praxis
                    </button>
                </div>
            )}
            {view.state === "sent" && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-emerald-100/90" data-choices-sent="">
                    <span className="min-w-0 flex-1">{answered > 0 ? `Sent to Praxis: ${answered} of ${items.length} answered.` : "The review you sent answered none of these."}</span>
                    {answered < items.length && onNewRound && (
                        <button type="button" onClick={onNewRound} className="rounded-md border border-cyan-400/50 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-500/20 max-lg:min-h-11" data-choices-new-round="">
                            Answer the rest in a new review
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

interface ChoiceItemProps {
    item: DecisionItem;
    index: number;
    saved: DecisionAnswer | null;
    /** The answer an earlier round on this version already sent, shown beside an open round. */
    sentEarlier: DecisionAnswer | null;
    /** The saved answer cannot be sent as it stands: choosing (or saving) it again confirms it against what is shown now. */
    stale: StaleDecisionAnswer | null;
    editable: boolean;
    sent: boolean;
    onSave: (decisionId: string, answer: string) => Promise<void>;
    onClear: (decisionId: string) => Promise<void>;
}

function ChoiceItem({ item, index, saved, sentEarlier, stale, editable, sent, onSave, onClear }: ChoiceItemProps) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const questionId = `choice-${item.id}-question`;
    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try { await work(); }
        catch (err) { setError(errorText(err)); }
        finally { setBusy(false); }
    };
    const chosenOption = item.options?.find((o) => o.id === saved?.answer) ?? null;
    const earlierText = sentEarlier ? item.options?.find((o) => o.id === sentEarlier.answer)?.label ?? sentEarlier.answer : null;
    return (
        <li className="rounded-md border border-slate-800 bg-slate-950/60 p-2.5" data-choice={item.id} data-choice-answered={saved ? "" : undefined}>
            <p id={questionId} className="text-sm font-semibold text-slate-100" data-choice-question="">{index + 1}. {item.question}</p>
            <p className="mt-0.5 text-xs text-cyan-200/90" data-choice-recommendation=""><span className="font-semibold">Recommended:</span> {item.recommendation}</p>
            {item.options?.length ? (
                <div role="group" aria-labelledby={questionId} className="mt-2 space-y-1.5">
                    {item.options.map((option) => {
                        const chosen = saved?.answer === option.id;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                aria-pressed={chosen}
                                disabled={!editable || busy}
                                onClick={() => { if (!chosen || stale) void run(() => onSave(item.id, option.id)); }}
                                className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left max-lg:min-h-11 ${chosen ? "border-emerald-500/60 bg-emerald-500/10" : "border-slate-700 bg-slate-900/60"} ${editable && !chosen ? "hover:border-cyan-500/50" : ""} disabled:cursor-default ${!editable && !chosen ? "opacity-70" : ""}`}
                                data-choice-option={option.id}
                                data-chosen={chosen ? "" : undefined}
                            >
                                <span className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${chosen ? "border-emerald-400 bg-emerald-500/30 text-emerald-100" : "border-slate-500"}`} aria-hidden="true">
                                    {chosen && <Check size={11} />}
                                </span>
                                <span className="min-w-0">
                                    <span className="block text-sm text-slate-100">{option.label}</span>
                                    <span className="block text-[11px] text-slate-400" data-choice-action="">{option.action}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            ) : (
                <FreeTextAnswer key={saved?.answer ?? ""} item={item} saved={saved} stale={Boolean(stale)} editable={editable} busy={busy} onSave={(text) => run(() => onSave(item.id, text))} />
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                {busy && <span className="inline-flex items-center gap-1 text-slate-400"><Loader2 size={11} className="animate-spin" aria-hidden="true" /> Saving</span>}
                {!busy && saved && stale && !error && (
                    <span className="min-w-0 text-amber-200" data-choice-stale={stale.reason}>
                        Your answer cannot be sent: {staleReasonText(stale.reason)}. {item.options?.length ? "Choose an answer again" : "Save your answer again"} to confirm it, or clear it.
                    </span>
                )}
                {!busy && saved && !stale && !error && (
                    <span className="text-emerald-200/90" data-choice-saved="">
                        {sent ? "Sent" : "Saved"}{chosenOption ? `: ${chosenOption.label}` : ""}
                    </span>
                )}
                {!busy && !saved && sent && <span className="text-slate-400" data-choice-unanswered="">Not answered in a review you sent</span>}
                {earlierText !== null && (
                    <span className="min-w-0 whitespace-pre-wrap break-words text-slate-400" data-choice-sent-earlier="">
                        Sent earlier: {earlierText}{saved && saved.answer !== sentEarlier?.answer ? " (your new answer replaces it when you send)" : ""}
                    </span>
                )}
                {editable && saved && !busy && (
                    <button type="button" onClick={() => void run(() => onClear(item.id))} className="text-slate-400 underline hover:text-slate-200" data-choice-clear="">
                        Clear answer
                    </button>
                )}
                {error && <span role="alert" className="text-rose-200" data-choice-error="">{error}</span>}
            </div>
        </li>
    );
}

interface FreeTextAnswerProps {
    item: DecisionItem;
    saved: DecisionAnswer | null;
    /** The saved text cannot be sent as it stands, so saving it unchanged is allowed: that confirms it. */
    stale: boolean;
    editable: boolean;
    busy: boolean;
    onSave: (text: string) => Promise<void>;
}

function FreeTextAnswer({ item, saved, stale, editable, busy, onSave }: FreeTextAnswerProps) {
    const [text, setText] = useState(saved?.answer ?? "");
    const fieldId = `choice-${item.id}-answer`;
    const unchanged = text.trim() === (saved?.answer ?? "") && !stale;
    return (
        <div className="mt-2">
            {item.action && <p className="text-[11px] text-slate-400" data-choice-action=""><span className="font-semibold text-slate-300">Your answer is used to:</span> {item.action}</p>}
            {editable ? (
                <>
                    <label htmlFor={fieldId} className="mt-1.5 block text-[11px] font-semibold text-slate-300">Your answer</label>
                    <textarea id={fieldId} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} className="mt-1 h-16 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-500/60" data-choice-text="" />
                    <div className="mt-1 flex justify-end">
                        <button type="button" onClick={() => void onSave(text)} disabled={busy || !text.trim() || unchanged} className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50 max-lg:min-h-11" data-choice-save="">
                            Save answer
                        </button>
                    </div>
                </>
            ) : saved ? (
                <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-900/60 p-2 text-sm text-slate-100" data-choice-text-answer="">{saved.answer}</p>
            ) : null}
        </div>
    );
}

interface StaleAnswersNoticeProps {
    stale: StaleDecisionAnswer[];
    decisions: DecisionItems | null | undefined;
    /** Clear exactly these answers from the draft; the round's comments stay. */
    onClear: (decisionIds: string[]) => Promise<void>;
}

/**
 * Saved answers the decisions card cannot show (task 50aa5747 QA repair): their
 * decision was withdrawn or this version no longer asks it. They stay on the
 * draft, and Finish refuses them, until Robert clears them here.
 */
export function StaleAnswersNotice({ stale, decisions, onClear }: StaleAnswersNoticeProps) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const one = stale.length === 1;
    const clear = async () => {
        setBusy(true);
        setError(null);
        try { await onClear(stale.map((s) => s.decision_id)); }
        catch (err) { setError(err instanceof Error && err.message ? err.message : "Could not clear the answers"); }
        finally { setBusy(false); }
    };
    return (
        <section aria-label="Answers that cannot be sent" className="mb-4 max-w-3xl rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-100" data-stale-answers="">
            <p className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                    Your review holds {one ? "an answer" : `${stale.length} answers`} that cannot be sent, so Finish review will refuse {one ? "it" : "them"}. Clearing {one ? "it" : "them"} keeps your comments.
                </span>
            </p>
            <ul className="mt-1.5 space-y-1 pl-6">
                {stale.map((s) => {
                    const label = staleAnswerLabel(decisions, s);
                    return (
                        <li key={s.decision_id} className="min-w-0 whitespace-pre-wrap break-words" data-stale-answer={s.decision_id}>
                            {label.question} Your answer: {label.answer}. Not sent because {staleReasonText(s.reason)}.
                        </li>
                    );
                })}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void clear()} disabled={busy} className="rounded-md border border-amber-400/50 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-50 max-lg:min-h-11 max-lg:min-w-11!" data-stale-answers-clear="">
                    {busy ? "Clearing" : `Clear ${one ? "this answer" : "these answers"}`}
                </button>
                {error && <span role="alert" className="text-rose-200">{error}</span>}
            </div>
        </section>
    );
}
