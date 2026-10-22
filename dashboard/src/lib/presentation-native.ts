import type { DisplayCommandResult } from '@praxis/contract';

declare global {
  interface Window { __NEXUS_DISPLAYS__?: { version: number; platform: 'windows' | 'android' }; }
}
export function displayShellAvailable(): boolean {
  return typeof window !== 'undefined' && window.__NEXUS_DISPLAYS__?.version === 1 && ['windows', 'android'].includes(window.__NEXUS_DISPLAYS__.platform);
}
type Request = { action: 'discover' | 'status' | 'wireless-picker' } | { action: 'stop'; sessionId?: string } | { action: 'start'; targetId: string; sessionId: string; expiresAt: string };
type Options = { navigate?: (url: string) => void; timeoutMs?: number };
type NativeRequest = (command: Request, options?: Options) => Promise<DisplayCommandResult>;
const lifecycles = new WeakMap<NativeRequest, NativeRequest>();

/** All callers sharing a native transport share its start/stop queue. A scoped
 * stop checks identity and closes under one lock; the native wire stays unchanged. */
export function serializeNativeDisplay(native: NativeRequest): NativeRequest {
  const existing = lifecycles.get(native);
  if (existing) return existing;
  let tail: Promise<unknown> = Promise.resolve();
  const wrapped: NativeRequest = (command, options) => {
    if (command.action !== 'start' && command.action !== 'stop') return native(command, options);
    const run = tail.then(async () => {
      if (command.action === 'stop' && command.sessionId) {
        const current = await native({ action: 'status' }, options);
        if (!current.ok || current.sessionId !== command.sessionId) return current;
        return native({ action: 'stop' }, options);
      }
      return native(command, options);
    });
    tail = run.catch(() => {});
    return run;
  };
  lifecycles.set(native, wrapped);
  lifecycles.set(wrapped, wrapped);
  return wrapped;
}

export const requestNativeDisplay = serializeNativeDisplay(sendNativeDisplay);

function sendNativeDisplay(command: Request, options: Options = {}): Promise<DisplayCommandResult> {
  if (!displayShellAvailable()) return Promise.reject(Object.assign(new Error('Display control requires the Windows or Android travel shell.'), { code: 'shell_unavailable' }));
  const android = window.__NEXUS_DISPLAYS__?.platform === 'android';
  if (android && typeof window.ReactNativeWebView?.postMessage !== 'function') return Promise.reject(Object.assign(new Error('The Android native display bridge is unavailable. Reopen the installed app.'), { code: 'bridge_unavailable' }));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); window.removeEventListener('nexus:display-result', receive); };
    const receive = (event: Event) => {
      const result = (event as CustomEvent<DisplayCommandResult>).detail;
      if (result?.requestId !== requestId) return;
      clear();
      // The native code rides on the rejection so a relay can report it verbatim (the message stays for people).
      if (result.ok) resolve(result); else reject(Object.assign(new Error(result.message || result.code || 'The native display request failed.'), result.code ? { code: result.code } : {}));
    };
    const timer = setTimeout(() => { clear(); reject(Object.assign(new Error('The native display service did not respond. Reopen the shell and refresh displays.'), { code: 'timeout' })); }, options.timeoutMs ?? 10000);
    window.addEventListener('nexus:display-result', receive);
    const url = `nexus-shell://presentation?request=${encodeURIComponent(JSON.stringify({ ...command, requestId }))}`;
    try {
      if (android) window.ReactNativeWebView!.postMessage(JSON.stringify({ type: 'presentation', command: { ...command, requestId } }));
      else (options.navigate || (value => { window.location.href = value; }))(url);
    }
    catch (cause) { clear(); reject(cause); }
  });
}
