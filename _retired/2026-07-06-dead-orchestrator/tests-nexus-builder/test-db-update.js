require('dotenv').config();
const db = require('../db');

async function runTest() {
    console.log('🧪 Testing DB Update Direct...');

    if (!db.isDatabaseEnabled()) {
        console.error('Database not enabled');
        process.exit(1);
    }

    // 1. Create temp project
    const testName = `test-db-${Date.now()}`;
    const { data: project } = await db.supabase.from('projects').insert({
        name: testName,
        type: 'web-app',
        path: `/tmp/${testName}`,
        vibe: 'neutral'
    }).select().single();

    console.log(`Created project ${project.id}`);

    // 2. Update via db module
    const updates = { vibe: 'immaculate', description: 'Updated directly' };
    const updated = await db.updateProject(project.id, updates);

    // 3. Verify
    if (updated.vibe === 'immaculate' && updated.description === 'Updated directly') {
        console.log('✅ DB Update success!');
    } else {
        console.error('❌ DB Update failed:', updated);
    }

    // Cleanup
    await db.deleteProject(project.id);
}

runTest();
