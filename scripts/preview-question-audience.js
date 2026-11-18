/** Run the startup migration on an in-memory snapshot and print every open
 * question. The source database is opened read-only, including WAL readers. */
const Database = require('better-sqlite3');
const { backfillQuestionAudience } = require('../db/question-audience-backfill');

const file = process.argv[2];
if (!file) throw Error('Usage: node scripts/preview-question-audience.js /path/to/nexus.db');
const source = new Database(file, { readonly: true, fileMustExist: true });
const preview = new Database(':memory:');
try {
    source.transaction(() => {
        for (const [table, columns] of [
            ['projects', ['id', 'name', 'status', 'needs', 'updated_at']],
            ['contacts', ['id', 'name', 'kind']],
            ['project_contacts', ['project_id', 'contact_id']],
        ]) {
            const fields = columns.join(', ');
            preview.exec(`CREATE TABLE ${table} (${fields})`);
            const insert = preview.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => '?').join(', ')})`);
            for (const row of source.prepare(`SELECT ${fields} FROM ${table}`).raw().iterate()) insert.run(row);
        }
    })();
    const rows = backfillQuestionAudience(preview);
    const read = preview.prepare('SELECT needs FROM projects WHERE id = ?');
    for (const row of rows) {
        const need = JSON.parse(read.get(row.project_id).needs).find(n => n.id === row.id);
        if ((need.knowledge?.client_facing ?? null) !== row.client_facing) throw Error('Migration read-back failed for ' + row.id);
    }
    console.log(JSON.stringify({ mode: 'snapshot', projects: preview.prepare('SELECT count(*) FROM projects').pluck().get(), rows }, null, 2));
} finally {
    source.close();
    preview.close();
}
