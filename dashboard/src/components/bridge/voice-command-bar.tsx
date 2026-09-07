/**
 * VoiceCommandBar — "Praxis, …" for the bridge.
 *
 * Input paths:
 *   - Wake word: a lightweight webkitSpeechRecognition loop listens for
 *     "Praxis" while the bar is idle; hearing it chirps and opens the mic.
 *   - Click the mic (manual push-to-talk) any time.
 * Recording auto-stops on ~1.6s of silence (or 60s cap), goes to Praxis's
 * Groq Whisper transcriber, runs the local intent grammar (navigation,
 * local-only lever, local-queue pause/resume, status report), and anything
 * unmatched falls through to Praxis chat. Replies are spoken back through
 * the configured Praxis voice route (/api/praxis/speak).
 *
 * Also owns configurable task and attention announcements with
 * quiet hours 22:00–08:00 and a 2-minute rate limit — excluding the routine
 * morning-review HITLs, which the morning greeting announces itself.
 *
 * Mic capture and audio playback live here in the cockpit; STT/TTS/intent
 * cognition stay in Praxis — so this survives the planned agent swap.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Square, Loader2, Volume2, VolumeX, X, Settings2, Ear, EarOff } from "lucide-react";
import { useLiveBoardState } from "@/components/live-board-state";
import { useVoiceStatus } from "@/hooks/use-voice-status";
import { setLocalOnlyMode } from "@/lib/model-control";
import { getAmbientIdleMinutes, setAmbientIdleMinutes } from "@/components/bridge/ambient-mode";
import { useBoardState } from "@/hooks/use-board-state";
import { VoiceSpeech, type VoiceSession, type VoiceState } from "@/lib/voice-speech";
import { VoiceConversation } from "@/lib/voice-conversation";
import { VoiceAlerts, alertLine, readAlertMode, ALERT_MODE_KEY, type AlertMode } from "@/lib/voice-alerts";

const WAKE_KEY = "nexus.voice.wakeword";
const WAKE_PATTERN = /\bpraxis\b|\bpraxus\b/i;
const SILENCE_STOP_MS = 1600;
const MAX_RECORDING_MS = 60_000;
const NO_SPEECH_MS = 10_000;
const SILENCE_RMS_THRESHOLD = 0.015;

const NAV_TARGETS: { pattern: RegExp; route: string; label: string }[] = [
  { pattern: /task ?board|tasks/, route: "/task-board", label: "Task board" },
  { pattern: /ops|dispatch/, route: "/ops", label: "Ops console" },
  { pattern: /knowledge|science|graph/, route: "/knowledge-ingestion", label: "Knowledge console" },
  { pattern: /engineering|model control|power/, route: "/model-control", label: "Model control" },
  { pattern: /academy|skill/, route: "/academy", label: "Academy" },
  { pattern: /agents?|fleet|tactical|registry/, route: "/agents", label: "Fleet registry" },
  { pattern: /studio/, route: "/studio", label: "Studio" },
  { pattern: /codex/, route: "/codex", label: "The Codex" },
  { pattern: /system monitor|monitor/, route: "/system-monitor", label: "System monitor" },
  { pattern: /calendar|schedule/, route: "/calendar", label: "Calendar" },
  { pattern: /home|bridge|dashboard|main/, route: "/", label: "Bridge" },
];

function mimeToFilename(mime: string): string {
  if (mime.includes("mp4")) return "voice.m4a";
  if (mime.includes("ogg")) return "voice.ogg";
  return "voice.webm";
}

function readSetting(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  return raw == null ? fallback : raw === "1";
}

/** Minimal typing for Chrome's prefixed SpeechRecognition. */
interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function createRecognition(): RecognitionLike | null {
  if (typeof window === "undefined") return null;
  const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => RecognitionLike }).webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  return rec;
}

function chirp(freq = 880) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* cosmetic */
  }
}

