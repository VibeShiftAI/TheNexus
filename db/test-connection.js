/**
 * Database Connection Test Script
 * 
 * Run this to verify your Supabase connection is working:
 *   node db/test-connection.js
 * 
 * Make sure your .env file has the Supabase variables set!
 */

require('dotenv').config();

const db = require('./index');

async function testConnection() {
    console.log('🔌 Testing Supabase Connection...\n');

    // Check if database is configured
    if (!db.isDatabaseEnabled()) {
        console.error('❌ Database not configured!');
        console.log('\nMake sure your .env file contains:');
        console.log('  SUPABASE_URL=https://jgdeannzzyskarqvfzwn.supabase.co');
        console.log('  SUPABASE_SECRET_KEY=sb_secret_...');
        process.exit(1);
    }

    console.log('✅ Database client initialized');

    // Test connection
    const result = await db.testConnection();

    if (!result.success) {
        console.error('❌ Connection failed:', result.error);
        console.log('\nPossible issues:');
        console.log('  1. Schema not created - run db/schema.sql in Supabase SQL Editor');
        console.log('  2. Wrong credentials in .env');
        console.log('  3. Network/firewall blocking connection');
        process.exit(1);
    }

    console.log('✅ Database connection successful!\n');

    // Test basic operations
    console.log('📋 Testing table access...');

    const tables = ['projects', 'features', 'workflows', 'scheduled_tasks', 'agent_configs'];

    for (const table of tables) {
        try {
            const { data, error } = await db.supabase
                .from(table)
                .select('count')
                .limit(1);

            if (error) {
                console.log(`  ❌ ${table}: ${error.message}`);
            } else {
                console.log(`  ✅ ${table}: accessible`);
            }
        } catch (err) {
            console.log(`  ❌ ${table}: ${err.message}`);
        }
    }

    console.log('\n🎉 Database setup complete!\n');
    console.log('Next steps:');
    console.log('  1. Run: node scripts/migrate-to-postgres.js');
    console.log('  2. This will migrate your existing project.json data');
}

testConnection().catch(console.error);
