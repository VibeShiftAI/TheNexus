
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Configuration
const API_URL = 'http://localhost:4000/api';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runTest() {
    console.log('🧪 Starting Project Update Test...');

    // 1. Create a temporary project directly in DB to test with
    const testProjectName = `test-project-${Date.now()}`;
    console.log(`Creating test project: ${testProjectName}`);

    const { data: project, error: createError } = await supabase
        .from('projects')
        .insert({
            name: testProjectName,
            type: 'web-app',
            path: `/tmp/${testProjectName}`,
            description: 'Original Description',
            vibe: 'neutral'
        })
        .select()
        .single();

    if (createError) {
        console.error('Failed to create test project:', createError);
        process.exit(1);
    }

    console.log(`Created project ID: ${project.id}`);

    // 2. Authenticate
    const email = `testuser${Date.now()}@example.com`;
    const password = 'password123';

    // Check if user exists or sign up
    let { data: authData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
    });

    let token = authData.session?.access_token;

    if (!token) {
        // Try sign in
        const { data: signInData } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        token = signInData.session?.access_token;
    }

    if (!token) {
        console.warn('⚠️ Could not get auth token. API calls might fail with 401.');
    } else {
        console.log('Got auth token for test user.');
    }

    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };

    try {
        // 3. Update the project via API
        const updates = {
            description: 'Updated Description via API',
            vibe: 'immaculate',
            urls: { production: 'https://example.com' }
        };

        console.log('Sending PATCH request...');
        const response = await fetch(`${API_URL}/projects/${project.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(updates)
        });

        const data = await response.json();

        // 4. Verify Response
        console.log('Response status:', response.status);
        if (response.ok && data.description === updates.description) {
            console.log('✅ API returned updated data correctly.');
        } else {
            console.error('❌ API did not return updated data:', data);
        }

        // 5. Verify Database persistence
        const { data: verifyProject } = await supabase
            .from('projects')
            .select('*')
            .eq('id', project.id)
            .single();

        if (verifyProject.description === updates.description &&
            verifyProject.vibe === updates.vibe &&
            // Note: urls might be stored as jsonb, so deep comparison might be needed, 
            // but for this simple case, checking the property should work if parsed correctly.
            // Supabase client returns object for jsonb column.
            verifyProject.urls.production === updates.urls.production) {
            console.log('✅ Database persistence verified.');
        } else {
            console.error('❌ Database persistence failed:', verifyProject);
        }

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        // Cleanup
        console.log('Cleaning up...');
        await supabase.from('projects').delete().eq('id', project.id);
    }
}

runTest();
