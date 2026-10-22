import type { PresentationSnapshot } from '@praxis/contract';

/** All authority stays in a header or the existing controller cookie; never a URL or localStorage. */
export async function presentationRequest<T>(url: string, init: RequestInit = {}, token?: string): Promise<T> {
  const abort = new AbortController();
  const parent = init.signal;
  const onAbort = () => abort.abort();
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const response = await fetch(url, {
      ...init, signal: abort.signal, credentials: token ? 'omit' : init.credentials ?? 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const denied = response.status === 401 || response.status === 403;
      // The service's error code rides on the thrown Error so a relay can report it verbatim; the message stays for people.
      throw Object.assign(
        new Error(denied ? (token ? 'Presentation access ended. Pair this display again from the controller.' : 'The session is no longer authorized. Sign in on the controller and start again.') : body?.error || 'Presentation ended or is unavailable.'),
        { code: typeof body?.code === 'string' && body.code ? body.code : denied ? 'operator_required' : `http_${response.status}` },
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The presentation service did not return data. Check the controller sign-in and receiver address.');
    return await response.json() as T;
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); }
}

export function presentationTransport(sessionId?: string, token?: string) {
  const prefix = token ? '/receiver' : `/api/presentations/sessions/${encodeURIComponent(sessionId || '')}`;
  return {
    load: (signal: AbortSignal) => presentationRequest<PresentationSnapshot>(`${prefix}/view`, { signal }, token),
    async loadAsset(url: string, signal: AbortSignal) {
      // The server may only select the primary asset endpoint for this session.
      if (url !== `${prefix}/asset`) throw new Error('The selected media path does not belong to this presentation.');
      const abort = new AbortController();
      const stop = () => abort.abort(); signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) abort.abort();
      const timer = setTimeout(stop, 30000);
      try {
        const response = await fetch(url, { signal: abort.signal, cache: 'no-store', redirect: 'error', credentials: token ? 'omit' : 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!response.ok || !response.body) throw new Error('The exact media bytes are unavailable or the presentation ended.');
        const limit = 128 * 1024 * 1024;
        if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('This media exceeds the 128 MiB presentation limit. Choose a smaller registered revision.');
        const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw new Error('This media exceeds the 128 MiB presentation limit.'); }
          chunks.push(value as Uint8Array<ArrayBuffer>);
        }
        return URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' }));
      } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); abort.abort(); }
    },
  };
}
