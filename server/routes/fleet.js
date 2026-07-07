/**
 * Fleet & bridge feeds for the dashboard command deck.
 *
 * - GET /api/fleet/health         → liveness + latency for every crew-member service
 * - GET /api/fleet/stats-history  → sampled Praxis knowledge/quota counters over time
 *
 * A 10-minute sampler polls Praxis `/api/praxis/stats` (plus `/api/skills`)
 * and records a row in praxis_stats_history so the Science station can chart
 * knowledge-base growth. Praxis stays the source of truth — this is just a
 * viewport-side recorder.
 */
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { PRAXIS_URL } = require('../shared/constants');

// The injected `db` dependency is the function facade from db/index.js (no
// raw prepare/exec), so the sampler opens its own WAL-mode connection to the
// same SQLite file for its one private table.
const DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../../nexus.db');

const SAMPLE_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_DAYS = 90;
const PROBE_TIMEOUT_MS = 2500;

const SERVICES = [
    { id: 'praxis', label: 'Praxis', port: 54322, url: `${PRAXIS_URL}/ping` },
    { id: 'nexus-node', label: 'Nexus node', port: 4000, url: 'http://127.0.0.1:4000/api/health' },
    { id: 'dashboard', label: 'Dashboard', port: 3000, url: 'http://127.0.0.1:3000' },
    { id: 'cortex', label: 'Cortex', port: 8100, url: 'http://127.0.0.1:8100/health' },
    { id: 'lars', label: 'LARS', port: 7878, url: 'http://192.168.86.205:7878' },
];

async function probe(service) {
    const started = Date.now();
    try {
        const res = await fetch(service.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { ...serviceSummary(service), ok: res.ok, status: res.status, latencyMs: Date.now() - started };
    } catch (err) {
        return { ...serviceSummary(service), ok: false, status: null, latencyMs: null, error: err?.cause?.code || err.message };
    }
}

function serviceSummary(service) {
    return { id: service.id, label: service.label, port: service.port };
}

function createFleetRouter() {
    const router = express.Router();

    let db;
    try {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
    } catch (err) {
        console.warn(`[Fleet] history DB unavailable (${err.message}) — health probes still served`);
        router.get('/health', async (_req, res) => {
            const services = await Promise.all(SERVICES.map(probe));
            res.json({ at: new Date().toISOString(), services });
        });
        router.get('/stats-history', (_req, res) => res.json({ since: null, rows: [] }));
        return router;
    }

    db.exec(`CREATE TABLE IF NOT EXISTS praxis_stats_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        neo4j_nodes INTEGER,
        pinecone_vectors INTEGER,
        mcp_tool_count INTEGER,
        daily_call_count INTEGER,
        skills_total INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_praxis_stats_history_at ON praxis_stats_history(at)');

    const insertSample = db.prepare(`INSERT INTO praxis_stats_history
        (at, neo4j_nodes, pinecone_vectors, mcp_tool_count, daily_call_count, skills_total)
        VALUES (?, ?, ?, ?, ?, ?)`);
    const pruneSamples = db.prepare('DELETE FROM praxis_stats_history WHERE at < ?');

    async function sampleOnce() {
        try {
            const res = await fetch(`${PRAXIS_URL}/api/praxis/stats`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return;
            const stats = await res.json();
            let skillsTotal = null;
            try {
                const skillsRes = await fetch(`${PRAXIS_URL}/api/skills`, { signal: AbortSignal.timeout(5000) });
                if (skillsRes.ok) skillsTotal = (await skillsRes.json()).total ?? null;
            } catch { /* skills endpoint optional */ }
            insertSample.run(
                new Date().toISOString(),
                stats.neo4jNodes ?? null,
                stats.pineconeVectors ?? null,
                stats.mcpToolCount ?? null,
                stats.dailyCallCount ?? null,
                skillsTotal,
            );
            pruneSamples.run(new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString());
        } catch (err) {
            console.warn(`[Fleet] stats sample failed: ${err.message}`);
        }
    }

    const timer = setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
    if (timer.unref) timer.unref();
    // Prime one sample shortly after boot so charts have a point immediately.
    const kickoff = setTimeout(sampleOnce, 10_000);
    if (kickoff.unref) kickoff.unref();

    router.get('/health', async (_req, res) => {
        const services = await Promise.all(SERVICES.map(probe));
        res.json({ at: new Date().toISOString(), services });
    });

    router.get('/stats-history', (req, res) => {
        const hours = Math.min(Number.parseInt(req.query.hours, 10) || 24 * 7, 24 * RETENTION_DAYS);
        const since = new Date(Date.now() - hours * 3600_000).toISOString();
        const rows = db.prepare('SELECT * FROM praxis_stats_history WHERE at >= ? ORDER BY at ASC').all(since);
        res.json({ since, rows });
    });

    return router;
}

module.exports = createFleetRouter;
