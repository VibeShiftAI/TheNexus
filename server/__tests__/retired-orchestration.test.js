const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const retiredName = ['lang', 'graph'].join('');
const retiredEnvMarker = ['LANG', 'GRAPH'].join('');
const retiredPort = String(80 * 100);
const retiredMarker = new RegExp(retiredName, 'i');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('retired orchestration cleanup', () => {
    test('dead route and supervisor files are not live server modules', () => {
        expect(fs.existsSync(path.join(root, 'server/routes', `${retiredName}.js`))).toBe(false);
        expect(fs.existsSync(path.join(root, 'server/services', `${retiredName}-supervisor.js`))).toBe(false);
        expect(fs.existsSync(path.join(root, 'server/routes/workflows.js'))).toBe(false);
    });

    test('server and dashboard live code no longer reference the retired bridge', () => {
        const liveFiles = [
            'server/server.js',
            'server/shared/constants.js',
            'server/routes/agents.js',
            'server/routes/fleet.js',
            'server/routes/tasks.js',
            'server/services/dashboard-initiative-supervisor.js',
            'server/services/project-workflow-supervisor.js',
            'dashboard/next.config.ts',
            'dashboard/src/lib/nexus.ts',
            'dashboard/src/components/task-manager.tsx',
            'dashboard/src/components/task-detail-modal.tsx',
            'dashboard/src/components/agent-manager.tsx',
            'dashboard/src/app/workflow-builder/page.tsx',
            'dashboard/src/app/system-monitor/page.tsx',
            'dashboard/src/components/workflow-debugger.tsx',
            'dashboard/src/hooks/useNodeSchema.ts',
        ];

        for (const file of liveFiles) {
            const contents = read(file);
            expect(contents).not.toMatch(retiredMarker);
            expect(contents).not.toContain(retiredEnvMarker);
            expect(contents).not.toContain(retiredPort);
        }
    });
});
