require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATION_FILE = 'db/migrations/013_add_task_specific_columns.sql';

(async () => {
    console.log('Applying migration:', MIGRATION_FILE);

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('DATABASE_URL not set in .env');
        process.exit(1);
    }

    const client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false } // Supabase requires SSL, node-postgres might need this
        // Note: 'postgres' vs 'pg' package. 'pg' uses 'ssl: true' or object.
    });

    try {
        await client.connect();

        const sqlPath = path.resolve(__dirname, '../../', MIGRATION_FILE);
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('Executing SQL...');
        await client.query(sql);

        console.log('Migration applied successfully.');
    } catch (e) {
        console.error('Migration failed:', e);
    } finally {
        await client.end();
    }
})();
