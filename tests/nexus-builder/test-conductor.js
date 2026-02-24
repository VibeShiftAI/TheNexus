require('dotenv').config();
const db = require('../db');
const ConductorService = require('../src/services/conductor');
const { determineNextTask, inferIntent } = require('../src/services/supervisor');

async function testConductorIntegration() {
    console.log('Testing Conductor Integration...');

    try {
        // 1. Test db.getProjectContexts (Mocking db call if allowed, or integration test)
        // Check if DB is enabled
        if (!db.isDatabaseEnabled()) {
            console.warn('Skipping DB tests: Database not enabled');
            return;
        }

        // Get a project (e.g. 'TheNexus')
        const projects = await db.getProjects();
        const project = projects.find(p => p.name === 'TheNexus');

        if (!project) {
            console.error('Project "TheNexus" not found');
            return;
        }

        console.log(`\n1. Testing ConductorService for project: ${project.name}`);
        const context = await ConductorService.getAgentContext(project.id);
        if (context.includes('# Project Context (Conductor)')) {
            console.log('  ✓ Conductor context retrieved successfully');
            console.log(`  Length: ${context.length} chars`);
        } else {
            console.error('  ✗ Conductor context missing or invalid');
            console.log(context);
        }

        // 2. Test Supervisor logic with Mock Tracks
        console.log('\n2. Testing Supervisor Logic (Mocked)');
        const mockFeature = { id: 'mock-feature', status: 'planning', metadata: {} };
        const mockLedger = [];
        const mockTracks = [{
            id: 'track-1',
            status: 'ready',
            steps: [
                { id: 's1', step_order: 1, title: 'Analyze requirements', status: 'completed' },
                { id: 's2', step_order: 2, title: 'Draft plan.md', status: 'pending' },
                { id: 's3', step_order: 3, title: 'Implement feature', status: 'pending' }
            ]
        }];

        // Test inferWait
        // Wait, I didn't export inferIntent in supervisor.js, I only added it internally.
        // But I exported determineNextTask.

        const nextTask = determineNextTask(mockFeature, mockLedger, mockTracks);
        console.log('  Next Task Result:', nextTask);

        if (nextTask && nextTask.taskId === 'track-track-1-step-2' && nextTask.intent === 'plan') {
            console.log('  ✓ Supervisor routed to correct track step');
        } else {
            console.error('  ✗ Supervisor routing failed or incorrect');
        }

        console.log('\nVerification Complete!');

    } catch (error) {
        console.error('Test Failed:', error);
    }
}

testConductorIntegration().catch(console.error);
