/**
 * One audio model for chat messages: legacy base64 voice notes and URL-backed
 * attachments (the full morning status-report MP3 relayed at
 * /api/praxis/report/…) resolve to the same ChatAudioItem shape.
 *
 * When a message carries a full_status_report attachment it is the SOLE
 * report audio — legacy voice entries on that message are suppressed so the
 * card never renders two competing players (2026-08-11 audio-delivery plan).
 */

import type { Message } from "@/components/cortex-provider";

export interface ChatAudioItem {
    key: string;
    src: string;
    mimeType: string;
    name: string;
    kind: "voice_reply" | "full_status_report";
}

/** Notes older than this never auto-play — badge/manual only. */
export const VOICE_AUTOPLAY_FRESH_MS = 3 * 60_000;

/** Mirrors ai-terminal's voiceKeyForMessage identity so played-state stores
 *  stay compatible; attachment keys get their own `#att` suffix space. */
function messageIdentity(message: Pick<Message, "id" | "timestamp" | "role">): string {
    return message.id
        ? `id:${message.id}`
        : `ts:${message.timestamp.toISOString()}|${message.role}`;
}

export function attachmentAudioKey(message: Message, index: number): string {
    return `${messageIdentity(message)}#att${index}`;
}

export function audioItemsForMessage(message: Message): ChatAudioItem[] {
    const items: ChatAudioItem[] = [];
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    attachments.forEach((attachment, index) => {
        if (attachment?.type !== "audio") return;
        const src = typeof attachment.url === "string" ? attachment.url.trim() : "";
        if (!src) return;
        items.push({
            key: attachmentAudioKey(message, index),
            // Relative URLs stay relative — the browser resolves them against
            // the dashboard origin, which proxies /api to the cockpit server.
            src,
            mimeType: attachment.mimeType || "audio/mpeg",
            name: attachment.name || "Praxis audio",
            kind: attachment.kind === "full_status_report" ? "full_status_report" : "voice_reply",
        });
    });

    const hasFullReport = items.some((item) => item.kind === "full_status_report");
    if (!hasFullReport && Array.isArray(message.voiceData)) {
        message.voiceData.forEach((voice, index) => {
            if (!voice?.audio) return;
            items.push({
                key: `${messageIdentity(message)}#${index}`,
                src: `data:${voice.mimeType || "audio/mpeg"};base64,${voice.audio}`,
                mimeType: voice.mimeType || "audio/mpeg",
                name: "Praxis voice reply",
                kind: "voice_reply",
            });
        });
    }
    return items;
}

/** The message's full-report attachment item, when it has one. */
export function fullReportAudioForMessage(message: Message): ChatAudioItem | null {
    return audioItemsForMessage(message).find((item) => item.kind === "full_status_report") ?? null;
}

/**
 * The single item eligible to auto-play for a message: the full report when
 * present, else the first voice note — and only while the message is FRESH.
 * Played/dismissed bookkeeping stays with the caller (ai-terminal owns the
 * persisted stores).
 */
export function autoplayAudioForMessage(
    message: Message,
    nowMs: number = Date.now(),
): ChatAudioItem | null {
    if (nowMs - message.timestamp.getTime() > VOICE_AUTOPLAY_FRESH_MS) return null;
    const items = audioItemsForMessage(message);
    return items.find((item) => item.kind === "full_status_report") ?? items[0] ?? null;
}
