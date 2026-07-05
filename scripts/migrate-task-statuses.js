#!/usr/bin/env node
/**
 * One-time (idempotent, re-runnable) migration to the canonical task-status
 * enum (@praxis/contract TaskBoardStatusSchema, unified 2026-07-05).
 *
 * The live board had drifted to three completion synonyms (complete=136,
 * done=66, completed=8) plus ready/in-progress variants. This normalizes
 * `tasks.status` AND `tasks.pre_archive_status` (which would otherwise
 * resurrect legacy values on unarchive), after taking a WAL-safe online
 * backup copy next to the db.
 *
 * Usage: node scripts/migrate-task-statuses.js [--dry-run]
 */

const Database = require('better-sqlite3');
const path = require('path');
const { LEGACY_TASK_STATUS_MAP, TaskBoardStatusSchema } = require('@praxis/contract');

const DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../nexus.db');
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    const counts = (col) =>
        db.prepare(`SELECT ${col} AS v, count(*) AS n FROM tasks WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC`).all();

    console.log(`DB: ${DB_PATH}${DRY_RUN ? '  (DRY RUN)' : ''}`);
    console.log('Before — status:', JSON.stringify(Object.fromEntries(counts('status').map(r => [r.v, r.n]))));
    console.log('Before — pre_archive_status:', JSON.stringify(Object.fromEntries(counts('pre_archive_status').map(r => [r.v, r.n]))));

    if (!DRY_RUN) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const backupPath = `${DB_PATH}.pre-status-migration-${stamp}`;
        await db.backup(backupPath);
        console.log(`Backup: ${backupPath}`);
    }

    const migrate = db.transaction(() => {
        let total = 0;
        for (const [legacy, canonical] of Object.entries(LEGACY_TASK_STATUS_MAP)) {
            for (const col of ['status', 'pre_archive_status']) {
                const stmt = DRY_RUN
                    ? db.prepare(`SELECT count(*) AS n FROM tasks WHERE lower(trim(${col})) = ?`)
                    : db.prepare(`UPDATE tasks SET ${col} = '${canonical}' WHERE lower(trim(${col})) = ?`);
                const res = DRY_RUN ? stmt.get(legacy) : stmt.run(legacy);
                const n = DRY_RUN ? res.n : res.changes;
                if (n > 0) { console.log(`  ${col}: ${legacy} → ${canonical}  (${n} rows)`); total += n; }
            }
        }
        return total;
    });
    const total = migrate();
    console.log(`${DRY_RUN ? 'Would migrate' : 'Migrated'} ${total} row-values.`);

    console.log('After — status:', JSON.stringify(Object.fromEntries(counts('status').map(r => [r.v, r.n]))));
    const valid = new Set(TaskBoardStatusSchema.options);
    const strays = counts('status').filter(r => !valid.has(r.v));
    if (strays.length) {
        console.warn('⚠️  Non-canonical statuses remain (unmapped — decide manually):', JSON.stringify(strays));
    } else {
        console.log('✅ All task statuses are canonical.');
    }
    db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
