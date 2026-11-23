/**
 * The working steps of a chat turn, as the chat shows them.
 *
 * Steps live only here, in page memory. They are never added to the message
 * list and never saved, so a reload shows no steps for a finished turn; a turn
 * still running after a reload is picked up again from its status route.
 * Praxis redacts step text before it leaves, and the chat renders it as plain
 * text. The store sits outside React so a new step re-renders only the step
 * panel, never the transcript.
 */

export type TurnStepKind = "tool" | "reasoning";
export type TurnStepStatus = "running" | "done" | "failed" | "unfinished";

export interface TurnStep {
    id: string;
    seq: number;
    kind: TurnStepKind;
    text: string;
    status: TurnStepStatus;
    started_ms?: number;
}

/** The fields of a status frame the step panel reads. */
export interface TurnStatusNote {
    state?: string;
    message: string;
    elapsed_ms?: number;
    /** The conversation the server saved the turn in; it outranks the page's guess at send. */
    conversation_id?: string;
}

/** What the turn status route and the final frame report about a turn. */
export interface TurnReceiptSteps {
    state?: string;
    steps?: unknown;
    step_count?: number;
    omitted_steps?: number;
    elapsed_ms?: number;
    duration_ms?: number | null;
}

export interface LiveTurn {
    id: string;
    conversationId: string | null;
    status: string;
    /** A real degraded or uncertain state, in Praxis's words. It stays for the rest of the turn. */
    warning: string | null;
    /** Set while reading this turn from its status route because no stream is open. */
    following: boolean;
    /** Set while the request that sent this turn is still open, so Praxis may not have registered it yet. */
    sending: boolean;
    /** Set when the status route has stopped answering. */
    lostContact: boolean;
    steps: readonly TurnStep[];
    /** Every step Praxis counted, including any this view no longer holds. */
    stepCount: number;
    /** Clock reading at which the turn started. */
    startedAt: number;
    /** True once the start time comes from Praxis rather than from the send. */
    anchored: boolean;
}

export interface FoldedTurn {
    turnId: string;
    durationMs: number;
    steps: readonly TurnStep[];
    stepCount: number;
}

/** Page memory per turn, matching what Praxis itself keeps for one turn. */
export const MAX_HELD_STEPS = 500;
/** Folded turns kept for this page; an older reply simply loses its line, as it would after a reload. */
export const MAX_FOLDED_TURNS = 64;

const WARNING_STATES = new Set(["degraded", "uncertain"]);
const STEP_KINDS = new Set<string>(["tool", "reasoning"]);
const STEP_STATUSES = new Set<string>(["running", "done", "failed", "unfinished"]);

export function isTurnStep(value: unknown): value is TurnStep {
    if (!value || typeof value !== "object") return false;
    const step = value as Record<string, unknown>;
    return typeof step.id === "string" && Number.isSafeInteger(step.seq) && typeof step.text === "string"
        && STEP_KINDS.has(step.kind as string) && STEP_STATUSES.has(step.status as string);
}

/** Insert or update one step, keeping Praxis's order. A closed step never reopens. */
export function upsertTurnStep(steps: readonly TurnStep[], incoming: TurnStep): readonly TurnStep[] {
    const step: TurnStep = {
        id: incoming.id, seq: incoming.seq, kind: incoming.kind, text: incoming.text, status: incoming.status,
        ...(incoming.started_ms === undefined ? {} : { started_ms: incoming.started_ms }),
    };
    const at = steps.findIndex(existing => existing.id === step.id);
    if (at >= 0) {
        const previous = steps[at];
        const status = previous.status !== "running" && step.status === "running" ? previous.status : step.status;
        if (previous.text === step.text && previous.status === status) return steps;
        const next = [...steps];
        next[at] = { ...step, status };
        return next;
    }
    const next = [...steps];
    let index = next.length;
    while (index > 0 && next[index - 1].seq > step.seq) index -= 1;
    next.splice(index, 0, step);
    return next.length > MAX_HELD_STEPS ? next.slice(next.length - MAX_HELD_STEPS) : next;
}

