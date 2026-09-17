import type { VoiceSession, VoiceSpeech } from './voice-speech';

export const VOICE_SETUP_EVENT = 'nexus:voice-setup';
export const MICROPHONE_DEVICE_KEY = 'nexus.voice.microphone';
export const MISSING_MICROPHONE = 'Microphone not found. Reconnect it or choose Default microphone.';
export const MICROPHONE_CHECK_MS = 5_000;

/** Preferences are suggestions; only the selected device ID is mandatory. */
export function microphoneConstraints(deviceId: string): MediaStreamConstraints {
  return { audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  } };
}

export function microphoneCapability(recording = true): string | null {
  if (typeof window === 'undefined' || window.isSecureContext === false) {
    return 'Microphone access needs a secure connection. Open the dashboard using HTTPS.';
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return 'Microphone access is unavailable in this browser. Open the HTTPS dashboard in a browser with microphone support.';
  }
  if (recording && typeof MediaRecorder === 'undefined') {
    return 'Voice recording is unavailable in this browser. Try the HTTPS dashboard in a browser with audio recording support. You can still check the microphone here.';
  }
  return null;
}

export function microphoneError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Allow this site to use your microphone. On Windows, also check Windows Settings > Privacy & security > Microphone, including desktop-app access.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return MISSING_MICROPHONE;
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The microphone could not be opened. It may be busy in another app; close that app, check the device connection, and try again.';
  }
  return 'The microphone could not be opened. Check its connection and site microphone permission, then try again.';
}

export function readMicrophonePreference(): string {
  try { return window.localStorage.getItem(MICROPHONE_DEVICE_KEY) || ''; } catch { return ''; }
}
export function saveMicrophonePreference(deviceId: string) {
  try { window.localStorage.setItem(MICROPHONE_DEVICE_KEY, deviceId); } catch { /* Browser session preference still works. */ }
}

export interface MicrophoneCheck {
  phase: 'idle' | 'requesting' | 'checking' | 'ready' | 'no-signal' | 'unavailable' | 'error' | 'stopped';
  message: string;
  level: number | null;
}
export const INITIAL_MICROPHONE_CHECK: MicrophoneCheck = {
  phase: 'idle', message: 'Check your microphone for five seconds. Audio stays on this device.', level: null,
};

/** A raw local signal check. It never records a Blob, uploads, or transcribes. */
export async function checkMicrophone(speech: VoiceSpeech, session: VoiceSession, options: {
  deviceId: string; onUpdate: (check: MicrophoneCheck) => void; onPermission: () => void;
}) {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cap: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let inputTracks: MediaStreamTrack[] = [];
  const disconnected = () => {
    if (!session.owns()) return;
    finished = true;
    options.onUpdate({ phase: 'error', message: MISSING_MICROPHONE, level: null });
    speech.finish(session);
  };
  const cleanup = () => {
    if (timer !== null) clearInterval(timer);
    if (cap !== null) clearTimeout(cap);
    source?.disconnect();
    if (context) void context.close().catch(() => {});
    inputTracks.forEach(track => track.removeEventListener?.('ended', disconnected));
    stream?.getTracks().forEach(track => track.stop());
    session.cleanup.delete(cleanup);
    if (!finished) options.onUpdate({ phase: 'stopped', message: 'Microphone check stopped.', level: null });
  };
  // Register before permission: cancellation also invalidates a late grant.
  session.cleanup.add(cleanup);
  options.onUpdate({ phase: 'requesting', message: 'Requesting microphone permission… You can stop the check while waiting.', level: null });
  speech.setState(session, 'working');
  try {
    const granted = await navigator.mediaDevices.getUserMedia(microphoneConstraints(options.deviceId));
    if (!session.owns()) { granted.getTracks().forEach(track => track.stop()); return; }
    stream = granted;
    inputTracks = granted.getTracks();
    inputTracks.forEach(track => track.addEventListener?.('ended', disconnected));
    if (inputTracks.some(track => track.readyState === 'ended')) { disconnected(); return; }
    let analyser: AnalyserNode | null = null;
    let measured = false;
    let detected = false;
    // The bound starts at the grant, independently of Web Audio setup/resume.
    cap = setTimeout(() => {
      if (!session.owns()) return;
      // Some hosts update readyState before delivering the ended event.
      if (inputTracks.some(track => track.readyState === 'ended')) { disconnected(); return; }
      finished = true;
      options.onUpdate(measured
        ? { phase: detected ? 'ready' : 'no-signal', message: detected ? 'Ready — microphone signal detected.' : 'No signal detected. Speak closer, check the input volume, or choose another microphone.', level: null }
        : { phase: 'unavailable', message: 'Microphone opened. The signal meter is unavailable in this browser; signal could not be checked.', level: null });
      speech.finish(session);
    }, MICROPHONE_CHECK_MS);
    options.onPermission();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    try {
      if (Ctx) {
        context = new Ctx();
        source = context.createMediaStreamSource(granted);
        analyser = context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
        void context.resume?.().catch(() => { analyser = null; });
      }
    } catch { analyser = null; }
    options.onUpdate({ phase: 'checking', message: analyser ? 'Checking microphone… Speak now (five seconds).' : 'Checking microphone… Signal meter unavailable in this browser.', level: null });
    const buffer = new Float32Array(512);
    timer = setInterval(() => {
      if (!session.owns()) return;
      if (inputTracks.some(track => track.readyState === 'ended')) { disconnected(); return; }
      if (!analyser || context?.state === 'suspended') return;
      try {
        analyser.getFloatTimeDomainData(buffer);
        const rms = Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length);
        measured = true; detected ||= rms > 0.015;
        options.onUpdate({ phase: 'checking', message: 'Checking microphone… Speak now (five seconds).', level: Math.min(100, Math.round(rms * 500)) });
      } catch {
        analyser = null;
        options.onUpdate({ phase: 'checking', message: 'Checking microphone… Signal meter unavailable in this browser.', level: null });
      }
    }, 100);
  } catch (error) {
    if (session.owns()) {
      finished = true;
      options.onUpdate({ phase: 'error', message: microphoneError(error), level: null });
      speech.finish(session);
    }
  }
}
