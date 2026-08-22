/**
 * VoiceCommandBar — "Praxis, …" for the bridge.
 *
 * Input paths:
 *   - Wake word: a lightweight webkitSpeechRecognition loop listens for
 *     "Praxis" while the bar is idle; hearing it chirps and opens the mic.
 *   - Click the mic (manual push-to-talk) any time.
 * Recording auto-stops on ~1.6s of silence (or 15s cap), goes to Praxis's
 * Groq Whisper transcriber, runs the local intent grammar (navigation,
 * local-only lever, local-queue pause/resume, status report), and anything
 * unmatched falls through to Praxis chat. Replies are spoken back through
 * the existing ElevenLabs route (/api/praxis/speak).
 *
 * Also owns spoken red-alert announcements (task.failed / hitl.created) with
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
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { useVoiceStatus } from "@/hooks/use-voice-status";
import { setLocalOnlyMode } from "@/lib/model-control";
import { getAmbientIdleMinutes, setAmbientIdleMinutes } from "@/components/bridge/ambient-mode";
import type { StreamEvent } from "@praxis/contract";

type VoiceState = "idle" | "recording" | "transcribing" | "working" | "speaking";

const WAKE_KEY = "nexus.voice.wakeword";
const ALERTS_KEY = "nexus.voice.alerts";
const WAKE_PATTERN = /\bpraxis\b|\bpraxus\b/i;
const SILENCE_STOP_MS = 1600;
const MAX_RECORDING_MS = 15_000;
const SILENCE_RMS_THRESHOLD = 0.015;
const ALERT_RATE_LIMIT_MS = 2 * 60_000;
const QUIET_HOURS = { start: 22, end: 8 }; // local time, inclusive start / exclusive end

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

function inQuietHours(date = new Date()): boolean {
  const h = date.getHours();
  return h >= QUIET_HOURS.start || h < QUIET_HOURS.end;
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

/** Two-tone klaxon that precedes spoken alerts. */
function alertChime() {
  chirp(660);
  setTimeout(() => chirp(494), 220);
}

/**
 * HITL kinds the morning routine announces on its own. The greeting ("Good
 * morning, Praxis") lands the [MORNING PLAN] trio — schedule proposal, skill
 * candidates, board maintenance — and speaks its own good-morning voice note.
 * Letting the red-alert path also bark "I need your attention on something"
 * over that (2026-07-25: Robert heard the alert instead of / on top of the
 * morning announcement) is noise, not news: these are expected, they carry
 * their own cards, and the inbox badge is the durable signal. Unexpected
 * HITLs — task questions, trade approvals, EOD commits — still speak.
 */
const ROUTINE_HITL_KINDS = new Set(["day-schedule", "skill-candidates", "board-maintenance"]);

function isRoutineMorningHitl(e: StreamEvent): boolean {
  if (e.type !== "hitl.created") return false;
  const kind = e.request?.metadata?.kind;
  return typeof kind === "string" && ROUTINE_HITL_KINDS.has(kind);
}