export function formatElapsed(ms: number): string {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    if (seconds < 1) return "under 1s";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const stepWord = (count: number) => `${count} ${count === 1 ? "step" : "steps"}`;

export function stepCountLabel(count: number): string {
    return stepWord(count);
}

/** The one line a finished turn folds into. */
export function foldedLabel(turn: Pick<FoldedTurn, "durationMs" | "stepCount" | "steps">): string {
    const failed = turn.steps.filter(step => step.status === "failed").length;
    const unfinished = turn.steps.filter(step => step.status === "unfinished").length;
    return [
        `Worked for ${formatElapsed(turn.durationMs)}`,
        stepWord(turn.stepCount),
        ...(failed ? [`${failed} failed`] : []),
        ...(unfinished ? [`${unfinished} did not finish`] : []),
    ].join(" · ");
}

export function hiddenStepCount(turn: Pick<LiveTurn, "stepCount" | "steps">): number {
    return Math.max(0, turn.stepCount - turn.steps.length);
}

export function createTurnStepsStore(clock: () => number = () => performance.now()) {
    const turns = new Map<string, LiveTurn>();
    const seen = new Set<string>();
    const unconfirmed = new Set<string>();
    const listeners = new Set<() => void>();
    let folded: ReadonlyMap<string, FoldedTurn> = new Map();

    const emit = () => listeners.forEach(listener => listener());
    const patch = (id: string, change: (turn: LiveTurn) => LiveTurn) => {
        const turn = turns.get(id);
        if (!turn) return;
        const next = change(turn);
        if (next === turn) return;
        turns.set(id, next);
        emit();
    };
    /** Latency only ever makes a reading late, so the earliest start seen is the truest. */
    const anchor = (turn: LiveTurn, elapsedMs: number | undefined): LiveTurn => {
        if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return turn;
        const reading = clock() - elapsedMs;
        const startedAt = turn.anchored ? Math.min(turn.startedAt, reading) : reading;
        return startedAt === turn.startedAt && turn.anchored ? turn : { ...turn, startedAt, anchored: true };
    };

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getFolded: () => folded,
        now: () => clock(),
        has: (id: string) => turns.has(id),
        /** True once this page has started, adopted or checked the turn. */
        known: (id: string) => seen.has(id),
        noteKnown(id: string) { seen.add(id); },
        forget(id: string) { seen.delete(id); },
        following: () => [...turns.values()].filter(turn => turn.following).map(turn => turn.id),
        isSending: (id: string) => turns.get(id)?.sending === true,
        /** The turn ended with no confirmed reply. The chat says so until a later message follows it. */
        noteUnconfirmed(id: string) {
            if (unconfirmed.has(id)) return;
            unconfirmed.add(id);
            emit();
        },
        isUnconfirmed: (id: string) => unconfirmed.has(id),
        /** The newest running turn of this conversation. */
        live(conversationId: string | null): LiveTurn | null {
            let newest: LiveTurn | null = null;
            for (const turn of turns.values()) {
                if (turn.conversationId === conversationId || turn.conversationId === null) newest = turn;
            }
            return newest;
        },
        begin(id: string, conversationId: string | null, status: string, following = false) {
            seen.add(id);
            if (turns.has(id)) return;
            turns.set(id, {
                id, conversationId, status, warning: null, following, sending: !following, lostContact: false,
                steps: [], stepCount: 0, startedAt: clock(), anchored: false,
            });
            emit();
        },
        noteStatus(id: string, note: TurnStatusNote) {
            patch(id, turn => {
                const warning = WARNING_STATES.has(note.state ?? "") ? note.message : turn.warning;
                const status = warning === note.message ? turn.status : note.message;
                const conversationId = note.conversation_id ?? turn.conversationId;
                const unchanged = status === turn.status && warning === turn.warning && conversationId === turn.conversationId;
                const next = unchanged ? turn : { ...turn, status, warning, conversationId };
                return anchor(next, note.elapsed_ms);
            });
        },
        noteStep(id: string, step: TurnStep & { elapsed_ms?: number }) {
            patch(id, turn => {
                const steps = upsertTurnStep(turn.steps, step);
                const stepCount = Math.max(turn.stepCount, step.seq);
                const next = steps === turn.steps && stepCount === turn.stepCount ? turn : { ...turn, steps, stepCount };
                return anchor(next, step.elapsed_ms);
            });
        },
        /** Merge what the status route reports; it answers after a stream was lost. */
        applyReceipt(id: string, receipt: TurnReceiptSteps) {
            patch(id, turn => {
                let steps = turn.steps;
                for (const step of Array.isArray(receipt.steps) ? receipt.steps : []) {
                    if (isTurnStep(step)) steps = upsertTurnStep(steps, step);
                }
                const counted = typeof receipt.step_count === "number" ? receipt.step_count : 0;
                const highest = steps.reduce((max, step) => Math.max(max, step.seq), 0);
                const stepCount = Math.max(turn.stepCount, counted, highest);
                const changed = steps !== turn.steps || stepCount !== turn.stepCount || turn.lostContact;
                return anchor(changed ? { ...turn, steps, stepCount, lostContact: false } : turn, receipt.elapsed_ms);
            });
        },
        startFollowing(id: string, status?: string) {
            patch(id, turn => (turn.following && !status ? turn : { ...turn, following: true, status: status ?? turn.status }));
        },
        noteLostContact(id: string) {
            patch(id, turn => (turn.lostContact ? turn : { ...turn, lostContact: true }));
        },
        /** Close the turn. With steps and a reply to sit above, it becomes one line. */
        fold(id: string, messageId: string | null | undefined, timing?: TurnReceiptSteps) {
            const turn = turns.get(id);
            if (!turn) return;
            turns.delete(id);
            if (messageId && turn.steps.length > 0) {
                const steps = turn.steps.map(step => (step.status === "running" ? { ...step, status: "unfinished" as const } : step));
                const next = new Map(folded);
                next.set(messageId, {
                    turnId: id,
                    durationMs: typeof timing?.duration_ms === "number" ? timing.duration_ms : Math.max(0, clock() - turn.startedAt),
                    steps,
                    stepCount: Math.max(turn.stepCount, typeof timing?.step_count === "number" ? timing.step_count : 0),
                });
                while (next.size > MAX_FOLDED_TURNS) next.delete(next.keys().next().value as string);
                folded = next;
            }
            emit();
        },
        /** The send's request has ended. Unless the turn is being followed, that ends the turn here too. */
        release(id: string) {
            const turn = turns.get(id);
            if (!turn) return;
            if (turn.following) {
                turns.set(id, { ...turn, sending: false });
                return;
            }
            turns.delete(id);
            emit();
        },
        drop(id: string) {
            if (turns.delete(id)) emit();
        },
        resetForTests() {
            turns.clear();
            seen.clear();
            unconfirmed.clear();
            folded = new Map();
            emit();
        },
    };
}

export type TurnStepsStore = ReturnType<typeof createTurnStepsStore>;

/** One store per page, so a turn survives the terminal remounting on a route change. */
export const chatTurnSteps = createTurnStepsStore();
