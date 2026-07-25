/**
 * SQLite Database Client for TheNexus
 * 
 * Local SQLite database via better-sqlite3.
 * Replaces the previous Supabase (PostgreSQL) client.
 * All operations are synchronous under the hood but wrapped
 * in async functions to preserve the existing API contract.
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { normalizeTaskBoardStatus, isTaskDone } = require('@praxis/contract');

/**
 * Write-side backstop for the canonical task-status enum (@praxis/contract
 * TaskBoardStatusSchema, unified 2026-07-05). Every task write funnels
 * through here: legacy synonyms (complete/done/ready/in-progress/…) are
 * silently normalized so mixed-version writers can never re-fragment the
 * board; genuinely unknown values are logged and passed through unchanged
 * (the API layer rejects them with a 400 — this backstop must not turn a
 * direct db-layer call into silent data loss).
 */
function normalizeTaskStatusField(task, context) {
    if (!task || task.status === undefined || task.status === null) return task;
    const canonical = normalizeTaskBoardStatus(task.status);
    if (canonical === null) {
        console.warn(`[Database] Unknown task status "${task.status}" in ${context} — storing as-is (API validation should have caught this)`);
        return task;
    }
    if (canonical !== task.status) task.status = canonical;
    return task;
}

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DB_PATH = process.env.NEXUS_DB_PATH
    || path.resolve(__dirname, '../nexus.db');

let db;
try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Auto-create tables if the DB is brand new
    const schemaPath = path.resolve(__dirname, 'schema-sqlite.sql');
    if (fs.existsSync(schemaPath)) {
        db.exec(fs.readFileSync(schemaPath, 'utf8'));
    }

    runModelControlMigrations(db);
    runContactsMigrations(db);

    // Canonical-status sweep (2026-07-05 unification): idempotent, runs every
    // boot. Writers normalize at createTask/updateTask, but a process still on
    // pre-unification code can slip a legacy synonym in — this heals it on the
    // next restart instead of letting the board re-fragment.
    try {
        const legacyMap = require('@praxis/contract').LEGACY_TASK_STATUS_MAP;
        let healed = 0;
        for (const [legacy, canonical] of Object.entries(legacyMap)) {
            for (const col of ['status', 'pre_archive_status']) {
                healed += db.prepare(`UPDATE tasks SET ${col} = ? WHERE lower(trim(${col})) = ?`).run(canonical, legacy).changes;
            }
        }
        if (healed > 0) console.log(`[Database] Status sweep: normalized ${healed} legacy task status value(s)`);
    } catch (err) {
        console.warn('[Database] Canonical-status sweep skipped:', err.message);
    }

    // Migration: add 'source' column to usage_stats for per-caller tracking
    try {
        const cols = db.prepare("PRAGMA table_info(usage_stats)").all();
        if (cols.length > 0 && !cols.find(c => c.name === 'source')) {
            db.exec("ALTER TABLE usage_stats ADD COLUMN source TEXT DEFAULT 'unknown'");
            // Drop old unique constraint and create new one including source
            // SQLite can't drop constraints, so we need to recreate the index
            try { db.exec("DROP INDEX IF EXISTS idx_usage_stats_date_model_source"); } catch {}
            db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_stats_date_model_source ON usage_stats(date, model, source)");
            console.log('[Database] Migration: added source column to usage_stats');
        }
    } catch (err) {
        console.warn('[Database] usage_stats source migration skipped:', err.message);
    }

    // Migration: project/task archival (see db/migrations/027_project_archival.sql)
    // projects.status already supports 'archived' (migration 024). Here we add the
    // timestamp/restore columns needed to archive a project and its tasks reversibly.
    try {
        const projCols = db.prepare("PRAGMA table_info(projects)").all();
        if (projCols.length > 0 && !projCols.find(c => c.name === 'archived_at')) {
            db.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
            console.log('[Database] Migration: added archived_at column to projects');
        }
        const taskCols = db.prepare("PRAGMA table_info(tasks)").all();
        if (taskCols.length > 0 && !taskCols.find(c => c.name === 'archived_at')) {
            db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
            console.log('[Database] Migration: added archived_at column to tasks');
        }
        if (taskCols.length > 0 && !taskCols.find(c => c.name === 'pre_archive_status')) {
            db.exec("ALTER TABLE tasks ADD COLUMN pre_archive_status TEXT");
            console.log('[Database] Migration: added pre_archive_status column to tasks');
        }
    } catch (err) {
        console.warn('[Database] project archival migration skipped:', err.message);
    }

    // Migration: knowledge-need tags on projects (task abdf62d0). A JSON array of
    // kebab-case tags (e.g. 'board-game-accessibility') written by Praxis's
    // project-tagger; the knowledge graph binds them to topic nodes. Stored as a
    // JSON TEXT column with DEFAULT '[]' so projects created before this migration
    // read back an empty array rather than NULL. Deserialised via JSON_COLS below.
    try {
        const tagCols = db.prepare("PRAGMA table_info(projects)").all();
        if (tagCols.length > 0 && !tagCols.find(c => c.name === 'tags')) {
            db.exec("ALTER TABLE projects ADD COLUMN tags TEXT DEFAULT '[]'");
            console.log('[Database] Migration: added tags column to projects');
        }
    } catch (err) {
        console.warn('[Database] projects tags migration skipped:', err.message);
    }

    // Migration: project data system — upgrade posture, needs registry, and
    // evolving end states. `upgrade_posture` gates autonomous improvement
    // filings (auto/propose/off — see @praxis/contract UpgradePostureSchema).
    // `needs` is a JSON array of ProjectNeed rows (what the project is missing
    // on the way to its end state). `end_state_history` is the append-only
    // revision log for end_state (newest entry mirrors the live value; the
    // append happens in updateProject so every writer — dashboard, Praxis,
    // MCP — gets versioning for free). Existing end_states are seeded as the
    // first revision so history never starts empty for a project that has one.
    try {
        const pdCols = db.prepare("PRAGMA table_info(projects)").all();
        if (pdCols.length > 0) {
            if (!pdCols.find(c => c.name === 'upgrade_posture')) {
                db.exec("ALTER TABLE projects ADD COLUMN upgrade_posture TEXT DEFAULT 'auto'");
                console.log('[Database] Migration: added upgrade_posture column to projects');
            }
            if (!pdCols.find(c => c.name === 'needs')) {
                db.exec("ALTER TABLE projects ADD COLUMN needs TEXT DEFAULT '[]'");
                console.log('[Database] Migration: added needs column to projects');
            }
            if (!pdCols.find(c => c.name === 'end_state_updated_at')) {
                db.exec("ALTER TABLE projects ADD COLUMN end_state_updated_at TEXT");
                console.log('[Database] Migration: added end_state_updated_at column to projects');
            }
            if (!pdCols.find(c => c.name === 'end_state_criteria')) {
                db.exec("ALTER TABLE projects ADD COLUMN end_state_criteria TEXT DEFAULT '[]'");
                console.log('[Database] Migration: added end_state_criteria column to projects');
            }
            if (!pdCols.find(c => c.name === 'end_state_history')) {
                db.exec("ALTER TABLE projects ADD COLUMN end_state_history TEXT DEFAULT '[]'");
                const seedTs = new Date().toISOString();
                const withEndState = db.prepare(
                    "SELECT id, end_state, updated_at FROM projects WHERE end_state IS NOT NULL AND trim(end_state) != ''"
                ).all();
                const seedStmt = db.prepare(
                    'UPDATE projects SET end_state_history = ?, end_state_updated_at = COALESCE(end_state_updated_at, ?) WHERE id = ?'
                );
                for (const p of withEndState) {
                    const revision = [{ end_state: p.end_state, at: p.updated_at || seedTs, source: 'backfill' }];
                    seedStmt.run(JSON.stringify(revision), p.updated_at || seedTs, p.id);
                }
                console.log(`[Database] Migration: added end_state_history column to projects (seeded ${withEndState.length} existing end state(s))`);
            }
        }
    } catch (err) {
        console.warn('[Database] project data system migration skipped:', err.message);
    }

    // Migration: real-activity timestamp for the Board Groundskeeper (task
    // 02f3c8a7). Seeded from created_at, deliberately NOT updated_at — the
    // daily sweeps have touched updated_at on every row, so it carries no
    // signal. Old ideas therefore surface as stale immediately, which is the
    // point; all Groundskeeper proposals are human-gated.
    try {
        const activityCols = db.prepare("PRAGMA table_info(tasks)").all();
        if (activityCols.length > 0 && !activityCols.find(c => c.name === 'last_activity_at')) {
            db.exec("ALTER TABLE tasks ADD COLUMN last_activity_at TEXT");
            db.exec("UPDATE tasks SET last_activity_at = created_at WHERE last_activity_at IS NULL");
            console.log('[Database] Migration: added last_activity_at column to tasks (seeded from created_at)');
        }
    } catch (err) {
        console.warn('[Database] last_activity_at migration skipped:', err.message);
    }

    // Migration: task sequencing. Predecessors already live in `dependencies`
    // (JSON array of task ids, migration 023 — all must complete before this
    // task starts). successor_id is the single task to start immediately
    // after this one completes.
    try {
        const seqCols = db.prepare("PRAGMA table_info(tasks)").all();
        if (seqCols.length > 0 && !seqCols.find(c => c.name === 'successor_id')) {
            db.exec("ALTER TABLE tasks ADD COLUMN successor_id TEXT");
            console.log('[Database] Migration: added successor_id column to tasks');
        }
    } catch (err) {
        console.warn('[Database] successor_id migration skipped:', err.message);
    }

    // Migration: per-task dispatch defaults (task-screen dispatch console
    // auto-save). The console persists the operator's chosen Worker, Model, and
    // standing instructions onto the task so they survive reloads, ride every
    // dispatch, and are reusable by scheduling. Deliberately NOT activity fields
    // (see server/lib/task-activity.js) — saving a default must not make a stale
    // task look freshly active.
    try {
        const dispatchCols = db.prepare("PRAGMA table_info(tasks)").all();
        if (dispatchCols.length > 0) {
            for (const col of ['default_executor', 'default_model', 'dispatch_instructions']) {
                if (!dispatchCols.find(c => c.name === col)) {
                    db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
                    console.log(`[Database] Migration: added ${col} column to tasks`);
                }
            }
        }
    } catch (err) {
        console.warn('[Database] dispatch defaults migration skipped:', err.message);
    }

    console.log(`[Database] Connected to SQLite: ${DB_PATH}`);
} catch (err) {
    console.error('[Database] Failed to open SQLite database:', err.message);
    db = null;
}

// Auth removed — single-user local app. No Supabase dependency at runtime.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

/** Serialise a value for SQLite TEXT column (JSON objects/arrays → string) */
function ser(val) {
    if (val === undefined) return null;
    if (val === null) return null;
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
}

/** Deserialise a JSON TEXT column back to JS */
function deser(val) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'string') return val;
    const t = val.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

/** Deserialise known JSON columns on a row */
const JSON_COLS = new Set([
    'stack', 'urls', 'tasks_list', 'task_ledger', 'supervisor_details',
    'graph_config', 'context', 'checkpoint', 'metadata',
    'agent_configuration', 'parameters', 'capabilities', 'default_parameters', 'parameters_summary', 'config',
    'trigger_config', 'configuration', 'target_projects', 'progress',
    'allowed_tools', 'denied_tools', 'details', 'data',
    'value',
    'stages', 'outputs',
    'antigravity_payload', 'dependencies',
    'suspended_context', 'resume_action',
    'tags',
    'needs', 'end_state_history', 'end_state_criteria',
    'preferences', 'expertise', 'interests', 'claims', 'interaction_log'
]);

function deserRow(row) {
    if (!row) return row;
    for (const key of Object.keys(row)) {
        if (JSON_COLS.has(key)) {
            row[key] = deser(row[key]);
        }
        // SQLite booleans back to JS booleans
        if (key === 'is_template' || key === 'is_active' || key === 'is_enabled' || key === 'resolved' || key === 'pinned' || key === 'local_only_active' || key === 'fallback_used') {
            row[key] = row[key] === 1 || row[key] === true;
        }
    }
    return row;
}

function deserRows(rows) { return (rows || []).map(deserRow); }

