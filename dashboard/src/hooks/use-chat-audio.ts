"use client";

/**
 * useChatAudio — the terminal's voice/audio lane: which Praxis note is
 * eligible to auto-play, the one-at-a-time playback queue, the TNG comm
 * chirp, the persisted "already started on this device" registry, and the
 * full-status-report briefing that rides the provider's global player.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03). The autoplay
 * TIMING RULES are unchanged and stated once, here:
 *   - a legacy voice note auto-plays only if it is FRESH
 *     (VOICE_AUTOPLAY_FRESH_MS = 3 min) and this device never started it;
 *   - a full status report auto-plays only if it is FRESH
 *     (REPORT_AUTOPLAY_FRESH_MS, from chat-audio.ts) and this device never
 *     started it, and it is not already the global player's item;
 *   - dismissed / listened notes never auto-play;
 *   - eligibility is keyed by stable message IDENTITY, not array index, so a
 *     history load or a mid-list merge can surface an old note without
 *     re-announcing it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isThisClientActive } from "@/lib/active-client";
import {
    fullReportAudioForMessage,
    VOICE_AUTOPLAY_FRESH_MS as REPORT_AUTOPLAY_FRESH_MS,
    type ChatAudioItem,
} from "@/lib/chat-audio";
import type { ChatAudioNowPlaying, Message } from "@/components/cortex-provider";

export { REPORT_AUTOPLAY_FRESH_MS };

// ── Voice-note identity + replay guard (2026-07-25) ──
// Voice tracking used to be keyed by ARRAY INDEX, which broke two ways:
// refresh reset the in-memory listened set and the initial scan re-eligible'd
// history notes (the morning greeting replayed on every reload), and the
// provider's chronological merges shift indices, so old notes fell into the
// "new since last scan" window and replayed when unrelated messages arrived.
// Fix: key by stable message identity, persist started-playback keys in
// localStorage, and only auto-play FRESH notes — an old note surfacing
// through a history load or merge is repetition, not news.
export function voiceKeyForMessage(msg: { id?: string; timestamp: Date; role: string }, vidx: number): string {
    return msg.id
        ? `id:${msg.id}#${vidx}`
        : `ts:${msg.timestamp.toISOString()}|${msg.role}#${vidx}`;
}

export const VOICE_PLAYED_STORE_KEY = 'nexus.voice.played';
export const VOICE_PLAYED_STORE_MAX = 300;
/** Notes older than this never auto-play — badge only. */
export const VOICE_AUTOPLAY_FRESH_MS = 3 * 60_000;

export function loadPlayedVoiceStore(): Set<string> {
    try {
        const raw = window.localStorage.getItem(VOICE_PLAYED_STORE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : []);
    } catch {
        return new Set(); // SSR / quota / corrupt store — session-only fallback
    }
}

/** Inputs to the "is this full report fresh news?" decision. */
export interface ReportAutoplayDecision {
    /** Stable key of the message's full-report attachment. */
    reportKey: string;
    /** The hosting message's timestamp, in ms. */
    messageTimeMs: number;
    nowMs: number;
    /** Keys this device has already STARTED playing (persisted). */
    playedKeys: ReadonlySet<string>;
    /** Key currently loaded in the provider's global player, if any. */
    currentAudioKey?: string | null;
    /** Key already staged to start when the inline queue drains, if any. */
    pendingKey?: string | null;
}

/**
 * The autoplay "fresh report" decision, exactly as the transcript scan makes
 * it: never re-announce something this device started, never announce a
 * report older than the fresh window, and never double-stage the item that is
 * already playing or already queued.
 */
export function shouldQueueReportAutoplay({
    reportKey,
    messageTimeMs,
    nowMs,
    playedKeys,
    currentAudioKey = null,
    pendingKey = null,
}: ReportAutoplayDecision): boolean {
    return (
        !playedKeys.has(reportKey)
        && nowMs - messageTimeMs <= REPORT_AUTOPLAY_FRESH_MS
        && currentAudioKey !== reportKey
        && pendingKey !== reportKey
    );
}

/** The same decision for a legacy inline voice note. */
export function shouldQueueVoiceAutoplay(params: {
    voiceKey: string;
    messageTimeMs: number;
    nowMs: number;
    playedKeys: ReadonlySet<string>;
    dismissedKeys: ReadonlySet<string>;
    listenedKeys: ReadonlySet<string>;
}): boolean {
    const { voiceKey, messageTimeMs, nowMs, playedKeys, dismissedKeys, listenedKeys } = params;
    if (playedKeys.has(voiceKey)) return false;
    if (dismissedKeys.has(voiceKey) || listenedKeys.has(voiceKey)) return false;
    if (nowMs - messageTimeMs > VOICE_AUTOPLAY_FRESH_MS) return false;
    return true;
}

