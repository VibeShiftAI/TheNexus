/**
 * VoiceCommandBar — "Computer, …" for the bridge.
 *
 * Click the mic to record, click again to stop. Audio goes to Praxis's Groq
 * Whisper transcriber (/api/praxis/transcribe). The transcript first runs
 * through a local intent grammar (navigation, local-only lever, local-queue
 * pause/resume, status report); anything unmatched falls through to Praxis
 * chat and the reply is spoken back via ElevenLabs (/api/praxis/speak).
 *
 * Mic capture and audio playback live here in the cockpit; STT/TTS/intent
 * cognition stay in Praxis — so this survives the planned agent swap.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Square, Loader2, Volume2, X } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { setLocalOnlyMode } from "@/lib/model-control";

type VoiceState = "idle" | "recording" | "transcribing" | "working" | "speaking";

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

export function VoiceCommandBar() {
  const router = useRouter();
  const { presence } = usePraxisStream();
  const presenceRef = useRef(presence);
  presenceRef.current = presence;

  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const speak = useCallback(async (text: string) => {
    try {
      setState("speaking");
      const res = await fetch("/api/praxis/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.length > 600 ? `${text.slice(0, 600)}…` : text }),
      });
      if (!res.ok) return; // TTS unconfigured/unreachable — text response is already shown
      const { audio, mime } = await res.json();
      if (!audio) return;
      await new Promise<void>((resolve) => {
        const el = new Audio(`data:${mime || "audio/mpeg"};base64,${audio}`);
        audioRef.current = el;
        el.onended = () => resolve();
        el.onerror = () => resolve();
        el.play().catch(() => resolve());
      });
    } catch {
      /* speech is best-effort */
    } finally {
      audioRef.current = null;
      setState("idle");
    }
  }, []);

  const runStatusReport = useCallback(async (): Promise<string> => {
    const p = presenceRef.current;
    const parts: string[] = [];
    parts.push(p ? `Praxis is ${p.activity}.` : "Praxis presence unknown.");
    if (p?.summary) parts.push(p.summary + ".");
    if (p?.scheduledTaskCount != null) parts.push(`${p.scheduledTaskCount} tasks scheduled.`);
    if (p?.completedTasksToday != null) parts.push(`${p.completedTasksToday} completed today.`);
    if (p?.budget?.dailyCallsRemaining != null) parts.push(`${p.budget.dailyCallsRemaining} cloud calls remaining.`);
    try {
      const res = await fetch("/api/fleet/health", { cache: "no-store" });
      if (res.ok) {
        const fleet = await res.json();
        const services: { ok: boolean; label: string }[] = fleet.services ?? [];
        const online = services.filter((s) => s.ok);
        const down = services.filter((s) => !s.ok);
        parts.push(`Fleet: ${online.length} of ${services.length} services online.`);
        if (down.length > 0) parts.push(`Down: ${down.map((s) => s.label).join(", ")}.`);
      }
    } catch {
      /* fleet probe optional */
    }
    return parts.join(" ");
  }, []);

  const executeTranscript = useCallback(
    async (text: string) => {
      const lower = text.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
      setState("working");

      // 1. Navigation
      if (/(open|show|bring up|go to|take me to|display)\b/.test(lower)) {
        for (const target of NAV_TARGETS) {
          if (target.pattern.test(lower)) {
            setResponse(`On screen: ${target.label}.`);
            router.push(target.route);
            await speak(`On screen. ${target.label}.`);
            return;
          }
        }
      }

      // 2. Local-only lever
      const localOnlyMatch = lower.match(/local[- ]only( mode)?\b.*\b(on|off)\b|\b(enable|engage|disable|disengage)\b.*local[- ]only/);
      if (localOnlyMatch) {
        const enable = /\bon\b|\benable\b|\bengage\b/.test(lower) && !/\boff\b|\bdisable\b|\bdisengage\b/.test(lower);
        try {
          await setLocalOnlyMode(enable, enable ? "voice_command" : null);
          const msg = enable ? "Local-only mode engaged. Cloud calls suspended." : "Local-only mode disengaged. Cloud restored.";
          setResponse(msg);
          await speak(msg);
        } catch {
          setResponse("Couldn't reach model control.");
          setState("idle");
        }
        return;
      }

      // 3. Local queue pause/resume
      const queueMatch = lower.match(/\b(pause|resume)\b.*(local|queue)/);
      if (queueMatch && /(queue|local)/.test(lower)) {
        const action = queueMatch[1] === "pause" ? "pause" : "resume";
        try {
          const res = await fetch(`/api/local-queue/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "voice_command" }),
          });
          const msg = res.ok ? `Local queue ${action}d.` : `Local queue ${action} failed.`;
          setResponse(msg);
          await speak(msg);
        } catch {
          setResponse("Couldn't reach the local queue.");
          setState("idle");
        }
        return;
      }

      // 4. Status report
      if (/\b(status report|sitrep|status update|full report|report status)\b/.test(lower)) {
        const report = await runStatusReport();
        setResponse(report);
        await speak(report);
        return;
      }

      // 5. Fallback → Praxis chat (non-streaming)
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
    [router, speak, runStatusReport]
  );

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
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
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
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
          if (!text || !text.trim()) {
            setResponse("I didn't catch that.");
            setState("idle");
            return;
          }
          setTranscript(text.trim());
          await executeTranscript(text.trim());
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

  const onMicClick = () => {
    if (state === "recording") stopRecording();
    else if (state === "idle") startRecording();
    else if (state === "speaking" && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setState("idle");
    }
  };

  // Escape closes the panel
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  const busy = state === "transcribing" || state === "working";

  return (
    <div className="relative">
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
        title="Voice command"
      >
        {state === "recording" ? (
          <Square size={13} />
        ) : busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : state === "speaking" ? (
          <Volume2 size={14} />
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
            : "Voice"}
        </span>
      </button>

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
