require('dotenv').config();

const API_URL = 'http://localhost:4000/api';
const PROJECT_NAME = 'TheNexus';

async function testContextAPI() {
    console.log('🧪 Testing Project Context API...');

    try {
        // 1. Get Project ID
        console.log('1. Fetching Project ID...');
        const projectsRes = await fetch(`${API_URL}/projects`, {
            headers: { 'x-nexus-api-key': 'dummy-key-for-local' }
        });
        const projects = await projectsRes.json();
        const project = projects.find(p => p.name === PROJECT_NAME);

        if (!project) {
            console.error(`❌ Project '${PROJECT_NAME}' not found.`);
            return;
        }
        const projectId = project.id;
        console.log(`   Found project: ${projectId}`);

        // 2. Update Context
        console.log('\n2. Updating Context (test-context)...');
        const updateRes = await fetch(`${API_URL}/projects/${projectId}/context`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-nexus-api-key': 'dummy-key-for-local'
            },
            body: JSON.stringify({
                type: 'test-context',
                content: '# Test Context\nThis is a test.'
            })
        });
        const updateData = await updateRes.json();

        if (updateData.success) {
            console.log('   ✅ Context updated successfully.');
        } else {
            console.error('   ❌ Update failed:', updateData);
        }

        // 3. Get Context
        console.log('\n3. Fetching Context...');
        const getRes = await fetch(`${API_URL}/projects/${projectId}/context`, {
            headers: { 'x-nexus-api-key': 'dummy-key-for-local' }
        });
        const getData = await getRes.json();
        const contexts = getData.contexts;
        const testContext = contexts.find(c => c.context_type === 'test-context');

        if (testContext && testContext.content.includes('# Test Context')) {
            console.log('   ✅ Test context found and verified.');
        } else {
            console.error('   ❌ Test context not found or incorrect:', contexts);
        }

    } catch (error) {
        console.error('❌ Test Failed:', error.message);
    }
}

testContextAPI();
