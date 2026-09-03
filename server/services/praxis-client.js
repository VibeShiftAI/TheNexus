/**
 * Praxis client — the ONE place Nexus resolves Praxis's address and talks to
 * it over HTTP (ticket P1-14).
 *
 * Before this module, twelve route/service files each built their own
 * `${PRAXIS_URL}...` fetch with their own timeout wiring and their own
 * error handling. This client centralizes:
 *
 *   praxisUrl()                 — PRAXIS_URL env (read at CALL time, so tests
 *                                 and restarts can repoint it), then the
 *                                 constants default.
 *   praxisFetch(path, opts)     — fetch with ONE timeout implementation
 *                                 (AbortSignal.timeout) and ONE error shape
 *                                 (PraxisError). Returns the raw Response —
 *                                 non-2xx is NOT thrown, because most callers
 *                                 are proxies that forward upstream status
 *                                 and body verbatim.
 *   praxisJson(path, opts)      — praxisFetch + `ok` check + JSON parse, for
 *                                 callers that want a value or an error.
 *   praxisProxyJson(res, path)  — the "forward status + content-type + body,
 *                                 502 on transport failure" pattern that four
 *                                 routers used to copy-paste.
 *   praxisStream(path, opts, cb)— raw node `http.request` for the long-lived
 *                                 SSE upstream (no buffering, no timeout;
 *                                 streaming semantics are the caller's).
 *
 * Timeouts are NEVER unified here: every caller passes its own `timeoutMs`
 * (or none), exactly the value it used before the port. A missing timeoutMs
 * means "no client-side clock", which is what those call sites had.
 *
 * `fetch` and `AbortSignal` are resolved from the global scope at call time
 * (not captured at require time) so the existing jest suites that stub
 * `global.fetch` / `global.AbortSignal.timeout` keep working unchanged.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const constants = require('../shared/constants');

/** Praxis base URL: PRAXIS_URL env first (live), then the constants default. */
function praxisUrl() {
    const fromEnv = process.env.PRAXIS_URL;
    return (typeof fromEnv === 'string' && fromEnv.trim()) ? fromEnv.trim() : constants.PRAXIS_URL;
}

/**
 * Transport-level failure talking to Praxis (unreachable, reset, timed out).
 * The `message` is the underlying error's message, unchanged — existing
 * log lines, 502 bodies and tests read `err.message` and must see the same
 * text they saw before the port. Structure rides alongside:
 *
 *   err.code     'PRAXIS_TIMEOUT' | 'PRAXIS_UNREACHABLE'
 *   err.path     upstream path (e.g. '/api/chat')
 *   err.method   HTTP method
 *   err.status   null (transport failures never have one)
 *   err.cause    the original error
 */
class PraxisError extends Error {
    constructor(message, { code = 'PRAXIS_UNREACHABLE', path = null, method = 'GET', status = null, cause } = {}) {
        super(message);
        this.name = 'PraxisError';
        this.code = code;
        this.path = path;
        this.method = method;
        this.status = status;
        if (cause !== undefined) this.cause = cause;
    }
}

function isTimeoutError(err) {
    return err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'UND_ERR_HEADERS_TIMEOUT' || err?.code === 'UND_ERR_BODY_TIMEOUT';
}

function wrapTransportError(err, { path, method }) {
    if (err instanceof PraxisError) return err;
    const message = (err && err.message) || 'Praxis unreachable';
    return new PraxisError(message, {
        code: isTimeoutError(err) ? 'PRAXIS_TIMEOUT' : 'PRAXIS_UNREACHABLE',
        path,
        method,
        cause: err,
    });
}

