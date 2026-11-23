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
    /** Every step Praxis counted, including any that have not reached this page. */
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

/**
 * The allowance server/middleware/api-rate-limit.js applies to a client, used
 * until a response has published the current one. A server test holds the two
 * equal.
 */
export const API_ALLOWANCE_FALLBACK = { limit: 5_758, windowMs: 900_000 };
/**
 * The share of that allowance one followed turn may spend: 360 reads per
 * 15-minute window at the current policy. Every open tab draws on the same
 * allowance. An idle page measured 795 reads per window on 2026-11-23, so a page
 * following a turn uses 1,155 of the 5,758. The browser check measures this again.
 */
const FOLLOW_ALLOWANCE_SHARE = 1 / 16;

/** Milliseconds between status reads of a followed turn, from what the API publishes. */
export function followSpacingMs(headers?: Pick<Headers, "get"> | null): number {
    const published = Number(headers?.get("RateLimit-Limit"));
    const windowSeconds = Number(headers?.get("RateLimit-Policy")?.match(/;\s*w=(\d+)/)?.[1]);
    const { limit, windowMs } = published > 0 && windowSeconds > 0
        ? { limit: published, windowMs: windowSeconds * 1000 }
        : API_ALLOWANCE_FALLBACK;
    return Math.ceil(windowMs / (limit * FOLLOW_ALLOWANCE_SHARE));
}

const WARNING_STATES = new Set(["degraded", "uncertain"]);
const STEP_KINDS = new Set<string>(["tool", "reasoning"]);
const STEP_STATUSES = new Set<string>(["running", "done", "failed", "unfinished"]);

export function isTurnStep(value: unknown): value is TurnStep {
    if (!value || typeof value !== "object") return false;
    const step = value as Record<string, unknown>;
    return typeof step.id === "string" && Number.isSafeInteger(step.seq) && typeof step.text === "string"
        && STEP_KINDS.has(step.kind as string) && STEP_STATUSES.has(step.status as string);
}

/** A step's display fields after an update. A closed step never reopens. */
function mergedStep(previous: TurnStep | undefined, incoming: TurnStep): TurnStep {
    const step: TurnStep = {
        id: incoming.id, seq: incoming.seq, kind: incoming.kind, text: incoming.text, status: incoming.status,
        ...(incoming.started_ms === undefined ? {} : { started_ms: incoming.started_ms }),
    };
    if (!previous) return step;
    const status = previous.status !== "running" && step.status === "running" ? previous.status : step.status;
    if (previous.text === step.text && previous.status === status) return previous;
    return { ...step, status };
}

/** Insert or update one step, keeping Praxis's order. */
export function upsertTurnStep(steps: readonly TurnStep[], incoming: TurnStep): readonly TurnStep[] {
    const at = steps.findIndex(existing => existing.id === incoming.id);
    if (at >= 0) {
        const merged = mergedStep(steps[at], incoming);
        if (merged === steps[at]) return steps;
        const next = [...steps];
        next[at] = merged;
        return next;
    }
    const next = [...steps];
    let index = next.length;
    while (index > 0 && next[index - 1].seq > incoming.seq) index -= 1;
    next.splice(index, 0, mergedStep(undefined, incoming));
    return next;
}

/** Merge a status read's steps in one pass, so replaying a long turn stays cheap. */
export function mergeTurnSteps(steps: readonly TurnStep[], incoming: unknown): readonly TurnStep[] {
    const byId = new Map(steps.map(step => [step.id, step]));
    let changed = false;
    for (const raw of Array.isArray(incoming) ? incoming : []) {
        if (!isTurnStep(raw)) continue;
        const previous = byId.get(raw.id);
        const merged = mergedStep(previous, raw);
        if (merged === previous) continue;
        byId.set(raw.id, merged);
        changed = true;
    }
    return changed ? [...byId.values()].sort((a, b) => a.seq - b.seq) : steps;
}

/** A turn that is over has nothing still running: a step that never reported back says so. */
function closedSteps(steps: readonly TurnStep[]): readonly TurnStep[] {
    return steps.some(step => step.status === "running")
        ? steps.map(step => (step.status === "running" ? { ...step, status: "unfinished" as const } : step))
        : steps;
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
    let followSpacing = followSpacingMs();

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
        /** Keep the read pace to the allowance the API last published. */
        noteAllowance(headers?: Pick<Headers, "get"> | null) {
            if (headers?.get("RateLimit-Limit")) followSpacing = followSpacingMs(headers);
        },
        followSpacing: () => followSpacing,
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
                // Praxis's running status is one fixed sentence; the steps and the timer already show the turn is working.
                const status = note.state === "running" ? "" : warning === note.message ? turn.status : note.message;
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
                const steps = mergeTurnSteps(turn.steps, receipt.steps);
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
        /** The status route answered, whatever it said. */
        noteContact(id: string) {
            patch(id, turn => (turn.lostContact ? { ...turn, lostContact: false } : turn));
        },
        /** Close the turn. With steps and a reply to sit above, it becomes one line. */
        fold(id: string, messageId: string | null | undefined, timing?: TurnReceiptSteps) {
            const turn = turns.get(id);
            if (!turn) return;
            turns.delete(id);
            if (messageId && turn.steps.length > 0) {
                const next = new Map(folded);
                next.set(messageId, {
                    turnId: id,
                    durationMs: typeof timing?.duration_ms === "number" ? timing.duration_ms : Math.max(0, clock() - turn.startedAt),
                    steps: closedSteps(turn.steps),
                    stepCount: Math.max(turn.stepCount, typeof timing?.step_count === "number" ? timing.step_count : 0),
                });
                folded = next;
            }
            emit();
        },
        /** The status route's word on a turn that has already folded. It can only add to the line. */
        completeFold(id: string, messageId: string | null | undefined, receipt: TurnReceiptSteps) {
            if (!messageId) return;
            const line = folded.get(messageId);
            const steps = closedSteps(mergeTurnSteps(line?.steps ?? [], receipt.steps));
            if (steps.length === 0) return;
            const durationMs = typeof receipt.duration_ms === "number" ? receipt.duration_ms
                : line?.durationMs ?? (typeof receipt.elapsed_ms === "number" ? receipt.elapsed_ms : 0);
            const stepCount = Math.max(line?.stepCount ?? 0, typeof receipt.step_count === "number" ? receipt.step_count : 0, steps.length);
            if (line && steps === line.steps && durationMs === line.durationMs && stepCount === line.stepCount) return;
            const next = new Map(folded);
            next.set(messageId, { turnId: id, durationMs, steps, stepCount });
            folded = next;
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
            followSpacing = followSpacingMs();
            emit();
        },
    };
}

export type TurnStepsStore = ReturnType<typeof createTurnStepsStore>;

/** One store per page, so a turn survives the terminal remounting on a route change. */
export const chatTurnSteps = createTurnStepsStore();
