const { validateInitiativeRequest } = require('../src/services/initiative-router');
require('dotenv').config();

async function runTests() {
    console.log('--- Testing Initiative Router ---');

    const testCases = [
        { title: "Add dark mode to the dashboard", description: "Users want a dark theme for better visibility at night." },
        { title: "The login button crashes the app", description: "Clicking login results in a white screen." },
        { title: "How do I add a new project?", description: "" },
        { title: "fix it", description: "it is broken" }
    ];

    for (const test of testCases) {
        console.log(`\nTesting: "${test.title}"`);
        try {
            const result = await validateInitiativeRequest(test);
            console.log('Result:', JSON.stringify(result, null, 2));
        } catch (error) {
            console.error('Error:', error.message);
        }
    }
}

runTests();
