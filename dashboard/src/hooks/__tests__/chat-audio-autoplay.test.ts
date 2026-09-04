/**
 * The autoplay "fresh report" decision — the rule that stopped the morning
 * status briefing from re-announcing itself on every reload and every
 * unrelated socket append (2026-07-25 / 2026-08-11).
 *
 * A full status report auto-plays ONLY when all four hold:
 *   1. this device has never STARTED it (persisted `played` registry),
 *   2. the hosting message is younger than REPORT_AUTOPLAY_FRESH_MS,
 *   3. it is not already the global player's current item,
 *   4. it is not already staged as the pending briefing.
 *
 * P2-27 extracted this out of ai-terminal.tsx into hooks/use-chat-audio.ts;
 * these are the timing rules the extraction had to keep exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    REPORT_AUTOPLAY_FRESH_MS,
    shouldQueueReportAutoplay,
    shouldQueueVoiceAutoplay,
    VOICE_AUTOPLAY_FRESH_MS,
    voiceKeyForMessage,
} from "../use-chat-audio.ts";

const NOW = Date.UTC(2026, 8, 3, 7, 30, 0);
const KEY = "id:1f0c#att0";

function decide(over: Partial<Parameters<typeof shouldQueueReportAutoplay>[0]> = {}) {
    return shouldQueueReportAutoplay({
        reportKey: KEY,
        messageTimeMs: NOW - 1_000,
        nowMs: NOW,
        playedKeys: new Set<string>(),
        currentAudioKey: null,
        pendingKey: null,
        ...over,
    });
}

test("a fresh, unheard briefing auto-plays", () => {
    assert.equal(decide(), true);
});

test("the fresh window is REPORT_AUTOPLAY_FRESH_MS, inclusive at the boundary", () => {
    assert.equal(REPORT_AUTOPLAY_FRESH_MS, 3 * 60_000);
    assert.equal(decide({ messageTimeMs: NOW - REPORT_AUTOPLAY_FRESH_MS }), true);
    assert.equal(decide({ messageTimeMs: NOW - REPORT_AUTOPLAY_FRESH_MS - 1 }), false);
});

test("a briefing this device already started never re-announces", () => {
    // The persisted store is what survives a refresh — the history load that
    // re-surfaces the morning briefing must stay silent.
    assert.equal(decide({ playedKeys: new Set([KEY]) }), false);
});

test("the item already on the global player is not staged again", () => {
    assert.equal(decide({ currentAudioKey: KEY }), false);
    assert.equal(decide({ currentAudioKey: "id:other#att0" }), true);
});

test("an already-pending briefing is not re-staged by a later transcript scan", () => {
    assert.equal(decide({ pendingKey: KEY }), false);
});

test("legacy voice notes use the same freshness discipline plus dismiss/listened", () => {
    const base = {
        voiceKey: "id:abc#0",
        messageTimeMs: NOW - 1_000,
        nowMs: NOW,
        playedKeys: new Set<string>(),
        dismissedKeys: new Set<string>(),
        listenedKeys: new Set<string>(),
    };
    assert.equal(shouldQueueVoiceAutoplay(base), true);
    assert.equal(VOICE_AUTOPLAY_FRESH_MS, 3 * 60_000);
    assert.equal(
        shouldQueueVoiceAutoplay({ ...base, messageTimeMs: NOW - VOICE_AUTOPLAY_FRESH_MS - 1 }),
        false,
    );
    assert.equal(shouldQueueVoiceAutoplay({ ...base, playedKeys: new Set([base.voiceKey]) }), false);
    assert.equal(shouldQueueVoiceAutoplay({ ...base, dismissedKeys: new Set([base.voiceKey]) }), false);
    assert.equal(shouldQueueVoiceAutoplay({ ...base, listenedKeys: new Set([base.voiceKey]) }), false);
});

test("voice keys are message IDENTITY, never array position", () => {
    const ts = new Date(NOW);
    assert.equal(voiceKeyForMessage({ id: "abc", timestamp: ts, role: "assistant" }, 0), "id:abc#0");
    assert.equal(
        voiceKeyForMessage({ timestamp: ts, role: "system" }, 1),
        `ts:${ts.toISOString()}|system#1`,
    );
});
