"use client";

/**
 * useChatTurnSteps: the terminal's seam to a turn's working steps.
 *
 * A streamed turn feeds the step store from its own stream. A turn with no
 * open stream (attachments, voice, a dropped connection, a page reload while
 * it runs) is read from its status route until it ends, and that route is the
 * same one the saved-turn page uses. Reading it never runs or resends a turn.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { Message } from "@/components/cortex-provider";
import { getAuthHeader } from "@/lib/auth";
import { chatTurnSteps, type TurnReceiptSteps } from "@/lib/chat-turn-steps";
import type { PraxisTurnStatus, PraxisTurnStep } from "@/lib/read-praxis-event-stream";

const FOLLOW_EVERY_MS = 2_500;
/** Failed reads in a row before the panel says it has lost contact. */
const LOST_CONTACT_AFTER = 3;
const TURN_KEY = /^[a-zA-Z0-9_-]{1,160}$/;
const STILL_WORKING = "Praxis is still working on this message.";
/** How long a landed reply waits for its turn's final steps before folding what the page holds. */
const FOLD_READ_TIMEOUT_MS = 5_000;

async function readTurn(id: string, signal?: AbortSignal): Promise<TurnReceiptSteps | "gone"> {
    const response = await fetch(`/api/ai/chat/turns/${encodeURIComponent(id)}`, {
        headers: await getAuthHeader(), signal, cache: "no-store",
    });
    if (response.status === 400 || response.status === 404) return "gone";
    if (!response.ok) throw new Error(`Turn status answered ${response.status}`);
    return response.json();
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}

interface FollowOptions {
    /** Wait before the first read, for a turn that was only just sent. */
    delayMs?: number;
    /** A turn this page did not send: show it only if it is really still running. */
    adopt?: { conversationId: string | null };
}

/** A saved reply, when there is one, arrives as a newer row and retires this notice. */
function noteHowItEnded(id: string, receipt: TurnReceiptSteps) {
    if (receipt.state !== "completed") chatTurnSteps.noteUnconfirmed(id);
}

async function followTurn(id: string, signal: AbortSignal, { delayMs = 0, adopt }: FollowOptions) {
    let failures = 0;
    let wait = delayMs;
    while (!signal.aborted) {
        if (wait > 0) await pause(wait, signal);
        if (signal.aborted) return;
        wait = FOLLOW_EVERY_MS;
        if (document.hidden) continue;
        try {
            const receipt = await readTurn(id, signal);
            if (signal.aborted) return;
            failures = 0;
            if (receipt === "gone") {
                // A send still on its way has not registered its turn yet.
                if (chatTurnSteps.isSending(id)) continue;
                chatTurnSteps.drop(id);
                return;
            }
            const running = receipt.state === "in_progress";
            if (adopt && !chatTurnSteps.has(id)) {
                if (!running) { noteHowItEnded(id, receipt); return; }
                chatTurnSteps.begin(id, adopt.conversationId, STILL_WORKING, true);
            }
            chatTurnSteps.applyReceipt(id, receipt);
            if (!running) {
                chatTurnSteps.fold(id, `${id}:reply`, receipt);
                noteHowItEnded(id, receipt);
                return;
            }
        } catch {
            if (signal.aborted) return;
            failures += 1;
            if (adopt && !chatTurnSteps.has(id) && failures >= LOST_CONTACT_AFTER) {
                chatTurnSteps.forget(id);
                return;
            }
            if (failures >= LOST_CONTACT_AFTER) chatTurnSteps.noteLostContact(id);
        }
    }
}

export function useChatTurnSteps({ messages, conversationId, isLoadingHistory }: {
    messages: Message[];
    conversationId: string | null;
    isLoadingHistory: boolean;
}) {
    const folded = useSyncExternalStore(chatTurnSteps.subscribe, chatTurnSteps.getFolded, chatTurnSteps.getFolded);
    const pollers = useRef(new Map<string, AbortController>());

    const follow = useCallback((id: string, options: FollowOptions = {}) => {
        if (pollers.current.has(id)) return;
        const controller = new AbortController();
        pollers.current.set(id, controller);
        void followTurn(id, controller.signal, options).finally(() => {
            if (pollers.current.get(id) === controller) pollers.current.delete(id);
        });
    }, []);

    // A turn already being followed carries on when the terminal remounts.
    useEffect(() => {
        const running = pollers.current;
        for (const id of chatTurnSteps.following()) follow(id);
        return () => {
            for (const controller of running.values()) controller.abort();
            running.clear();
        };
    }, [follow]);

    // The newest row is a user message this page knows nothing about, as after
    // a reload or a send from another device: check whether it is still running.
    const newest = messages[messages.length - 1];
    const unansweredTurn = newest?.role === "user" && typeof newest.id === "string" && TURN_KEY.test(newest.id)
        ? newest.id : null;
    useEffect(() => {
        if (!unansweredTurn || isLoadingHistory || chatTurnSteps.known(unansweredTurn)) return;
        chatTurnSteps.noteKnown(unansweredTurn);
        follow(unansweredTurn, { adopt: { conversationId } });
    }, [unansweredTurn, isLoadingHistory, conversationId, follow]);

    // Only while that message is still the newest row: a reply or a new send retires the notice.
    const readUnconfirmed = () => (unansweredTurn && chatTurnSteps.isUnconfirmed(unansweredTurn) ? unansweredTurn : null);
    const unconfirmedTurn = useSyncExternalStore(chatTurnSteps.subscribe, readUnconfirmed, () => null);

    return useMemo(() => ({
        folded,
        unconfirmedTurn,
        begin: (id: string, status: string) => chatTurnSteps.begin(id, conversationId, status),
        noteStatus: (id: string, status: PraxisTurnStatus | { message: string }) => chatTurnSteps.noteStatus(id, status),
        noteStep: (id: string, step: PraxisTurnStep) => chatTurnSteps.noteStep(id, step),
        fold: (id: string, messageId: string | null | undefined, timing?: TurnReceiptSteps) => chatTurnSteps.fold(id, messageId, timing),
        /** This send has no stream, so its steps come from the status route. */
        followWithoutStream: (id: string) => {
            chatTurnSteps.startFollowing(id);
            follow(id, { delayMs: FOLLOW_EVERY_MS });
        },
        /** The stream or request broke while the turn may still be running. */
        followAfterLoss: (id: string) => {
            if (!chatTurnSteps.has(id)) return;
            chatTurnSteps.startFollowing(id, STILL_WORKING);
            follow(id);
        },
        /** A reply with no stream arrived: read the turn's final steps, then fold them. */
        foldAfterReply: async (id: string, messageId: string | null | undefined) => {
            pollers.current.get(id)?.abort();
            pollers.current.delete(id);
            // The send ends right after this call; hold the turn until the read below settles.
            chatTurnSteps.startFollowing(id);
            const reading = new AbortController();
            const timer = setTimeout(() => reading.abort(), FOLD_READ_TIMEOUT_MS);
            let receipt: TurnReceiptSteps | undefined;
            try {
                const read = await readTurn(id, reading.signal);
                if (read !== "gone") { receipt = read; chatTurnSteps.applyReceipt(id, read); }
            } catch { /* Fold what this page already holds, timed by its own clock. */ }
            clearTimeout(timer);
            chatTurnSteps.fold(id, messageId, receipt);
        },
        release: (id: string) => chatTurnSteps.release(id),
    }), [folded, unconfirmedTurn, conversationId, follow]);
}
