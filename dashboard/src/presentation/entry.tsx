import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import { PresentationScreen } from '../components/presentation/presentation-screen';
import { presentationRequest, presentationTransport } from '../lib/presentation-transport';

function PairedView({ token }: { token: string }) {
  const transport = useMemo(() => presentationTransport(undefined, token), [token]);
  return <PresentationScreen {...transport} />;
}

function ReceiverPairing() {
  const [name, setName] = useState('TV browser');
  const [pair, setPair] = useState<{ code: string; pollToken: string; expiresAt: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  if (token) return <PairedView token={token} />;
  return <main className="presentation-ended"><p className="presentation-brand">THE NEXUS</p><h1>Pair this display</h1>
    <p>Show one view from your signed-in Nexus app. No TV account or full sign-in is needed.</p>
    {pair ? <><p>On your Windows or Android controller, choose a view and enter:</p><strong className="presentation-code">{pair.code}</strong><p>Code ends at {new Date(pair.expiresAt).toLocaleTimeString()}.</p></> :
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

const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('mode') === 'controller' ? params.get('session') : null;
const root = createRoot(document.getElementById('presentation')!);
if (sessionId && /^[A-Za-z0-9_.:-]{1,240}$/.test(sessionId)) {
  root.render(<PresentationScreen {...presentationTransport(sessionId)} />);
} else {
  root.render(<ReceiverPairing />);
}
