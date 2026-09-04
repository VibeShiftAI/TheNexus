const express = require('express');
const fs = require('fs');
const path = require('path');
const { vaultRoot } = require('../lib/vault-paths');

/**
 * Skill Wiki — read-only viewport onto the shared-mind skill library
 * (pattern: SkillWiki, arXiv 2606.16523 — provenance-aware exploration).
 *
 * Renders what the vault already holds: skill manifests under `skills/`,
 * usage/outcome telemetry from `skills/_index.json`, knowledge pages from
 * `skills/_knowledge/`, and related skills from the LINKS.md backlink graph.
 * Every endpoint is a GET; nothing here writes to the vault or to Praxis.
 * Skills missing telemetry, evidence, or knowledge come back with those
 * fields null/empty — absence renders as absence, never as invented data.
 */

// NEXUS_VAULT_PATH is this route's historical override and still wins;
// otherwise the fleet-wide root from server/lib/vault-paths.js.
const DEFAULT_VAULT_PATH = process.env.NEXUS_VAULT_PATH || vaultRoot();

/** Skill names are kebab/word tokens; anything else (slashes, dots) is refused. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const WIKI_LINK_RE = /\[\[([^\[\]]+)\]\]/g;

function readTextIfExists(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function stripQuotes(value) {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}

/**
 * Minimal YAML-subset frontmatter parser — scalars, inline arrays
 * (`tags: [a, b]`), and block lists (`evidence:` + `  - "..."` lines).
 * Skill manifests use nothing deeper; unknown shapes are skipped, not errors.
 */
function parseFrontmatter(raw) {
    if (!raw.startsWith('---')) return { data: {}, body: raw };
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return { data: {}, body: raw };

    const header = raw.slice(raw.indexOf('\n') + 1, end);
    const body = raw.slice(end + 4).replace(/^\r?\n/, '');
    const data = {};
    let listKey = null;

    for (const line of header.split(/\r?\n/)) {
        const listItem = line.match(/^\s+-\s+(.*)$/);
        if (listItem && listKey) {
            data[listKey].push(stripQuotes(listItem[1]));
            continue;
        }
        const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (!kv) continue;
        const [, key, rest] = kv;
        if (rest === '') {
            listKey = key;
            data[key] = [];
        } else if (rest.startsWith('[') && rest.endsWith(']')) {
            listKey = null;
            data[key] = rest.slice(1, -1).split(',').map((s) => stripQuotes(s)).filter(Boolean);
        } else {
            listKey = null;
            data[key] = stripQuotes(rest);
        }
    }
    return { data, body };
}

/** First prose paragraph of the manifest body (usually the ## Summary text). */
function extractSummary(body) {
    const lines = body.split(/\r?\n/);
    const paragraph = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) {
            if (paragraph.length) break;
            continue;
        }
        paragraph.push(trimmed);
    }
    return paragraph.join(' ') || null;
}

/**
 * Classify one evidence entry from a manifest's `evidence:` list. Vault
 * wiki-links, external URLs, Nexus task refs, and session refs each get a
 * kind the dashboard can turn into the right affordance.
 */
