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
    await presentationRequest(`${api}/inventory`, { method: 'PUT', body: JSON.stringify(next) });
    inventoryRef.current = next; setInventory(next);
    setSelection(current => next.targets.some(target => target.id === current) ? current : '');
    const [listed, config] = await Promise.all([
      presentationRequest<{ sessions: PresentationSession[] }>(`${api}/sessions`),
      presentationRequest<{ receiverOrigin: string | null }>(`${api}/config`),
    ]);
    sessionsRef.current = listed.sessions.filter(s => s.sourceDeviceId === next.sourceDevice.id);
    setSessions(sessionsRef.current);
    setReceiverOrigin(config.receiverOrigin);
    return next;
  }, []);
  const perform = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operations.current(action); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Display request failed.'); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    if (!displayShellAvailable()) return;
    setEnabled(true);
    // The source identifier comes only from this laptop's native inventory.
    void operations.current(refresh).catch(() => {});
    const present = (event: Event) => {
      const parsed = PresentationViewSchema.safeParse((event as CustomEvent).detail);
      if (!parsed.success || parsed.data.kind !== 'document') return;
      setView(parsed.data); setOpen(true); void perform(async () => { await refresh(); });
    };
    window.addEventListener('nexus:present-document', present);
    return () => window.removeEventListener('nexus:present-document', present);
  }, [perform, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false, running = false;
    const tick = async () => {
      if (running || !inventoryRef.current) return; running = true;
      await operations.current(async () => {
      if (disposed) return;
      try {
        const listed = await presentationRequest<{ sessions: PresentationSession[] }>(`${api}/sessions`);
        const own = listed.sessions.filter(s => s.sourceDeviceId === inventoryRef.current?.sourceDevice.id);
        const native = own.some(s => s.method === 'windows-monitor' && live(s)) ? await requestNativeDisplay({ action: 'status' }) : null;
        for (const session of own.filter(live)) {
          const active = session.method !== 'windows-monitor' || (native?.sessionId === session.id && native.state === 'active');
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
          <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-semibold">Displays on this laptop</h3><button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => { await refresh(); })}><RefreshCw size={14} className="mr-1 inline" /> Refresh</button></div>
            {inventory && <p className="text-xs text-slate-400">Source: {inventory.sourceDevice.name} · {inventory.sourceDevice.platform} · observed {new Date(inventory.observedAt).toLocaleTimeString()}. Refresh before starting.</p>}
            {inventory?.targets.map(target => <label key={target.id} className="block rounded-lg border border-slate-700 p-3"><input type="radio" name="presentation-target" value={target.id} checked={selection === target.id} disabled={target.availability !== 'available' || !target.capabilities.includes(view.kind)} onChange={() => setSelection(target.id)} /> <strong>{target.name}</strong> <span className="text-slate-400">· {target.method} · {target.availability}</span><span className="mt-1 block break-all pl-5 font-mono text-[11px] text-slate-500">{target.id}</span>{target.limitations.map((limit, i) => <span key={i} className="mt-1 block pl-5 text-xs text-amber-200">{limit}</span>)}</label>)}
            {!inventory?.targets.length && <p>No usable displays reported. Refresh in the Windows travel shell.</p>}
            {inventory?.limitations.map((limit, i) => <p key={i} className="text-xs text-slate-400">{limit}</p>)}
            <button type="button" className={`${buttonClass} border-cyan-600 bg-cyan-950`} disabled={busy || !selectedTarget || selectedTarget.availability !== 'available'} onClick={() => void perform(async () => {
              if (!selection) return;
              const fresh = await refresh();
              const target = fresh.targets.find(t => t.id === selection && t.availability === 'available');
              if (!target) throw new Error('That display is no longer available. Choose a current target.');
              for (const previous of sessionsRef.current.filter(s => s.method === 'windows-monitor' && live(s))) {
                await requestNativeDisplay({ action: 'stop' }); await presentationRequest(`${api}/sessions/${previous.id}`, { method: 'DELETE' });
              }
              const created = await presentationRequest<PresentationSession>(`${api}/sessions`, { method: 'POST', body: JSON.stringify({ sourceDeviceId: fresh.sourceDevice.id, targetId: selection, view }) });
              try {
                const opened = await requestNativeDisplay({ action: 'start', targetId: selection, sessionId: created.id, expiresAt: created.expiresAt });
                if (opened.state !== 'active' || opened.sessionId !== created.id) throw new Error('Windows did not confirm this presentation.');
                await presentationRequest(`${api}/sessions/${created.id}/heartbeat`, { method: 'POST', body: JSON.stringify({ state: 'active' }) });
              } catch (cause) { await requestNativeDisplay({ action: 'stop' }).catch(() => {}); await presentationRequest(`${api}/sessions/${created.id}`, { method: 'DELETE' }).catch(() => {}); throw cause; }
              await refresh(); setNotice('Windows confirmed the presentation window.');
            })}>Present on selected display</button>
            <p className="text-xs text-slate-400">Wireless display: press Win+K and choose a Miracast-compatible target in Windows. Use Extend mode, then refresh here. OS consent stays in Windows.</p>
          </section>
          <section className="space-y-3 border-t border-slate-800 pt-5"><h3 className="font-semibold">Pair a TV browser</h3>
            {receiverOrigin ? <><p>On the TV browser, open <span className="break-all font-mono text-cyan-200">{receiverOrigin}/presentation/index.html</span>. Get a code, then enter it here for only the selected view.</p><form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void perform(async () => {
              const fresh = await refresh();
              await presentationRequest(`${api}/pairings/${encodeURIComponent(code.trim())}/claim`, { method: 'POST', body: JSON.stringify({ sourceDevice: fresh.sourceDevice, view }) });
              setCode(''); await refresh(); setNotice('Pairing approved for this selected view. The TV will connect on its next poll.');
            }); }}><input aria-label="TV pairing code" value={code} maxLength={32} onChange={event => setCode(event.target.value.toUpperCase())} required className="min-w-0 rounded-lg border border-slate-600 bg-slate-900 p-2 font-mono" /><button className={buttonClass} disabled={busy || !code.trim()}>Pair selected view</button></form></> : <p className="text-slate-400">The isolated TV receiver address is not configured. A reachable receiver origin is required; the TV must never sign in to the full dashboard. Use an attached display meanwhile.</p>}
            <p className="text-xs text-slate-400">TV browsers are paired manually. Cast from WebView2 and AirPlay are not supported here; a TV name alone does not establish either protocol.</p>
          </section>
          <section className="space-y-3 border-t border-slate-800 pt-5"><h3 className="font-semibold">Presentation sessions</h3>{!sessions.length && <p className="text-slate-400">No sessions from this laptop.</p>}{sessions.map(session => <div key={session.id} className="rounded-lg border border-slate-700 p-3"><div className="flex items-center justify-between gap-3"><span>{session.view.kind} · {session.state}</span>{live(session) && <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
            // Revoke first: even if closing a native window fails, its data lease is ended.
            await presentationRequest(`${api}/sessions/${session.id}`, { method: 'DELETE' });
            if (session.method === 'windows-monitor') await requestNativeDisplay({ action: 'stop' });
            await refresh(); setNotice('Presentation stopped and receiver access revoked.');
          })}>Stop / revoke</button>}</div><p className="mt-2 break-all font-mono text-xs text-slate-400">{session.targetId}</p><p className="text-xs text-slate-400">Expires {new Date(session.expiresAt).toLocaleTimeString()}{session.reason ? ` · ${session.reason}` : ''}</p></div>)}</section>
        </div>
      </div>
    </div>, document.body)}
  </>;
}
