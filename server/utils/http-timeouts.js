const ONE_MINUTE_MS = 60 * 1000;

function configureLongRunningRequestTimeouts(server, options = {}) {
    const praxisChatTimeoutMs = Number.isFinite(options.praxisChatTimeoutMs)
        ? options.praxisChatTimeoutMs
        : 20 * ONE_MINUTE_MS;
    const requestTimeoutMs = Math.max(
        Number.parseInt(process.env.NEXUS_HTTP_REQUEST_TIMEOUT_MS || '', 10) || 0,
        praxisChatTimeoutMs + ONE_MINUTE_MS,
    );

    server.requestTimeout = requestTimeoutMs;
    server.headersTimeout = Math.max(server.headersTimeout || 0, 65 * 1000);

    return { requestTimeoutMs, headersTimeoutMs: server.headersTimeout };
}

module.exports = { configureLongRunningRequestTimeouts };
