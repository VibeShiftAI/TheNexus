/**
 * Memory Routes — Global context memory (preferences, rules, hints, learning)
 * Extracted from server.js for modularity
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports = function createMemoryRouter({ scanProjects, PROJECT_ROOT, getDefaultMemoryManager }) {
    const router = express.Router();

    // Get all preferences
    router.get('/preferences', async (req, res) => {
        try {
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const prefs = await memory.getAllPreferences();
            res.json(prefs);
        } catch (error) {
            console.error('[Memory] Failed to get preferences:', error);
            res.status(500).json({ error: 'Failed to get preferences' });
        }
    });

    // Set a preference
    router.post('/preferences', async (req, res) => {
        try {
            const { category, key, value } = req.body;
            if (!category || !key) {
                return res.status(400).json({ error: 'category and key are required' });
            }
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            await memory.setPreference(category, key, value);
            res.json({ success: true });
        } catch (error) {
            console.error('[Memory] Failed to set preference:', error);
            res.status(500).json({ error: 'Failed to set preference' });
        }
    });

    // Delete a preference
    router.delete('/preferences/:category/:key', async (req, res) => {
        try {
            const { category, key } = req.params;
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const success = await memory.removePreference(category, key);
            res.json({ success });
        } catch (error) {
            console.error('[Memory] Failed to remove preference:', error);
            res.status(500).json({ error: 'Failed to remove preference' });
        }
    });

    // Get all rules
    router.get('/rules', async (req, res) => {
        try {
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const rules = await memory.getRules();
            res.json(rules);
        } catch (error) {
            console.error('[Memory] Failed to get rules:', error);
            res.status(500).json({ error: 'Failed to get rules' });
        }
    });

    // Add a rule
    router.post('/rules', async (req, res) => {
        try {
            const { rule } = req.body;
            if (!rule) {
                return res.status(400).json({ error: 'rule is required' });
            }
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const id = await memory.addRule(rule);
            res.json({ success: true, id });
        } catch (error) {
            console.error('[Memory] Failed to add rule:', error);
            res.status(500).json({ error: 'Failed to add rule' });
        }
    });

    // Delete a rule
    router.delete('/rules/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const success = await memory.removeRule(id);
            res.json({ success });
        } catch (error) {
            console.error('[Memory] Failed to remove rule:', error);
            res.status(500).json({ error: 'Failed to remove rule' });
        }
    });

    // Toggle a rule
    router.patch('/rules/:id/toggle', async (req, res) => {
        try {
            const { id } = req.params;
            const { enabled } = req.body;
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const success = await memory.toggleRule(id, enabled);
            res.json({ success });
        } catch (error) {
            console.error('[Memory] Failed to toggle rule:', error);
            res.status(500).json({ error: 'Failed to toggle rule' });
        }
    });

    // Get context for prompt injection
    router.get('/context', async (req, res) => {
        try {
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const context = await memory.getContextForPrompt();
            res.json({ context });
        } catch (error) {
            console.error('[Memory] Failed to get context:', error);
            res.status(500).json({ error: 'Failed to get context' });
        }
    });

    // Get scaffolding hints
    router.get('/hints', async (req, res) => {
        try {
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const hints = await memory.getScaffoldingHints();
            res.json(hints);
        } catch (error) {
            console.error('[Memory] Failed to get hints:', error);
            res.status(500).json({ error: 'Failed to get scaffolding hints' });
        }
    });

    // Get memory stats
    router.get('/stats', async (req, res) => {
        try {
            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const stats = await memory.getStats();
            res.json(stats);
        } catch (error) {
            console.error('[Memory] Failed to get stats:', error);
            res.status(500).json({ error: 'Failed to get memory stats' });
        }
    });

    // Learn from a project (trigger project analysis)
    router.post('/learn/:projectId', async (req, res) => {
        try {
            const { projectId } = req.params;
            const projects = scanProjects(PROJECT_ROOT);
            const project = projects.find(p => p.id === projectId);

            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Read key config files
            const files = new Map();
            const filesToRead = [
                'package.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js',
                '.prettierrc', '.prettierrc.json', 'tailwind.config.js', 'tailwind.config.ts',
                'tsconfig.json', 'vitest.config.ts', 'jest.config.js', 'biome.json',
                'next.config.js', 'next.config.mjs', 'vite.config.ts'
            ];

            for (const filename of filesToRead) {
                const filePath = path.join(project.path, filename);
                if (fs.existsSync(filePath)) {
                    files.set(filename, fs.readFileSync(filePath, 'utf-8'));
                }
            }

            const memory = getDefaultMemoryManager();
            await memory.ensureInitialized();
            const analysis = await memory.learnFromProject(project.path, files);

            res.json({ success: true, analysis });
        } catch (error) {
            console.error('[Memory] Failed to learn from project:', error);
            res.status(500).json({ error: 'Failed to learn from project' });
        }
    });

    return router;
};
