"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MonitorUp, RefreshCw, X } from 'lucide-react';
import { DisplayInventorySchema, PresentationViewSchema, type DisplayInventory, type PresentationSession, type PresentationView } from '@praxis/contract';
import { displayShellAvailable, requestNativeDisplay } from '@/lib/presentation-native';
import { createPresentationOperationQueue } from '@/lib/presentation-operations';
import { presentationRequest } from '@/lib/presentation-transport';

const api = '/api/presentations';
const live = (s: PresentationSession) => s.state === 'active' || s.state === 'starting';
const nativeSession = (s: PresentationSession) => s.method === 'windows-monitor' || s.method === 'android-presentation';
const buttonClass = 'rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-100 hover:border-cyan-400 disabled:opacity-40';

export function PresentDocumentButton({ documentId, revisionId, contentHash }: { documentId: string; revisionId: string; contentHash: string }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => setEnabled(displayShellAvailable()), []);
  if (!enabled) return null;
  return <button type="button" className={buttonClass} onClick={() => window.dispatchEvent(new window.CustomEvent('nexus:present-document', {
    detail: { kind: 'document', documentId, revisionId, contentHash },
  }))}><MonitorUp size={14} className="mr-1 inline" /> Present this revision</button>;
}

export function TravelPresentationLauncher() {
  const android = typeof window !== 'undefined' && window.__NEXUS_DISPLAYS__?.platform === 'android';
  const platformName = android ? 'Android' : 'Windows';
  const suspended = useRef(false);
  const lifecycle = useRef(0);
  const revoking = useRef(new Set<string>());
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<DisplayInventory | null>(null);
  const [selection, setSelection] = useState('');
  const [view, setView] = useState<PresentationView>({ kind: 'ambient' });
  const [sessions, setSessions] = useState<PresentationSession[]>([]);
  const [receiverOrigin, setReceiverOrigin] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionsRef = useRef<PresentationSession[]>([]);
  const operations = useRef(createPresentationOperationQueue());
  const inventoryRef = useRef<DisplayInventory | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const result = await requestNativeDisplay({ action: 'discover' });
    const next = DisplayInventorySchema.parse(result.inventory);
    // Keep the phone's observed capabilities visible even if the service is unavailable.
    // Starting still awaits this registration and server authorization on every attempt.
    inventoryRef.current = next; setInventory(next);
    setSelection(current => next.targets.some(target => target.id === current) ? current : '');
    await presentationRequest(`${api}/inventory`, { method: 'PUT', body: JSON.stringify(next) });
    const [listed, config] = await Promise.all([
      presentationRequest<{ sessions: PresentationSession[] }>(`${api}/sessions`),
      presentationRequest<{ receiverOrigin: string | null }>(`${api}/config`),
    ]);
    sessionsRef.current = listed.sessions.filter(s => s.sourceDeviceId === next.sourceDevice.id);
    setSessions(sessionsRef.current);
    setReceiverOrigin(config.receiverOrigin);
    return next;
  }, []);
  const perform = useCallback(async (action: (ensureActive: () => void) => Promise<void>) => {
    if (android && document.visibilityState === 'hidden') return;
    const generation = lifecycle.current;
    const ensureActive = () => {
      if (android && (suspended.current || generation !== lifecycle.current || document.visibilityState === 'hidden')) throw new Error('The Android controller left the foreground. Start again to present.');
    };
    suspended.current = false;
    setBusy(true); setError(''); setNotice('');
    try { await operations.current(() => { ensureActive(); return action(ensureActive); }); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Display request failed.'); }
    finally { setBusy(false); }
  }, [android]);

  useEffect(() => {
    if (!displayShellAvailable()) return;
    setEnabled(true);
    // Android discovery starts on a controller gesture, never from the home host.
    if (!android) void operations.current(refresh).catch(() => {});
    const present = (event: Event) => {
      const parsed = PresentationViewSchema.safeParse((event as CustomEvent).detail);
      if (!parsed.success || parsed.data.kind !== 'document') return;
      setView(parsed.data); setOpen(true); void perform(async () => { await refresh(); });
    };
    window.addEventListener('nexus:present-document', present);
    return () => window.removeEventListener('nexus:present-document', present);
  }, [perform, refresh, android]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false, running = false;
    const tick = async () => {
      if (running || suspended.current || !inventoryRef.current) return; running = true;
      await operations.current(async () => {
      if (disposed || suspended.current) return;
      try {
        const listed = await presentationRequest<{ sessions: PresentationSession[] }>(`${api}/sessions`);
        const own = listed.sessions.filter(s => s.sourceDeviceId === inventoryRef.current?.sourceDevice.id);
        const native = own.some(s => nativeSession(s) && live(s)) ? await requestNativeDisplay({ action: 'status' }) : null;
        for (const session of own.filter(live)) {
          if (disposed || suspended.current) return;
          if (revoking.current.has(session.id)) { await presentationRequest(`${api}/sessions/${session.id}`, { method: 'DELETE' }); continue; }
          const active = !nativeSession(session) || (native?.sessionId === session.id && native.state === 'active');
          await presentationRequest(`${api}/sessions/${session.id}/heartbeat`, { method: 'POST', body: JSON.stringify({ state: active ? 'active' : 'disconnected' }) });
        }
        if (!disposed) { sessionsRef.current = own; setSessions(own); }
      } catch (cause) {
        // Native output must also end when the existing controller login stops authorizing reads.
        await requestNativeDisplay({ action: 'stop' }).catch(() => {});
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Controller connection lost.');
      }
      }).finally(() => { running = false; });
    };
    const timer = setInterval(() => { void tick(); }, 10000);
    return () => { disposed = true; clearInterval(timer); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !android) return;
    const background = () => {
      if (suspended.current) return;
      suspended.current = true;
      lifecycle.current++;
      void operations.current(async () => {
        // Serialize after any in-flight start/claim. Revoke authority before native teardown.
        await Promise.allSettled(sessionsRef.current.filter(live).map(session => {
          revoking.current.add(session.id);
          return presentationRequest(`${api}/sessions/${session.id}`, { method: 'DELETE' });
        }));
        await requestNativeDisplay({ action: 'stop' }).catch(() => {});
        setNotice('Presentation ended when the Android controller left the foreground. Start again to present.');
      });
    };
    const visibility = () => { if (document.visibilityState === 'hidden') background(); };
    window.addEventListener('nexus:display-background', background);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('nexus:display-background', background); document.removeEventListener('visibilitychange', visibility); };
  }, [enabled, android]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); return; }
      if (event.key !== 'Tab') return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]') || [])];
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);

  if (!enabled) return null;
  const selectedTarget = inventory?.targets.find(target => target.id === selection);
  const viewOption = view.kind === 'focus' ? `focus-${view.mode}` : view.kind;
  return <>
    <button type="button" onClick={() => { setOpen(true); void perform(async () => { await refresh(); }); }} className="fixed bottom-12 left-4 z-40 flex items-center gap-2 rounded-full border border-cyan-700 bg-slate-950 px-4 py-2 text-sm text-cyan-100 shadow-xl"><MonitorUp size={17} /> Displays{sessions.some(live) ? ' · presenting' : ''}</button>
    {open && createPortal(<div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/75 p-4" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Present on a display" className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 p-5"><div><h2 className="text-xl font-semibold text-white">Present on a display</h2><p className="mt-1 text-xs text-slate-400">Choose a read-only view. Keep review controls here.</p></div><button ref={close} type="button" onClick={() => setOpen(false)} aria-label="Close displays" className={buttonClass}><X size={18} /></button></header>
        <div className="min-h-0 space-y-6 overflow-y-auto p-5 text-sm text-slate-200">
          {error && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-red-200">{error}</p>}
          {notice && <p role="status" className="rounded-lg border border-cyan-800 p-3 text-cyan-100">{notice}</p>}
          <label className="block">View<select aria-label="Presentation view" value={viewOption} className="mt-2 block w-full rounded-lg border border-slate-600 bg-slate-900 p-3" onChange={event => {
            const value = event.target.value;
            if (value === 'ambient') setView({ kind: 'ambient' });
            else if (value === 'day-plan') setView({ kind: 'day-plan', date: new Date().toLocaleDateString('en-CA') });
            else if (value === 'focus-board' || value === 'focus-active') setView({ kind: 'focus', mode: value === 'focus-board' ? 'board' : 'active' });
          }}><option value="ambient">Ambient bridge</option><option value="focus-active">Current focus / active work</option><option value="focus-board">Task board</option><option value="day-plan">Calendar / day plan</option>{view.kind === 'document' && <option value="document">Selected document revision</option>}</select></label>
          {view.kind === 'day-plan' && <label className="block">Plan date<input aria-label="Plan date" type="date" value={view.date} onChange={event => setView({ kind: 'day-plan', date: event.target.value })} className="ml-3 rounded-lg border border-slate-600 bg-slate-900 p-2" /></label>}
          {view.kind === 'document' ? <div className="break-all rounded-lg border border-slate-700 p-3 font-mono text-xs"><p>Document {view.documentId}</p><p>Revision {view.revisionId}</p><p>SHA-256 {view.contentHash}</p></div> : <p className="text-xs text-slate-400">For a document, open its review and choose “Present this revision”. Markdown, PDF, images and video are supported.</p>}
          <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-semibold">Displays from this device</h3><button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => { await refresh(); })}><RefreshCw size={14} className="mr-1 inline" /> Refresh</button></div>
            {inventory && <p className="text-xs text-slate-400">Source: {inventory.sourceDevice.name} · {inventory.sourceDevice.platform} · observed {new Date(inventory.observedAt).toLocaleTimeString()}. Refresh before starting.</p>}
            {inventory?.targets.map(target => <label key={target.id} className="block rounded-lg border border-slate-700 p-3"><input type="radio" name="presentation-target" value={target.id} checked={selection === target.id} disabled={target.availability !== 'available' || !target.capabilities.includes(view.kind)} onChange={() => setSelection(target.id)} /> <strong>{target.name}</strong> <span className="text-slate-400">· {target.method} · {target.availability}</span><span className="mt-1 block break-all pl-5 font-mono text-[11px] text-slate-500">{target.id}</span>{target.limitations.map((limit, i) => <span key={i} className="mt-1 block pl-5 text-xs text-amber-200">{limit}</span>)}</label>)}
            {!inventory?.targets.length && <p>No usable displays reported. Connect a supported display, then refresh from this device.</p>}
            {inventory?.limitations.map((limit, i) => <p key={i} className="text-xs text-slate-400">{limit}</p>)}
            <button type="button" className={`${buttonClass} border-cyan-600 bg-cyan-950`} disabled={busy || !selectedTarget || selectedTarget.availability !== 'available'} onClick={() => void perform(async ensureActive => {
              if (!selection) return;
              const fresh = await refresh();
              ensureActive();
              const target = fresh.targets.find(t => t.id === selection && t.availability === 'available');
              if (!target) throw new Error('That display is no longer available. Choose a current target.');
              for (const previous of sessionsRef.current.filter(s => nativeSession(s) && live(s))) {
                await requestNativeDisplay({ action: 'stop' }); await presentationRequest(`${api}/sessions/${previous.id}`, { method: 'DELETE' });
              }
              const created = await presentationRequest<PresentationSession>(`${api}/sessions`, { method: 'POST', body: JSON.stringify({ sourceDeviceId: fresh.sourceDevice.id, targetId: selection, view }) });
              sessionsRef.current = [...sessionsRef.current, created];
              try {
                ensureActive();
                const opened = await requestNativeDisplay({ action: 'start', targetId: selection, sessionId: created.id, expiresAt: created.expiresAt });
                ensureActive();
                if (opened.state !== 'active' || opened.sessionId !== created.id) throw new Error(`${platformName} did not confirm this presentation.`);
                await presentationRequest(`${api}/sessions/${created.id}/heartbeat`, { method: 'POST', body: JSON.stringify({ state: 'active' }) });
              } catch (cause) { revoking.current.add(created.id); await requestNativeDisplay({ action: 'stop' }).catch(() => {}); await presentationRequest(`${api}/sessions/${created.id}`, { method: 'DELETE' }).catch(() => {}); throw cause; }
              await refresh(); setNotice(`${platformName} confirmed the presentation window.`);
            })}>Present on selected display</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => { await requestNativeDisplay({ action: 'wireless-picker' }); setNotice('Choose the target in the device picker, then refresh or enter the receiver pairing code. Opening the picker alone does not start a Nexus view.'); })}>Choose wireless display</button>
            <p className="text-xs text-slate-400">{android ? 'Google Cast requires a configured custom Nexus receiver. Launch it with the Cast picker, then pair the code below. Android wireless-display settings may mirror the whole phone; a separate presentation display depends on the phone and TV.' : 'Wireless display: press Win+K and choose a Miracast-compatible target in Windows. Use Extend mode, then refresh here. OS consent stays in Windows.'}</p>
          </section>
          <section className="space-y-3 border-t border-slate-800 pt-5"><h3 className="font-semibold">Pair a TV browser</h3>
            {receiverOrigin ? <><p>On the TV browser, open <span className="break-all font-mono text-cyan-200">{receiverOrigin}/presentation/index.html</span>. Get a two-digit code, then enter it here for only the selected view.</p><form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (!/^[0-9]{2}$/.test(code)) return; void perform(async ensureActive => {
              const fresh = await refresh();
              ensureActive();
              const claimed = await presentationRequest<{ session: PresentationSession }>(`${api}/pairings/${encodeURIComponent(code.trim())}/claim`, { method: 'POST', body: JSON.stringify({ sourceDevice: fresh.sourceDevice, view }) });
              sessionsRef.current = [...sessionsRef.current, claimed.session];
              ensureActive();
              setCode(''); await refresh(); setNotice('Pairing approved for this selected view. The TV will connect on its next poll.');
            }); }}><input aria-label="TV pairing code" value={code} inputMode="numeric" pattern="[0-9]{2}" maxLength={2} onChange={event => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 2))} required className="min-w-0 rounded-lg border border-slate-600 bg-slate-900 p-2 font-mono" /><button className={buttonClass} disabled={busy || !/^[0-9]{2}$/.test(code)}>Pair selected view</button></form></> : <p className="text-slate-400">The isolated TV receiver address is not configured. A reachable receiver origin is required; the TV must never sign in to the full dashboard. Use an attached display meanwhile.</p>}
            <p className="text-xs text-slate-400">{android ? 'TV browsers require an explicit pairing code; they are not automatically discovered. Apple TV/AirPlay has no supported Android sender here. Use a supported Cast receiver, TV browser or attached display.' : 'TV browsers are paired manually. Cast from WebView2 and AirPlay are not supported here; a TV name alone does not establish either protocol.'}</p>
          </section>
          <section className="space-y-3 border-t border-slate-800 pt-5"><h3 className="font-semibold">Presentation sessions</h3>{!sessions.length && <p className="text-slate-400">No sessions from this device.</p>}{sessions.map(session => <div key={session.id} className="rounded-lg border border-slate-700 p-3"><div className="flex items-center justify-between gap-3"><span>{session.view.kind} · {session.state}</span>{live(session) && <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
            // Revoke first: even if closing a native window fails, its data lease is ended.
            revoking.current.add(session.id);
            await presentationRequest(`${api}/sessions/${session.id}`, { method: 'DELETE' });
            if (nativeSession(session)) await requestNativeDisplay({ action: 'stop' });
            await refresh(); setNotice('Presentation stopped and receiver access revoked.');
          })}>Stop / revoke</button>}</div><p className="mt-2 break-all font-mono text-xs text-slate-400">{session.targetId}</p><p className="text-xs text-slate-400">Expires {new Date(session.expiresAt).toLocaleTimeString()}{session.reason ? ` · ${session.reason}` : ''}</p></div>)}</section>
        </div>
      </div>
    </div>, document.body)}
  </>;
}