function classifyEvidence(raw) {
    const wiki = raw.match(/^\[\[(.+)\]\]$/);
    if (wiki) return { raw, kind: 'vault', target: wiki[1] };
    if (/^https?:\/\//.test(raw)) return { raw, kind: 'url', target: raw };
    const nexusTask = raw.match(/^nexus:task:([A-Za-z0-9-]+)$/);
    if (nexusTask) return { raw, kind: 'nexus-task', target: nexusTask[1] };
    const session = raw.match(/^session:([A-Za-z0-9-]+)$/);
    if (session) return { raw, kind: 'session', target: session[1] };
    return { raw, kind: 'other', target: raw };
}

/**
 * Scan installed manifests: `skills/*.md` plus every non-underscore category
 * directory. `_candidates`, `_knowledge`, and friends are not the active
 * library — candidates await approval, knowledge pages ride their skill.
 */
function scanManifests(vaultPath) {
    const skillsDir = path.join(vaultPath, 'skills');
    const manifests = new Map();
    let entries;
    try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
        return manifests;
    }

    const files = [];
    for (const entry of entries) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push({ relPath: `skills/${entry.name}`, category: null });
        } else if (entry.isDirectory()) {
            let inner;
            try {
                inner = fs.readdirSync(path.join(skillsDir, entry.name));
            } catch {
                continue;
            }
            for (const file of inner) {
                if (file.endsWith('.md')) {
                    files.push({ relPath: `skills/${entry.name}/${file}`, category: entry.name });
                }
            }
        }
    }

    for (const { relPath, category } of files) {
        const raw = readTextIfExists(path.join(vaultPath, relPath));
        if (raw === null) continue;
        const { data, body } = parseFrontmatter(raw);
        const name = typeof data.name === 'string' && data.name
            ? data.name
            : path.basename(relPath, '.md');
        manifests.set(name, {
            name,
            relPath,
            category: data.category || category || 'general',
            frontmatter: data,
            body,
        });
    }
    return manifests;
}

/** Telemetry rows from skills/_index.json, keyed by skill name. */
function loadTelemetry(vaultPath) {
    const byName = new Map();
    const raw = readTextIfExists(path.join(vaultPath, 'skills', '_index.json'));
    if (raw === null) return byName;
    try {
        const parsed = JSON.parse(raw);
        for (const row of parsed.skills || []) {
            if (row && typeof row.name === 'string') byName.set(row.name, row);
        }
    } catch {
        // Malformed index: the wiki degrades to manifests-only, no telemetry.
    }
    return byName;
}

function telemetrySummary(row) {
    if (!row) return null;
    return {
        recallCount: row.recallCount ?? 0,
        promptInjectionCount: row.promptInjectionCount ?? 0,
        successCount: row.successCount ?? 0,
        failureCount: row.failureCount ?? 0,
        state: row.state ?? null,
        pinned: Boolean(row.pinned),
        lastRecalledAt: row.lastRecalledAt ?? null,
        lastUsedAt: row.lastUsedAt ?? null,
        archivedReason: row.archivedReason ?? null,
    };
}

/**
 * Parse LINKS.md (vault-watcher generated) into targetRelPath → [sourceRelPath].
 * Format per entry: `- target: [label](path)` then `- ← [label](path)` lines.
 */
function parseBacklinkGraph(vaultPath) {
    const graph = new Map();
    const raw = readTextIfExists(path.join(vaultPath, 'LINKS.md'));
    if (raw === null) return graph;

    let current = null;
    for (const line of raw.split(/\r?\n/)) {
        const target = line.match(/^- target: \[[^\]]*\]\(([^)]+)\)/);
        if (target) {
            current = decodeURIComponent(target[1]);
            if (!graph.has(current)) graph.set(current, []);
            continue;
        }
        const source = line.match(/^- ← \[[^\]]*\]\(([^)]+)\)/);
        if (source && current) graph.get(current).push(decodeURIComponent(source[1]));
    }
    return graph;
}

/** Map a vault-relative path to a skill name when it belongs to a manifest. */
function skillNameForPath(relPath, manifests) {
    if (!relPath.startsWith('skills/')) return null;
    const name = path.basename(relPath, '.md');
    return manifests.has(name) ? name : null;
}

function relatedSkills(skill, manifests, backlinks) {
    const inbound = new Set();
    for (const source of backlinks.get(skill.relPath) || []) {
        const name = skillNameForPath(source, manifests);
        if (name && name !== skill.name) inbound.add(name);
    }

    const outbound = new Set();
    const evidence = Array.isArray(skill.frontmatter.evidence) ? skill.frontmatter.evidence : [];
    const scan = `${evidence.join('\n')}\n${skill.body}`;
    WIKI_LINK_RE.lastIndex = 0;
    for (let m = WIKI_LINK_RE.exec(scan); m; m = WIKI_LINK_RE.exec(scan)) {
        const target = m[1].trim();
        if (manifests.has(target) && target !== skill.name) outbound.add(target);
    }
    return { inbound: [...inbound].sort(), outbound: [...outbound].sort() };
}