function tableExists(sqlite, tableName) {
    return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function columnExists(sqlite, tableName, columnName) {
    if (!tableExists(sqlite, tableName)) return false;
    return sqlite.prepare(`PRAGMA table_info("${tableName}")`).all().some(c => c.name === columnName);
}

function ensureColumn(sqlite, tableName, columnName, definition) {
    if (!tableExists(sqlite, tableName)) return;
    if (!columnExists(sqlite, tableName, columnName)) {
        sqlite.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`);
    }
}

function runModelControlMigrations(sqlite) {
    try {
        [
            ['models', 'api_model_id', 'TEXT'],
            ['models', 'display_name', 'TEXT'],
            ['models', 'default_parameters', "TEXT DEFAULT '{}'"],
            ['models', 'version_sort', 'TEXT'],
            ['models', 'discovered_at', 'TEXT'],
            ['models', 'last_seen_at', 'TEXT'],
            ['models', 'availability_status', "TEXT DEFAULT 'unknown'"],
            ['tasks', 'model_assignment', 'TEXT'],
            ['calendar_events', 'model_assignment', 'TEXT'],
            ['project_workflows', 'model_assignment', 'TEXT'],
            ['workflow_templates', 'model_assignment', 'TEXT'],
        ].forEach(([table, column, definition]) => ensureColumn(sqlite, table, column, definition));

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS model_aliases (
                alias TEXT PRIMARY KEY,
                target TEXT NOT NULL,
                description TEXT,
                is_active INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- Named call-site roles (e.g. "ingestion.extract", "agent.interactive").
            -- assignment uses the same grammar as model_aliases.target:
            -- "alias:<name>" | "model:<id>" | "family:<name>" | "capability:<cap>".
            -- Lets every Praxis LLM call resolve its model from one controllable place.
            CREATE TABLE IF NOT EXISTS model_roles (
                role TEXT PRIMARY KEY,
                assignment TEXT NOT NULL,
                description TEXT,
                is_active INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS project_model_aliases (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                target TEXT NOT NULL,
                description TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (project_id, alias)
            );

            CREATE TABLE IF NOT EXISTS model_control_settings (
                key TEXT PRIMARY KEY,
                value TEXT DEFAULT '{}',
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS project_model_control_settings (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                key TEXT NOT NULL,
                value TEXT DEFAULT '{}',
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (project_id, key)
            );

            CREATE TABLE IF NOT EXISTS model_execution_snapshots (
                id TEXT PRIMARY KEY,
                requested_assignment TEXT,
                resolved_model_id TEXT,
                provider TEXT,
                api_model_id TEXT,
                parameters_summary TEXT DEFAULT '{}',
                source TEXT,
                local_only_active INTEGER DEFAULT 0,
                local_only_reason TEXT,
                fallback_used INTEGER DEFAULT 0,
                fallback_reason TEXT,
                project_id TEXT,
                task_id TEXT,
                calendar_event_id TEXT,
                workflow_id TEXT,
                workflow_run_id TEXT,
                node_id TEXT,
                conversation_id TEXT,
                message_id TEXT,
                command_id TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
        `);

        // Seed repointable online aliases (one place to change "which Gemini")
        // and the canonical call-site roles (local-first, with a small Gemini
        // allowlist). INSERT OR IGNORE never clobbers a value the user has tuned.
        sqlite.exec(`
            INSERT OR IGNORE INTO model_aliases (alias, target, description) VALUES
              ('gemini_default', 'model:google-gemini-pro',   'Default online model (Gemini Pro) for quality/latency-sensitive roles'),
              ('gemini_fast',    'model:google-gemini-flash', 'Fast online model (Gemini Flash) for classify/plan roles');

            INSERT OR IGNORE INTO model_roles (role, assignment, description) VALUES
              ('ingestion.extract',       'alias:local_default',  'Nightly Pass-1 entity/factoid extraction'),
              ('ingestion.refine',        'alias:local_default',  'Pass-2 refinement'),
              ('ingestion.journal',       'alias:local_default',  'Overnight journal reflection'),
              ('ingestion.summary',       'cli:claude-code/claude-sonnet-5@medium', 'Nightly AI-intelligence briefing narrative'),
              ('report.upload',           'alias:local_default',  'Report-upload chunk summaries'),
              ('maintenance.synthesis',   'alias:local_default',  'Nightly synthesis'),
              ('maintenance.lars',        'alias:local_default',  'LARS analysis'),
              ('memory.evolve',           'alias:local_default',  'Conversation-evolve extraction'),
              ('memory.synthesize',       'alias:local_default',  'Session synthesizer'),
              ('morning.rank',            'alias:local_default',  'Morning task ranking'),
              ('morning.commentary',      'alias:local_default',  'Morning planning commentary'),
              ('morning.goalgen',         'alias:local_default',  'Morning goal regression'),
              ('morning.self_assess',     'alias:local_default',  'Morning self-assessment'),
              ('morning.archive_audit',   'alias:local_default',  'Morning archive audit (obsolete/done task recommendations)'),
              ('trading.council',         'alias:local_default',  'Trading council'),
              ('youtube.research',        'alias:local_default',  'YouTube story research'),
              ('agent.consolidate',       'alias:local_default',  'Tool-output fusion / compression'),
              ('rag.counter_query',       'alias:local_default',  'Counter-evidence query rewrite'),
              ('memory.prune',            'alias:local_default',  'Conversation context summarization'),
              ('agent.interactive',       'cli:claude-code/claude-sonnet-5@low',    'Human-facing interactive chat replies'),
              ('agent.intermediate_eval', 'cli:claude-code/claude-haiku-4-5@low',   'Agent intermediate rubric self-check'),
              ('agent.skill_rank',        'cli:claude-code/claude-haiku-4-5@low',   'Skill ranking / selection'),
              ('memory.multimodal',       'cli:claude-code/claude-sonnet-5@low',    'Image description (vision; image paths ride the CLI seat)'),
              ('research.deep',           'cli:claude-code/claude-opus-5@high',     'Deep-research worker (SOTA reasoning)'),
              ('agent.self_consistency',  'alias:gemini_default', 'Multi-path reasoning sampler (stays on the Gemini API — parallel samples suit an API, not a CLI)'),
              ('agent.epistemic',         'alias:gemini_default', 'Trust-gap / epistemic evaluation (stays on the Gemini API — parallel samples suit an API, not a CLI)'),
              ('brain.chat',              'cli:claude-code/claude-opus-5@high',     'External reasoning offload (praxis-mind brain_chat + Nexus ai-service relays)'),
              ('router.classify',         'cli:claude-code/claude-haiku-4-5@low',   'Turn classifier (fast; low = CLI effort floor, latency-guarded)'),
              ('context.plan',            'cli:claude-code/claude-haiku-4-5@low',   'Context planner (fast; low = CLI effort floor, latency-guarded)'),
              ('feedback.triage',            'alias:local_default',  'Feedback gateway: classify + route an end-user submission'),
              ('feedback.council_synthesis', 'cli:claude-code/claude-sonnet-5@high', 'Feedback gateway: fuse council theses into an implementation plan'),
              ('feedback.reply',             'cli:claude-code/claude-sonnet-5@low',  'Feedback gateway: compose outbound email prose to submitters');
        `);

        // 2026-07-18 (task 0a62d8a6): one-time migration of the Gemini-allowlist
        // roles onto the subscription CLI lane. The INSERT OR IGNORE seed above
        // only covers fresh databases; existing rows still carry their old
        // gemini_default/gemini_fast assignments, so update them ONCE — keyed in
        // model_control_settings so later operator tuning via PUT /roles is
        // never clobbered by a restart. agent.epistemic and agent.self_consistency
        // deliberately stay on the Gemini API (Robert's call: they fire many
        // fast parallel samples, which a CLI session handles poorly).
        const cliLaneMigrated = sqlite
            .prepare("SELECT key FROM model_control_settings WHERE key = 'cli_lane_roles_v1'")
            .get();
        if (!cliLaneMigrated) {
            const CLI_LANE_ROLES_V1 = {
                'agent.interactive':          'cli:claude-code/claude-sonnet-5@low',
                'agent.intermediate_eval':    'cli:claude-code/claude-haiku-4-5@low',
                'agent.skill_rank':           'cli:claude-code/claude-haiku-4-5@low',
                'router.classify':            'cli:claude-code/claude-haiku-4-5@low',
                'context.plan':               'cli:claude-code/claude-haiku-4-5@low',
                'memory.multimodal':          'cli:claude-code/claude-sonnet-5@low',
                'research.deep':              'cli:claude-code/claude-opus-5@high',
                'brain.chat':                 'cli:claude-code/claude-opus-5@high',
                'ingestion.summary':          'cli:claude-code/claude-sonnet-5@medium',
                'feedback.council_synthesis': 'cli:claude-code/claude-sonnet-5@high',
                'feedback.reply':             'cli:claude-code/claude-sonnet-5@low',
            };
            const updateRole = sqlite.prepare(
                "UPDATE model_roles SET assignment = ?, updated_at = datetime('now') WHERE role = ?"
            );
            for (const [role, assignment] of Object.entries(CLI_LANE_ROLES_V1)) {
                updateRole.run(assignment, role);
            }
            sqlite.prepare(
                "INSERT OR IGNORE INTO model_control_settings (key, value) VALUES ('cli_lane_roles_v1', ?)"
            ).run(JSON.stringify({ appliedAt: new Date().toISOString() }));
        }

        // 2026-07-25: Opus 5 (claude-opus-5) replaces Opus 4.8 as the default
        // Claude model (Robert's directive). Same keyed one-time pattern as
        // cli_lane_roles_v1, but value-guarded: only rows still carrying the
        // old Opus 4.8 default are upgraded, so operator tuning survives.
        const opus5Migrated = sqlite
            .prepare("SELECT key FROM model_control_settings WHERE key = 'opus5_default_roles_v1'")
            .get();
        if (!opus5Migrated) {
            const upgradeRole = sqlite.prepare(
                "UPDATE model_roles SET assignment = ?, updated_at = datetime('now') WHERE role = ? AND assignment = ?"
            );
            upgradeRole.run('cli:claude-code/claude-opus-5@high', 'research.deep', 'cli:claude-code/claude-opus-4-8@high');
            upgradeRole.run('cli:claude-code/claude-opus-5@high', 'brain.chat', 'cli:claude-code/claude-opus-4-8@high');
            sqlite.prepare(
                "INSERT OR IGNORE INTO model_control_settings (key, value) VALUES ('opus5_default_roles_v1', ?)"
            ).run(JSON.stringify({ appliedAt: new Date().toISOString() }));
        }
    } catch (err) {
        console.warn('[Database] model-control migration skipped:', err.message);
    }
}

/**
 * Members — the ONE shared people directory (contacts + council members were
 * unified 2026-07-16 on Robert's directive): humans AND AI council seats,
 * with per-project role links. Contract shapes: @praxis/contract
 * entities/contact.ts (Member = Contact). Praxis's feedback pipeline
 * auto-observes submitters here; the dashboard's project pages manage them;
 * the council reads claims/expertise + `seat_id` (its reputation-ledger key)
 * to decide WHO to ask for off-internet knowledge, and appends its own
 * interaction notes to `interaction_log`.
 */