/**
 * fetch() against Praxis.
 *
 * @param {string} path            Upstream path, leading slash, may carry a query.
 * @param {object} [opts]
 * @param {string} [opts.method]   Default 'GET'.
 * @param {*}      [opts.body]     Objects/arrays are JSON-encoded (and get a
 *                                 JSON Content-Type unless one is set);
 *                                 strings/Buffers are sent as-is.
 * @param {number} [opts.timeoutMs] Per-call budget → AbortSignal.timeout.
 *                                 Omit for no client-side clock.
 * @param {object} [opts.headers]
 * @param {AbortSignal} [opts.signal] Caller-owned signal (used instead of
 *                                 timeoutMs when given).
 * @param {string}   [opts.baseUrl]   Override the Praxis base (test injection).
 * @param {Function} [opts.fetchImpl] Override fetch (test injection).
 * Any other option (e.g. undici `dispatcher`, `redirect`) is passed through
 * to fetch untouched.
 * @returns {Promise<Response>}    Raw Response — status is NOT checked.
 * @throws {PraxisError}           On transport failure / timeout only.
 */
async function praxisFetch(path, opts = {}) {
    const { method = 'GET', body, timeoutMs, headers, signal, baseUrl, fetchImpl, ...rest } = opts;
    const url = `${baseUrl || praxisUrl()}${path}`;
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    const init = { method, ...rest };

    const finalHeaders = { ...(headers || {}) };
    if (body !== undefined && body !== null) {
        const isRaw = typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array;
        if (isRaw) {
            init.body = body;
        } else {
            init.body = JSON.stringify(body);
            if (!hasHeader(finalHeaders, 'content-type')) finalHeaders['Content-Type'] = 'application/json';
        }
    }
    if (Object.keys(finalHeaders).length > 0) init.headers = finalHeaders;

    if (signal) {
        init.signal = signal;
    } else if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        init.signal = AbortSignal.timeout(timeoutMs);
    }

    try {
        return await doFetch(url, init);
    } catch (err) {
        throw wrapTransportError(err, { path, method });
    }
}

function hasHeader(headers, name) {
    const wanted = name.toLowerCase();
    return Object.keys(headers).some((k) => k.toLowerCase() === wanted);
}

/**
 * praxisFetch + ok-check + JSON body. Non-2xx throws a PraxisError carrying
 * `status` and (up to 300 chars of) the upstream body in the message.
 */
async function praxisJson(path, opts = {}) {
    const method = opts.method || 'GET';
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const response = await praxisFetch(path, { ...opts, headers });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new PraxisError(`Praxis ${method} ${path} returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`, {
            code: 'PRAXIS_HTTP_ERROR',
            path,
            method,
            status: response.status,
        });
    }
    return response.json();
}

/**
 * Express proxy helper: relay an upstream Praxis JSON response — status,
 * content-type and body verbatim — and answer 502 `{ error }` when Praxis
 * cannot be reached. `opts` are praxisFetch options; `Accept: application/json`
 * is added unless the caller sets one.
 */
async function praxisProxyJson(res, path, opts = {}) {
    try {
        const headers = { Accept: 'application/json', ...(opts.headers || {}) };
        const response = await praxisFetch(path, { ...opts, headers });
        const text = await response.text();
        res.status(response.status);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        res.send(text);
    } catch (err) {
        res.status(502).json({ error: err.message || 'Praxis unreachable' });
    }
}

/**
 * Raw streaming request to Praxis via node `http.request` — for the SSE
 * upstream in praxis-stream.js, where the response is consumed chunk by
 * chunk for as long as Praxis keeps it open. Nothing is buffered and no
 * timeout is applied; the caller owns the response stream and the request's
 * 'error' event exactly as it did with a hand-built http.request.
 *
 * The request is ended (sent) before returning, so the caller only needs to
 * attach listeners.
 *
 * @param {string} path
 * @param {{ method?: string, headers?: object }} [opts]
 * @param {(res: import('http').IncomingMessage) => void} onResponse
 * @returns {import('http').ClientRequest}
 */
function praxisStream(path, opts = {}, onResponse) {
    if (typeof opts === 'function') {
        onResponse = opts;
        opts = {};
    }
    const url = new URL(path, praxisUrl());
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
    }, onResponse);
    req.end();
    return req;
}

module.exports = {
    praxisUrl,
    praxisFetch,
    praxisJson,
    praxisProxyJson,
    praxisStream,
    PraxisError,
};
