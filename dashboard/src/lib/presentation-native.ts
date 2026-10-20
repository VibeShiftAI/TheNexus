import type { DisplayCommandResult } from '@praxis/contract';

declare global {
  interface Window { __NEXUS_DISPLAYS__?: { version: number; platform: 'windows' | 'android' }; }
}
export function displayShellAvailable(): boolean {
  return typeof window !== 'undefined' && window.__NEXUS_DISPLAYS__?.version === 1 && window.__NEXUS_DISPLAYS__.platform === 'windows';
}
type Request = { action: 'discover' | 'stop' | 'status' | 'wireless-picker' } | { action: 'start'; targetId: string; sessionId: string; expiresAt: string };
export function requestNativeDisplay(command: Request, options: { navigate?: (url: string) => void; timeoutMs?: number } = {}): Promise<DisplayCommandResult> {
  if (!displayShellAvailable()) return Promise.reject(new Error('Display control requires the Windows travel shell.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); window.removeEventListener('nexus:display-result', receive); };
    const receive = (event: Event) => {
      const result = (event as CustomEvent<DisplayCommandResult>).detail;
      if (result?.requestId !== requestId) return;
      clear();
      if (result.ok) resolve(result); else reject(new Error(result.message || result.code || 'The Windows display request failed.'));
    };
    const timer = setTimeout(() => { clear(); reject(new Error('The Windows display service did not respond. Reopen the shell and refresh displays.')); }, options.timeoutMs ?? 10000);
    window.addEventListener('nexus:display-result', receive);
    const url = `nexus-shell://presentation?request=${encodeURIComponent(JSON.stringify({ ...command, requestId }))}`;
    try { (options.navigate || (value => { window.location.href = value; }))(url); }
    catch (cause) { clear(); reject(cause); }
  });
}
