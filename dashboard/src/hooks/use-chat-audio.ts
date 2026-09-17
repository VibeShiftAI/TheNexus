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

import { playAnnouncementCue } from "@/lib/announcement-cue";
import { useCallback, useEffect, useRef, useState } from "react";

import { speechOwner, claimMediaSpeech, type SpeechLease } from "@/lib/speech-ownership";
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
    const queuedUntilRef = useRef(new Map<string, number>());
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

    const playbackEpoch = useRef(0);
    const playbackLease = useRef<SpeechLease | null>(null);
    const playbackAbort = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const cancelPendingPlayback = useCallback(() => {
        ++playbackEpoch.current;
        playbackAbort.current?.abort();
        playbackAbort.current = null;
        voiceStartPendingRef.current = false;
        voiceAudioRefs.current.forEach(el => { if (!el.paused) el.pause(); });
        nowPlayingVoiceRef.current = null;
        playbackLease.current?.release();
        playbackLease.current = null;
    }, []);

    // Fresh full-report briefing waiting for its turn on the GLOBAL player
    // (provider-owned, survives navigating to /inbox). It starts only when
    // the inline voice queue is idle — one Praxis voice at a time.
    const pendingReportRef = useRef<ChatAudioItem | null>(null);
    const pendingReportUntil = useRef(0);
    const startQueuedAudio = useCallback(async () => {
        if (!mounted.current || voiceStartPendingRef.current || speechOwner.busy()) return;
        if (!voiceQueueRef.current.length && !pendingReportRef.current) return;
        const lease = speechOwner.claim('chat-autoplay', cancelPendingPlayback, false);
        if (!lease) return;
        playbackLease.current = lease;
        voiceStartPendingRef.current = true;
        const epoch = ++playbackEpoch.current;
        const controller = new AbortController(); playbackAbort.current = controller;
        const owns = () => mounted.current && epoch === playbackEpoch.current && lease.owns();
        try {
            const active = await isThisClientActive();
            if (!owns()) return;
            if (!active) {
                voiceQueueRef.current.forEach(markVoicePlayed);
                voiceQueueRef.current = [];
                queuedUntilRef.current.clear();
                if (pendingReportRef.current) markVoicePlayed(pendingReportRef.current.key);
                pendingReportRef.current = null;
                return;
            }
            let key: string | null = null;
            let el: HTMLAudioElement | null = null;
            while (voiceQueueRef.current.length) {
                const candidateKey = voiceQueueRef.current.shift()!;
                const expires = queuedUntilRef.current.get(candidateKey) ?? 0;
                queuedUntilRef.current.delete(candidateKey);
                if (Date.now() > expires) { markVoicePlayed(candidateKey); continue; }
                const candidate = voiceAudioRefs.current.get(candidateKey);
                if (candidate && !candidate.ended) { key = candidateKey; el = candidate; break; }
            }
            if (pendingReportRef.current && Date.now() > pendingReportUntil.current) {
                markVoicePlayed(pendingReportRef.current.key);
                pendingReportRef.current = null;
            }
            const report = !el ? pendingReportRef.current : null;
            if (!el && !report) return;
            if (key) nowPlayingVoiceRef.current = key;
            if (!await playAnnouncementCue(controller.signal)) {
                // A blocked cue consumes this automatic attempt. Otherwise a
                // pending report immediately retries when this lease releases.
                // Explicit cancellation leaves the queued report available.
                if (owns()) {
                    if (key) markVoicePlayed(key);
                    if (report) { markVoicePlayed(report.key); pendingReportRef.current = null; }
                }
                return;
            }
            if (!owns()) return;
            // Transfer the reservation synchronously to the actual player.
            voiceStartPendingRef.current = false;
            if (el && key) {
                markVoicePlayed(key);
                // bindMediaSpeech claims on native play; release our reservation first.
                lease.release(); playbackLease.current = null;
                const mediaLease = claimMediaSpeech(el);
                try { await el.play(); } catch { mediaLease?.release(); }
            } else if (report) {
                pendingReportRef.current = null;
                markVoicePlayed(report.key);
                lease.release(); playbackLease.current = null;
                playChatAudio(report);
            }
        } catch { /* blocked autoplay retains manual controls */ }
        finally {
            if (epoch === playbackEpoch.current) {
                voiceStartPendingRef.current = false;
                playbackAbort.current = null;
                lease.release();
                if (playbackLease.current === lease) playbackLease.current = null;
            }
        }
    }, [cancelPendingPlayback, markVoicePlayed, playChatAudio]);
    const playNextQueuedVoice = useCallback(() => { void startQueuedAudio(); }, [startQueuedAudio]);
    useEffect(() => {
        mounted.current = true;
        const unsubscribe = speechOwner.subscribe(() => {
            // Ownership transfers finish synchronously before deciding whether a queue is idle.
            queueMicrotask(() => { if (mounted.current && !speechOwner.busy()) playNextQueuedVoice(); });
        });
        return () => { mounted.current = false; unsubscribe(); cancelPendingPlayback(); };
    }, [cancelPendingPlayback, playNextQueuedVoice]);

    useEffect(() => {
        // Enqueue voice notes by stable message identity. Eligibility, not
        // position: a note auto-plays only if it is FRESH (arrived within the
        // last few minutes) and this device hasn't started it before — so
        // history loads, refreshes, and mid-list merges can surface old notes
        // without re-announcing them.
        const nowMs = Date.now();
        for (const msg of messages) {
            // VoiceSession owns its full reply, including delayed receipt playback.
            // Keep these attachments available to the existing manual players.
            if (msg.metadata?.playbackOwner === 'voice' || msg.metadata?.suppressVoice === true) continue;
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
                    pendingReportUntil.current = msg.timestamp.getTime() + REPORT_AUTOPLAY_FRESH_MS;
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
                queuedUntilRef.current.set(key, msg.timestamp.getTime() + VOICE_AUTOPLAY_FRESH_MS);
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
