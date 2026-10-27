/** Silent local bootstrap. Decisions still use the ordinary same-origin /api proxy. */
type ClientOptions = {
    origin?: () => string | undefined;
    request?: typeof fetch;
    nativeRenew?: () => Promise<boolean>;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    now?: () => number;
};
export const LOCAL_OPERATOR_PROOF_KEY = 'nexus:local-operator-proof';
const validProof = (proof: unknown): proof is string => typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof);

/** Never send the origin-bound proof to another host, port, or non-API URL. */
export function localOperatorHeaders(url: string): Record<string, string> {
    try {
        if (typeof window === 'undefined' || window.location.origin !== 'http://localhost:3000') return {};
        const target = new URL(url, window.location.href);
        if (target.origin !== window.location.origin || !/^\/api(?:\/|$)/.test(target.pathname)) return {};
        const proof = window.localStorage.getItem(LOCAL_OPERATOR_PROOF_KEY);
        return validProof(proof) ? { 'X-Nexus-Local-Proof': proof } : {};
    } catch { return {}; }
}

function renewNative(): Promise<boolean> {
    return new Promise(resolve => {
        const finish = (ok: boolean) => {
            clearTimeout(timer);
            window.removeEventListener("nexus:local-operator-ready", listener);
            resolve(ok);
        };
        const listener = (event: Event) => finish((event as CustomEvent).detail === true);
        const timer = setTimeout(() => finish(false), 15000);
        window.addEventListener("nexus:local-operator-ready", listener);
        // The shell handles only this fixed signal from its local main view.
        // No secret, URL or request body crosses the native boundary.
        window.location.assign("nexus-shell://local-operator");
    });
}

export function createLocalOperatorSessionClient({
    origin = () => typeof window === "undefined" ? undefined : window.location.origin,
    request = (...args) => fetch(...args), nativeRenew, storage, now = Date.now,
}: ClientOptions = {}) {
    let pending: Promise<boolean> | null = null;
    const currentStorage = () => storage ?? window.localStorage;
    async function establish() {
        try {
            const headers = () => {
                const proof = currentStorage().getItem(LOCAL_OPERATOR_PROOF_KEY);
                return validProof(proof) ? { 'X-Nexus-Local-Proof': proof } : undefined;
            };
            const status = () => request("/api/operator-session", {
                credentials: "same-origin", cache: "no-store", redirect: "error", headers: headers(), signal: AbortSignal.timeout(15000),
            });
            const response = await status();
            if (!response.ok) return false;
            const session = await response.json();
            // Renew before the 45-minute background check can miss a 1h expiry.
            if (session.operator === true && session.expiresAt > now() + 20 * 60 * 1000) return true;
            if (!session.operator) currentStorage().removeItem(LOCAL_OPERATOR_PROOF_KEY);
            const native = nativeRenew ?? (typeof window !== "undefined" &&
                (window as Window & { __NEXUS_LOCAL_OPERATOR__?: boolean }).__NEXUS_LOCAL_OPERATOR__ ? renewNative : undefined);
            if (native) {
                if (!await native()) return false;
                const check = await status();
                return check.ok && (await check.json()).operator === true;
            }
            // A direct socket is essential here: the Next proxy is a Node
            // process and cannot attest the browser which connected to it.
            if (typeof session.bootstrapUrl !== "string" ||
                !/^http:\/\/localhost:[1-9]\d{0,4}\/api\/operator-session\/bootstrap$/.test(session.bootstrapUrl)) return false;
            const bootstrap = await request(session.bootstrapUrl, {
                method: "POST", credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
            });
            if (!bootstrap.ok) return false;
            const issued = await bootstrap.json();
            if (!validProof(issued.proof)) return false;
            currentStorage().setItem(LOCAL_OPERATOR_PROOF_KEY, issued.proof);
            // Cookie and origin storage must describe the same session, even
            // if another tab renewed while this request was in flight.
            const check = await status();
            return check.ok && (await check.json()).operator === true;
        } catch { return false; }
    }
    return function ensure(): Promise<boolean> {
        if (origin() !== "http://localhost:3000") return Promise.resolve(false);
        if (!pending) {
            // Web Locks serializes bootstrap across the browser's local tabs.
            const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
            pending = (async () => await (locks ? locks.request('nexus-local-operator-session', establish) : establish()))()
                .finally(() => { pending = null; });
        }
        return pending;
    };
}

export const ensureLocalOperatorSession = createLocalOperatorSessionClient();

/** Operator UI requests use Access cookies or the verified local session,
 * never the legacy machine bearer used by the general Nexus API client. */
export async function operatorFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const current = typeof window === 'undefined' ? undefined : window.location;
    const target = current ? new URL(url, current.href) : undefined;
    if (!current || target?.origin !== current.origin || !/^\/api(?:\/|$)/.test(target.pathname)) {
        throw new Error('Operator requests require a same-origin API destination.');
    }
    if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())) {
        await ensureLocalOperatorSession();
    }
    const headers = new Headers(options.headers);
    headers.delete('Authorization');
    headers.delete('X-Nexus-Local-Proof');
    for (const [key, value] of Object.entries(localOperatorHeaders(url))) headers.set(key, value);
    return fetch(url, { ...options, headers, credentials: 'include', cache: 'no-store', redirect: 'error' });
}
