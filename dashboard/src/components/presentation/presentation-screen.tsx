"use client";

import { useEffect, useState } from 'react';
import type { PresentationSnapshot } from '@praxis/contract';
import { PresentationView } from './presentation-view';

export function PresentationScreen({ load, loadAsset, pollMs = 3000 }: {
  load: (signal: AbortSignal) => Promise<PresentationSnapshot>;
  loadAsset: (url: string, signal: AbortSignal) => Promise<string>;
  pollMs?: number;
}) {
  const [snapshot, setSnapshot] = useState<PresentationSnapshot | null>(null);
  const [assetSrc, setAssetSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false, refreshing = false, ended = false, currentAsset: string | null = null, assetKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const release = () => { if (currentAsset) URL.revokeObjectURL(currentAsset); currentAsset = null; assetKey = null; };
    const blank = (message: string) => { ended = true; release(); clearTimeout(timer); if (!disposed) { setSnapshot(null); setAssetSrc(null); setError(message); } };
    const refresh = async () => {
      if (refreshing || disposed || ended) return;
      refreshing = true;
      try {
        const next = await load(abort.signal);
        if (disposed || ended) return;
        const remaining = Date.parse(next.session.expiresAt) - Date.now();
        if (remaining <= 0 || !['starting', 'active'].includes(next.session.state)) throw new Error('Presentation ended. Start a new one from the controller.');
        clearTimeout(expiry);
        expiry = setTimeout(() => { blank('Presentation expired. Start a new one from the controller.'); abort.abort(); }, remaining);
        const doc = next.content.kind === 'document' ? next.content : null;
        const key = doc?.assetUrl ? `${doc.revisionId}:${doc.contentHash}` : null;
        if (key !== assetKey) {
          release(); setAssetSrc(null);
          if (doc?.assetUrl) {
            const src = await loadAsset(doc.assetUrl, abort.signal);
            if (disposed || abort.signal.aborted) { URL.revokeObjectURL(src); return; }
            currentAsset = src; assetKey = key; setAssetSrc(src);
          }
        }
        setSnapshot(next); setError(null);
        timer = setTimeout(refresh, pollMs);
      } catch (cause) {
        if (disposed || ended) return;
        // No stale presentation stays visible after an auth, network, stop or expiry failure.
        blank(cause instanceof Error ? cause.message : 'Presentation unavailable.');
      } finally { refreshing = false; }
    };
    void refresh();
    const hide = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void refresh(); } };
    document.addEventListener('visibilitychange', hide);
    return () => { disposed = true; abort.abort(); clearTimeout(timer); clearTimeout(expiry); release(); document.removeEventListener('visibilitychange', hide); };
  }, [load, loadAsset, pollMs]);
  if (!snapshot) return <main className="presentation-ended"><p className="presentation-brand">THE NEXUS</p><h1>{error ? 'Presentation unavailable' : 'Connecting to your controller'}</h1><p role={error ? 'alert' : 'status'}>{error || 'Waiting for the selected view…'}</p></main>;
  return <PresentationView snapshot={snapshot} assetSrc={assetSrc} />;
}
