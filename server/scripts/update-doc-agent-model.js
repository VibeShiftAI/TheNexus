const db = require('../../db');

(async () => {
    try {
        console.log('Updating Documentation Agent Model...');

        if (!db.isDatabaseEnabled()) {
            console.error('Database not enabled.');
            process.exit(1);
        }

        // We need to fetch the current config to get the system prompt, then update
        const agent = await db.getAgentConfig('documentation-generator');
        if (!agent) {
            console.log('Agent not found, nothing to update.');
            return;
        }

        console.log(`Current model: ${agent.default_model}`);

        // Update directly via SQL or helper if available? 
        // db.getAgentConfig returns the row. usage: db.supabase.from('agent_configs')...

        const { error } = await db.supabase
            .from('agent_configs')
            .update({ default_model: 'gemini-3-flash-preview' })
            .eq('id', 'documentation-generator');

        if (error) {
            console.error('Error updating agent config:', error);
        } else {
            console.log('Successfully updated agent config to gemini-3-flash-preview');
        }

    } catch (e) {
        console.error('Script Error:', e);
    }
})();
