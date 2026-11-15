/**
 * What the decisions card at the top of the document viewer shows (task
 * 50aa5747): the producer's structured decision_items, Robert's answers on his
 * review round, and whether he can answer now. Answers go to Praxis with
 * Finish review as feedback.decision_answers; an answer never approves,
 * edits, publishes or sends the document.
 *
 * Kept in lib/ (not exported from the component module) so a save of the page
 * does not force a full reload.
 */
import type { DecisionAnswer, DecisionItems, ReviewView, StaleAnswerReason, StaleDecisionAnswer } from './document-review';

export type ChoicesState = 'open' | 'sent' | 'blocked';

export interface ChoicesView {
    /** open: answers can be saved; sent: the round on this version went to Praxis; blocked: read-only, `note` says why. */
    state: ChoicesState;
    /** False when the declared items belong to another revision: only the note is shown. */
    showItems: boolean;
    /** Answers on the round that covers the revision on screen; once sent, the latest answer per decision across the sent rounds. */
    answers: DecisionAnswer[];
    /** What earlier rounds already sent, shown beside an open round so no decision is answered twice unseen. */
    sentAnswers: DecisionAnswer[];
    note: string | null;
}

export interface ChoicesInput {
    decisions: DecisionItems | null | undefined;
    review: Pick<ReviewView, 'status' | 'revision_id' | 'decision_answers'> | null;
    currentRevisionId: string | null;
    /** An earlier version is on screen. */
    showingEarlier: boolean;
    /** The current version takes review actions (no replacement work open, ready). */
    reviewable: boolean;
}

export function choicesView({ decisions, review, currentRevisionId, showingEarlier, reviewable }: ChoicesInput): ChoicesView | null {
    if (!decisions || decisions.items.length === 0) return null;
    const count = decisions.items.length;
    const roundOnCurrent = Boolean(review && review.status !== 'superseded' && review.revision_id === currentRevisionId);
    const answers = roundOnCurrent ? review?.decision_answers ?? [] : [];
    const none: DecisionAnswer[] = [];
    if (!decisions.answerable) {
        if (decisions.revision_id === null) {
            return { state: 'blocked', showItems: true, answers: none, sentAnswers: none, note: 'These decisions were saved before Nexus recorded which version they belong to, so they cannot be answered here. Answer them in chat with Praxis.' };
        }
        return { state: 'blocked', showItems: false, answers: none, sentAnswers: none, note: `${count === 1 ? 'The decision' : `The ${count} decisions`} listed with an earlier version ${count === 1 ? 'does' : 'do'} not apply to this one; this version has none to answer.` };
    }
    const sentAnswers = decisions.sent_answers ?? none;
    if (showingEarlier) return { state: 'blocked', showItems: true, answers, sentAnswers, note: 'These decisions belong to the latest version. Go back to it to answer them.' };
    if (roundOnCurrent && review?.status === 'submitted') {
        // Every round sent on this version counts, the latest answer per decision. The round on screen is the latest one sent and the
        // document read may predate its finish, so its own answers are laid over the list.
        const latest = new Map(sentAnswers.map(a => [a.decision_id, a]));
        for (const a of answers) latest.set(a.decision_id, a);
        return { state: 'sent', showItems: true, answers: [...latest.values()], sentAnswers: none, note: null };
    }
    if (!reviewable) return { state: 'blocked', showItems: true, answers, sentAnswers, note: 'This version takes no answers right now: a new version is being produced or this one is not ready.' };
    if (review && review.status === 'draft' && review.revision_id !== currentRevisionId) {
        return { state: 'blocked', showItems: true, answers: none, sentAnswers, note: 'Your open review is on an earlier version. Finish it first, then answer these on the current version.' };
    }
    return { state: 'open', showItems: true, answers, sentAnswers, note: null };
}

/** The answer saved for one decision, if any. */
export function answerFor(answers: DecisionAnswer[], decisionId: string): DecisionAnswer | null {
    return answers.find(a => a.decision_id === decisionId) ?? null;
}

/**
 * The draft's saved answers that Finish would refuse, each with its reason, so
 * the viewer can offer to clear them even when their decision is gone. A round
 * pinned to an earlier version, or a decision this version no longer lists, is
 * found here; a definition that changed under an answer comes from the
 * server's `stale_answers`, while the same answer is still saved.
 */
export function unsendableDraftAnswers(
    review: Pick<ReviewView, 'status' | 'revision_id' | 'decision_answers' | 'stale_answers'> | null,
    decisions: DecisionItems | null | undefined,
    currentRevisionId: string | null,
): StaleDecisionAnswer[] {
    if (!review || review.status !== 'draft') return [];
    const answers = review.decision_answers ?? [];
    if (answers.length === 0) return [];
    if (review.revision_id !== currentRevisionId) return answers.map(({ decision_id, answer }) => ({ decision_id, answer, reason: 'revision_changed' }));
    const reported = new Map((review.stale_answers ?? []).map(s => [s.decision_id, s]));
    const listed = decisions?.answerable && decisions.revision_id === review.revision_id ? new Set(decisions.items.map(i => i.id)) : null;
    const unsendable: StaleDecisionAnswer[] = [];
    for (const { decision_id, answer } of answers) {
        const server = reported.get(decision_id);
        if (server && server.answer === answer) unsendable.push(server);
        else if (!listed) unsendable.push({ decision_id, answer, reason: 'decisions_unavailable' });
        else if (!listed.has(decision_id)) unsendable.push({ decision_id, answer, reason: 'decision_removed' });
    }
    return unsendable;
}

/** Why an answer cannot be sent, as a clause. */
export function staleReasonText(reason: StaleAnswerReason): string {
    switch (reason) {
        case 'revision_changed': return 'it was given on an earlier version';
        case 'definition_changed': return 'the question or its action changed after you answered';
        case 'answer_invalid': return 'it is no longer one of the answers offered';
        default: return 'this version no longer asks it';
    }
}

/** A stale answer as Robert gave it: the question if it is still listed, and the option label or the text. */
export function staleAnswerLabel(decisions: DecisionItems | null | undefined, stale: StaleDecisionAnswer): { question: string; answer: string } {
    const item = decisions?.items.find(i => i.id === stale.decision_id);
    return { question: item?.question ?? `The decision “${stale.decision_id}” (no longer listed).`, answer: item?.options?.find(o => o.id === stale.answer)?.label ?? stale.answer };
}
