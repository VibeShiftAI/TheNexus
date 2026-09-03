/**
 * Slim fleet health relay.
 *
 * - GET /api/fleet/health → liveness + latency for the Mac-local services
 *
 * The full fleet router (10-minute stats sampler + /stats-history for the
 * dashboard's fleet station) was decommissioned 2026-07-09 along with the
 * station itself. This probe-only relay was restored 2026-07-14 because the
 * iPad Home Hub still depends on it: Cortex (:8100) is bound to the Mac's
 * loopback, so the hub reads its status from this endpoint's `cortex` entry
 * instead of probing it directly (PraxisHub/FleetDashboardManager.swift,
 * fleetRelayID). DO NOT remove without repointing that consumer.
 */
const express = require('express');
const { praxisFetch } = require('../services/praxis-client');

const PROBE_TIMEOUT_MS = 2500;

const SERVICES = [
    // Praxis is probed through the shared client (URL resolved per call).
    { id: 'praxis', label: 'Praxis', port: 54322, praxisPath: '/ping' },
    { id: 'nexus-node', label: 'Nexus node', port: 4000, url: 'http://127.0.0.1:4000/api/health' },
    { id: 'dashboard', label: 'Dashboard', port: 3000, url: 'http://127.0.0.1:3000' },
    { id: 'cortex', label: 'Cortex', port: 8100, url: 'http://127.0.0.1:8100/health' },
];

async function probe(service) {
    const started = Date.now();
    try {
        const res = service.praxisPath
            ? await praxisFetch(service.praxisPath, { timeoutMs: PROBE_TIMEOUT_MS })
            : await fetch(service.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { id: service.id, label: service.label, port: service.port, ok: res.ok, status: res.status, latencyMs: Date.now() - started };
    } catch (err) {
        // PraxisError wraps fetch's TypeError, whose own `cause` is the syscall
        // error — look one level deeper so `error` stays e.g. 'ECONNREFUSED'.
        const code = err?.cause?.cause?.code || err?.cause?.code;
        return { id: service.id, label: service.label, port: service.port, ok: false, status: null, latencyMs: null, error: code || err.message };
    }
}

function createFleetRouter() {
    const router = express.Router();

    router.get('/health', async (_req, res) => {
        const services = await Promise.all(SERVICES.map(probe));
        res.json({ at: new Date().toISOString(), services });
    });

    return router;
}

module.exports = createFleetRouter;
