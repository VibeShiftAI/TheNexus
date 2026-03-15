#!/usr/bin/env node
/**
 * Migrate Supabase → SQLite
 * 
 * Reads all data from your live Supabase instance and writes it into a local
 * nexus.db SQLite database.  Run this ONCE before switching to SQLite.
 * 
 * Usage:
 *   node server/scripts/migrate-supabase-to-sqlite.js [--db-path ./nexus.db]
 * 
 * Requires:
 *   SUPABASE_URL and SUPABASE_SERVICE_KEY in .env (or environment)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
const DB_PATH = process.argv.includes('--db-path')
    ? process.argv[process.argv.indexOf('--db-path') + 1]
    : path.resolve(__dirname, '../../nexus.db');

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// ---------------------------------------------------------------------------
// Tables to migrate, in dependency order (parents first)
// ---------------------------------------------------------------------------
const TABLES = [
    // No FK dependencies
    'workflows',
    'agent_configs',
    'models',
    'mcp_server_scopes',
    'dashboard_initiatives',
    // Depends on: projects (but projects has no FK)
    'projects',
    // Depends on: projects
    'tasks',
    'project_contexts',
    'project_workflows',
    'scheduled_tasks',
    'tracks',
    'execution_steps',
    'inline_comments',
    // Depends on: projects + workflows
    'runs',
    // Depends on: tracks
    'track_steps',
    // Depends on: scheduled_tasks
    'execution_logs',
    'agent_memories',
    // Depends on: dashboard_initiatives + projects
    'initiative_project_status',
    // No FK
    'usage_stats',
    'checkpoints',
    'usage_quotas',
    'agent_audit_log',
    'workflow_static_data',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch ALL rows from a Supabase table (handles pagination) */
async function fetchAll(tableName) {
    const PAGE_SIZE = 1000;
    let allRows = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
            // Table might not exist in this Supabase instance — that's okay
            if (error.code === '42P01' || error.message?.includes('does not exist') ||
                error.message?.includes('schema cache')) {
                console.log('  ⚠️  not in Supabase — skipping');
                return [];
            }
            throw new Error(`Supabase fetch error on "${tableName}": ${error.message}`);
        }

        allRows = allRows.concat(data || []);
        hasMore = (data || []).length === PAGE_SIZE;
        offset += PAGE_SIZE;
    }

    return allRows;
}

/**
 * Ensure the SQLite table has all the columns present in the data.
 * Dynamically adds missing columns via ALTER TABLE ADD COLUMN.
 */
function ensureColumns(db, tableName, columns) {
    // Get existing columns
    const existingCols = db
        .prepare(`PRAGMA table_info("${tableName}")`)
        .all()
        .map(col => col.name);

    for (const col of columns) {
        if (!existingCols.includes(col)) {
            try {
                db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${col}" TEXT`);
            } catch (e) {
                // Column might already exist from a concurrent add — ignore
                if (!e.message.includes('duplicate column')) {
                    console.error(`\n    ⚠️  Cannot add column "${col}" to "${tableName}": ${e.message}`);
                }
            }
        }
    }
}

/**
 * Ensure the SQLite table exists (even if not in the schema file).
 * Creates a minimal table with just an id column, then ensureColumns adds the rest.
 */
function ensureTable(db, tableName) {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (id TEXT PRIMARY KEY)`);
    } catch (e) {
        // Table might already exist — that's fine
    }
}

/** Convert a JS value to its SQLite-safe string representation */
function toSQLiteValue(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
}

/** Build a parameterized INSERT statement from column names */
function buildInsertSQL(tableName, columns) {
    const placeholders = columns.map(() => '?').join(', ');
    const colList = columns.map(c => `"${c}"`).join(', ');
    return `INSERT OR IGNORE INTO "${tableName}" (${colList}) VALUES (${placeholders})`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║        Supabase → SQLite Migration Script                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`  Source:  ${SUPABASE_URL}`);
    console.log(`  Target:  ${DB_PATH}`);
    console.log();

    // Create (or open) SQLite database
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    // Disable FK constraints during migration to allow orphaned rows
    db.pragma('foreign_keys = OFF');

    // Run schema
    const schemaPath = path.resolve(__dirname, '../../db/schema-sqlite.sql');
    if (!fs.existsSync(schemaPath)) {
        console.error(`❌ Schema file not found: ${schemaPath}`);
        process.exit(1);
    }
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schemaSql);
    console.log('✅ SQLite schema created\n');

    // Migrate each table
    const report = {};
    let totalRows = 0;

    for (const table of TABLES) {
        process.stdout.write(`  📦 ${table.padEnd(30)}`);

        try {
            const rows = await fetchAll(table);

            if (rows.length === 0) {
                console.log('  0 rows (empty or missing)');
                report[table] = { supabase: 0, sqlite: 0, status: '✅' };
                continue;
            }

            // Get columns from first row
            const columns = Object.keys(rows[0]);

            // Ensure table and all columns exist in SQLite
            ensureTable(db, table);
            ensureColumns(db, table, columns);

            const insertSQL = buildInsertSQL(table, columns);
            const stmt = db.prepare(insertSQL);

            // Wrap in transaction for speed
            const insertMany = db.transaction((rowBatch) => {
                for (const row of rowBatch) {
                    const values = columns.map(col => toSQLiteValue(row[col]));
                    try {
                        stmt.run(...values);
                    } catch (e) {
                        // Log but don't fail — some rows may have FK issues
                        console.error(`\n    ⚠️  Row insert error in ${table}: ${e.message}`);
                    }
                }
            });

            insertMany(rows);

            // Validate count
            const { count } = db.prepare(`SELECT COUNT(*) as count FROM "${table}"`).get();

            const status = count >= rows.length ? '✅' : '⚠️';
            console.log(`  ${rows.length} → ${count} ${status}`);
            report[table] = { supabase: rows.length, sqlite: count, status };
            totalRows += count;

        } catch (err) {
            console.log(`  ❌ ERROR: ${err.message}`);
            report[table] = { supabase: '?', sqlite: 0, status: '❌', error: err.message };
        }
    }

    // Summary
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('  MIGRATION SUMMARY');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  Total rows migrated: ${totalRows}`);
    console.log(`  Database file:       ${DB_PATH}`);
    console.log(`  Database size:       ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2)} MB`);
    console.log();

    // Print table-by-table report
    console.log('  Table                          Supabase → SQLite   Status');
    console.log('  ─────────────────────────────  ─────────────────   ──────');
    for (const [table, info] of Object.entries(report)) {
        const arrow = `${String(info.supabase).padStart(6)} → ${String(info.sqlite).padEnd(6)}`;
        console.log(`  ${table.padEnd(31)} ${arrow.padEnd(19)} ${info.status}`);
    }

    // Check for mismatches
    const mismatches = Object.entries(report).filter(([, info]) => info.status !== '✅');
    if (mismatches.length > 0) {
        console.log('\n  ⚠️  Some tables had issues — review above for details.');
    } else {
        console.log('\n  ✅ All tables migrated successfully!');
    }

    db.close();
    console.log('\n  Done. You can now switch db/index.js to use better-sqlite3.\n');
}

main().catch(err => {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
});
