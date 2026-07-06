const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../db');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Configuration
const TEST_PROJECT_ROOT = path.join(__dirname, 'test_workspace');
const TEST_PROJECT_NAME = 'DB_Integrity_Test_Project';

async function runTest() {
    console.log('🔍 Starting DB Integrity Verification...');

    // Ensure test workspace exists
    if (!fs.existsSync(TEST_PROJECT_ROOT)) {
        fs.mkdirSync(TEST_PROJECT_ROOT, { recursive: true });
    }

    let projectId = null;

    try {
        // 1. Test Project Creation (DB Only)
        console.log('\n[1] Testing Project Creation...');
        const newProject = {
            name: TEST_PROJECT_NAME,
            path: TEST_PROJECT_ROOT,
            description: 'Temporary test project for DB integrity check',
            type: 'web-app'
        };

        const createdProject = await db.upsertProject(newProject);
        projectId = createdProject.id;

        console.log(`✅ Project created in DB with ID: ${projectId}`);

        // ASSERT: Project ID is UUID
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
            throw new Error(`Project ID is not a UUID: ${projectId}`);
        }

        // ASSERT: No project.json created
        if (fs.existsSync(path.join(TEST_PROJECT_ROOT, 'project.json'))) {
            throw new Error('❌ project.json was created! Refactoring failed.');
        } else {
            console.log('✅ confirmed: No project.json file created.');
        }

        // 2. Test Feature Creation (DB Only)
        console.log('\n[2] Testing Feature Creation & UUID...');
        const featureData = {
            project_id: projectId,
            name: 'Test Feature 1',
            description: 'Testing DB persistence',
            status: 'planned',
            priority: 1,
            metadata: {
                source: 'verification_script',
                complexData: { nested: true, array: [1, 2, 3] }
            }
        };

        const createdFeature = await db.createFeature(featureData);
        const featureId = createdFeature.id;

        console.log(`✅ Feature created in DB with ID: ${featureId}`);

        // ASSERT: Feature ID is UUID
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(featureId)) {
            throw new Error(`Feature ID is not a UUID: ${featureId}`);
        }

        // ASSERT: Metadata saved correctly (JSONB)
        if (createdFeature.metadata.complexData.nested !== true) {
            throw new Error('❌ JSONB metadata not saved correctly');
        }
        console.log('✅ JSONB metadata verification passed.');

        // 3. Test Feature Update (Reading/Writing)
        console.log('\n[3] Testing Feature Update...');
        const feedbackData = [{ id: 'fb-1', content: 'Good job', action: 'approve' }];

        const updatedFeature = await db.updateFeature(featureId, {
            status: 'implementing',
            feedback: feedbackData
        });

        if (updatedFeature.status !== 'implementing') {
            throw new Error('❌ Status update failed');
        }
        // Check feedback (if schema supports it separate or in metadata)
        // Note: We added `feedback` column as specific JSONB
        if (updatedFeature.feedback && updatedFeature.feedback[0].content === 'Good job') {
            console.log('✅ Feedback JSONB verification passed.');
        } else {
            // Fallback check if it wasn't returned or saved
            console.warn('⚠️ Feedback column check inconclusive (maybe not returned by updateFeature?), fetching fresh...');
            const freshFeature = await db.getFeature(featureId);
            if (freshFeature.feedback && freshFeature.feedback[0].content === 'Good job') {
                console.log('✅ Feedback JSONB verification passed (after refetch).');
            } else {
                throw new Error('❌ Feedback JSONB persistence failed');
            }
        }

        // 4. Test Autopilot/Research Logic (Stub check)
        // Just verify we can call getters without error
        console.log('\n[4] Verifying Getters...');
        const features = await db.getFeatures(projectId);
        if (features.length !== 1) throw new Error('❌ getFeatures returned wrong count');
        console.log('✅ getFeatures functional.');

        console.log('\n✅✅✅ VERIFICATION SUCCESSFUL ✅✅✅');
        console.log('All checks passed: strict DB usage, UUIDs, JSONB, no files.');

    } catch (error) {
        console.error('\n❌ VERIFICATION FAILED:', error.message);
        console.error(error);
    } finally {
        // Cleanup
        if (projectId) {
            console.log('\nCleaning up test data...');
            // Need deleteProject implemented in db/index.js
            try {
                await db.deleteProject(projectId);
                console.log('✅ Test project deleted from DB.');
            } catch (e) {
                console.warn('⚠️ Failed to cleanup project from DB:', e.message);
            }
        }
        // clean up folder
        if (fs.existsSync(TEST_PROJECT_ROOT)) {
            // fs.rmdirSync(TEST_PROJECT_ROOT, { recursive: true });
            // Keeping it might be safer or just leave it empty
        }
    }
}

runTest();
