// Nexus advertises an IP allowance on its own 429s. Upstream refusals from
// individual API routes can carry a narrower Retry-After. Keep health separate.
export function withNexusReadBackoff(transport: typeof fetch, origin: string): typeof fetch {
    const deadlines = new Map<string, number>();
    return async (input, init) => {
        const request = input instanceof Request ? input : undefined;
        const url = new URL(request?.url ?? String(input), origin);
        if (url.origin !== origin || !url.pathname.startsWith('/api/')) return transport(input, init);
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        const lane = method === 'GET' && url.pathname === '/api/health' ? 'health' : 'general';
        const now = Date.now();
        for (const [key, deadline] of deadlines) if (deadline <= now) deadlines.delete(key);
        const until = Math.max(deadlines.get(lane) ?? 0, deadlines.get(url.pathname) ?? 0);
        if (method === 'GET' && until > now) {
            (init?.signal ?? request?.signal)?.throwIfAborted();
            return Response.json({ error: 'Too many requests, please try again later.' }, {
                status: 429, headers: { 'Retry-After': String(Math.ceil((until - now) / 1000)) },
            });
        }
        const res = await transport(input, init);
        if (res.status === 429) {
            const raw = res.headers?.get('Retry-After')?.trim();
            if (raw) {
                const deadline = /^\d+$/.test(raw) ? Date.now() + Number(raw) * 1000 : Date.parse(raw);
                if (Number.isFinite(deadline) && deadline > Date.now()) {
                    const key = res.headers.get('X-Nexus-Allowance') === lane ? lane : url.pathname;
                    deadlines.set(key, Math.max(deadlines.get(key) ?? 0, deadline));
                }
            }
        }
        return res;
    };
}
