require('dotenv').config({ path: '../../.env' });
const { createClient } = require('@supabase/supabase-js');

// Helper to get env vars (handling different running locations)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

(async () => {
    console.log('Verifying Task Columns...');

    // 1. Create a dummy project
    const { data: project, error: pError } = await supabase
        .from('projects')
        .insert({
            name: `Test Project ${Date.now()}`,
            path: '/tmp/test',
            type: 'tool'
        })
        .select()
        .single();

    if (pError) {
        console.error('Failed to create test project:', pError);
        process.exit(1);
    }
    console.log('Created test project:', project.id);

    try {
        // 2. Create a task with NEW COLUMNS
        const testData = {
            project_id: project.id,
            name: 'Column Verification Task',
            status: 'idea',
            initiative_validation: { classification: 'TASK', confidence: 0.9, reasoning: 'Test' },
            research_metadata: { mode: 'deep', generatedAt: new Date().toISOString() },
            plan_metadata: { approvedAt: new Date().toISOString() },
            source: 'verification_script',
            metadata: { customField: 'should work too' }
        };

        const { data: task, error: tError } = await supabase
            .from('tasks')
            .insert(testData)
            .select()
            .single();

        if (tError) {
            console.error('Failed to create test task:', tError);
            throw tError;
        }

        console.log('Created test task:', task.id);

        // 3. Verify Columns
        if (task.initiative_validation?.classification !== 'TASK') throw new Error('initiative_validation failed');
        if (task.research_metadata?.mode !== 'deep') throw new Error('research_metadata failed');
        if (task.plan_metadata?.approvedAt !== testData.plan_metadata.approvedAt) throw new Error('plan_metadata failed');
        if (task.source !== 'verification_script') throw new Error('source failed');
        if (task.metadata?.customField !== 'should work too') throw new Error('metadata failed');

        console.log('✅ ALL COLUMNS VERIFIED SUCCESSFULLY');

    } catch (e) {
        console.error('Verification Failed:', e);
    } finally {
        // Cleanup
        await supabase.from('projects').delete().eq('id', project.id);
        console.log('Cleanup complete');
    }
})();