function createSkillWikiRouter({ vaultPath = DEFAULT_VAULT_PATH } = {}) {
    const router = express.Router();

    // GET /api/skill-wiki/skills — the index: every installed manifest merged
    // with whatever telemetry exists for it. Shape is a superset of the
    // Praxis /api/skills response so existing SkillSummary consumers work.
    router.get('/skills', (req, res) => {
        const manifests = scanManifests(vaultPath);
        const telemetry = loadTelemetry(vaultPath);

        const skills = [...manifests.values()].map((skill) => {
            const row = telemetry.get(skill.name);
            const evidence = Array.isArray(skill.frontmatter.evidence) ? skill.frontmatter.evidence : [];
            return {
                id: skill.name,
                name: skill.name,
                category: skill.category,
                summary: (row && row.summary) || extractSummary(skill.body),
                tags: Array.isArray(skill.frontmatter.tags) ? skill.frontmatter.tags : [],
                provenance: skill.frontmatter.provenance || null,
                evidenceProvenance: skill.frontmatter.evidence_provenance || null,
                evidenceCount: evidence.length,
                hasKnowledge: fs.existsSync(path.join(vaultPath, 'skills', '_knowledge', `${skill.name}.md`)),
                confidence: skill.frontmatter.confidence ? Number(skill.frontmatter.confidence) : null,
                source: skill.frontmatter.source || null,
                created: skill.frontmatter.created || null,
                updated: skill.frontmatter.updated || null,
                state: (row && row.state) || null,
                pinned: Boolean(row && row.pinned),
                recallCount: row ? row.recallCount ?? 0 : null,
                successCount: row ? row.successCount ?? 0 : null,
                failureCount: row ? row.failureCount ?? 0 : null,
                lastUsedAt: (row && row.lastUsedAt) || null,
                hasTelemetry: Boolean(row),
            };
        }).sort((a, b) => a.name.localeCompare(b.name));

        const byCategory = {};
        for (const s of skills) byCategory[s.category] = (byCategory[s.category] || 0) + 1;

        res.json({ total: skills.length, byCategory, skills, vaultPath });
    });

    // GET /api/skill-wiki/skills/:name — one skill page: manifest, evidence,
    // knowledge page, telemetry, and backlink-graph neighbours.
    router.get('/skills/:name', (req, res) => {
        const { name } = req.params;
        if (!SKILL_NAME_RE.test(name)) {
            return res.status(400).json({ error: 'invalid skill name' });
        }

        const manifests = scanManifests(vaultPath);
        const skill = manifests.get(name);
        if (!skill) return res.status(404).json({ error: `unknown skill: ${name}` });

        const telemetry = loadTelemetry(vaultPath);
        const backlinks = parseBacklinkGraph(vaultPath);
        const evidence = Array.isArray(skill.frontmatter.evidence) ? skill.frontmatter.evidence : [];
        const knowledge = readTextIfExists(
            path.join(vaultPath, 'skills', '_knowledge', `${skill.name}.md`));

        res.json({
            name: skill.name,
            category: skill.category,
            relPath: skill.relPath,
            frontmatter: skill.frontmatter,
            manifest: skill.body,
            evidence: evidence.map(classifyEvidence),
            knowledge,
            telemetry: telemetrySummary(telemetry.get(skill.name)),
            related: relatedSkills(skill, manifests, backlinks),
            knownSkills: [...manifests.keys()].sort(),
        });
    });

    return router;
}

module.exports = createSkillWikiRouter;
module.exports._internal = { parseFrontmatter, classifyEvidence, parseBacklinkGraph, extractSummary };
