/**
 * Travel-shell tab roster — /api/tabs
 *
 * The Windows travel shell pulls its tab list from here at launch (with the
 * Access service token, like the updater), so adding/removing/reordering
 * project tabs is a settings edit — no rebuild, no reinstall. The shell
 * keeps a baked-in copy of DEFAULT_TABS as its offline fallback; keep the
 * two rosters loosely in sync when defaults change
 * (desktop/src-tauri/src/main.rs `default_tabs`).
 *
 * Storage is a plain JSON file (data/travel-tabs.json) so it survives
 * restarts, diffs cleanly, and can be hand-edited in a pinch. Entries keep
 * an `enabled` flag rather than being deleted so tabs can be toggled back
 * on from the dashboard settings.
 *
 *   GET /api/tabs        → { tabs: [...] } enabled entries only (the shell)
 *   GET /api/tabs?all=1  → { tabs: [...] } every entry (the settings editor)
 *   PUT /api/tabs        → replace the roster (validated)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const STORE = path.resolve(__dirname, '..', '..', 'data', 'travel-tabs.json');

// `hosted: true` marks a page that renders the tab strip inside its own
// header (the bridge dashboard) — the shell hides the native strip there.
const DEFAULT_TABS = [
    { id: 'bridge', label: 'BRIDGE', url: 'https://nexus.vibeshiftai.com', accent: '#22d3ee', hosted: true, enabled: true },
    { id: 'studio', label: 'GAYGUIDE YOUTUBE', url: 'https://gayguyde.vibeshiftai.com/admin/studio', accent: '#f472b6', enabled: true },
    { id: 'families', label: 'FAMILIES', url: 'https://families.vibeshiftai.com', accent: '#fbbf24', enabled: true },
    { id: 'choresmaxxer', label: 'CHORESMAXXER', url: 'https://choresmaxxer.web.app', accent: '#4ade80', enabled: true },
    { id: 'homefinder', label: 'HOMEFINDER', url: 'https://lab.vibeshiftai.com/p/nyc-home-finder', accent: '#f87171', enabled: true },
    { id: 'lars', label: 'LARS', url: 'https://lars.vibeshiftai.com', accent: '#facc15', enabled: true },
    { id: 'worlds', label: 'WORLDS', url: 'https://lab.vibeshiftai.com/p/impossible-worlds-field-guide', accent: '#a78bfa', enabled: true },
    { id: 'lab', label: 'THE LAB', url: 'https://lab.vibeshiftai.com', accent: '#e2e8f0', enabled: true },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

function validateTab(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const { id, label, url, accent } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    if (typeof label !== 'string' || !label.trim() || label.length > 28) return null;
    if (typeof accent !== 'string' || !ACCENT_RE.test(accent)) return null;
    try {
        if (new URL(url).protocol !== 'https:') return null;
    } catch {
        return null;
    }
    return {
        id,
        label: label.trim(),
        url,
        accent,
        hosted: raw.hosted === true,
        enabled: raw.enabled !== false,
    };
}

function readStore() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE, 'utf8'));
        const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : []).map(validateTab).filter(Boolean);
        if (tabs.length) return tabs;
    } catch { /* no file yet, or unreadable — defaults below */ }
    return DEFAULT_TABS;
}

function createTabsRouter() {
    const router = express.Router();

    router.get('/', (req, res) => {
        const tabs = readStore();
        res.json({ tabs: req.query.all ? tabs : tabs.filter((t) => t.enabled) });
    });

    router.put('/', (req, res) => {
        const raw = req.body && req.body.tabs;
        if (!Array.isArray(raw) || raw.length === 0) {
            return res.status(400).json({ error: 'tabs must be a non-empty array' });
        }
        const tabs = raw.map(validateTab);
        const bad = tabs.findIndex((t) => t === null);
        if (bad !== -1) {
            return res.status(400).json({ error: `invalid tab at index ${bad}` });
        }
        const ids = new Set(tabs.map((t) => t.id));
        if (ids.size !== tabs.length) {
            return res.status(400).json({ error: 'duplicate tab ids' });
        }
        if (!tabs.some((t) => t.enabled)) {
            return res.status(400).json({ error: 'at least one tab must be enabled' });
        }
        fs.mkdirSync(path.dirname(STORE), { recursive: true });
        fs.writeFileSync(STORE, JSON.stringify({ tabs }, null, 2) + '\n');
        console.log(`[tabs] roster saved: ${tabs.filter((t) => t.enabled).map((t) => t.id).join(', ')}`);
        res.json({ tabs });
    });

    return router;
}

module.exports = createTabsRouter;