export function VoiceCommandBar() {
  const router = useRouter();
  const { presence, recentEvents } = usePraxisStream();
  const voiceStatus = useVoiceStatus();
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
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [ambientIdle, setAmbientIdle] = useState(10);
  const [wakeSupported, setWakeSupported] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const wakeEnabledRef = useRef(false);
  const lastAlertAtRef = useRef(0);
  const announcedIdsRef = useRef<Set<string>>(new Set());
  const mountedAtRef = useRef(Date.now());

  useEffect(() => {
    setWakeEnabled(readSetting(WAKE_KEY, false));
    setAlertsEnabled(readSetting(ALERTS_KEY, true));
    setAmbientIdle(getAmbientIdleMinutes());
    setWakeSupported(Boolean(createRecognition()));
  }, []);
  wakeEnabledRef.current = wakeEnabled;

  // ── Speech output ─────────────────────────────────────────────
  const speak = useCallback(async (text: string, opts: { keepState?: boolean } = {}) => {
    try {
      if (!opts.keepState) setState("speaking");
      const res = await fetch("/api/praxis/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.length > 600 ? `${text.slice(0, 600)}…` : text }),
      });
      if (!res.ok) return;
      const { audio, mime } = await res.json();
      if (!audio) return;
      await new Promise<void>((resolve) => {
        const el = new Audio(`data:${mime || "audio/mpeg"};base64,${audio}`);
        audioRef.current = el;
        el.onended = () => resolve();
        el.onerror = () => resolve();
        el.onpause = () => resolve(); // barge-in: pausing playback releases the await
        el.play().catch(() => resolve());
      });
    } catch {
      /* speech is best-effort */
    } finally {
      audioRef.current = null;
      // Only reset if nothing else (e.g. a barge-in recording) took the state.
      if (!opts.keepState && stateRef.current === "speaking") setState("idle");
    }
  }, []);

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
    async (intent: ServerIntent): Promise<boolean> => {
      switch (intent.type) {
        case "navigate":
          setResponse(`On screen: ${intent.label}.`);
          router.push(intent.route);
          await speak(intent.speech);
          return true;
        case "local_only":
          try {
            await setLocalOnlyMode(intent.enable, intent.enable ? "voice_command" : null);
            setResponse(intent.speech);
            await speak(intent.speech);
          } catch {
            setResponse("Couldn't reach model control.");
            setState("idle");
          }
          return true;
        case "local_queue":
          try {
            const res = await fetch(`/api/local-queue/${intent.action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: "voice_command" }),
            });
            const msg = res.ok ? intent.speech : `Local queue ${intent.action} failed.`;
            setResponse(msg);
            await speak(msg);
          } catch {
            setResponse("Couldn't reach the local queue.");
            setState("idle");
          }
          return true;
        case "status_report": {
          // Server composes the report; fall back to the local composer if empty.
          const report = intent.speech || (await runStatusReport());
          setResponse(report);
          await speak(report);
          return true;
        }
        case "chat":
        default:
          return false;
      }
    },
    [router, speak, runStatusReport]
  );

  /** Offline fallback grammar — used only when Praxis's intent endpoint is unreachable. */
  const runLocalGrammar = useCallback(
    async (text: string): Promise<boolean> => {
      const lower = text.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
      if (/(open|show|bring up|go to|take me to|display)\b/.test(lower)) {
        for (const target of NAV_TARGETS) {
          if (target.pattern.test(lower)) {
            return runIntent({
              type: "navigate",
              route: target.route,
              label: target.label,
              speech: `On screen. ${target.label}.`,
            });
          }
        }
      }
      if (/\b(status report|sitrep|status update|full report|report status)\b/.test(lower)) {
        return runIntent({ type: "status_report", speech: "" });
      }
      return false;
    },
    [runIntent]
  );

  const executeTranscript = useCallback(
    async (text: string) => {
      setState("working");

      // 1. Shared grammar on Praxis — one grammar for every cockpit surface.
      let handled = false;
      let serverReachable = true;
      try {
        const res = await fetch("/api/praxis/voice-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: text }),
        });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { intent: ServerIntent };
        handled = await runIntent(data.intent);
      } catch {
        serverReachable = false;
      }
      if (handled) return;

      // 2. Praxis unreachable → minimal local grammar keeps navigation working.
      if (!serverReachable) {
        if (await runLocalGrammar(text)) return;
      }

      // 3. Chat fall-through — the reply is spoken via the ElevenLabs route.
      try {
        const res = await fetch("/api/praxis/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, stream: false }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const reply: string = data.response ?? "No response.";
        setResponse(reply);
        await speak(reply);
      } catch {
        setResponse("Praxis didn't answer. Check the comms channel.");
        setState("idle");
      }
    },
    [speak, runIntent, runLocalGrammar]
  );

  // ── Recording (manual or wake-word triggered) ─────────────────
  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    // "speaking" is allowed: barge-in — cut Praxis off and listen.
    if (stateRef.current !== "idle" && stateRef.current !== "speaking") return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setTranscript(null);
    setResponse(null);
    setPanelOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      // Silence auto-stop: watch RMS on an analyser; stop after sustained
      // silence once speech has been heard (or at the hard cap).
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const audioCtx = Ctx ? new Ctx() : null;
      let silenceTimer: ReturnType<typeof setInterval> | null = null;
      let capTimer: ReturnType<typeof setTimeout> | null = null;
      if (audioCtx) {
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let heardSpeech = false;
        let silentSince = Date.now();
        silenceTimer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (rms > SILENCE_RMS_THRESHOLD) {
            heardSpeech = true;
            silentSince = Date.now();
          } else if (heardSpeech && Date.now() - silentSince > SILENCE_STOP_MS) {
            recorder.stop();
          }
        }, 150);
      }
      capTimer = setTimeout(() => recorder.stop(), MAX_RECORDING_MS);

      recorder.onstop = async () => {
        if (silenceTimer) clearInterval(silenceTimer);
        if (capTimer) clearTimeout(capTimer);
        audioCtx?.close().catch(() => {});
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          if (blob.size < 2000) {
            // Nothing meaningful captured (wake word false positive etc.)
            setState("idle");
            return;
          }
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          const res = await fetch("/api/praxis/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: base64, filename: mimeToFilename(recorder.mimeType || "") }),
          });
          if (!res.ok) throw new Error();
          const { text } = await res.json();
          // Strip a leading wake word so "Praxis, status report" routes cleanly.
          const cleaned = String(text ?? "").replace(/^\s*(hey\s+)?(praxis|praxus)[\s,.!—-]*/i, "").trim();
          if (!cleaned) {
            setResponse("I didn't catch that.");
            setState("idle");
            return;
          }
          setTranscript(cleaned);
          await executeTranscript(cleaned);
        } catch {
          setResponse("Transcription failed — is Praxis online?");
          setState("idle");
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setState("recording");
    } catch {
      setResponse("Microphone unavailable. Check browser permissions.");
      setState("idle");
      setPanelOpen(true);
    }
  }, [executeTranscript]);

  // ── Wake word loop ────────────────────────────────────────────
  // Armed while idle AND while Praxis is speaking (say "Praxis" to barge in).
  useEffect(() => {
    if (!wakeEnabled || (state !== "idle" && state !== "speaking")) {
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
        wakeEnabledRef.current &&
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
  }, [wakeEnabled, state, startRecording]);

  // ── Spoken red-alert announcements ────────────────────────────
  useEffect(() => {
    if (!alertsEnabled || state !== "idle") return;
    if (inQuietHours()) return;
    if (Date.now() - lastAlertAtRef.current < ALERT_RATE_LIMIT_MS) return;
    const alertEvent = recentEvents.find(
      (e: StreamEvent) =>
        (e.type === "task.failed" || e.type === "hitl.created") &&
        !isRoutineMorningHitl(e) &&
        e.eventId &&
        !announcedIdsRef.current.has(e.eventId) &&
        new Date(e.at).getTime() > mountedAtRef.current
    );
    if (!alertEvent || !alertEvent.eventId) return;
    announcedIdsRef.current.add(alertEvent.eventId);
    lastAlertAtRef.current = Date.now();
    const line =
      alertEvent.type === "task.failed"
        ? `Alert. A task has failed: ${alertEvent.error?.slice(0, 120) ?? "unknown error"}`
        : `Hi Robert, I need your attention on something: ${alertEvent.type === "hitl.created" ? alertEvent.request?.question?.slice(0, 120) ?? "approval required" : ""}`;
    alertChime();
    setTimeout(() => speak(line, { keepState: true }), 550);
  }, [recentEvents, alertsEnabled, state, speak]);

  const onMicClick = () => {
    if (state === "recording") stopRecording();
    else if (state === "idle") startRecording();
    else if (state === "speaking" && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setState("idle");
    }
  };

  useEffect(() => {
    if (!panelOpen && !settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanelOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, settingsOpen]);

  const busy = state === "transcribing" || state === "working";

  return (
    <div className="relative flex items-center gap-1">
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
        disabled={busy}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
          state === "recording"
            ? "border-red-500/60 bg-red-500/15 text-red-300 shadow-lg shadow-red-500/10 motion-safe:animate-pulse"
            : state === "speaking"
            ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
            : busy
            ? "border-slate-700 bg-slate-900/50 text-slate-500"
            : "border-cyan-500/30 bg-cyan-500/10 text-cyan-400 hover:border-cyan-500/50 hover:text-cyan-300"
        }`}
        aria-label={state === "recording" ? "Stop recording" : "Start voice command"}
        title={wakeEnabled ? 'Listening for "Praxis" — or click to talk' : "Voice command"}
      >
        {state === "recording" ? (
          <Square size={13} />
        ) : busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : state === "speaking" ? (
          <Volume2 size={14} />
        ) : wakeEnabled ? (
          <Ear size={14} />
        ) : (
          <Mic size={14} />
        )}
        <span className="hidden sm:inline">
          {state === "recording"
            ? "Listening…"
            : state === "transcribing"
            ? "Decoding…"
            : state === "working"
            ? "Working…"
            : state === "speaking"
            ? "Speaking"
            : wakeEnabled
            ? '"Praxis…"'
            : "Voice"}
        </span>
      </button>

      <button
        onClick={() => setSettingsOpen((v) => !v)}
        className="p-1.5 rounded-lg border border-slate-800 bg-slate-900/50 text-slate-500 hover:text-white transition-all"
        aria-label="Voice settings"
        title="Voice settings"
      >
        <Settings2 size={14} />
      </button>

      {settingsOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md">
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
              disabled={!wakeSupported}
              onChange={(e) => {
                setWakeEnabled(e.target.checked);
                window.localStorage.setItem(WAKE_KEY, e.target.checked ? "1" : "0");
              }}
            />
          </label>

          <label className="flex items-center justify-between gap-2 py-1.5 text-xs text-slate-300">
            <span className="flex items-center gap-2">
              <Volume2 size={13} className="text-slate-400" />
              Spoken alerts <span className="text-[10px] text-slate-600">(quiet 22:00–08:00)</span>
            </span>
            <input
              type="checkbox"
              checked={alertsEnabled}
              onChange={(e) => {
                setAlertsEnabled(e.target.checked);
                window.localStorage.setItem(ALERTS_KEY, e.target.checked ? "1" : "0");
              }}
            />
          </label>

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

      {panelOpen && (transcript || response) && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md">
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
