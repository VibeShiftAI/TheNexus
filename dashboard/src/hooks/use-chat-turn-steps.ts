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

/** The key the turn status route accepts: validTurnKey in server/routes/ai-chat.js. */
const TURN_KEY = /^[a-zA-Z0-9_-]{1,160}$/;
const STILL_WORKING = "Praxis is still working on this message.";

/**
 * One read of the turn's status route. "gone" means it knows no such turn;
 * "wait" means the API allowance is spent for now, which says nothing about the
 * turn and is not a lost connection (the read backoff holds requests meanwhile).
 */
async function readTurn(id: string, signal?: AbortSignal): Promise<TurnReceiptSteps | "gone" | "wait"> {
    const response = await fetch(`/api/ai/chat/turns/${encodeURIComponent(id)}`, {
        headers: await getAuthHeader(), signal, cache: "no-store",
    });
    chatTurnSteps.noteAllowance(response.headers);
    if (response.status === 400 || response.status === 404) return "gone";
    if (response.status === 429) return "wait";
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
    /** A turn this page did not send: show it only if it is really still running. */
    adopt?: { conversationId: string | null };
}

/** A saved reply, when there is one, arrives as a newer row and retires this notice. */
function noteHowItEnded(id: string, receipt: TurnReceiptSteps) {
    if (receipt.state !== "completed") chatTurnSteps.noteUnconfirmed(id);
}

async function followTurn(id: string, signal: AbortSignal, { adopt }: FollowOptions) {
    for (let first = true; !signal.aborted; first = false) {
        if (!first) await pause(chatTurnSteps.followSpacing(), signal);
        if (signal.aborted) return;
        if (document.hidden) continue;
        try {
            const receipt = await readTurn(id, signal);
            if (signal.aborted) return;
            chatTurnSteps.noteContact(id);
            if (receipt === "wait") continue;
            // A definite answer. Until one comes, a remount asks about this turn again.
            chatTurnSteps.noteKnown(id);
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
            // The panel says so from the first unanswered read; the next answer clears it.
            chatTurnSteps.noteLostContact(id);
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
            follow(id);
        },
        /** The stream or request broke while the turn may still be running. */
        followAfterLoss: (id: string) => {
            if (!chatTurnSteps.has(id)) return;
            chatTurnSteps.startFollowing(id, STILL_WORKING);
            follow(id);
        },
        /**
         * A reply with no stream arrived. The line folds now from what this page
         * holds, so a slow read can hold nothing open, and the turn's final steps
         * join it whenever that read answers.
         */
        foldAfterReply: async (id: string, messageId: string | null | undefined) => {
            pollers.current.get(id)?.abort();
            pollers.current.delete(id);
            chatTurnSteps.fold(id, messageId);
            try {
                const read = await readTurn(id);
                if (read !== "gone" && read !== "wait") chatTurnSteps.completeFold(id, messageId, read);
            } catch { /* The line stays as this page measured it. */ }
        },
        release: (id: string) => chatTurnSteps.release(id),
    }), [folded, unconfirmedTurn, conversationId, follow]);
}
