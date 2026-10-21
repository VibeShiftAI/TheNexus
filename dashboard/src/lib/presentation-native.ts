import type { DisplayCommandResult } from '@praxis/contract';

declare global {
  interface Window { __NEXUS_DISPLAYS__?: { version: number; platform: 'windows' | 'android' }; }
}
export function displayShellAvailable(): boolean {
  return typeof window !== 'undefined' && window.__NEXUS_DISPLAYS__?.version === 1 && ['windows', 'android'].includes(window.__NEXUS_DISPLAYS__.platform);
}
type Request = { action: 'discover' | 'stop' | 'status' | 'wireless-picker' } | { action: 'start'; targetId: string; sessionId: string; expiresAt: string };
export function requestNativeDisplay(command: Request, options: { navigate?: (url: string) => void; timeoutMs?: number } = {}): Promise<DisplayCommandResult> {
  if (!displayShellAvailable()) return Promise.reject(new Error('Display control requires the Windows or Android travel shell.'));
  const android = window.__NEXUS_DISPLAYS__?.platform === 'android';
  if (android && typeof window.ReactNativeWebView?.postMessage !== 'function') return Promise.reject(new Error('The Android native display bridge is unavailable. Reopen the installed app.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); window.removeEventListener('nexus:display-result', receive); };
    const receive = (event: Event) => {
      const result = (event as CustomEvent<DisplayCommandResult>).detail;
      if (result?.requestId !== requestId) return;
      clear();
      if (result.ok) resolve(result); else reject(new Error(result.message || result.code || 'The native display request failed.'));
    };
    const timer = setTimeout(() => { clear(); reject(new Error('The native display service did not respond. Reopen the shell and refresh displays.')); }, options.timeoutMs ?? 10000);
    window.addEventListener('nexus:display-result', receive);
    const url = `nexus-shell://presentation?request=${encodeURIComponent(JSON.stringify({ ...command, requestId }))}`;
    try {
      if (android) window.ReactNativeWebView!.postMessage(JSON.stringify({ type: 'presentation', command: { ...command, requestId } }));
      else (options.navigate || (value => { window.location.href = value; }))(url);
    }
    catch (cause) { clear(); reject(cause); }
  });
}
