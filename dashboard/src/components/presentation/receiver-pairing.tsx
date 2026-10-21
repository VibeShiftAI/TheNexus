import { useEffect, useMemo, useState } from 'react';
import { PresentationScreen } from './presentation-screen';
import { presentationRequest, presentationTransport } from '@/lib/presentation-transport';
import { startCastReceiver, type CastFramework } from '@/lib/presentation-cast';

function PairedView({ token }: { token: string }) {
  const transport = useMemo(() => presentationTransport(undefined, token), [token]);
  return <PresentationScreen {...transport} />;
}

export function ReceiverPairing({ cast = false }: { cast?: boolean }) {
  const [name, setName] = useState('TV browser');
  const [pair, setPair] = useState<{ code: string; pollToken: string; expiresAt: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (!cast) return;
    const abort = new AbortController();
    let stop: (() => void) | undefined;
    try {
      stop = startCastReceiver((window as Window & { cast?: { framework: CastFramework } }).cast?.framework, () => {
        abort.abort(); setToken(null); setPair(null); setEnded(true);
      });
      setBusy(true);
      void presentationRequest<{ code: string; pollToken: string; expiresAt: string }>('/receiver/pairings', {
        method: 'POST', credentials: 'omit', signal: abort.signal, body: JSON.stringify({ name: 'Cast display' }),
      }).then(value => { if (!abort.signal.aborted) setPair(value); }).catch(() => {
        if (!abort.signal.aborted) setError('The isolated receiver is unavailable. Stop casting and check its configured address.');
      }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cast receiver unavailable.'); }
    return () => { abort.abort(); stop?.(); };
  }, [cast]);
  useEffect(() => {
    if (!pair) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (Date.parse(pair.expiresAt) <= Date.now()) throw new Error('Pairing code expired. Request a new code.');
        const result = await presentationRequest<{ state: string; token?: string }>(`/receiver/pairings/${encodeURIComponent(pair.code)}`, { signal: abort.signal }, pair.pollToken);
        if (abort.signal.aborted) return;
        if (result.state === 'paired' && result.token) { setToken(result.token); setPair(null); return; }
        if (result.state !== 'pending') throw new Error('Pairing ended. Request a new code.');
        timer = setTimeout(poll, 1500);
      } catch (cause) { if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Pairing unavailable'); setPair(null); } }
    };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [pair]);
  if (ended) return <main className="presentation-ended"><h1>Presentation ended</h1><p>Start a new session from your controller.</p></main>;
  if (token) return <PairedView token={token} />;
  return <main className="presentation-ended"><p className="presentation-brand">THE NEXUS</p><h1>Pair this display</h1>
    <p>Show one view from your signed-in Nexus app. No TV account or full sign-in is needed.</p>
    {pair ? <><p>On your Windows or Android controller, choose a view and enter:</p><strong className="presentation-code">{pair.code}</strong><p>Code ends at {new Date(pair.expiresAt).toLocaleTimeString()}.</p></> : cast ? <p>{busy ? 'Requesting a temporary pairing code…' : 'Stop casting, then reopen this receiver to pair again.'}</p> :
      <form onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try { setPair(await presentationRequest('/receiver/pairings', { method: 'POST', credentials: 'omit', body: JSON.stringify({ name }) })); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Pairing unavailable'); }
        finally { setBusy(false); }
      }}><label>Display name <input value={name} maxLength={160} onChange={event => setName(event.target.value)} required /></label><button disabled={busy}>{busy ? 'Requesting…' : 'Get pairing code'}</button></form>}
    {error && <p role="alert">{error}</p>}
    <p className="presentation-muted">Keep this page open. Closing or reloading it requires a new pairing. Stop or revoke from the controller.</p>
  </main>;
}