function runContactsMigrations(sqlite) {
    try {
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                relationship TEXT,
                notes TEXT,
                preferences TEXT DEFAULT '{}',
                expertise TEXT DEFAULT '[]',
                interests TEXT DEFAULT '[]',
                source TEXT DEFAULT 'operator',
                last_contact_at TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email
                ON contacts(lower(email)) WHERE email IS NOT NULL AND email != '';

            CREATE TABLE IF NOT EXISTS project_contacts (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
                role TEXT,
                notes TEXT,
                added_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (project_id, contact_id)
            );
            CREATE INDEX IF NOT EXISTS idx_project_contacts_contact
                ON project_contacts(contact_id);
        `);
    } catch (err) {
        console.warn('[Database] contacts migration skipped:', err.message);
    }
    // 2026-07-16 unification: member profile columns (additive, idempotent).
    const memberColumns = [
        ["kind", "TEXT DEFAULT 'human'"],
        ["seat_id", "TEXT"],
        ["birthday", "TEXT"],
        ["claims", "TEXT DEFAULT '[]'"],
        ["interaction_log", "TEXT DEFAULT '[]'"],
        ["status", "TEXT DEFAULT 'active'"],
    ];
    for (const [col, type] of memberColumns) {
        try {
            sqlite.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${type}`);
        } catch (err) {
            if (!/duplicate column/i.test(err.message)) {
                console.warn(`[Database] contacts.${col} migration skipped:`, err.message);
            }
        }
    }
    try {
        sqlite.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_seat
                ON contacts(seat_id) WHERE seat_id IS NOT NULL AND seat_id != '';
        `);
    } catch (err) {
        console.warn('[Database] contacts seat index skipped:', err.message);
    }
    // Backfill: pre-unification humans get their council seat key minted so
    // the reputation ledger can fold on them from day one.
    try {
        const unseated = sqlite.prepare(
            "SELECT id, name FROM contacts WHERE (seat_id IS NULL OR seat_id = '') AND kind != 'ai'"
        ).all();
        for (const row of unseated) {
            const slug = String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member';
            let candidate = `human:${slug}`;
            for (let n = 2; n < 100; n++) {
                const taken = sqlite.prepare('SELECT 1 FROM contacts WHERE seat_id = ?').get(candidate);
                if (!taken) break;
                candidate = `human:${slug}-${n}`;
            }
            sqlite.prepare('UPDATE contacts SET seat_id = ? WHERE id = ?').run(candidate, row.id);
        }
        if (unseated.length > 0) {
            console.log(`[Database] Members unification: minted seat ids for ${unseated.length} existing contact(s)`);
        }
    } catch (err) {
        console.warn('[Database] contacts seat backfill skipped:', err.message);
    }
}

/**
 * Build an INSERT or INSERT OR REPLACE from an object.
 * Returns { sql, params }.
 */
function buildInsert(table, obj, upsertConflict) {
    const keys = Object.keys(obj);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map(k => ser(obj[k]));

    let sql;
    if (upsertConflict) {
        const setClauses = keys
            .filter(k => !upsertConflict.split(',').map(c => c.trim()).includes(k))
            .map(k => `"${k}" = excluded."${k}"`)
            .join(', ');
        sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})
               ON CONFLICT(${upsertConflict}) DO UPDATE SET ${setClauses}`;
    } else {
        sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`;
    }

    return { sql, values };
}

/**
 * Build an UPDATE from an object.
 * Returns { sql, params }.
 */
function buildUpdate(table, updates, whereCol, whereVal) {
    const keys = Object.keys(updates);
    if (!keys.includes('updated_at')) keys.push('updated_at');
    if (!updates.updated_at) updates.updated_at = now();

    const setClauses = keys.map(k => `"${k}" = ?`).join(', ');
    const values = keys.map(k => ser(updates[k]));
    values.push(whereVal);

    return {
        sql: `UPDATE "${table}" SET ${setClauses} WHERE "${whereCol}" = ?`,
        values
    };
}

// ============================================================================
// CORE
// ============================================================================

function isDatabaseEnabled() { return db !== null; }

async function testConnection() {
    if (!db) return { success: false, error: 'Database not configured' };
    try {
        db.prepare('SELECT 1').get();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ============================================================================
// PROJECT OPERATIONS
// ============================================================================

/**
 * List projects. Archived projects are excluded by default so they drop out of
 * the dashboard list and any context-retrieval paths that feed project data to
 * the AI for analysis. Pass { includeArchived: true } for archive-management views.
 */
async function getProjects({ includeArchived = false } = {}) {
    if (!db) return [];
    try {
        const sql = includeArchived
            ? 'SELECT * FROM projects ORDER BY name'
            : "SELECT * FROM projects WHERE status IS NULL OR status != 'archived' ORDER BY name";
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching projects:', err.message);
        return [];
    }
}

async function getProject(identifier) {
    if (!db) return null;
    try {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
        let row = db.prepare('SELECT * FROM projects WHERE name = ?').get(identifier);
        if (!row && isUuid) {
            row = db.prepare('SELECT * FROM projects WHERE id = ?').get(identifier);
        }
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching project:', err.message);
        return null;
    }
}

async function getProjectByPath(projectPath) {
    if (!db) return null;
    try {
        const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath);
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching project by path:', err.message);
        return null;
    }
}

async function upsertProject(project) {
    if (!db) return null;
    try {
        if (!project.id) project.id = uuid();
        project.updated_at = now();
        if (!project.created_at) project.created_at = now();
        const { sql, values } = buildInsert('projects', project, 'name');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM projects WHERE name = ?').get(project.name));
    } catch (err) {
        console.error('[Database] Error upserting project:', err.message);
        return null;
    }
}

async function updateProject(projectId, updates) {
    if (!db) return null;
    try {
        const patch = { ...updates };
        // end_state_source / end_state_reason are revision metadata, not
        // columns — consume them here so buildUpdate never sees them.
        const revisionSource = patch.end_state_source;
        const revisionReason = patch.end_state_reason;
        delete patch.end_state_source;
        delete patch.end_state_reason;

        // Evolving end states: every end_state change appends a revision to
        // end_state_history (newest entry mirrors the live value), so the
        // goal can move without losing where it came from. Done here — not in
        // the route — so the dashboard, Praxis, and the MCP all get
        // versioning for free.
        if (Object.prototype.hasOwnProperty.call(patch, 'end_state')) {
            const current = db.prepare('SELECT end_state, end_state_history FROM projects WHERE id = ?').get(projectId);
            if (current && (current.end_state || '') !== (patch.end_state || '')) {
                let history = [];
                try {
                    const parsed = JSON.parse(current.end_state_history || '[]');
                    if (Array.isArray(parsed)) history = parsed;
                } catch { /* corrupted history — restart the log rather than fail the update */ }
                const revision = { end_state: patch.end_state || '', at: now() };
                if (revisionSource) revision.source = revisionSource;
                if (revisionReason) revision.reason = revisionReason;
                history.push(revision);
                patch.end_state_history = history;
                patch.end_state_updated_at = revision.at;
            }
        }

        const { sql, values } = buildUpdate('projects', patch, 'id', projectId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
    } catch (err) {
        console.error('[Database] Error updating project:', err.message);
        return null;
    }
}

async function deleteProject(projectId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting project:', err.message);
        return false;
    }
}

/**
 * Archive a project and all of its tasks. This is a soft, reversible operation
 * that NEVER touches project files on disk — only database state changes:
 *   - The project's status becomes 'archived' (drops it from the dashboard and
 *     from context-retrieval paths via getProjects/getBoardState filtering).
 *   - Every non-archived task gets status='archived', its prior status stashed in
 *     pre_archive_status, and an archived_at timestamp, so it can be restored.
 *
 * @returns {{ project: object, tasksArchived: number } | null}
 */
async function archiveProject(projectId) {
    if (!db) return null;
    try {
        const ts = now();
        const run = db.transaction(() => {
            const tasks = db.prepare(
                "SELECT id, status FROM tasks WHERE project_id = ? AND (status IS NULL OR status != 'archived')"
            ).all(projectId);
            const updateTaskStmt = db.prepare(
                "UPDATE tasks SET pre_archive_status = ?, status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
            );
            for (const t of tasks) {
                updateTaskStmt.run(t.status || null, ts, ts, t.id);
            }
            db.prepare(
                "UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
            ).run(ts, ts, projectId);
            return tasks.length;
        });
        const tasksArchived = run();
        const project = deserRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
        return { project, tasksArchived };
    } catch (err) {
        console.error('[Database] Error archiving project:', err.message);
        return null;
    }
}

/**
 * Reverse archiveProject. Restores the project to 'active' and each archived task
 * to the status it held before archival (falling back to 'idea' if unknown).
 *
 * @returns {{ project: object, tasksRestored: number } | null}
 */
async function unarchiveProject(projectId) {
    if (!db) return null;
    try {
        const ts = now();
        const run = db.transaction(() => {
            const tasks = db.prepare(
                "SELECT id, pre_archive_status FROM tasks WHERE project_id = ? AND status = 'archived'"
            ).all(projectId);
            const restoreTaskStmt = db.prepare(
                "UPDATE tasks SET status = ?, pre_archive_status = NULL, archived_at = NULL, updated_at = ? WHERE id = ?"
            );
            for (const t of tasks) {
                restoreTaskStmt.run(t.pre_archive_status || 'idea', ts, t.id);
            }
            db.prepare(
                "UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?"
            ).run(ts, projectId);
            return tasks.length;
        });
        const tasksRestored = run();
        const project = deserRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
        return { project, tasksRestored };
    } catch (err) {
        console.error('[Database] Error unarchiving project:', err.message);
        return null;
    }
}

// ============================================================================
// CONTEXT OPERATIONS
// ============================================================================

async function getProjectContexts(projectId) {
    if (!db) return [];
    try {
        return deserRows(db.prepare('SELECT * FROM project_contexts WHERE project_id = ?').all(projectId));
    } catch (err) {
        console.error('[Database] Error fetching project contexts:', err.message);
        return [];
    }
}

async function updateProjectContext(projectId, type, content, status) {
    if (!db) return null;

    // Write to local file for git backup
    try {
        const project = await getProject(projectId);
        if (project?.path) {
            const contextDir = path.join(project.path, '.context');
            if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
            const typeToFile = {
                'product': 'product.md', 'tech-stack': 'tech-stack.md',
                'product-guidelines': 'product-guidelines.md', 'workflow': 'workflow.md',
                'database-schema': 'database-schema.md', 'context_map': 'context_map.md',
                'project-workflow-map': 'project-workflow-map.md',
                'task-pipeline-map': 'task-pipeline-map.md', 'function_map': 'function_map.md'
            };
            const filename = typeToFile[type] || `${type}.md`;
            const filepath = path.join(contextDir, filename);
            const fileContent = [
                '---', `context_type: ${type}`, `status: ${status || 'draft'}`,
                `updated_at: ${now()}`, '---', '', content || ''
            ].join('\n');
            fs.writeFileSync(filepath, fileContent, 'utf-8');
            console.log(`[Database] Wrote context to ${filepath}`);
        }
    } catch (fileErr) {
        console.warn('[Database] Could not write context file:', fileErr.message);
    }

    try {
        const row = {
            id: uuid(), project_id: projectId, context_type: type,
            content, status: status || 'draft', updated_at: now()
        };
        const { sql, values } = buildInsert('project_contexts', row, 'project_id,context_type');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM project_contexts WHERE project_id = ? AND context_type = ?')
                .get(projectId, type)
        );
    } catch (err) {
        console.error('[Database] Error updating project context:', err.message);
        return null;
    }
}

async function getContextStats() {
    if (!db) return {};
    try {
        const rows = db.prepare(
            "SELECT project_id, COUNT(*) as cnt FROM project_contexts WHERE status = 'review_pending' GROUP BY project_id"
        ).all();
        const stats = {};
        rows.forEach(r => { stats[r.project_id] = { pending_reviews: r.cnt }; });
        return stats;
    } catch (err) {
        console.error('[Database] Error fetching context stats:', err.message);
        return {};
    }
}

// ============================================================================
// TASK HELPERS
// ============================================================================

function parseTaskFields(task) {
    if (!task) return null;

    // Deserialise JSON columns
    task = deserRow(task);

    // Parse walkthrough if it's a string
    if (task.walkthrough && typeof task.walkthrough === 'string') {
        try { task.walkthrough = JSON.parse(task.walkthrough); }
        catch (e) {
            task.walkthrough = { content: task.walkthrough, error: 'Failed to parse JSON content' };
        }
    }

    // 1. Implementation Plan — merge plan_metadata + plan_output
    let plan = (typeof task.plan_metadata === 'string' ? deser(task.plan_metadata) : task.plan_metadata) || {};
    if (task.plan_output) {
        if (typeof task.plan_output === 'string') {
            if (task.plan_output.trim().startsWith('{')) {
                try { plan = { ...JSON.parse(task.plan_output), ...plan }; }
                catch { plan.content = task.plan_output; }
            } else { plan.content = task.plan_output; }
        } else { plan = { ...task.plan_output, ...plan }; }
    }
    if (Object.keys(plan).length > 0) {
        if (!plan.generatedAt) plan.generatedAt = task.updated_at;
        task.implementationPlan = plan;
    } else { task.implementationPlan = null; }

    // 2. Research Report — merge research_metadata + research_output
    let research = (typeof task.research_metadata === 'string' ? deser(task.research_metadata) : task.research_metadata) || {};
    if (task.research_output) {
        if (typeof task.research_output === 'string') {
            if (task.research_output.trim().startsWith('{')) {
                try { research = { ...JSON.parse(task.research_output), ...research }; }
                catch { research.content = task.research_output; }
            } else { research.content = task.research_output; }
        } else { research = { ...task.research_output, ...research }; }
    }
    if (Object.keys(research).length > 0) {
        if (!research.generatedAt) research.generatedAt = task.created_at;
        task.researchReport = research;
    } else { task.researchReport = null; }

    // 3. Metadata mapping
    task.metadata = task.metadata || {};
    if (task.initiative_validation) task.initiativeValidation = task.initiative_validation;
    if (task.supervisor_status) task.supervisorStatus = task.supervisor_status;
    if (task.supervisor_details) task.supervisorDetails = task.supervisor_details;

    return task;
}

// ============================================================================
// TASK OPERATIONS
// ============================================================================

async function getTasks(projectId) {
    if (!db) return [];
    try {
        const rows = db.prepare(
            'SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at DESC'
        ).all(projectId);
        return rows.map(parseTaskFields);
    } catch (err) {
        console.error('[Database] Error fetching tasks:', err.message);
        return [];
    }
}

async function getTask(taskId) {
    if (!db) return null;
    try {
        return parseTaskFields(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    } catch (err) {
        console.error('[Database] Error fetching task:', err.message);
        return null;
    }
}

async function createTask(task) {
    if (!db) return null;
    try {
        if (!task.id) task.id = uuid();
        if (!task.created_at) task.created_at = now();
        task.updated_at = now();
        normalizeTaskStatusField(task, 'createTask');
        const { sql, values } = buildInsert('tasks', task);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
    } catch (err) {
        console.error('[Database] Error creating task:', err.message);
        return null;
    }
}

async function updateTask(taskId, updates) {
    if (!db) return null;
    try {
        const normalized = normalizeTaskStatusField({ ...updates }, 'updateTask');
        const { sql, values } = buildUpdate('tasks', normalized, 'id', taskId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    } catch (err) {
        console.error('[Database] Error updating task:', err.message);
        return null;
    }
}

async function deleteTask(taskId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting task:', err.message);
        return false;
    }
}

// ============================================================================
// DUAL-PAYLOAD TASK OPERATIONS (Executive Planning)
// ============================================================================

/**
 * Batch-create tasks in a single SQLite transaction.
 * Each task supports the dual-payload structure:
 *   - human layer: name, description, status, priority
 *   - machine layer: antigravity_payload (JSON), dependencies (JSON array)
 *
 * @param {Array} tasks - Array of task objects
 * @returns {Array} Created tasks with IDs
 */
async function batchCreateTasks(tasks) {
    if (!db) return [];
    try {
        const insertMany = db.transaction((items) => {
            const results = [];
            for (const task of items) {
                if (!task.id) task.id = uuid();
                if (!task.created_at) task.created_at = now();
                task.updated_at = now();
                normalizeTaskStatusField(task, 'batchCreateTasks');

                // Serialize JSON fields for storage
                if (task.antigravity_payload && typeof task.antigravity_payload === 'object') {
                    task.antigravity_payload = JSON.stringify(task.antigravity_payload);
                }
                if (task.dependencies && Array.isArray(task.dependencies)) {
                    task.dependencies = JSON.stringify(task.dependencies);
                }

                const { sql, values } = buildInsert('tasks', task);
                db.prepare(sql).run(...values);
                results.push(deserRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)));
            }
            return results;
        });
        return insertMany(tasks);
    } catch (err) {
        console.error('[Database] Error batch-creating tasks:', err.message);
        return [];
    }
}

/**
 * Get the "board state" — active projects with their tasks and unblocked status.
 * A task is "unblocked" if all task IDs in its `dependencies` array have status='complete'.
 *
 * @param {string} [projectId] - Optional filter by project ID
 * @returns {Array} Projects with tasks annotated with `is_unblocked` flag
 */
async function getBoardState(projectId) {
    if (!db) return [];
    try {
        // Get projects
        let projects;
        if (projectId) {
            const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
            projects = p ? [deserRow(p)] : [];
        } else {
            projects = deserRows(
                db.prepare("SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC").all()
            );
        }

        // Get all tasks for these projects in one query
        const projectIds = projects.map(p => p.id);
        if (projectIds.length === 0) return [];

        const placeholders = projectIds.map(() => '?').join(',');
        const allTasks = deserRows(
            db.prepare(`SELECT * FROM tasks WHERE project_id IN (${placeholders}) ORDER BY priority DESC, created_at ASC`).all(...projectIds)
        );

        // Build a status lookup map for dependency resolution
        const taskStatusMap = new Map();
        for (const task of allTasks) {
            taskStatusMap.set(task.id, task.status);
        }

        // Annotate each task with is_unblocked
        for (const task of allTasks) {
            const deps = task.dependencies || [];
            if (deps.length === 0) {
                task.is_unblocked = true;
            } else {
                task.is_unblocked = deps.every(depId => isTaskDone(taskStatusMap.get(depId)));
            }
        }

        // Group tasks by project
        const tasksByProject = new Map();
        for (const task of allTasks) {
            if (!tasksByProject.has(task.project_id)) {
                tasksByProject.set(task.project_id, []);
            }
            tasksByProject.get(task.project_id).push(task);
        }

        // Assemble result
        return projects.map(project => ({
            ...project,
            tasks: tasksByProject.get(project.id) || [],
            task_summary: {
                total: (tasksByProject.get(project.id) || []).length,
                unblocked: (tasksByProject.get(project.id) || []).filter(t => t.is_unblocked && t.status !== 'complete' && t.status !== 'completed' && t.status !== 'done' && t.status !== 'suspended').length,
                complete: (tasksByProject.get(project.id) || []).filter(t => t.status === 'complete' || t.status === 'completed' || t.status === 'done').length,
                suspended: (tasksByProject.get(project.id) || []).filter(t => t.status === 'suspended').length,
            }
        }));
    } catch (err) {
        console.error('[Database] Error getting board state:', err.message);
        return [];
    }
}

/**
 * Reorder tasks within a project by updating sort_order values.
 * Accepts an array of { id, sort_order } pairs and updates them atomically.
 *
 * @param {Array} ordering - Array of { id: string, sort_order: number }
 * @returns {boolean} true if reorder succeeded
 */
async function reorderTasks(ordering) {
    if (!db) return false;
    try {
        const reorder = db.transaction((items) => {
            const stmt = db.prepare('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?');
            const timestamp = now();
            for (const item of items) {
                stmt.run(item.sort_order, timestamp, item.id);
            }
        });
        reorder(ordering);
        return true;
    } catch (err) {
        console.error('[Database] Error reordering tasks:', err.message);
        return false;
    }
}

// ============================================================================
// TRACK OPERATIONS
// ============================================================================

async function getTracks(taskId) {
    if (!db) return [];
    try {
        const tracks = deserRows(
            db.prepare('SELECT * FROM tracks WHERE task_id = ? ORDER BY created_at').all(taskId)
        );
        for (const track of tracks) {
            track.steps = deserRows(
                db.prepare('SELECT * FROM track_steps WHERE track_id = ? ORDER BY step_order').all(track.id)
            );
        }
        return tracks;
    } catch (err) {
        console.error('[Database] Error fetching tracks:', err.message);
        return [];
    }
}

async function createTrack(track) {
    if (!db) return null;
    try {
        if (!track.id) track.id = uuid();
        if (!track.created_at) track.created_at = now();
        track.updated_at = now();
        const { sql, values } = buildInsert('tracks', track);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tracks WHERE id = ?').get(track.id));
    } catch (err) {
        console.error('[Database] Error creating track:', err.message);
        return null;
    }
}

async function createTrackSteps(steps) {
    if (!db) return null;
    try {
        const insertMany = db.transaction((items) => {
            const results = [];
            for (const step of items) {
                if (!step.id) step.id = uuid();
                if (!step.created_at) step.created_at = now();
                step.updated_at = now();
                const { sql, values } = buildInsert('track_steps', step);
                db.prepare(sql).run(...values);
                results.push(deserRow(db.prepare('SELECT * FROM track_steps WHERE id = ?').get(step.id)));
            }
            return results;
        });
        return insertMany(steps);
    } catch (err) {
        console.error('[Database] Error creating track steps:', err.message);
        return null;
    }
}

async function updateTrack(trackId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('tracks', { ...updates }, 'id', trackId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId));
    } catch (err) {
        console.error('[Database] Error updating track:', err.message);
        return null;
    }
}

// ============================================================================
// WORKFLOW OPERATIONS (React Flow visual editor)
// ============================================================================

async function getWorkflows(templatesOnly = false) {
    if (!db) return [];
    try {
        const sql = templatesOnly
            ? 'SELECT * FROM workflows WHERE is_template = 1 ORDER BY name'
            : 'SELECT * FROM workflows ORDER BY name';
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching workflows:', err.message);
        return [];
    }
}

async function saveWorkflow(workflow) {
    if (!db) return null;
    try {
        if (!workflow.id) workflow.id = uuid();
        workflow.updated_at = now();
        if (!workflow.created_at) workflow.created_at = now();
        const { sql, values } = buildInsert('workflows', workflow, 'id');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflow.id));
    } catch (err) {
        console.error('[Database] Error saving workflow:', err.message);
        return null;
    }
}

// ============================================================================
// DASHBOARD STATISTICS
// ============================================================================

async function getDashboardStats() {
    if (!db) return {
        tasksByStatus: {}, activeProjectWorkflows: 0,
        artifactsInReview: { total: 0, project: 0, task: 0, items: [] }
    };

    try {
        // 1. Tasks
        const tasks = db.prepare(`
            SELECT id, project_id, name, status, research_output, plan_output,
                   walkthrough, research_metadata, plan_metadata, supervisor_status
            FROM tasks
        `).all();

        // Archived projects are retired — their artifacts should never appear in the review queue.
        const archivedProjectIds = new Set(
            db.prepare("SELECT id FROM projects WHERE status = 'archived'").all().map(r => r.id)
        );

        // Finished tasks never need review. Was only 'cancelled'/'complete',
        // which let archived/done/completed tasks keep their artifacts in the
        // queue forever (archiving a project cascades status='archived' to its
        // tasks — see archiveProject — but those still slipped through here).
        // Statuses are free snake_case/dash text, so normalize before matching.
        const TERMINAL_TASK_STATUSES = new Set(['cancelled', 'canceled', 'complete', 'completed', 'done', 'archived']);
        const isTerminalTaskStatus = (status) =>
            TERMINAL_TASK_STATUSES.has(String(status || '').toLowerCase().replace(/-/g, '_'));

        const tasksByStatus = {};
        const reviewItems = [];

        tasks.forEach(task => {
            tasksByStatus[task.status] = (tasksByStatus[task.status] || 0) + 1;
            if (isTerminalTaskStatus(task.status)) return;
            if (archivedProjectIds.has(task.project_id)) return;

            const parsed = parseTaskFields({ ...task });
            if (parsed.researchReport?.content && !parsed.researchReport.approvedAt && !parsed.researchReport.rejectedAt) {
                reviewItems.push({ type: 'task-research', id: task.id, projectId: task.project_id, name: `Research: ${task.name}`, level: 'Task' });
            }
            if (parsed.implementationPlan?.content && !parsed.implementationPlan.approvedAt && !parsed.implementationPlan.rejectedAt) {
                reviewItems.push({ type: 'task-plan', id: task.id, projectId: task.project_id, name: `Plan: ${task.name}`, level: 'Task' });
            }
            if (parsed.walkthrough?.content && !parsed.walkthrough.approvedAt && !parsed.walkthrough.rejectedAt) {
                reviewItems.push({ type: 'task-walkthrough', id: task.id, projectId: task.project_id, name: `Walkthrough: ${task.name}`, level: 'Task' });
            }
        });

        // 2. Project Workflows
        const workflows = db.prepare('SELECT id, project_id, name, status, current_stage FROM project_workflows').all();
        let activeWorkflows = 0;
        workflows.forEach(wf => {
            if (archivedProjectIds.has(wf.project_id)) return;
            if (wf.status === 'in_progress') activeWorkflows++;
            if (wf.status === 'review') {
                reviewItems.push({ type: 'project-workflow', id: wf.id, projectId: wf.project_id, name: `Workflow: ${wf.name}`, level: 'Project' });
            }
        });

        // 3. Context reviews
        const contexts = db.prepare("SELECT project_id, context_type, status FROM project_contexts WHERE status = 'review_pending'").all();
        contexts.forEach(ctx => {
            if (archivedProjectIds.has(ctx.project_id)) return;
            reviewItems.push({ type: 'project-context', id: `${ctx.project_id}-${ctx.context_type}`, projectId: ctx.project_id, name: `Context: ${ctx.context_type}`, level: 'Project' });
        });

        return {
            tasksByStatus, activeProjectWorkflows: activeWorkflows,
            artifactsInReview: {
                total: reviewItems.length,
                project: reviewItems.filter(i => i.level === 'Project').length,
                task: reviewItems.filter(i => i.level === 'Task').length,
                items: reviewItems
            }
        };
    } catch (error) {
        console.error('[Database] Error fetching dashboard stats:', error.message);
        return { tasksByStatus: {}, activeProjectWorkflows: 0, artifactsInReview: { total: 0, project: 0, task: 0, items: [] } };
    }
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

async function recordUsage(model, inputTokens, outputTokens, source = 'unknown') {
    if (!db) return;
    try {
        const today = new Date().toISOString().split('T')[0];
        const existing = db.prepare('SELECT * FROM usage_stats WHERE date = ? AND model = ? AND source = ?').get(today, model, source);
        if (existing) {
            db.prepare(`
                UPDATE usage_stats SET
                    input_tokens = input_tokens + ?,
                    output_tokens = output_tokens + ?,
                    total_tokens = total_tokens + ?,
                    request_count = request_count + 1
                WHERE date = ? AND model = ? AND source = ?
            `).run(inputTokens, outputTokens, inputTokens + outputTokens, today, model, source);
        } else {
            db.prepare(`
                INSERT INTO usage_stats (id, date, model, input_tokens, output_tokens, total_tokens, request_count, source)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            `).run(uuid(), today, model, inputTokens, outputTokens, inputTokens + outputTokens, source);
        }
    } catch (err) {
        console.error('[Database] Error recording usage:', err.message);
    }
}

function normalizeNumber(value) {
    if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return Number.isFinite(value) ? value : 0;
}

async function getUsageStats(startDate, endDate) {
    if (!db) return [];
    try {
        const rows = db.prepare(
            'SELECT * FROM usage_stats WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT 100'
        ).all(startDate, endDate);
        return rows.map(row => ({
            ...row,
            input_tokens: normalizeNumber(row.input_tokens),
            output_tokens: normalizeNumber(row.output_tokens),
            total_tokens: normalizeNumber(row.total_tokens),
            request_count: normalizeNumber(row.request_count)
        }));
    } catch (err) {
        console.error('[Database] Error fetching usage stats:', err.message);
        return [];
    }
}

// ============================================================================
// DASHBOARD INITIATIVE OPERATIONS
// ============================================================================

async function getDashboardInitiatives(status = null) {
    if (!db) return [];
    try {
        const sql = status
            ? 'SELECT * FROM dashboard_initiatives WHERE status = ? ORDER BY created_at DESC'
            : 'SELECT * FROM dashboard_initiatives ORDER BY created_at DESC';
        return deserRows(status ? db.prepare(sql).all(status) : db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching dashboard initiatives:', err.message);
        return [];
    }
}

async function getDashboardInitiative(initiativeId) {
    if (!db) return null;
    try {
        return deserRow(db.prepare('SELECT * FROM dashboard_initiatives WHERE id = ?').get(initiativeId)) || null;
    } catch (err) {
        console.error('[Database] Error fetching dashboard initiative:', err.message);
        return null;
    }
}

async function createDashboardInitiative(initiative) {
    if (!db) return null;
    try {
        if (!initiative.id) initiative.id = uuid();
        if (!initiative.created_at) initiative.created_at = now();
        initiative.updated_at = now();
        const { sql, values } = buildInsert('dashboard_initiatives', initiative);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM dashboard_initiatives WHERE id = ?').get(initiative.id));
    } catch (err) {
        console.error('[Database] Error creating dashboard initiative:', err.message);
        return null;
    }
}

async function updateDashboardInitiative(initiativeId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('dashboard_initiatives', { ...updates }, 'id', initiativeId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM dashboard_initiatives WHERE id = ?').get(initiativeId));
    } catch (err) {
        console.error('[Database] Error updating dashboard initiative:', err.message);
        return null;
    }
}

async function deleteDashboardInitiative(initiativeId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM dashboard_initiatives WHERE id = ?').run(initiativeId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting dashboard initiative:', err.message);
        return false;
    }
}

async function getInitiativeProgress(initiativeId) {
    if (!db) return [];
    try {
        // Manual join: initiative_project_status + projects
        const rows = db.prepare(`
            SELECT ips.*, p.id as p_id, p.name as p_name, p.path as p_path
            FROM initiative_project_status ips
            LEFT JOIN projects p ON ips.project_id = p.id
            WHERE ips.initiative_id = ?
            ORDER BY ips.started_at DESC
        `).all(initiativeId);

        return deserRows(rows).map(row => ({
            ...row,
            project: row.p_id ? { id: row.p_id, name: row.p_name, path: row.p_path } : null,
            p_id: undefined, p_name: undefined, p_path: undefined
        }));
    } catch (err) {
        console.error('[Database] Error fetching initiative progress:', err.message);
        return [];
    }
}

async function updateInitiativeProjectStatus(initiativeId, projectId, statusUpdate) {
    if (!db) return null;
    try {
        const row = {
            id: uuid(),
            initiative_id: initiativeId,
            project_id: projectId,
            ...statusUpdate,
            updated_at: now()
        };
        const { sql, values } = buildInsert('initiative_project_status', row, 'initiative_id,project_id');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM initiative_project_status WHERE initiative_id = ? AND project_id = ?')
                .get(initiativeId, projectId)
        );
    } catch (err) {
        console.error('[Database] Error updating initiative project status:', err.message);
        return null;
    }
}

// ============================================================================
// PROJECT WORKFLOW OPERATIONS
// ============================================================================

async function getProjectWorkflows(projectId, status = null) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM project_workflows WHERE project_id = ?';
        const params = [projectId];
        if (status) { sql += ' AND status = ?'; params.push(status); }
        sql += ' ORDER BY created_at DESC';
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching project workflows:', err.message);
        return [];
    }
}

async function getProjectWorkflow(workflowId) {
    if (!db) return null;
    try {
        const row = db.prepare(`
            SELECT pw.*, p.id as p_id, p.name as p_name, p.path as p_path
            FROM project_workflows pw
            LEFT JOIN projects p ON pw.project_id = p.id
            WHERE pw.id = ?
        `).get(workflowId);
        if (!row) return null;
        const result = deserRow(row);
        result.project = row.p_id ? { id: row.p_id, name: row.p_name, path: row.p_path } : null;
        delete result.p_id; delete result.p_name; delete result.p_path;
        return result;
    } catch (err) {
        console.error('[Database] Error fetching project workflow:', err.message);
        return null;
    }
}

async function createProjectWorkflow(workflow) {
    if (!db) return null;
    try {
        if (!workflow.id) workflow.id = uuid();
        if (!workflow.created_at) workflow.created_at = now();
        workflow.updated_at = now();
        const { sql, values } = buildInsert('project_workflows', workflow);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM project_workflows WHERE id = ?').get(workflow.id));
    } catch (err) {
        console.error('[Database] Error creating project workflow:', err.message);
        return null;
    }
}

async function updateProjectWorkflow(workflowId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('project_workflows', { ...updates }, 'id', workflowId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM project_workflows WHERE id = ?').get(workflowId));
    } catch (err) {
        console.error('[Database] Error updating project workflow:', err.message);
        return null;
    }
}

async function deleteProjectWorkflow(workflowId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM project_workflows WHERE id = ?').run(workflowId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting project workflow:', err.message);
        return false;
    }
}

// ============================================================================
// MODEL OPERATIONS
// ============================================================================

async function getModels(activeOnly = true) {
    if (!db) throw new Error('Database connection required for models');
    try {
        const sql = activeOnly
            ? 'SELECT * FROM models WHERE is_active = 1 ORDER BY sort_order'
            : 'SELECT * FROM models ORDER BY sort_order';
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching models:', err.message);
        throw new Error(`Failed to fetch models: ${err.message}`);
    }
}

async function getModel(modelId) {
    if (!db) throw new Error('Database connection required for models');
    try {
        const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching model:', err.message);
        throw new Error(`Failed to fetch model: ${err.message}`);
    }
}

async function upsertModel(model) {
    if (!db) throw new Error('Database connection required for models');
    try {
        model.updated_at = now();
        if (!model.created_at) model.created_at = now();
        const { sql, values } = buildInsert('models', model, 'id');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM models WHERE id = ?').get(model.id));
    } catch (err) {
        console.error('[Database] Error upserting model:', err.message);
        throw new Error(`Failed to upsert model: ${err.message}`);
    }
}

async function deleteModel(modelId) {
    if (!db) throw new Error('Database connection required for models');
    try {
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting model:', err.message);
        throw new Error(`Failed to delete model: ${err.message}`);
    }
}

async function getDefaultModelForTask(taskType) {
    if (!db) throw new Error('Database connection required for models');
    try {
        const row = db.prepare(
            'SELECT * FROM models WHERE is_default_for_task = ? AND is_active = 1'
        ).get(taskType);
        return deserRow(row) || null;
    } catch (err) {
        console.error('[Database] Error fetching default model for task:', err.message);
        throw new Error(`Failed to fetch default model: ${err.message}`);
    }
}

async function upsertModelAlias(aliasRecord) {
    if (!db) throw new Error('Database connection required for model aliases');
    try {
        const record = {
            alias: aliasRecord.alias,
            target: aliasRecord.target,
            description: aliasRecord.description || null,
            is_active: aliasRecord.is_active === undefined ? 1 : aliasRecord.is_active,
            updated_at: now(),
            created_at: aliasRecord.created_at || now()
        };
        const { sql, values } = buildInsert('model_aliases', record, 'alias');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM model_aliases WHERE alias = ?').get(record.alias));
    } catch (err) {
        console.error('[Database] Error upserting model alias:', err.message);
        throw new Error(`Failed to upsert model alias: ${err.message}`);
    }
}

async function getModelAliases(activeOnly = true) {
    if (!db) throw new Error('Database connection required for model aliases');
    try {
        const sql = activeOnly
            ? 'SELECT * FROM model_aliases WHERE is_active = 1 ORDER BY alias'
            : 'SELECT * FROM model_aliases ORDER BY alias';
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching model aliases:', err.message);
        throw new Error(`Failed to fetch model aliases: ${err.message}`);
    }
}

async function upsertModelRole(roleRecord) {
    if (!db) throw new Error('Database connection required for model roles');
    try {
        const record = {
            role: roleRecord.role,
            assignment: roleRecord.assignment,
            description: roleRecord.description || null,
            is_active: roleRecord.is_active === undefined ? 1 : roleRecord.is_active,
            updated_at: now(),
            created_at: roleRecord.created_at || now()
        };
        const { sql, values } = buildInsert('model_roles', record, 'role');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM model_roles WHERE role = ?').get(record.role));
    } catch (err) {
        console.error('[Database] Error upserting model role:', err.message);
        throw new Error(`Failed to upsert model role: ${err.message}`);
    }
}

async function getModelRoles(activeOnly = true) {
    if (!db) throw new Error('Database connection required for model roles');
    try {
        const sql = activeOnly
            ? 'SELECT * FROM model_roles WHERE is_active = 1 ORDER BY role'
            : 'SELECT * FROM model_roles ORDER BY role';
        return deserRows(db.prepare(sql).all());
    } catch (err) {
        console.error('[Database] Error fetching model roles:', err.message);
        throw new Error(`Failed to fetch model roles: ${err.message}`);
    }
}

async function getModelRole(role) {
    if (!db) throw new Error('Database connection required for model roles');
    try {
        return deserRow(db.prepare('SELECT * FROM model_roles WHERE role = ?').get(role)) || null;
    } catch (err) {
        console.error('[Database] Error fetching model role:', err.message);
        throw new Error(`Failed to fetch model role: ${err.message}`);
    }
}

async function upsertProjectModelAlias(projectId, aliasRecord) {
    if (!db) throw new Error('Database connection required for project model aliases');
    try {
        const record = {
            project_id: projectId,
            alias: aliasRecord.alias,
            target: aliasRecord.target,
            description: aliasRecord.description || null,
            updated_at: now(),
            created_at: aliasRecord.created_at || now()
        };
        const { sql, values } = buildInsert('project_model_aliases', record, 'project_id, alias');
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM project_model_aliases WHERE project_id = ? AND alias = ?').get(projectId, record.alias));
    } catch (err) {
        console.error('[Database] Error upserting project model alias:', err.message);
        throw new Error(`Failed to upsert project model alias: ${err.message}`);
    }
}

async function getProjectModelAliases(projectId) {
    if (!db) throw new Error('Database connection required for project model aliases');
    try {
        return deserRows(db.prepare('SELECT * FROM project_model_aliases WHERE project_id = ? ORDER BY alias').all(projectId));
    } catch (err) {
        console.error('[Database] Error fetching project model aliases:', err.message);
        throw new Error(`Failed to fetch project model aliases: ${err.message}`);
    }
}

async function setModelControlSetting(key, value) {
    if (!db) throw new Error('Database connection required for model control settings');
    try {
        const record = { key, value, updated_at: now() };
        const { sql, values } = buildInsert('model_control_settings', record, 'key');
        db.prepare(sql).run(...values);
        return getModelControlSetting(key);
    } catch (err) {
        console.error('[Database] Error setting model control setting:', err.message);
        throw new Error(`Failed to set model control setting: ${err.message}`);
    }
}

async function getModelControlSetting(key) {
    if (!db) throw new Error('Database connection required for model control settings');
    try {
        const row = deserRow(db.prepare('SELECT * FROM model_control_settings WHERE key = ?').get(key));
        return row ? row.value : null;
    } catch (err) {
        console.error('[Database] Error fetching model control setting:', err.message);
        throw new Error(`Failed to fetch model control setting: ${err.message}`);
    }
}

async function setProjectModelControlSetting(projectId, key, value) {
    if (!db) throw new Error('Database connection required for project model control settings');
    try {
        const record = { project_id: projectId, key, value, updated_at: now() };
        const { sql, values } = buildInsert('project_model_control_settings', record, 'project_id, key');
        db.prepare(sql).run(...values);
        return getProjectModelControlSetting(projectId, key);
    } catch (err) {
        console.error('[Database] Error setting project model control setting:', err.message);
        throw new Error(`Failed to set project model control setting: ${err.message}`);
    }
}

async function getProjectModelControlSetting(projectId, key) {
    if (!db) throw new Error('Database connection required for project model control settings');
    try {
        const row = deserRow(db.prepare('SELECT * FROM project_model_control_settings WHERE project_id = ? AND key = ?').get(projectId, key));
        return row ? row.value : null;
    } catch (err) {
        console.error('[Database] Error fetching project model control setting:', err.message);
        throw new Error(`Failed to fetch project model control setting: ${err.message}`);
    }
}

async function createModelExecutionSnapshot(snapshot) {
    if (!db) throw new Error('Database connection required for model execution snapshots');
    try {
        const record = {
            id: snapshot.id || uuid(),
            ...snapshot,
            local_only_active: snapshot.local_only_active ? 1 : 0,
            fallback_used: snapshot.fallback_used ? 1 : 0,
            created_at: snapshot.created_at || now()
        };
        const { sql, values } = buildInsert('model_execution_snapshots', record);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM model_execution_snapshots WHERE id = ?').get(record.id));
    } catch (err) {
        console.error('[Database] Error creating model execution snapshot:', err.message);
        throw new Error(`Failed to create model execution snapshot: ${err.message}`);
    }
}

async function getModelExecutionSnapshots(filters = {}) {
    if (!db) throw new Error('Database connection required for model execution snapshots');
    try {
        const where = [];
        const values = [];
        const filterMap = {
            projectId: 'project_id',
            taskId: 'task_id',
            calendarEventId: 'calendar_event_id',
            workflowId: 'workflow_id',
            workflowRunId: 'workflow_run_id',
            nodeId: 'node_id',
            conversationId: 'conversation_id',
            messageId: 'message_id',
            commandId: 'command_id',
            provider: 'provider',
            resolvedModelId: 'resolved_model_id',
        };

        for (const [inputKey, column] of Object.entries(filterMap)) {
            if (filters[inputKey]) {
                where.push(`${column} = ?`);
                values.push(filters[inputKey]);
            }
        }

        if (filters.fallbackUsed !== undefined) {
            where.push('fallback_used = ?');
            values.push(filters.fallbackUsed ? 1 : 0);
        }
        if (filters.localOnlyActive !== undefined) {
            where.push('local_only_active = ?');
            values.push(filters.localOnlyActive ? 1 : 0);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
        const offset = Math.max(Number(filters.offset) || 0, 0);

        const total = db.prepare(`SELECT COUNT(*) AS count FROM model_execution_snapshots ${whereSql}`).get(...values).count;
        const snapshots = deserRows(db.prepare(`
            SELECT *
            FROM model_execution_snapshots
            ${whereSql}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `).all(...values, limit, offset));

        return { snapshots, total, limit, offset };
    } catch (err) {
        console.error('[Database] Error fetching model execution snapshots:', err.message);
        throw new Error(`Failed to fetch model execution snapshots: ${err.message}`);
    }
}

// ============================================================================
// NEW WRAPPER FUNCTIONS (for server consumers that used db.supabase directly)
// ============================================================================

// --- Audit Log ---
async function insertAuditLog(entry) {
    if (!db) return null;
    try {
        if (!entry.id) entry.id = uuid();
        if (!entry.created_at) entry.created_at = now();
        const { sql, values } = buildInsert('agent_audit_log', entry);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM agent_audit_log WHERE id = ?').get(entry.id));
    } catch (err) {
        console.error('[Database] Error inserting audit log:', err.message);
        return null;
    }
}

async function getAuditLogs(filters = {}) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM agent_audit_log WHERE 1=1';
        const params = [];
        if (filters.action) { sql += ' AND action = ?'; params.push(filters.action); }
        if (filters.actor) { sql += ' AND actor = ?'; params.push(filters.actor); }
        if (filters.target_type) { sql += ' AND target_type = ?'; params.push(filters.target_type); }
        if (filters.target_id) { sql += ' AND target_id = ?'; params.push(filters.target_id); }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(filters.limit || 100);
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching audit logs:', err.message);
        return [];
    }
}

async function getAuditLogEntry(id) {
    if (!db) return null;
    try {
        return deserRow(db.prepare('SELECT * FROM agent_audit_log WHERE id = ?').get(id)) || null;
    } catch (err) {
        console.error('[Database] Error fetching audit log entry:', err.message);
        return null;
    }
}

// --- API Quotas ---
async function getQuota(endpoint, period = 'daily') {
    if (!db) return null;
    try {
        return deserRow(db.prepare('SELECT * FROM usage_quotas WHERE endpoint = ? AND period = ?').get(endpoint, period)) || null;
    } catch (err) {
        console.error('[Database] Error fetching quota:', err.message);
        return null;
    }
}

async function upsertQuota(quota) {
    if (!db) return null;
    try {
        if (!quota.id) quota.id = uuid();
        quota.updated_at = now();
        const { sql, values } = buildInsert('usage_quotas', quota, 'endpoint,period');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM usage_quotas WHERE endpoint = ? AND period = ?')
                .get(quota.endpoint, quota.period)
        );
    } catch (err) {
        console.error('[Database] Error upserting quota:', err.message);
        return null;
    }
}

async function updateQuota(id, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('usage_quotas', { ...updates }, 'id', id);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM usage_quotas WHERE id = ?').get(id));
    } catch (err) {
        console.error('[Database] Error updating quota:', err.message);
        return null;
    }
}

// --- MCP Scopes ---
async function getMcpScopes() {
    if (!db) return [];
    try {
        return deserRows(db.prepare('SELECT * FROM mcp_server_scopes ORDER BY server_name').all());
    } catch (err) {
        console.error('[Database] Error fetching MCP scopes:', err.message);
        return [];
    }
}

async function upsertMcpScope(scope) {
    if (!db) return null;
    try {
        if (!scope.id) scope.id = uuid();
        scope.updated_at = now();
        if (!scope.created_at) scope.created_at = now();
        const { sql, values } = buildInsert('mcp_server_scopes', scope, 'server_name');
        db.prepare(sql).run(...values);
        return deserRow(
            db.prepare('SELECT * FROM mcp_server_scopes WHERE server_name = ?').get(scope.server_name)
        );
    } catch (err) {
        console.error('[Database] Error upserting MCP scope:', err.message);
        return null;
    }
}

async function deleteMcpScope(serverName) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM mcp_server_scopes WHERE server_name = ?').run(serverName);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting MCP scope:', err.message);
        return false;
    }
}

// --- Execution Steps ---
async function getExecutionSteps(projectId, featureId) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM execution_steps WHERE project_id = ?';
        const params = [projectId];
        if (featureId) { sql += ' AND task_id = ?'; params.push(featureId); }
        sql += ' ORDER BY created_at ASC';
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching execution steps:', err.message);
        return [];
    }
}

async function insertExecutionStep(step) {
    if (!db) return null;
    try {
        if (!step.id) step.id = uuid();
        if (!step.created_at) step.created_at = now();
        const { sql, values } = buildInsert('execution_steps', step);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM execution_steps WHERE id = ?').get(step.id));
    } catch (err) {
        console.error('[Database] Error inserting execution step:', err.message);
        return null;
    }
}

// --- Inline Comments ---
async function getInlineComments(projectId, featureId) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM inline_comments WHERE project_id = ?';
        const params = [projectId];
        if (featureId) { sql += ' AND task_id = ?'; params.push(featureId); }
        sql += ' ORDER BY created_at ASC';
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching inline comments:', err.message);
        return [];
    }
}

async function insertInlineComment(comment) {
    if (!db) return null;
    try {
        if (!comment.id) comment.id = uuid();
        if (!comment.created_at) comment.created_at = now();
        const { sql, values } = buildInsert('inline_comments', comment);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM inline_comments WHERE id = ?').get(comment.id));
    } catch (err) {
        console.error('[Database] Error inserting inline comment:', err.message);
        return null;
    }
}

async function updateInlineComment(commentId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('inline_comments', { ...updates }, 'id', commentId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM inline_comments WHERE id = ?').get(commentId));
    } catch (err) {
        console.error('[Database] Error updating inline comment:', err.message);
        return null;
    }
}

// ============================================================================
// NOTES (Agent Scratchpad)
// ============================================================================

/**
 * Get notes, optionally filtered by project.
 * If projectId is null/undefined, returns global notes (project_id IS NULL).
 * If projectId is a string, returns notes for that project.
 * If projectId is '__all__', returns all notes.
 */
async function getNotes(projectId) {
    if (!db) return [];
    try {
        if (projectId === '__all__') {
            return deserRows(db.prepare('SELECT * FROM notes ORDER BY pinned DESC, created_at DESC').all());
        } else if (projectId) {
            return deserRows(db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY pinned DESC, created_at DESC').all(projectId));
        } else {
            return deserRows(db.prepare('SELECT * FROM notes WHERE project_id IS NULL ORDER BY pinned DESC, created_at DESC').all());
        }
    } catch (err) {
        console.error('[Database] Error fetching notes:', err.message);
        return [];
    }
}

async function createNote({ project_id, content, category, source }) {
    if (!db) return null;
    try {
        const note = {
            id: crypto.randomUUID(),
            project_id: project_id || null,
            content,
            category: category || 'general',
            source: source || 'praxis',
            pinned: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        const { sql, values } = buildInsert('notes', note);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id));
    } catch (err) {
        console.error('[Database] Error creating note:', err.message);
        return null;
    }
}

async function updateNote(noteId, updates) {
    if (!db) return null;
    try {
        updates.updated_at = new Date().toISOString();
        const { sql, values } = buildUpdate('notes', { ...updates }, 'id', noteId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId));
    } catch (err) {
        console.error('[Database] Error updating note:', err.message);
        return null;
    }
}

async function deleteNote(noteId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting note:', err.message);
        return false;
    }
}

/**
 * Mark a note as ingested into The Cortex (Neo4j + Pinecone).
 * Stamps cortex_ingested_at with the current ISO timestamp.
 */
async function markNoteIngested(noteId) {
    if (!db) return null;
    try {
        db.prepare(
            'UPDATE notes SET cortex_ingested_at = ?, updated_at = ? WHERE id = ?'
        ).run(new Date().toISOString(), new Date().toISOString(), noteId);
        return deserRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId));
    } catch (err) {
        console.error('[Database] Error marking note ingested:', err.message);
        return null;
    }
}

/**
 * Get notes that have NOT been ingested into The Cortex.
 * Optionally filter by category (e.g., 'ingested', 'daily-log', 'revenue-ideas').
 */
async function getUningestedNotes(category = null) {
    if (!db) return [];
    try {
        if (category) {
            return deserRows(
                db.prepare(
                    'SELECT * FROM notes WHERE cortex_ingested_at IS NULL AND category = ? ORDER BY created_at DESC'
                ).all(category)
            );
        }
        return deserRows(
            db.prepare(
                'SELECT * FROM notes WHERE cortex_ingested_at IS NULL ORDER BY created_at DESC'
            ).all()
        );
    } catch (err) {
        console.error('[Database] Error fetching uningested notes:', err.message);
        return [];
    }
}

// ============================================================================
// CONTACTS (shared stakeholder directory + per-project role links)
// ============================================================================

async function listContacts({ search = null, limit = 200 } = {}) {
    if (!db) return [];
    try {
        if (search) {
            const q = `%${search.toLowerCase()}%`;
            return deserRows(db.prepare(
                `SELECT * FROM contacts
                 WHERE lower(name) LIKE ? OR lower(coalesce(email,'')) LIKE ? OR lower(coalesce(relationship,'')) LIKE ?
                 ORDER BY name COLLATE NOCASE LIMIT ?`
            ).all(q, q, q, limit));
        }
        return deserRows(db.prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE LIMIT ?').all(limit));
    } catch (err) {
        console.error('[Database] Error listing contacts:', err.message);
        return [];
    }
}

async function getContact(id) {
    if (!db) return null;
    const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!row) return null;
    const contact = deserRow(row);
    contact.projects = deserRows(db.prepare(
        `SELECT pc.project_id, pc.role, pc.notes AS link_notes, pc.added_at, p.name AS project_name
         FROM project_contacts pc JOIN projects p ON p.id = pc.project_id
         WHERE pc.contact_id = ? ORDER BY pc.added_at DESC`
    ).all(id));
    return contact;
}

async function findContactByEmail(email) {
    if (!db || !email) return null;
    const row = db.prepare('SELECT * FROM contacts WHERE lower(email) = lower(?)').get(String(email).trim());
    return row ? deserRow(row) : null;
}

/**
 * Mint a unique seat id for a human member: "human:<name-slug>", suffixed
 * -2/-3… on collision. The seat id is the council reputation ledger's key,
 * so it must be stable and unique for the member's lifetime.
 */
function mintSeatId(name) {
    const slug = String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'member';
    let candidate = `human:${slug}`;
    for (let n = 2; n < 100; n++) {
        const taken = db.prepare('SELECT 1 FROM contacts WHERE seat_id = ?').get(candidate);
        if (!taken) return candidate;
        candidate = `human:${slug}-${n}`;
    }
    return `human:${slug}-${crypto.randomUUID().slice(0, 6)}`;
}

async function createContact({ name, email, phone, relationship, birthday, notes, preferences, expertise, interests, claims, source, kind, seat_id, status }) {
    if (!db) return null;
    try {
        const memberKind = kind === 'ai' ? 'ai' : 'human';
        const contact = {
            id: crypto.randomUUID(),
            name: String(name).trim(),
            kind: memberKind,
            // AI members carry their council seat id ("cli:codex"); humans get
            // a minted "human:<slug>" unless the caller supplied one.
            seat_id: seat_id || (memberKind === 'human' ? mintSeatId(name) : null),
            email: email ? String(email).trim() : null,
            phone: phone || null,
            relationship: relationship || null,
            birthday: birthday || null,
            notes: notes || null,
            preferences: JSON.stringify(preferences || {}),
            expertise: JSON.stringify(expertise || []),
            interests: JSON.stringify(interests || []),
            claims: JSON.stringify(claims || []),
            interaction_log: JSON.stringify([]),
            status: status === 'dormant' ? 'dormant' : 'active',
            source: source || 'operator',
            last_contact_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        const { sql, values } = buildInsert('contacts', contact);
        db.prepare(sql).run(...values);
        return getContact(contact.id);
    } catch (err) {
        console.error('[Database] Error creating contact:', err.message);
        return null;
    }
}

async function findContactBySeat(seatId) {
    if (!db || !seatId) return null;
    const row = db.prepare('SELECT * FROM contacts WHERE seat_id = ?').get(String(seatId).trim());
    return row ? deserRow(row) : null;
}

/** Append a Praxis interaction note ({ note, source?, at? }); optionally stamp last_contact_at. */
async function appendContactLog(id, { note, source, at, touchContact = false } = {}) {
    if (!db || !note) return null;
    try {
        const row = db.prepare('SELECT interaction_log FROM contacts WHERE id = ?').get(id);
        if (!row) return null;
        let log = [];
        try {
            log = JSON.parse(row.interaction_log || '[]');
        } catch { /* rebuild from empty */ }
        log.push({ at: at || new Date().toISOString(), note: String(note).slice(0, 2000), source: source || 'praxis' });
        // Keep the log bounded — the newest 200 entries tell the story.
        if (log.length > 200) log = log.slice(-200);
        const now = new Date().toISOString();
        db.prepare(
            `UPDATE contacts SET interaction_log = ?, updated_at = ?${touchContact ? ', last_contact_at = ?' : ''} WHERE id = ?`
        ).run(...(touchContact ? [JSON.stringify(log), now, now, id] : [JSON.stringify(log), now, id]));
        return getContact(id);
    } catch (err) {
        console.error('[Database] Error appending contact log:', err.message);
        return null;
    }
}

async function updateContact(id, updates) {
    if (!db) return null;
    const allowed = ['name', 'email', 'phone', 'relationship', 'birthday', 'notes', 'preferences', 'expertise', 'interests', 'claims', 'status', 'kind', 'seat_id', 'last_contact_at'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
        if (!(key in updates)) continue;
        sets.push(`${key} = ?`);
        const v = updates[key];
        values.push(JSON_COLS.has(key) ? JSON.stringify(v ?? (key === 'preferences' ? {} : [])) : (v ?? null));
    }
    if (sets.length === 0) return getContact(id);
    sets.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    try {
        const result = db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
        return result.changes > 0 ? getContact(id) : null;
    } catch (err) {
        console.error('[Database] Error updating contact:', err.message);
        return null;
    }
}

async function deleteContact(id) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM project_contacts WHERE contact_id = ?').run(id);
        return db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes > 0;
    } catch (err) {
        console.error('[Database] Error deleting contact:', err.message);
        return false;
    }
}

/** Contacts attached to a project, joined with their per-project role. */
async function listProjectContacts(projectId) {
    if (!db) return [];
    try {
        return deserRows(db.prepare(
            `SELECT c.*, pc.role, pc.notes AS link_notes, pc.added_at
             FROM project_contacts pc JOIN contacts c ON c.id = pc.contact_id
             WHERE pc.project_id = ? ORDER BY pc.added_at ASC`
        ).all(projectId));
    } catch (err) {
        console.error('[Database] Error listing project contacts:', err.message);
        return [];
    }
}

async function linkContactToProject(projectId, contactId, { role, notes } = {}) {
    if (!db) return false;
    try {
        // Re-linking is an upsert that never downgrades operator data: an
        // existing role/notes wins over the incoming default (role edits go
        // through updateProjectContactLink instead).
        db.prepare(
            `INSERT INTO project_contacts (project_id, contact_id, role, notes, added_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project_id, contact_id) DO UPDATE SET
               role = coalesce(project_contacts.role, excluded.role),
               notes = coalesce(project_contacts.notes, excluded.notes)`
        ).run(projectId, contactId, role || null, notes || null, new Date().toISOString());
        return true;
    } catch (err) {
        console.error('[Database] Error linking contact:', err.message);
        return false;
    }
}

async function updateProjectContactLink(projectId, contactId, { role, notes }) {
    if (!db) return false;
    try {
        const result = db.prepare(
            `UPDATE project_contacts SET role = ?, notes = ? WHERE project_id = ? AND contact_id = ?`
        ).run(role ?? null, notes ?? null, projectId, contactId);
        return result.changes > 0;
    } catch (err) {
        console.error('[Database] Error updating contact link:', err.message);
        return false;
    }
}

async function unlinkContactFromProject(projectId, contactId) {
    if (!db) return false;
    try {
        return db.prepare('DELETE FROM project_contacts WHERE project_id = ? AND contact_id = ?')
            .run(projectId, contactId).changes > 0;
    } catch (err) {
        console.error('[Database] Error unlinking contact:', err.message);
        return false;
    }
}

/**
 * Observe a communication with a (possibly new) human — used by Praxis's
 * feedback pipeline. Upserts by email (never clobbers operator-entered
 * fields), stamps last_contact_at, and optionally links to a project by
 * NAME (case-insensitive) with a default role.
 */
async function observeContact({ email, name, projectName, role, source } = {}) {
    if (!db || !email) return null;
    try {
        let contact = await findContactByEmail(email);
        if (!contact) {
            contact = await createContact({
                name: name || String(email).split('@')[0],
                email,
                source: source || 'feedback'
            });
            if (!contact) return null;
        }
        db.prepare('UPDATE contacts SET last_contact_at = ?, updated_at = ? WHERE id = ?')
            .run(new Date().toISOString(), new Date().toISOString(), contact.id);
        if (projectName) {
            const project = db.prepare('SELECT id FROM projects WHERE lower(name) = lower(?)').get(String(projectName).trim());
            if (project) await linkContactToProject(project.id, contact.id, { role: role || 'Tester' });
        }
        return getContact(contact.id);
    } catch (err) {
        console.error('[Database] Error observing contact:', err.message);
        return null;
    }
}

// ============================================================================
// CHAT CONVERSATIONS & MESSAGES (persistent Praxis / terminal chat history)
// ============================================================================

// No artificial message cap — we'll compress data as needed

/**
 * Get all conversations for a mode, newest first.
 */
async function getChatConversations(mode = 'praxis') {
    if (!db) return [];
    try {
        const rows = db.prepare(
            `SELECT c.*, 
                    (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
                    (SELECT content FROM chat_messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at ASC LIMIT 1) as first_message
             FROM chat_conversations c
             WHERE c.mode = ?
             ORDER BY c.updated_at DESC`
        ).all(mode);
        return rows.map(row => {
            row.is_active = row.is_active === 1 || row.is_active === true;
            return row;
        });
    } catch (err) {
        console.error('[Database] Error fetching conversations:', err.message);
        return [];
    }
}

/**
 * Get or create the active conversation for a mode.
 * If none exists, creates one automatically.
 */
async function getActiveConversation(mode = 'praxis') {
    if (!db) return null;
    try {
        let row = db.prepare(
            'SELECT * FROM chat_conversations WHERE mode = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1'
        ).get(mode);
        if (!row) {
            // Auto-create first conversation
            row = await createConversation(mode);
        }
        if (row) row.is_active = row.is_active === 1 || row.is_active === true;
        return row;
    } catch (err) {
        console.error('[Database] Error getting active conversation:', err.message);
        return null;
    }
}

/**
 * Create a new conversation and mark it as active.
 * Deactivates any previously active conversation for the same mode.
 */
async function createConversation(mode = 'praxis', title = 'New Conversation') {
    if (!db) return null;
    try {
        // Deactivate all other conversations for this mode
        db.prepare('UPDATE chat_conversations SET is_active = 0 WHERE mode = ?').run(mode);

        const id = uuid();
        const timestamp = now();
        db.prepare(
            `INSERT INTO chat_conversations (id, title, mode, is_active, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`
        ).run(id, title, mode, timestamp, timestamp);

        return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id);
    } catch (err) {
        console.error('[Database] Error creating conversation:', err.message);
        return null;
    }
}

/**
 * Switch active conversation — deactivate all, activate the target.
 */
async function switchConversation(conversationId) {
    if (!db) return null;
    try {
        const conv = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(conversationId);
        if (!conv) return null;

        // Deactivate all for this mode, activate the target
        db.prepare('UPDATE chat_conversations SET is_active = 0 WHERE mode = ?').run(conv.mode);
        db.prepare('UPDATE chat_conversations SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), conversationId);

        return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(conversationId);
    } catch (err) {
        console.error('[Database] Error switching conversation:', err.message);
        return null;
    }
}

/**
 * Update conversation title.
 */
async function updateConversationTitle(conversationId, title) {
    if (!db) return null;
    try {
        db.prepare('UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), conversationId);
        return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(conversationId);
    } catch (err) {
        console.error('[Database] Error updating conversation title:', err.message);
        return null;
    }
}

/**
 * Delete a conversation and all its messages (CASCADE).
 */
async function deleteConversation(conversationId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(conversationId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting conversation:', err.message);
        return false;
    }
}

/**
 * Get messages for a specific conversation.
 * Supports pagination: options.limit and options.before (timestamp)
 * Returns messages in chronological (ASC) order, but fetches newest first.
 */
async function getChatMessages(conversationId, options = {}) {
    if (!db) return [];
    
    // Handle legacy call signature: getChatMessages(id, limit)
    let limit = 200;
    let before = null;
    
    if (typeof options === 'number') {
        limit = options;
    } else {
        limit = options.limit || 200;
        before = options.before || null;
    }

    try {
        let sql = 'SELECT * FROM chat_messages WHERE conversation_id = ?';
        const params = [conversationId];
        
        if (before) {
            sql += ' AND created_at < ?';
            params.push(before);
        }
        
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        
        const rows = db.prepare(sql).all(...params);
        
        // Reverse to return in chronological order (ASC)
        return rows.reverse().map(row => {
            row.metadata = deser(row.metadata);
            return row;
        });
    } catch (err) {
        console.error('[Database] Error fetching chat messages:', err.message);
        return [];
    }
}

/**
 * Save a message to a conversation.
 * Auto-generates title from first user message.
 */
async function saveChatMessage(msg) {
    if (!db) return null;
    try {
        if (!msg.id) msg.id = uuid();
        if (!msg.created_at) msg.created_at = now();
        const conversationId = msg.conversation_id;
        if (!conversationId) {
            console.error('[Database] saveChatMessage: conversation_id is required');
            return null;
        }

        const row = {
            id: msg.id,
            conversation_id: conversationId,
            role: msg.role,
            content: msg.content,
            mode: msg.mode || 'praxis',
            metadata: ser(msg.metadata || {}),
            created_at: msg.created_at
        };

        const { sql, values } = buildInsert('chat_messages', row);
        db.prepare(sql).run(...values);

        // Auto-title: if this is the first user message, derive title from it
        if (msg.role === 'user') {
            const conv = db.prepare('SELECT title FROM chat_conversations WHERE id = ?').get(conversationId);
            if (conv && conv.title === 'New Conversation') {
                const autoTitle = msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : '');
                db.prepare('UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?')
                    .run(autoTitle, now(), conversationId);
            }
        }

        // Touch conversation updated_at
        db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(now(), conversationId);



        return row;
    } catch (err) {
        console.error('[Database] Error saving chat message:', err.message);
        return null;
    }
}

/**
 * Clear all messages in a conversation (but keep the conversation record).
 */
async function clearChatMessages(conversationId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId);
        return true;
    } catch (err) {
        console.error('[Database] Error clearing chat messages:', err.message);
        return false;
    }
}

// ============================================================================
// CALENDAR SYSTEM
// ============================================================================

async function getCalendarEvents(startTime, endTime) {
    if (!db) return [];
    try {
        let sql = 'SELECT * FROM calendar_events ORDER BY start_time ASC';
        let params = [];
        if (startTime && endTime) {
            sql = 'SELECT * FROM calendar_events WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC';
            params = [startTime, endTime];
        }
        return deserRows(db.prepare(sql).all(...params));
    } catch (err) {
        console.error('[Database] Error fetching calendar events:', err.message);
        return [];
    }
}

async function createCalendarEvent(event) {
    if (!db) return null;
    try {
        if (!event.id) event.id = uuid();
        if (!event.created_at) event.created_at = now();
        event.updated_at = now();
        const { sql, values } = buildInsert('calendar_events', event);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id));
    } catch (err) {
        console.error('[Database] Error creating calendar event:', err.message);
        return null;
    }
}

async function updateCalendarEvent(eventId, updates) {
    if (!db) return null;
    try {
        const { sql, values } = buildUpdate('calendar_events', { ...updates }, 'id', eventId);
        db.prepare(sql).run(...values);
        return deserRow(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId));
    } catch (err) {
        console.error('[Database] Error updating calendar event:', err.message);
        return null;
    }
}

async function deleteCalendarEvent(eventId) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
        return true;
    } catch (err) {
        console.error('[Database] Error deleting calendar event:', err.message);
        return false;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    isDatabaseEnabled,
    testConnection,
    // Calendar
    getCalendarEvents,
    createCalendarEvent,
    updateCalendarEvent,
    deleteCalendarEvent,
    // Projects
    getProjects,
    getProject,
    getProjectByPath,
    upsertProject,
    updateProject,
    deleteProject,
    archiveProject,
    unarchiveProject,
    // Tasks
    getTasks,
    getTask,
    createTask,
    updateTask,
    deleteTask,
    // Context
    getProjectContexts,
    updateProjectContext,
    getContextStats,
    // Tracks
    getTracks,
    createTrack,
    createTrackSteps,
    updateTrack,
    // Workflows (React Flow visual editor)
    getWorkflows,
    saveWorkflow,
    // Dashboard Initiatives
    getDashboardInitiatives,
    getDashboardInitiative,
    createDashboardInitiative,
    updateDashboardInitiative,
    deleteDashboardInitiative,
    getInitiativeProgress,
    updateInitiativeProjectStatus,
    // Project Workflows
    getProjectWorkflows,
    getProjectWorkflow,
    createProjectWorkflow,
    updateProjectWorkflow,
    deleteProjectWorkflow,
    // Models
    getModels,
    getModel,
    upsertModel,
    deleteModel,
    getDefaultModelForTask,
    upsertModelAlias,
    getModelAliases,
    upsertModelRole,
    getModelRoles,
    getModelRole,
    upsertProjectModelAlias,
    getProjectModelAliases,
    setModelControlSetting,
    getModelControlSetting,
    setProjectModelControlSetting,
    getProjectModelControlSetting,
    createModelExecutionSnapshot,
    getModelExecutionSnapshots,
    // Usage
    recordUsage,
    getUsageStats,
    getDashboardStats,
    // NEW: Wrapper functions for audit-log, quotas, scopes, timeline, comments
    insertAuditLog,
    getAuditLogs,
    getAuditLogEntry,
    getQuota,
    upsertQuota,
    updateQuota,
    getMcpScopes,
    upsertMcpScope,
    deleteMcpScope,
    getExecutionSteps,
    insertExecutionStep,
    getInlineComments,
    insertInlineComment,
    updateInlineComment,
    // Dual-Payload Task Operations (Phase 1: Executive Planning)
    batchCreateTasks,
    getBoardState,
    reorderTasks,
    // Notes (Agent Scratchpad)
    getNotes,
    createNote,
    updateNote,
    deleteNote,
    markNoteIngested,
    getUningestedNotes,
    // Contacts (shared stakeholder directory + project links)
    listContacts,
    getContact,
    findContactByEmail,
    findContactBySeat,
    createContact,
    updateContact,
    appendContactLog,
    deleteContact,
    listProjectContacts,
    linkContactToProject,
    updateProjectContactLink,
    unlinkContactFromProject,
    observeContact,
    // Chat Conversations & Messages (persistent Praxis chat history)
    getChatConversations,
    getActiveConversation,
    createConversation,
    switchConversation,
    updateConversationTitle,
    deleteConversation,
    getChatMessages,
    saveChatMessage,
    clearChatMessages,
    // Antigravity Event Stream
    // Push Notification Tokens
    registerPushToken,
    unregisterPushToken,
    getActivePushTokens,
    getAllPushTokens,
    markPushTokenSuccess,
    markPushTokenError
};

// ---------------------------------------------------------------------------
// Push Notification Tokens
// ---------------------------------------------------------------------------

async function registerPushToken({ token, deviceId, platform, label }) {
    if (!db) return null;
    try {
        // Upsert: if token exists, update metadata; otherwise insert
        const existing = db.prepare('SELECT id FROM push_tokens WHERE token = ?').get(token);
        if (existing) {
            db.prepare(`
                UPDATE push_tokens 
                SET device_id = COALESCE(?, device_id),
                    platform = COALESCE(?, platform),
                    label = COALESCE(?, label),
                    enabled = 1,
                    error_count = 0,
                    last_error = NULL,
                    updated_at = datetime('now')
                WHERE token = ?
            `).run(deviceId || null, platform || null, label || null, token);
            return { id: existing.id, token, updated: true };
        } else {
            const result = db.prepare(`
                INSERT INTO push_tokens (token, device_id, platform, label)
                VALUES (?, ?, ?, ?)
            `).run(token, deviceId || null, platform || 'android', label || null);
            return { id: result.lastInsertRowid, token, created: true };
        }
    } catch (err) {
        console.error('[Database] registerPushToken error:', err.message);
        return null;
    }
}

async function unregisterPushToken(token) {
    if (!db) return false;
    try {
        db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
        return true;
    } catch (err) {
        console.error('[Database] unregisterPushToken error:', err.message);
        return false;
    }
}

async function getActivePushTokens() {
    if (!db) return [];
    try {
        return db.prepare('SELECT * FROM push_tokens WHERE enabled = 1').all();
    } catch (err) {
        console.error('[Database] getActivePushTokens error:', err.message);
        return [];
    }
}

async function markPushTokenSuccess(token) {
    if (!db) return;
    try {
        db.prepare(`
            UPDATE push_tokens 
            SET last_success_at = datetime('now'), error_count = 0, last_error = NULL, updated_at = datetime('now')
            WHERE token = ?
        `).run(token);
    } catch (err) {
        // Non-critical, just log
        console.warn('[Database] markPushTokenSuccess error:', err.message);
    }
}

async function markPushTokenError(token, errorMessage) {
    if (!db) return;
    try {
        const row = db.prepare('SELECT error_count FROM push_tokens WHERE token = ?').get(token);
        const newCount = (row?.error_count || 0) + 1;
        
        // Auto-disable after 10 consecutive failures
        const shouldDisable = newCount >= 10;
        
        db.prepare(`
            UPDATE push_tokens 
            SET last_error = ?, error_count = ?, enabled = ?, updated_at = datetime('now')
            WHERE token = ?
        `).run(errorMessage, newCount, shouldDisable ? 0 : 1, token);
        
        if (shouldDisable) {
            console.warn(`[Database] Push token auto-disabled after ${newCount} failures:`, token.substring(0, 30) + '...');
        }
    } catch (err) {
        console.warn('[Database] markPushTokenError error:', err.message);
    }
}

async function getAllPushTokens() {
    if (!db) return [];
    try {
        return db.prepare('SELECT * FROM push_tokens ORDER BY created_at DESC').all();
    } catch (err) {
        console.error('[Database] getAllPushTokens error:', err.message);
        return [];
    }
}
