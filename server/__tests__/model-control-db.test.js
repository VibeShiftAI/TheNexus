const fs = require('fs');
const os = require('os');
const path = require('path');

function loadFreshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-control-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
    jest.resetModules();
    return require('../../db');
}

describe('model control database contract', () => {
    afterEach(() => {
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
    });

    test('stores aliases, project overrides, local-only state, assignments, and snapshots', async () => {
        const db = loadFreshDb();
        const project = await db.upsertProject({
            name: 'ModelControlTest',
            path: '/tmp/model-control-test',
            type: 'app'
        });

        await db.upsertModel({
            id: 'anthropic-claude-sonnet',
            provider: 'anthropic',
            api_model_id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet',
            display_name: 'Claude Sonnet',
            family: 'claude-sonnet',
            capabilities: { coding: true },
            default_parameters: { max_tokens: 8192 },
            availability_status: 'available',
            is_active: 1
        });

        await db.upsertModelAlias({
            alias: 'coder',
            target: 'model:anthropic-claude-sonnet',
            description: 'Coding model'
        });
        await db.upsertProjectModelAlias(project.id, {
            alias: 'coder',
            target: 'model:anthropic-claude-sonnet'
        });
        await db.setModelControlSetting('local_only', { enabled: true, reason: 'budget_limit' });

        const created = await db.createTask({
            project_id: project.id,
            name: 'Use model control',
            status: 'idea',
            model_assignment: 'alias:coder'
        });
        const snapshot = await db.createModelExecutionSnapshot({
            requested_assignment: 'alias:coder',
            resolved_model_id: 'anthropic-claude-sonnet',
            provider: 'anthropic',
            api_model_id: 'claude-sonnet-4-6',
            source: 'project',
            local_only_active: false,
            fallback_used: false,
            project_id: project.id,
            task_id: created.id
        });

        expect((await db.getModelAliases()).find(a => a.alias === 'coder').target).toBe('model:anthropic-claude-sonnet');
        expect((await db.getProjectModelAliases(project.id)).find(a => a.alias === 'coder').target).toBe('model:anthropic-claude-sonnet');
        expect(await db.getModelControlSetting('local_only')).toEqual({ enabled: true, reason: 'budget_limit' });
        expect((await db.getTask(created.id)).model_assignment).toBe('alias:coder');
        expect(snapshot.provider).toBe('anthropic');
        expect(snapshot.local_only_active).toBe(false);
        expect(snapshot.fallback_used).toBe(false);

        const history = await db.getModelExecutionSnapshots({ projectId: project.id, limit: 10 });
        expect(history.total).toBe(1);
        expect(history.snapshots[0].id).toBe(snapshot.id);
        expect(history.snapshots[0].task_id).toBe(created.id);
        expect(history.snapshots[0].parameters_summary).toEqual({});
    });
});
