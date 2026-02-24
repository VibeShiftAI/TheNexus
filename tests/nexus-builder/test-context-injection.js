require('dotenv').config();
const db = require('../db');
const ConductorService = require('../src/services/conductor');

async function testContextInjection() {
    console.log('--- Testing Context Injection ---');

    if (!db.isDatabaseEnabled()) {
        console.error('Database not enabled. Test cannot run.');
        process.exit(1);
    }

    // 1. Get a Project
    const projects = await db.getProjects();
    if (projects.length === 0) {
        console.log('No projects found to test.');
        return;
    }
    const project = projects[0]; // Use first available project
    console.log(`Testing with Project: ${project.name} (${project.id})`);

    // 2. Fetch Agent Context (Product, Tech Stack, etc.)
    console.log('\nFetching Global Agent Context...');
    const agentContext = await ConductorService.getAgentContext(project.id);
    
    if (agentContext) {
        console.log('[SUCCESS] Context loaded.');
        console.log(`Length: ${agentContext.length} chars`);
        console.log('Preview:\n', agentContext.substring(0, 200) + '...');
    } else {
        console.warn('[WARNING] No context found. This might be normal if no docs exist, but check DB.');
        
        // Debug: Check raw DB table
        const contexts = await db.getProjectContexts(project.id);
        console.log(`Raw DB count for project_contexts: ${contexts.length}`);
    }

    // 3. Fetch Track Context
    // Find a feature with tracks
    const features = await db.getFeatures(project.id);
    const featureWithTracks = features.find(f => f.metadata && f.metadata.sourceWorkflow); // Just a heuristic
    
    // Better way: query tracks table
    const { data: tracks, error } = await db.supabase.from('tracks').select('*').limit(1);
    
    if (tracks && tracks.length > 0) {
        const track = tracks[0];
        console.log(`\nTesting with Track: ${track.name} (Feature: ${track.feature_id})`);
        
        const trackContext = await ConductorService.getActiveTrackContext(track.feature_id);
        if (trackContext) {
            console.log('[SUCCESS] Track Context loaded.');
            console.log(`Length: ${trackContext.length} chars`);
            console.log('Preview:\n', trackContext.substring(0, 200) + '...');
        } else {
            console.warn('[WARNING] Track context returned empty string.');
        }
    } else {
        console.log('\nNo tracks found in DB to test track context.');
    }
}

testContextInjection();
