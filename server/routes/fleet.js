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
const { PRAXIS_URL } = require('../shared/constants');

const PROBE_TIMEOUT_MS = 2500;

const SERVICES = [
    { id: 'praxis', label: 'Praxis', port: 54322, url: `${PRAXIS_URL}/ping` },
    { id: 'nexus-node', label: 'Nexus node', port: 4000, url: 'http://127.0.0.1:4000/api/health' },
    { id: 'dashboard', label: 'Dashboard', port: 3000, url: 'http://127.0.0.1:3000' },
    { id: 'cortex', label: 'Cortex', port: 8100, url: 'http://127.0.0.1:8100/health' },
];

async function probe(service) {
    const started = Date.now();
    try {
        const res = await fetch(service.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { id: service.id, label: service.label, port: service.port, ok: res.ok, status: res.status, latencyMs: Date.now() - started };
    } catch (err) {
        return { id: service.id, label: service.label, port: service.port, ok: false, status: null, latencyMs: null, error: err?.cause?.code || err.message };
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