export function VoiceCommandBar() {
  const router = useRouter();
  const { presence, recentEvents } = useLiveBoardState();
  const voiceStatus = useVoiceStatus();
  const { projects } = useBoardState();
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const presenceRef = useRef(presence);
  presenceRef.current = presence;

  const [state, setState] = useState<VoiceState>("idle");
  const stateRef = useRef<VoiceState>("idle");
  stateRef.current = state;
  const [transcript, setTranscript] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [alertMode, setAlertMode] = useState<AlertMode>('off');
  const [conversationActive, setConversationActive] = useState(false);
  const [wakeSuspended, setWakeSuspended] = useState(false);
  const wakeSuspendedRef = useRef(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [ambientIdle, setAmbientIdle] = useState(10);
  const [wakeSupported, setWakeSupported] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const wakeEnabledRef = useRef(false);
  const mountedAtRef = useRef(Date.now());

  useEffect(() => {
    setWakeEnabled(readSetting(WAKE_KEY, false));
    setAlertMode(readAlertMode());
    setAmbientIdle(getAmbientIdleMinutes());
    setWakeSupported(Boolean(createRecognition()));
  }, []);
  wakeEnabledRef.current = wakeEnabled;

  // One session owns recording, requests, and playback until finish/cancel.
  const mountedRef = useRef(true);
  const speechRef = useRef<VoiceSpeech | null>(null);
  if (!speechRef.current) speechRef.current = new VoiceSpeech({ onState: next => {
    if (mountedRef.current) { stateRef.current = next; setState(next); }
  } });
  const speech = speechRef.current;
  const startRecordingRef = useRef<(session: VoiceSession) => void>(() => {});
  const conversationRef = useRef<VoiceConversation | null>(null);
  if (!conversationRef.current) conversationRef.current = new VoiceConversation({
    speech,
    capture: session => startRecordingRef.current(session),
    onChange: active => { if (mountedRef.current) setConversationActive(active); },
  });
  const conversation = conversationRef.current;
  const suspendWake = useCallback(() => {
    wakeSuspendedRef.current = true; setWakeSuspended(true);
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) { recognition.onend = null; recognition.abort(); }
  }, []);
  const cancelAll = useCallback(() => {
    suspendWake(); conversation.end(); speech.cancel();
  }, [conversation, speech, suspendWake]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; conversation.end(); speech.cancel(); };
  }, [conversation, speech]);
  const speak = useCallback(async (session: VoiceSession, text: string, voiceData?: { audio: string; mimeType: string }[]) => {
    const followUp = conversation.owns(session);
    const outcome = await speech.speak(session, text, voiceData, notice => {
      if (session.owns()) { setSpeechNotice(notice); setPanelOpen(true); }
    }, followUp);
    if (followUp) conversation.complete(session, outcome);
  }, [conversation, speech]);

  // ── Intent handling ───────────────────────────────────────────
  const runStatusReport = useCallback(async (): Promise<string> => {
    const p = presenceRef.current;
    const parts: string[] = [];
    parts.push(p ? `Praxis is ${p.activity}.` : "Praxis presence unknown.");
    if (p?.summary) parts.push(p.summary + ".");
    if (p?.scheduledTaskCount != null) parts.push(`${p.scheduledTaskCount} tasks scheduled.`);
    if (p?.completedTasksToday != null) parts.push(`${p.completedTasksToday} completed today.`);
    if (p?.budget?.dailyCallsRemaining != null) parts.push(`${p.budget.dailyCallsRemaining} cloud calls remaining.`);
    return parts.join(" ");
  }, []);

  /** Server intent shape returned by Praxis /api/voice/intent. */
  type ServerIntent =
    | { type: "navigate"; route: string; label: string; speech: string }
    | { type: "local_only"; enable: boolean; speech: string }
    | { type: "local_queue"; action: "pause" | "resume"; speech: string }
    | { type: "status_report"; speech: string }
    | { type: "chat" };

  /** Execute a classified intent. Returns false for chat fall-through. */
  const runIntent = useCallback(
    async (session: VoiceSession, intent: ServerIntent): Promise<boolean> => {
      if (!session.owns()) return true;
      switch (intent.type) {
        case "navigate":
          setResponse(`On screen: ${intent.label}.`);
          router.push(intent.route);
          await speak(session, intent.speech);
          return true;
        case "local_only":
          try {
            await setLocalOnlyMode(intent.enable, intent.enable ? "voice_command" : null);
            if (!session.owns()) return true;
            setResponse(intent.speech);
            await speak(session, intent.speech);
          } catch {
            if (session.owns()) setResponse("Couldn't reach model control.");
            speech.finish(session);
          }
          return true;
        case "local_queue":
          try {
            const res = await fetch(`/api/local-queue/${intent.action}`, {
              method: "POST",
              signal: session.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: "voice_command" }),
            });
            if (!session.owns()) return true;
            if (!res.ok) {
              setResponse(`Local queue ${intent.action} failed.`); speech.finish(session); return true;
            }
            const msg = intent.speech;
            setResponse(msg);
            await speak(session, msg);
          } catch {
            if (session.owns()) setResponse("Couldn't reach the local queue.");
            speech.finish(session);
          }
          return true;
        case "status_report": {
          // Server composes the report; fall back to the local composer if empty.
          const report = intent.speech || (await runStatusReport());
          if (!session.owns()) return true;
          setResponse(report);
          await speak(session, report);
          return true;
        }
        case "chat":
        default:
          return false;
      }
    },
    [router, speak, runStatusReport, speech]
  );

  /** Offline fallback grammar — used only when Praxis's intent endpoint is unreachable. */
  const runLocalGrammar = useCallback(
    async (session: VoiceSession, text: string): Promise<boolean> => {
      const lower = text.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
      if (/(open|show|bring up|go to|take me to|display)\b/.test(lower)) {
        for (const target of NAV_TARGETS) {
          if (target.pattern.test(lower)) {
            return runIntent(session, {
              type: "navigate",
              route: target.route,
              label: target.label,
              speech: `On screen. ${target.label}.`,
            });
          }
        }
      }
      if (/\b(status report|sitrep|status update|full report|report status)\b/.test(lower)) {
        return runIntent(session, { type: "status_report", speech: "" });
      }
      return false;
    },
    [runIntent]
  );

  const executeTranscript = useCallback(async (session: VoiceSession, text: string) => {
    if (!session.owns()) return;
    speech.setState(session, "working");
    let serverReachable = true;
    try {
      const res = await fetch("/api/praxis/voice-intent", {
        method: "POST", signal: session.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: text }),
      });
      if (!session.owns()) return;
      if (!res.ok) throw new Error();
      const data = await res.json(); if (!session.owns()) return;
      const handled = await runIntent(session, data.intent);
      if (!session.owns() || handled) return;
    } catch { if (!session.owns()) return; serverReachable = false; }
    if (!serverReachable) {
      const handled = await runLocalGrammar(session, text);
      if (!session.owns() || handled) return;
    }
    try {
      const res = await fetch("/api/praxis/chat", {
        method: "POST", signal: session.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, stream: false, voiceConversation: true }),
      });
      if (!session.owns()) return;
      if (!res.ok) throw new Error();
      const data = await res.json(); if (!session.owns()) return;
      const reply = typeof data.response === 'string' ? data.response : '';
      if (!reply.trim() && !data.voiceData?.some((v: { audio?: string }) => typeof v.audio === 'string' && v.audio)) {
        setResponse("Praxis didn't return a reply."); speech.finish(session); return;
      }
      setResponse(reply);
      await speak(session, reply, Array.isArray(data.voiceData) ? data.voiceData : undefined);
    } catch {
      if (session.owns()) setResponse("Praxis didn't answer. Check the comms channel.");
      speech.finish(session);
    }
  }, [speak, runIntent, runLocalGrammar, speech]);

  // ── Recording (manual or explicitly enabled wake word) ─────────
  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);
  const startRecording = useCallback(async (ownedSession?: VoiceSession) => {
    if (document.hidden) { cancelAll(); return; }
    if (!ownedSession && stateRef.current !== 'idle' && stateRef.current !== 'speaking') return;
    if (!ownedSession) conversation.end();
    const session = ownedSession ?? speech.begin(); if (!session || !session.owns()) return;
    speech.setState(session, 'working');
    setTranscript(null); setResponse(null); setSpeechNotice(null); setElapsed(0); setSettingsOpen(false); setPanelOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!session.owns()) { stream.getTracks().forEach(t => t.stop()); return; }
      const releaseStream = () => stream.getTracks().forEach(t => t.stop());
      session.cleanup.add(releaseStream);
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => { if (session.owns() && e.data.size > 0) chunks.push(e.data); };
      let audioCtx: AudioContext | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;
      let cap: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer) clearInterval(timer); if (cap) clearTimeout(cap);
        recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null;
        if (recorder.state === 'recording') recorder.stop();
        source?.disconnect?.(); audioCtx?.close().catch(() => {});
        stream.getTracks().forEach(t => t.stop());
        if (recorderRef.current === recorder) recorderRef.current = null;
        session.cleanup.delete(cleanup);
      };
      session.cleanup.delete(releaseStream);
      session.cleanup.add(cleanup);
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      let analyser: AnalyserNode | null = null;
      try {
        if (Ctx) { audioCtx = new Ctx(); source = audioCtx.createMediaStreamSource(stream); analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; source.connect(analyser); }
      } catch { audioCtx?.close().catch(() => {}); audioCtx = null; analyser = null; }
      const buf = new Float32Array(512); const startedAt = Date.now();
      let heardSpeech = false; let silentSince = startedAt;
      timer = setInterval(() => {
        if (!session.owns()) return;
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
        if (analyser) {
          try {
            analyser.getFloatTimeDomainData(buf);
            const rms = Math.sqrt(buf.reduce((sum, sample) => sum + sample * sample, 0) / buf.length);
            if (rms > SILENCE_RMS_THRESHOLD) { heardSpeech = true; silentSince = Date.now(); }
          } catch { analyser = null; }
        }
        // Manual capture can still use its stop button and cap without an
        // analyser. Only an owned conversation must fail closed in this case.
        if (!analyser && !conversation.owns(session)) return;
        if (!heardSpeech && Date.now() - startedAt >= NO_SPEECH_MS) {
          setResponse("I didn't hear anything. Tap the mic when you're ready."); speech.finish(session);
        } else if (heardSpeech && Date.now() - silentSince > SILENCE_STOP_MS) stopRecording();
      }, 150);
      cap = setTimeout(stopRecording, MAX_RECORDING_MS);
      recorder.onstop = async () => {
        cleanup(); if (!session.owns()) return;
        speech.setState(session, 'transcribing');
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          if (blob.size < 2000) { speech.finish(session); return; }
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            const abort = () => { reader.abort?.(); reject(new Error('Canceled')); };
            session.signal.addEventListener('abort', abort, { once: true });
            reader.onload = () => { session.signal.removeEventListener('abort', abort); resolve(String(reader.result).split(',')[1] ?? ''); };
            reader.onerror = () => { session.signal.removeEventListener('abort', abort); reject(reader.error); };
            reader.readAsDataURL(blob);
          });
          if (!session.owns()) return;
          const res = await fetch('/api/praxis/transcribe', {
            method: 'POST', signal: session.signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: base64, filename: mimeToFilename(recorder.mimeType || '') }),
          });
          if (!session.owns()) return;
          if (!res.ok) throw new Error();
          const data = await res.json(); if (!session.owns()) return;
          const cleaned = String(data.text ?? '').replace(/^\s*(hey\s+)?(praxis|praxus)[\s,.!—-]*/i, '').trim();
          if (!cleaned) { setResponse("I didn't catch that."); speech.finish(session); return; }
          setTranscript(cleaned); await executeTranscript(session, cleaned);
        } catch {
          if (session.owns()) setResponse('Transcription failed — is Praxis online?');
          speech.finish(session);
        }
      };
      recorder.onerror = () => {
        if (session.owns()) setResponse('Microphone recording failed. Tap the mic to try again.');
        speech.finish(session);
      };
      recorderRef.current = recorder; recorder.start(); speech.setState(session, 'recording');
    } catch {
      if (session.owns()) setResponse('Microphone unavailable. Check browser permissions.');
      speech.finish(session);
    }
  }, [cancelAll, conversation, executeTranscript, speech, stopRecording]);
  startRecordingRef.current = session => { void startRecording(session); };

  // ── Wake word loop ────────────────────────────────────────────
  // Armed while idle AND while Praxis is speaking (say "Praxis" to barge in).
  useEffect(() => {
    if (!wakeEnabled || wakeSuspended || conversationActive || tabHidden || document.hidden || (state !== "idle" && state !== "speaking")) {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      return;
    }
    const rec = createRecognition();
    if (!rec) {
      setWakeSupported(false);
      return;
    }
    let disposed = false;
    rec.onresult = (event) => {
      if (disposed || wakeSuspendedRef.current || conversation.active() || document.hidden) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const alt = event.results[i][0];
        if (alt && WAKE_PATTERN.test(alt.transcript)) {
          rec.abort();
          chirp();
          startRecording();
          return;
        }
      }
    };
    rec.onend = () => {
      // Chrome ends recognition periodically — restart while still armed.
      if (
        !disposed &&
        wakeEnabledRef.current && !wakeSuspendedRef.current && !conversation.active() && !document.hidden &&
        (stateRef.current === "idle" || stateRef.current === "speaking")
      ) {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        disposed = true;
        setWakeEnabled(false);
        window.localStorage.setItem(WAKE_KEY, "0");
        setResponse("Wake word disabled — microphone permission was denied.");
        setPanelOpen(true);
      }
    };
    try {
      rec.start();
      recognitionRef.current = rec;
    } catch {
      /* start can throw if called twice */
    }
    return () => {
      disposed = true;
      rec.abort();
      if (recognitionRef.current === rec) recognitionRef.current = null;
    };
  }, [wakeEnabled, wakeSuspended, conversationActive, tabHidden, state, startRecording, conversation]);

  const alertsRef = useRef<VoiceAlerts | null>(null);
  useEffect(() => {
    const alerts = new VoiceAlerts({ mountedAt: mountedAtRef.current, announce: event => {
      const session = speech.begin(true); if (!session) return null;
      const line = alertLine(event, id => {
        const task = projectsRef.current?.flatMap(project => project.tasks ?? []).find(task => task.id === id);
        return task?.title || task?.name;
      });
      setResponse(line); setTranscript(null); setSpeechNotice(null); setSettingsOpen(false); setPanelOpen(true);
      return speak(session, line);
    } });
    alertsRef.current = alerts;
    return () => { alerts.dispose(); alertsRef.current = null; };
  }, [speak, speech]);
  useEffect(() => { alertsRef.current?.update(recentEvents, alertMode); }, [recentEvents, alertMode]);

  const onMicClick = () => {
    if (stateRef.current === 'recording') stopRecording();
    else if (stateRef.current === 'idle') void startRecording();
    else cancelAll();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelAll();
        setPanelOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelAll]);
  useEffect(() => {
    const onVisibility = () => {
      setTabHidden(document.hidden);
      if (document.hidden) cancelAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [cancelAll]);

  const wakeListening = wakeEnabled && !wakeSuspended && !conversationActive && !tabHidden;
  const busy = state === "transcribing" || state === "working";

  return (
    <div className="relative flex flex-wrap items-center justify-end gap-1">
      {voiceStatus && !voiceStatus.available && (
        <span
          className="flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] font-semibold text-amber-300"
          title={`Praxis voice is text-only — ${voiceStatus.reason}`}
          aria-label="Praxis voice offline"
        >
          <VolumeX size={13} />
          <span className="hidden md:inline">Voice muted</span>
        </span>
      )}
      <button
        onClick={onMicClick}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
          state === "recording"
            ? "border-red-500/60 bg-red-500/15 text-red-300 shadow-lg shadow-red-500/10 motion-safe:animate-pulse"
            : state === "speaking"
            ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
            : busy
            ? "border-slate-700 bg-slate-900/50 text-slate-500"
            : "border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:border-cyan-500/50 hover:text-cyan-300"
        }`}
        aria-label={state === "recording" ? "Stop recording" : state === "speaking" ? "Stop speaking" : busy ? "Cancel voice command" : "Start voice command"}
        title={wakeListening ? 'Listening for "Praxis" — or click to talk' : "Voice command"}
      >
        {state === "recording" ? (
          <Square size={13} />
        ) : busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : state === "speaking" ? (
          <Volume2 size={14} />
        ) : wakeListening ? (
          <Ear size={14} />
        ) : (
          <Mic size={14} />
        )}
        <span className={state === 'recording' ? 'inline' : 'hidden sm:inline'}>
          {state === "recording"
            ? `Listening… ${elapsed}s / 60s`
            : state === "transcribing"
            ? "Decoding…"
            : state === "working"
            ? "Working…"
            : state === "speaking"
            ? "Speaking"
            : wakeListening
            ? '"Praxis…"'
            : "Voice"}
        </span>
      </button>

      <button
        onClick={() => { if (conversation.active()) cancelAll(); else { suspendWake(); conversation.start(); } }}
        aria-label={conversationActive ? "End conversation" : "Start conversation"}
        className={`rounded-lg border px-2 py-1.5 text-xs font-semibold ${conversationActive ? 'border-red-500/50 text-red-300' : 'border-cyan-500/30 text-cyan-300'}`}
      >
        {conversationActive ? 'End conversation' : 'Start conversation'}
      </button>
      {state === 'speaking' && <button onClick={() => void startRecording()} aria-label="Interrupt and talk" className="rounded-lg border border-cyan-500/30 px-2 py-1.5 text-xs text-cyan-300">Talk</button>}
      <button
        onClick={() => { setSettingsOpen((v) => !v); setPanelOpen(false); }}
        className="p-1.5 rounded-lg border border-slate-800 bg-slate-900/50 text-slate-500 hover:text-white transition-all"
        aria-label="Voice settings"
        title="Voice settings"
      >
        <Settings2 size={14} />
      </button>

      {settingsOpen && (
        <div className="absolute right-0 bottom-full z-50 mb-3 w-80 max-w-[calc(100vw/var(--nexus-display-scale,1)-2.25rem)] max-h-[calc(100dvh/var(--nexus-display-scale,1)-8rem)] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">voice and ambient</div>

          <label className="flex items-center justify-between gap-2 py-1.5 text-xs text-slate-300">
            <span className="flex items-center gap-2">
              {wakeEnabled ? <Ear size={13} className="text-cyan-400" /> : <EarOff size={13} className="text-slate-500" />}
              Wake word &quot;Praxis&quot;
              {!wakeSupported && <span className="text-[10px] text-amber-400">(needs Chrome)</span>}
            </span>
            <input
              type="checkbox"
              checked={wakeEnabled}
              disabled={!wakeSupported || conversationActive}
              onChange={(e) => {
                wakeSuspendedRef.current = false; setWakeSuspended(false);
                setWakeEnabled(e.target.checked);
                window.localStorage.setItem(WAKE_KEY, e.target.checked ? "1" : "0");
              }}
            />
          </label>

          {wakeEnabled && wakeSuspended && <p className="text-[10px] text-amber-300">Wake word paused. Toggle it off and on to resume.</p>}
          <label className="flex items-center justify-between gap-2 py-1.5 text-xs text-slate-300">
            <span className="flex items-center gap-2">
              <Volume2 size={13} className="text-slate-400" />
              Spoken alerts <span className="text-[10px] text-slate-600">(quiet 22:00–08:00)</span>
            </span>
            <select
              aria-label="Spoken alert mode"
              value={alertMode}
              onChange={e => {
                const mode = e.target.value as AlertMode;
                setAlertMode(mode);
                try { window.localStorage.setItem(ALERT_MODE_KEY, mode); } catch { /* session preference */ }
              }}
              className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200"
            >
              <option value="off">Off</option>
              <option value="attention">Attention</option>
              <option value="conversational">Conversational</option>
            </select>
          </label>

          <p className="mb-2 text-[10px] leading-relaxed text-slate-500">Attention speaks failures and unexpected approvals. Conversational also speaks task completions and blocks.</p>
          <label className="flex items-center justify-between gap-2 py-1.5 text-xs text-slate-300">
            <span>Ambient after idle</span>
            <select
              value={ambientIdle}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAmbientIdle(v);
                setAmbientIdleMinutes(v);
              }}
              className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200"
            >
              <option value={0}>off</option>
              <option value={5}>5 min</option>
              <option value={10}>10 min</option>
              <option value={20}>20 min</option>
              <option value={30}>30 min</option>
            </select>
          </label>
        </div>
      )}

      {panelOpen && (transcript || response || speechNotice) && (
        <div className="absolute right-0 bottom-full z-50 mb-3 w-80 max-w-[calc(100vw/var(--nexus-display-scale,1)-2.25rem)] max-h-[calc(100dvh/var(--nexus-display-scale,1)-8rem)] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">voice channel</span>
            <button onClick={() => setPanelOpen(false)} aria-label="Close voice panel">
              <X size={12} className="text-slate-500 hover:text-white" />
            </button>
          </div>
          {transcript && (
            <p className="mb-1.5 text-xs text-cyan-300">
              <span className="text-slate-600">you ›</span> {transcript}
            </p>
          )}
          {speechNotice && <p role="status" className="mb-2 text-xs text-amber-300">{speechNotice}</p>}
          {response && (
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
              <span className="text-slate-600">praxis ›</span> {response}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
