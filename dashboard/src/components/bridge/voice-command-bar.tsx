/**
 * VoiceCommandBar — "Praxis, …" for the bridge.
 *
 * Input paths:
 *   - Wake word: a lightweight webkitSpeechRecognition loop listens for
 *     "Praxis" while the bar is idle; hearing it chirps and opens the mic.
 *   - Click the mic (manual push-to-talk) any time.
 * Recording auto-stops on ~1.6s of silence (or 60s cap), goes to Praxis's
 * Groq Whisper transcriber, runs Praxis’s intent grammar (navigation,
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

import { playAnnouncementCue } from '@/lib/announcement-cue';
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Mic, Square, Loader2, Volume2, VolumeX, X, Settings2, Ear, EarOff } from "lucide-react";
import { useCortex } from "@/components/cortex-provider";
import { archiveVoiceDeliveryNotice, archiveVoiceAnnouncement, archiveVoiceExchange, mergeVoiceMessages, sendVoiceChat, voiceChatRequest, type SavedVoiceMessage, type VoiceChatTurn } from "@/lib/voice-chat";
import { useLiveBoardState } from "@/components/live-board-state";
import { useVoiceStatus } from "@/hooks/use-voice-status";
import { setLocalOnlyMode } from "@/lib/model-control";
import { getAmbientIdleMinutes, setAmbientIdleMinutes } from "@/components/bridge/ambient-mode";
import { useBoardState } from "@/hooks/use-board-state";
import { VoiceSpeech, type VoiceSession, type VoiceState } from "@/lib/voice-speech";
import { composeVoiceProse, type VoiceProseInput } from "@/lib/voice-prose";
import { VoiceConversation } from "@/lib/voice-conversation";
import { VoiceAlerts, alertFacts, readAlertMode, ALERT_MODE_KEY, type AlertMode } from "@/lib/voice-alerts";
import { checkMicrophone, INITIAL_MICROPHONE_CHECK, microphoneCapability, microphoneConstraints, microphoneError, MISSING_MICROPHONE, readMicrophonePreference, saveMicrophonePreference, VOICE_SETUP_EVENT, type MicrophoneCheck } from "@/lib/voice-input";

const WAKE_PATTERN = /\bpraxis\b|\bpraxus\b/i;
const SILENCE_STOP_MS = 1600;
const MAX_RECORDING_MS = 60_000;
const NO_SPEECH_MS = 10_000;
const SILENCE_RMS_THRESHOLD = 0.015;

function mimeToFilename(mime: string): string {
  if (mime.includes("mp4")) return "voice.m4a";
  if (mime.includes("ogg")) return "voice.ogg";
  return "voice.webm";
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
  const params = useParams();
  const pathname = usePathname();
  const projectId = /^\/project\/[^/]+\/?$/.test(pathname ?? '') && typeof params?.id === 'string' ? params.id : undefined;
  const { messages, setMessages, conversationId } = useCortex();
  const chatRef = useRef({ messages, conversationId, projectId });
  chatRef.current = { messages, conversationId, projectId };
  const { recentEvents } = useLiveBoardState();
  const voiceStatus = useVoiceStatus();
  const { projects } = useBoardState();
  const projectsRef = useRef(projects); projectsRef.current = projects;

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
  const [microphone, setMicrophone] = useState('');
  const microphoneRef = useRef('');
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [devicesKnown, setDevicesKnown] = useState(false);
  const devicesKnownRef = useRef(false);
  const enumerationEpoch = useRef(0);
  const [micCheck, setMicCheck] = useState<MicrophoneCheck>(INITIAL_MICROPHONE_CHECK);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const microphoneSessionRef = useRef<VoiceSession | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const wakeEnabledRef = useRef(false);
  const mountedAtRef = useRef(Date.now());

  useEffect(() => {
    // Microphone arming is explicit for each page session, never restored.
    setAlertMode(readAlertMode());
    try { setAmbientIdle(getAmbientIdleMinutes()); } catch { /* Default when storage is blocked. */ }
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
  const registerMicrophoneSession = useCallback((session: VoiceSession) => {
    microphoneSessionRef.current = session;
    const release = () => {
      if (microphoneSessionRef.current === session) microphoneSessionRef.current = null;
      session.cleanup.delete(release);
    };
    session.cleanup.add(release);
    return release;
  }, []);
  const refreshMicrophones = useCallback(async (granted = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const epoch = ++enumerationEpoch.current;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
      if (!mountedRef.current || epoch !== enumerationEpoch.current) return;
      // Before permission, browsers may conceal every non-default device.
      const known = granted || devicesKnownRef.current || devices.some(device => Boolean(device.label));
      devicesKnownRef.current = known; setDevicesKnown(known); setMicrophones(devices);
      if (known && microphoneRef.current && !devices.some(device => device.deviceId === microphoneRef.current)) {
        if (microphoneSessionRef.current?.owns()) cancelAll();
        setMicCheck({ phase: 'error', message: MISSING_MICROPHONE, level: null });
      }
    } catch { /* Enumeration is optional; exact capture can establish availability. */ }
  }, [cancelAll]);
  useEffect(() => {
    const saved = readMicrophonePreference(); microphoneRef.current = saved; setMicrophone(saved);
    void refreshMicrophones();
    const media = navigator.mediaDevices;
    const changed = () => { void refreshMicrophones(); };
    media?.addEventListener?.('devicechange', changed);
    return () => { ++enumerationEpoch.current; media?.removeEventListener?.('devicechange', changed); };
  }, [refreshMicrophones]);
  const missingMicrophone = Boolean(microphone && devicesKnown && !microphones.some(device => device.deviceId === microphone));
  const openSetup = useCallback(() => {
    suspendWake(); setSettingsOpen(true); setPanelOpen(false);
    settingsRef.current?.focus();
    void refreshMicrophones();
  }, [refreshMicrophones, suspendWake]);
  useEffect(() => { if (settingsOpen) settingsRef.current?.focus(); }, [settingsOpen]);
  useEffect(() => {
    window.addEventListener(VOICE_SETUP_EVENT, openSetup);
    return () => window.removeEventListener(VOICE_SETUP_EVENT, openSetup);
  }, [openSetup]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; conversation.end(); speech.cancel(); };
  }, [conversation, speech]);
  const speak = useCallback(async (session: VoiceSession, text: string, voiceData?: { audio: string; mimeType: string }[], beforePlayback?: () => Promise<boolean>) => {
    const followUp = conversation.owns(session);
    const outcome = await speech.speak(session, text, voiceData, notice => {
      if (session.owns()) { setSpeechNotice(notice); setPanelOpen(true); }
    }, followUp, beforePlayback);
    if (followUp) conversation.complete(session, outcome);
  }, [conversation, speech]);

  // ── Intent handling ───────────────────────────────────────────
  /** Praxis has already executed status, demo and away intents before responding. */
  type ServerIntent = (
    | { type: "navigate"; route: string; label: string }
    | { type: "local_only"; enable: boolean }
    | { type: "local_queue"; action: "pause" | "resume" }
    | { type: "status_report" | "away_briefing" }
    | { type: "demo_mode"; enable: boolean }
    | { type: "chat" }
  ) & { speechContext?: VoiceProseInput };
  type IntentOutcome = { context: VoiceProseInput; fallback: string };

  /** Execute once; archival and composition can never cause another action. */
  const runIntent = useCallback(async (session: VoiceSession, intent: ServerIntent): Promise<IntentOutcome> => {
    const result = (facts: Record<string, unknown>, fallback: string): IntentOutcome => ({ context: { kind: 'command-result', facts }, fallback });
    if (intent.type === 'status_report' || intent.type === 'away_briefing' || intent.type === 'demo_mode') {
      const context = intent.speechContext;
      const facts = context && typeof context.facts === 'object' ? context.facts : {};
      const report = facts.report as { outcome?: string } | undefined;
      const fallback = intent.type === 'demo_mode'
        ? typeof facts.active === 'boolean' ? `Demo mode is ${facts.active ? 'active' : 'off'}.` : 'The demo mode result is uncertain. Check its state before repeating the command.'
        : report?.outcome === 'started' ? 'Status report started.'
          : report?.outcome === 'already-running' ? 'A status report is already running.'
            : report?.outcome === 'cooldown' ? 'Status report was not started because its cooldown is active.'
              : 'The status report result is uncertain. Check reports before repeating the command.';
      return { context: context ?? { kind: 'command-result', facts: { intent: intent.type, outcome: 'uncertain' } }, fallback };
    }
    if (!session.owns()) return result({ intent: intent.type, outcome: 'not-executed' }, 'Voice ended before this command was executed.');
    switch (intent.type) {
      case 'navigate':
        router.push(intent.route);
        return result({ action: 'navigate', route: intent.route, label: intent.label, outcome: 'opened' }, `Opened ${intent.label}.`);
      case 'local_only':
        try {
          const state = await setLocalOnlyMode(intent.enable, intent.enable ? 'voice_command' : null);
          if (typeof state?.enabled !== 'boolean') throw new Error('Model control outcome unavailable');
          return result({ action: 'local_only', enabled: state.enabled, outcome: 'updated' }, `Local-only mode is ${state.enabled ? 'enabled' : 'disabled'}.`);
        } catch { return result({ action: 'local_only', requestedEnabled: intent.enable, outcome: 'uncertain' }, 'The model control result is uncertain. Check model control before repeating the command.'); }
      case 'local_queue':
        try {
          const res = await voiceChatRequest(`/api/local-queue/${intent.action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'voice_command' }),
          }, { signal: session.signal });
          return result({ action: 'local_queue', requestedAction: intent.action, outcome: res.ok ? 'succeeded' : 'failed' },
            res.ok ? `Local queue ${intent.action === 'pause' ? 'paused' : 'resumed'}.` : `Local queue ${intent.action} failed.`);
        } catch { return result({ action: 'local_queue', requestedAction: intent.action, outcome: 'uncertain' }, 'The local queue result is uncertain. Check the queue before repeating the command.'); }
      default: return result({ outcome: 'uncertain' }, 'The command result is uncertain. Check its state before repeating it.');
    }
  }, [router]);

  const executeTranscript = useCallback(async (session: VoiceSession, text: string, snapshot: typeof chatRef.current) => {
    if (!session.owns()) return;
    // The capture saved this context before microphone permission or transcription awaited.
    const turn: VoiceChatTurn = {
      clientMessageId: crypto.randomUUID(), message: text, conversationId: snapshot.conversationId ?? undefined,
      history: snapshot.messages.slice(-10).map(message => ({ role: message.role, content: message.content })), projectId: snapshot.projectId,
    };
    const merge = (saved: SavedVoiceMessage[] = []) => {
      if (!mountedRef.current || chatRef.current.conversationId !== snapshot.conversationId) return;
      setMessages(previous => chatRef.current.conversationId === snapshot.conversationId
        ? mergeVoiceMessages(previous, saved.filter(message => message.conversation_id === snapshot.conversationId)) : previous);
    };
    // Local archival outlives cancellation: an action may already have taken effect.
    const archive = async (outcome?: string, suppressVoice = false) => {
      try { merge(await archiveVoiceExchange(turn, outcome, { suppressVoice })); }
      catch {
        if (mountedRef.current && session.owns()) setSpeechNotice('This voice exchange could not be saved to chat. The command outcome is shown separately.');
      }
    };
    speech.setState(session, 'working');
    let intent: ServerIntent;
    try {
      const res = await voiceChatRequest<{ intent: ServerIntent }>('/api/praxis/voice-intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: text }),
      }, { signal: session.signal });
      if (!res.ok || !res.data.intent?.type) throw new Error('Intent unavailable');
      intent = res.data.intent;
    } catch {
      // Classification can execute server actions before a response is lost. Never
      // retry it or claim those actions did not run, including when End was pressed.
      const uncertain = 'The command result is uncertain. Check its state before repeating it.';
      if (session.owns()) setResponse(uncertain);
      await archive(uncertain, true);
      speech.finish(session); return;
    }
    if (intent.type !== 'chat') {
      // The transcript and outcome always use the frozen chat. Archival outlives
      // End because either Praxis or a local request may already have acted.
      await archive();
      const outcome = await runIntent(session, intent);
      let reply = outcome.fallback;
      let generated = false;
      if (session.owns()) {
        setResponse(reply);
        try {
          reply = await composeVoiceProse(session, outcome.context);
          generated = true;
          if (session.owns()) setResponse(reply);
        } catch {
          if (session.owns()) setSpeechNotice('Text only: spoken wording is unavailable. The command outcome is shown below.');
        }
      }
      await archive(reply, !generated);
      if (session.owns() && generated) await speak(session, reply);
      else speech.finish(session);
      return;
    }
    if (!session.owns()) { await archive('Voice ended before this chat message was sent.', true); return; }
    try {
      const data = await sendVoiceChat(turn, {
        signal: session.signal,
        onReceipt: receipt => merge(receipt.messages),
        onProgress: progress => {
          if (!session.owns()) return;
          setResponse({ accepting: 'Sending to shared chat…', accepted: 'Accepted. Praxis is working…',
            working: 'Accepted. Praxis is working…', reconnecting: 'Reconnecting to saved chat. The result may still be in progress…' }[progress]);
        },
      });
      if (!session.owns()) return;
      const reply = typeof data.response === 'string' ? data.response : '';
      if (!reply.trim() && !data.voiceData?.some(voice => typeof voice.audio === 'string' && voice.audio)) {
        setResponse('The saved response is empty. Check saved chat before resending.'); speech.finish(session); return;
      }
      setResponse(reply);
      if (data.suppressVoice === true) { speech.finish(session); return; }
      await speak(session, reply, data.voiceData);
    } catch (error) {
      if (session.owns()) setResponse(error instanceof Error ? error.message : 'The result is uncertain. Check saved chat before resending.');
      speech.finish(session);
    }
  }, [runIntent, setMessages, speak, speech]);

  // ── Recording (manual or explicitly enabled wake word) ─────────
  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);
  const startRecording = useCallback(async (ownedSession?: VoiceSession) => {
    if (document.hidden) { cancelAll(); return; }
    if (!ownedSession && stateRef.current !== 'idle' && stateRef.current !== 'speaking') return;
    if (!ownedSession) conversation.end();
    const session = ownedSession ?? speech.begin(); if (!session || !session.owns()) return;
    const chatContext = chatRef.current;
    speech.setState(session, 'working');
    setTranscript(null); setResponse(null); setSpeechNotice(null); setElapsed(0); setSettingsOpen(false); setPanelOpen(true);
    const unavailable = !chatRef.current.conversationId ? 'Shared chat is loading. Try voice when the conversation is ready.'
      : microphoneCapability() || (missingMicrophone ? MISSING_MICROPHONE : null);
    if (unavailable) { setResponse(unavailable); speech.finish(session); return; }
    const releaseCapture = registerMicrophoneSession(session);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(microphoneRef.current));
      if (!session.owns()) { stream.getTracks().forEach(t => t.stop()); return; }
      const releaseStream = () => stream.getTracks().forEach(t => t.stop());
      session.cleanup.add(releaseStream);
      void refreshMicrophones(true);
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
        releaseCapture();
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
        if (Ctx) { audioCtx = new Ctx(); source = audioCtx.createMediaStreamSource(stream); analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; source.connect(analyser); void audioCtx.resume?.().catch(() => { analyser = null; }); }
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
          setTranscript(cleaned); await executeTranscript(session, cleaned, chatContext);
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
    } catch (error) {
      if (session.owns()) setResponse(microphoneError(error));
      speech.finish(session);
    }
  }, [cancelAll, conversation, executeTranscript, missingMicrophone, refreshMicrophones, registerMicrophoneSession, speech, stopRecording]);
  startRecordingRef.current = session => { void startRecording(session); };

  const startMicCheck = () => {
    cancelAll(); setPanelOpen(false); setSpeechNotice(null);
    const unavailable = microphoneCapability(false) || (missingMicrophone ? MISSING_MICROPHONE : null);
    if (unavailable) { setMicCheck({ phase: 'error', message: unavailable, level: null }); return; }
    if (document.hidden) return;
    const session = speech.begin(); if (!session) return;
    registerMicrophoneSession(session);
    void checkMicrophone(speech, session, {
      deviceId: microphoneRef.current,
      onUpdate: next => { if (mountedRef.current) setMicCheck(next); },
      onPermission: () => { void refreshMicrophones(true); },
    });
  };
  const testVoice = () => {
    cancelAll(); setPanelOpen(false); setTranscript(null); setResponse(null); setSpeechNotice(null);
    if (document.hidden) return;
    const session = speech.begin(); if (!session) return;
    speech.setState(session, 'working');
    void (async () => {
      try {
        const text = await composeVoiceProse(session, { kind: 'voice-test', facts: { purpose: 'Check voice audibility' } });
        if (!session.owns()) return;
        setResponse(text);
        await speech.speak(session, text, undefined, notice => {
          if (session.owns()) setSpeechNotice(notice);
        });
      } catch {
        if (session.owns()) setSpeechNotice('Text only: voice test wording is unavailable. Try Test Praxis voice again.');
        speech.finish(session);
      }
    })();
  };

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
      if (settingsOpenRef.current || document.hidden) return null;
      const session = speech.begin(true); if (!session) return null;
      const announcementConversationId = chatRef.current.conversationId;
      const facts = alertFacts(event, id => {
        const task = projectsRef.current?.flatMap(project => project.tasks ?? []).find(task => task.id === id);
        return task?.title || task?.name;
      });
      // Chat receives the words first. The voice panel is revealed only by audio playback.
      speech.setState(session, 'working');
      return (async () => {
        let deliveryConversationId = announcementConversationId || undefined;
        let failure = 'Voice update could not be prepared or saved to chat.';
        let delivered = false;
        const mergeSaved = (saved: SavedVoiceMessage[]) => {
          if (mountedRef.current && chatRef.current.conversationId === deliveryConversationId) {
            setMessages(previous => mergeVoiceMessages(previous, saved.filter(message => !message.conversation_id || message.conversation_id === deliveryConversationId)));
          }
        };
        try {
          const text = await composeVoiceProse(session, { kind: 'alert', facts });
          if (!session.owns()) { failure = 'Voice update was canceled before playback.'; return; }
          const saved = await archiveVoiceAnnouncement(event.eventId, text, deliveryConversationId, { signal: session.signal });
          const archived = saved.find(message => message.id === `voice-alert:${event.eventId}`);
          if (!archived?.content) throw new Error('Announcement receipt is missing its text');
          deliveryConversationId = archived.conversation_id || deliveryConversationId;
          mergeSaved(saved);
          failure = 'Voice update was skipped or interrupted before playback finished. The update is in chat.';
          const mayPlay = () => alerts.canPlay(event, session.signal, () => session.owns() && !settingsOpenRef.current && !document.hidden);
          if (!await mayPlay()) return;
          const outcome = await speech.speak(session, archived.content, undefined, notice => {
            failure = `Voice update failed: ${notice.replace(' The full response remains in the voice panel.', '')} The update is in chat.`;
          }, false, async () => {
            if (!await mayPlay()) return false;
            if (!await playAnnouncementCue(session.signal)) {
              failure = 'Voice update could not play its announcement sound. The update is in chat.';
              return false;
            }
            return mayPlay();
          }, () => {
            if (session.owns()) {
              setResponse(archived.content); setTranscript(null); setSpeechNotice(null);
              setSettingsOpen(false); setPanelOpen(true);
            }
          });
          delivered = outcome === 'completed';
        } catch {
          if (session.signal.aborted) failure = 'Voice update was canceled before playback finished.';
        } finally {
          speech.finish(session);
          if (!delivered) {
            // Speech completion releases/aborts its session. Archival needs its own lifetime.
            try {
              mergeSaved(await archiveVoiceDeliveryNotice(event.eventId, failure, deliveryConversationId));
            } catch {
              mergeSaved([{ id: `voice-delivery:${event.eventId}`, role: 'assistant',
                content: `${failure} This notice could not be saved; it is shown locally.`,
                conversation_id: deliveryConversationId,
                metadata: { eventId: event.eventId, voiceDeliveryNotice: true, playbackOwner: 'voice', suppressVoice: true } }]);
            }
          }
        }
      })();
    } });
    alertsRef.current = alerts;
    return () => { alerts.dispose(); alertsRef.current = null; };
  }, [speak, speech, setMessages]);
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
      } else if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'v' && !e.repeat) {
        e.preventDefault(); openSetup();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelAll, openSetup]);
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
        <span>
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
        onClick={() => { if (settingsOpen) { cancelAll(); setSettingsOpen(false); } else openSetup(); }}
        className="p-1.5 rounded-lg border border-slate-800 bg-slate-900/50 text-slate-500 hover:text-white transition-all"
        aria-label="Voice settings"
        title="Voice settings"
      >
        <Settings2 size={14} />
      </button>

      {settingsOpen && (
        <div ref={settingsRef} role="dialog" aria-label="Talk to Praxis setup" tabIndex={-1} className="custom-scrollbar absolute right-0 bottom-full z-50 mb-3 w-96 max-w-[calc(100vw/var(--nexus-display-scale,1)-2.25rem)] max-h-[calc(100dvh/var(--nexus-display-scale,1)-8rem)] overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-4 shadow-2xl focus-visible:outline-2 focus-visible:outline-cyan-400">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-cyan-200">Talk to Praxis</h2>
            <button type="button" onClick={() => { cancelAll(); setSettingsOpen(false); }} aria-label="Close voice setup" className="rounded p-1.5 text-slate-300 hover:text-white"><X size={16} /></button>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-slate-300">Start conversation to talk hands free. Praxis listens, replies, then listens again. End conversation or press Escape to stop.</p>
          <p className="mb-3 text-xs leading-relaxed text-slate-400">Commands and conversations send audio to the existing Praxis transcription service. Replies use Praxis voice, with Qwen running on your Mac. The microphone check stays on this device.</p>
          <label className="mb-1 block text-xs font-semibold text-slate-200" htmlFor="praxis-microphone">Microphone input</label>
          <select id="praxis-microphone" aria-label="Microphone input" value={microphone} onChange={event => {
            cancelAll(); const value = event.target.value; microphoneRef.current = value; setMicrophone(value); saveMicrophonePreference(value); setMicCheck(INITIAL_MICROPHONE_CHECK);
          }} className="mb-2 w-full rounded border border-slate-600 bg-slate-900 px-2 py-2 text-xs text-slate-100">
            <option value="">Default microphone</option>
            {microphone && !microphones.some(device => device.deviceId === microphone) && <option value={microphone}>Saved microphone{missingMicrophone ? ' (unavailable)' : ''}</option>}
            {microphones.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
          </select>
          {missingMicrophone && <p role="status" className="mb-2 text-xs text-amber-300">{MISSING_MICROPHONE}</p>}
          {microphoneCapability() && <p className="mb-2 text-xs text-amber-300">{microphoneCapability()}</p>}
          <div className="mb-2 flex flex-wrap gap-2">
            <button type="button" aria-label="Check microphone" onClick={startMicCheck} className="rounded border border-cyan-500/40 px-2.5 py-2 text-xs text-cyan-200">Check microphone</button>
            {(micCheck.phase === 'requesting' || micCheck.phase === 'checking') && <button type="button" aria-label="Stop check" onClick={cancelAll} className="rounded border border-red-400/40 px-2.5 py-2 text-xs text-red-200">Stop check</button>}
            <button type="button" aria-label="Test Praxis voice" onClick={testVoice} className="rounded border border-slate-500 px-2.5 py-2 text-xs text-slate-100">Test Praxis voice</button>
          </div>
          <p role="status" className="mb-2 text-xs leading-relaxed text-slate-200">{micCheck.message}</p>
          {micCheck.phase === 'checking' && micCheck.level !== null && <div role="meter" aria-label="Microphone signal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={micCheck.level} className="mb-3 h-2 overflow-hidden rounded bg-slate-800"><div className="h-full bg-cyan-400" style={{ width: `${micCheck.level}%` }} /></div>}
          {response && <p className="mb-2 text-xs leading-relaxed text-slate-200">{response}</p>}
          {speechNotice && <p role="status" className="mb-2 text-xs text-amber-300">{speechNotice}</p>}
          <div className="mb-2 mt-4 border-t border-slate-700 pt-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">voice and ambient</div>

          <label className="flex items-center justify-between gap-2 py-1.5 text-xs text-slate-300">
            <span className="flex items-center gap-2">
              {wakeEnabled ? <Ear size={13} className="text-cyan-400" /> : <EarOff size={13} className="text-slate-500" />}
              Wake word &quot;Praxis&quot;
              {!wakeSupported && <span className="text-[10px] text-amber-300">(unavailable in this browser)</span>}
            </span>
            <input
              type="checkbox"
              checked={wakeEnabled}
              disabled={!wakeSupported || conversationActive || micCheck.phase === 'requesting' || micCheck.phase === 'checking'}
              onChange={(e) => {
                wakeSuspendedRef.current = false; setWakeSuspended(false);
                setWakeEnabled(e.target.checked);
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
                try { setAmbientIdleMinutes(v); } catch { /* Session setting. */ }
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

      {panelOpen && !settingsOpen && (transcript || response || speechNotice) && (
        <div className="custom-scrollbar absolute right-0 bottom-full z-50 mb-3 w-80 max-w-[calc(100vw/var(--nexus-display-scale,1)-2.25rem)] max-h-[calc(100dvh/var(--nexus-display-scale,1)-8rem)] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md">
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
            <p className="custom-scrollbar max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
              <span className="text-slate-600">praxis ›</span> {response}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
