const VERSION = 1;
const quote = name => `"${name.replace(/"/g, '""')}"`;

function usageIndexes(db) {
    return db.pragma('index_list(usage_stats)').map(index => ({
        ...index,
        columns: db.pragma(`index_info(${quote(index.name)})`).map(column => column.name),
    }));
}

function isIdentity(index, columns) {
    return index.unique && !index.partial && index.columns.length === columns.length
        && columns.every(column => index.columns.includes(column));
}

/**
 * V1 replaces the obsolete date/model identity with date/model/source.
 *
 * NULL means an unattributed legacy call and becomes the existing 'unknown'
 * bucket. Empty strings and every non-NULL legacy source remain unchanged.
 * If normalization would combine rows, abort: merging would lose original IDs
 * and make references/backfill ambiguous. An operator must reconcile those rows.
 *
 * Run outside any caller transaction. Foreign keys are disabled only on this
 * connection for SQLite's create/copy/drop/rename procedure, so DROP cannot
 * cascade into receipts. Both PRAGMAs are restored, even after rollback. Views
 * and external triggers retain the stable usage_stats name; attached indexes
 * and triggers are recreated from their original SQL. Invalid references to
 * the removed pair identity cause rollback during foreign_key_check.
 */
function migrateUsageStats(db) {
    if (db.inTransaction) throw new Error('Usage migration must run outside a transaction');
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    const legacyAlter = db.pragma('legacy_alter_table', { simple: true });
    try {
        db.pragma('foreign_keys = OFF');
        db.pragma('legacy_alter_table = ON');
        return db.transaction(() => {
            const original = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'usage_stats'").get();
            if (!original) throw new Error('Usage migration requires the usage_stats table');
            const columns = db.pragma('table_xinfo(usage_stats)');
            const hasSource = columns.some(column => column.name === 'source');
            const indexes = usageIndexes(db);
            const obsolete = indexes.filter(index => isIdentity(index, ['date', 'model']));
            const sourceIdentity = indexes.some(index => isIdentity(index, ['date', 'model', 'source']));
            const normalizedNullSources = hasSource
                ? db.prepare('SELECT COUNT(*) AS n FROM usage_stats WHERE source IS NULL').get().n : 0;
            if (hasSource && db.prepare(`SELECT 1 FROM usage_stats
                GROUP BY date, model, COALESCE(source, 'unknown') HAVING COUNT(*) > 1 LIMIT 1`).get()) {
                throw new Error('Ambiguous usage source normalization; reconcile duplicate identities before migration');
            }
            const rebuilt = !hasSource || obsolete.length > 0 || !sourceIdentity || normalizedNullSources > 0;
            if (rebuilt) {
                const foreignKeyBefore = JSON.stringify(db.pragma('foreign_key_check'));
                const objects = db.prepare(`SELECT type, name, sql FROM sqlite_schema
                    WHERE tbl_name = 'usage_stats' AND type IN ('index', 'trigger') AND sql IS NOT NULL
                    ORDER BY type, name`).all();
                // Preserve column definitions, additional constraints, table options,
                // and application-specific columns; change only the known identity.
                let ddl = original.sql.replace(
                    /^CREATE TABLE\s+(?:"usage_stats"|`usage_stats`|\[usage_stats\]|usage_stats)\s*\(/i,
                    'CREATE TABLE usage_stats__source_v1 ('
                );
                if (ddl === original.sql) throw new Error('Unsupported usage_stats CREATE TABLE syntax');
                if (!hasSource) ddl = ddl.replace('(', "(source TEXT DEFAULT 'unknown',");
                // Tokenize quoted text/comments first so a DEFAULT or CHECK
                // literal containing "UNIQUE(date, model)" is never rewritten.
                const pairConstraint = /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|\bUNIQUE\s*\(\s*["`\[]?date["`\]]?\s*,\s*["`\[]?model["`\]]?\s*\)/ig;
                let replacedPair = false;
                ddl = ddl.replace(pairConstraint, token => {
                    if (!/^UNIQUE/i.test(token)) return token;
                    replacedPair = true;
                    return 'UNIQUE(date, model, source)';
                });
                // An index-only legacy identity also needs a new triple constraint.
                if (!sourceIdentity && !replacedPair) {
                    const end = ddl.lastIndexOf(')');
                    ddl = `${ddl.slice(0, end)}, UNIQUE(date, model, source)${ddl.slice(end)}`;
                }
                db.exec(ddl);
                const stored = columns.filter(column => column.hidden === 0).map(column => column.name);
                const target = hasSource ? stored : [...stored, 'source'];
                const select = target.map(name => name === 'source'
                    ? (hasSource ? "COALESCE(source, 'unknown')" : "'unknown'") : quote(name));
                db.exec(`INSERT INTO usage_stats__source_v1 (${target.map(quote).join(', ')})
                    SELECT ${select.join(', ')} FROM usage_stats`);
                db.exec('DROP TABLE usage_stats');
                db.exec('ALTER TABLE usage_stats__source_v1 RENAME TO usage_stats');
                for (const object of objects) {
                    if (!obsolete.some(index => index.name === object.name)) db.exec(object.sql);
                }
                const finalIndexes = usageIndexes(db);
                if (finalIndexes.some(index => isIdentity(index, ['date', 'model']))
                    || !finalIndexes.some(index => isIdentity(index, ['date', 'model', 'source']))) {
                    throw new Error('Usage migration did not establish the source identity');
                }
                if (JSON.stringify(db.pragma('foreign_key_check')) !== foreignKeyBefore) {
                    throw new Error('Usage migration changed foreign-key integrity');
                }
            }
            // Do not consume the database-wide user_version owned by other schemas.
            db.exec(`CREATE TABLE IF NOT EXISTS usage_stats_migrations (
                version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
            )`);
            db.prepare('INSERT OR IGNORE INTO usage_stats_migrations (version, applied_at) VALUES (?, ?)')
                .run(VERSION, new Date().toISOString());
            return { version: VERSION, rebuilt, normalizedNullSources };
        }).immediate();
    } finally {
        db.pragma(`legacy_alter_table = ${legacyAlter}`);
        db.pragma(`foreign_keys = ${foreignKeys}`);
    }
}

module.exports = { migrateUsageStats };