export interface ChatAudioApi {
    /** Live <audio> elements for inline voice notes, keyed by voice key. */
    voiceAudioRefs: React.MutableRefObject<Map<string, HTMLAudioElement>>;
    nowPlayingVoiceRef: React.MutableRefObject<string | null>;
    dismissedVoice: Set<string>;
    setDismissedVoice: React.Dispatch<React.SetStateAction<Set<string>>>;
    listenedVoice: Set<string>;
    setListenedVoice: React.Dispatch<React.SetStateAction<Set<string>>>;
    getPlayedVoice: () => Set<string>;
    markVoicePlayed: (key: string) => void;
    playNextQueuedVoice: () => void;
    saveVoiceMemo: (audio: string, mimeType: string, msgIndex: number, voiceIndex: number) => void;
}

export interface UseChatAudioOptions {
    messages: Message[];
    chatAudio: ChatAudioNowPlaying | null;
    playChatAudio: (item: ChatAudioItem) => void;
    pauseChatAudio: () => void;
}

export function useChatAudio({ messages, chatAudio, playChatAudio }: UseChatAudioOptions): ChatAudioApi {
    // Voice message dismiss/listened tracking
    const [dismissedVoice, setDismissedVoice] = useState<Set<string>>(new Set());
    const [listenedVoice, setListenedVoice] = useState<Set<string>>(new Set());

    // ── Sequential voice playback (2026-07-17) ──
    // Exactly ONE Praxis voice note plays at a time. New arrivals QUEUE behind
    // whatever is playing instead of talking over it (the morning status-report
    // announcement lands while Praxis is still walking through the schedule),
    // and manual playback pauses everything else. Previously each newest
    // message autoPlayed independently and never paused the prior one — two
    // greetings in quick succession produced two simultaneous voices.
    const voiceAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
    const nowPlayingVoiceRef = useRef<string | null>(null);
    const voiceQueueRef = useRef<string[]>([]);
    // True from chirp-start until the voice element actually starts — guards
    // the queue against double-starts during the ~0.5s chirp window.
    const voiceStartPendingRef = useRef(false);
    // Started-playback registry, persisted per browser so a page refresh
    // never re-announces something this device already began playing.
    // Lazy-loaded (localStorage is unavailable during SSR).
    const playedVoiceRef = useRef<Set<string> | null>(null);
    const getPlayedVoice = useCallback((): Set<string> => {
        if (!playedVoiceRef.current) playedVoiceRef.current = loadPlayedVoiceStore();
        return playedVoiceRef.current;
    }, []);
    const markVoicePlayed = useCallback((key: string) => {
        const set = getPlayedVoice();
        if (set.has(key)) return;
        set.add(key);
        try {
            const arr = [...set].slice(-VOICE_PLAYED_STORE_MAX);
            window.localStorage.setItem(VOICE_PLAYED_STORE_KEY, JSON.stringify(arr));
            if (set.size > arr.length) playedVoiceRef.current = new Set(arr);
        } catch {
            /* quota — the in-memory set still guards this session */
        }
    }, [getPlayedVoice]);

    // TNG-style comm chirp: two quick rising tones synthesized with WebAudio
    // (no audio asset, no copyright), played a beat before each auto-played
    // Praxis voice note. Resolves after the chirp (or immediately on any
    // failure/blocked-autoplay) so the voice always follows.
    const playCommChirp = useCallback((): Promise<void> => new Promise((resolve) => {
        try {
            type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };
            const Ctx = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
            if (!Ctx) return resolve();
            const ctx = new Ctx();
            const tone = (start: number, dur: number, f0: number, f1: number) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.setValueAtTime(f0, ctx.currentTime + start);
                osc.frequency.exponentialRampToValueAtTime(f1, ctx.currentTime + start + dur);
                gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
                gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
                osc.connect(gain).connect(ctx.destination);
                osc.start(ctx.currentTime + start);
                osc.stop(ctx.currentTime + start + dur + 0.05);
            };
            tone(0, 0.16, 620, 1320);
            tone(0.2, 0.22, 980, 1980);
            window.setTimeout(() => {
                ctx.close().catch(() => {});
                resolve();
            }, 560);
        } catch {
            resolve();
        }
    }), []);

    // Fresh full-report briefing waiting for its turn on the GLOBAL player
    // (provider-owned, survives navigating to /inbox). It starts only when
    // the inline voice queue is idle — one Praxis voice at a time.
    const pendingReportRef = useRef<ChatAudioItem | null>(null);
    const maybeStartPendingReport = useCallback(() => {
        const item = pendingReportRef.current;
        if (!item) return;
        if (voiceStartPendingRef.current || nowPlayingVoiceRef.current || voiceQueueRef.current.length > 0) return;
        pendingReportRef.current = null;
        isThisClientActive().then((active) => {
            // Same discipline as voice notes: inactive devices keep the manual
            // player, and a started briefing never re-announces after refresh.
            markVoicePlayed(item.key);
            if (!active) return;
            voiceAudioRefs.current.forEach((el) => {
                if (!el.paused) el.pause();
            });
            playCommChirp().then(() => playChatAudio(item));
        });
    }, [markVoicePlayed, playCommChirp, playChatAudio]);

    const playNextQueuedVoice = useCallback(() => {
        if (voiceStartPendingRef.current) return;
        if (voiceQueueRef.current.length === 0) {
            nowPlayingVoiceRef.current = null;
            maybeStartPendingReport();
            return;
        }
        voiceStartPendingRef.current = true;
        // Last-active-location gate: announcements auto-play only on the
        // device Robert most recently touched (2026-07-17 — the Studio's
        // desktop app AND a web tab both spoke while he worked on the
        // laptop). Inactive clients keep the "New Voice Message" badge for
        // manual play; the queue is dropped so a stale note never blurts
        // out minutes later when this device becomes active again.
        isThisClientActive().then((active) => {
            if (!active) {
                // Dropped notes are marked played so they can't re-queue and
                // blurt out later when this device becomes active — the
                // "New Voice Message" badge stays for manual play.
                voiceQueueRef.current.forEach(markVoicePlayed);
                voiceQueueRef.current = [];
                voiceStartPendingRef.current = false;
                nowPlayingVoiceRef.current = null;
                return;
            }
            let key: string | null = null;
            let el: HTMLAudioElement | null = null;
            while (voiceQueueRef.current.length > 0) {
                const candidateKey = voiceQueueRef.current.shift()!;
                const candidate = voiceAudioRefs.current.get(candidateKey);
                if (candidate && !candidate.ended) {
                    key = candidateKey;
                    el = candidate;
                    break;
                }
            }
            if (!key || !el) {
                voiceStartPendingRef.current = false;
                nowPlayingVoiceRef.current = null;
                return;
            }
            const playKey = key;
            const playEl = el;
            nowPlayingVoiceRef.current = playKey;
            playCommChirp().then(() => {
                voiceStartPendingRef.current = false;
                playEl.play().catch(() => {
                    // Autoplay blocked (no user gesture yet) — drop, don't loop.
                    if (nowPlayingVoiceRef.current === playKey) nowPlayingVoiceRef.current = null;
                });
            });
        });
    }, [playCommChirp, markVoicePlayed, maybeStartPendingReport]);

    useEffect(() => {
        // Enqueue voice notes by stable message identity. Eligibility, not
        // position: a note auto-plays only if it is FRESH (arrived within the
        // last few minutes) and this device hasn't started it before — so
        // history loads, refreshes, and mid-list merges can surface old notes
        // without re-announcing them.
        const nowMs = Date.now();
        for (const msg of messages) {
            // A full-report attachment is the message's SOLE report audio —
            // it rides the global player, and any accidental legacy voice on
            // the same message stays out of the inline queue.
            const reportItem = fullReportAudioForMessage(msg);
            if (reportItem) {
                if (shouldQueueReportAutoplay({
                    reportKey: reportItem.key,
                    messageTimeMs: msg.timestamp.getTime(),
                    nowMs,
                    playedKeys: getPlayedVoice(),
                    currentAudioKey: chatAudio?.item.key ?? null,
                    pendingKey: pendingReportRef.current?.key ?? null,
                })) {
                    pendingReportRef.current = reportItem;
                }
                continue;
            }
            if (!msg.voiceData || msg.voiceData.length === 0) continue;
            const key = voiceKeyForMessage(msg, 0);
            if (!shouldQueueVoiceAutoplay({
                voiceKey: key,
                messageTimeMs: msg.timestamp.getTime(),
                nowMs,
                playedKeys: getPlayedVoice(),
                dismissedKeys: dismissedVoice,
                listenedKeys: listenedVoice,
            })) continue;
            if (!voiceQueueRef.current.includes(key) && nowPlayingVoiceRef.current !== key) {
                voiceQueueRef.current.push(key);
            }
        }

        const playingKey = nowPlayingVoiceRef.current;
        const playingEl = playingKey ? voiceAudioRefs.current.get(playingKey) : null;
        if (!voiceStartPendingRef.current && (!playingEl || playingEl.paused || playingEl.ended)) {
            playNextQueuedVoice();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    // Save voice memo to disk (browser download)
    const saveVoiceMemo = useCallback((audio: string, mimeType: string, msgIndex: number, voiceIndex: number) => {
        const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'mp3';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `praxis-voice-${timestamp}.${ext}`;
        const byteChars = atob(audio);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
            byteNumbers[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    return {
        voiceAudioRefs,
        nowPlayingVoiceRef,
        dismissedVoice,
        setDismissedVoice,
        listenedVoice,
        setListenedVoice,
        getPlayedVoice,
        markVoicePlayed,
        playNextQueuedVoice,
        saveVoiceMemo,
    };
}
