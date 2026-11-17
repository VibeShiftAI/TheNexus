const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Run the real CLI with isolated artifacts; retain the real MCP server and dependencies.
describe('boundary probe latest link', () => {
    let root;
    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-test-')));
        fs.mkdirSync(path.join(root, 'scripts'));
        const repo = path.resolve(__dirname, '../..');
        fs.copyFileSync(path.join(repo, 'scripts/mcp-boundary-probe.js'), path.join(root, 'scripts/probe.js'));
        for (const name of ['services', 'node_modules']) {
            fs.symlinkSync(path.join(repo, name), path.join(root, name));
        }
        fs.mkdirSync(path.join(root, 'logs/mcp-boundary-probe'), { recursive: true });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test.each(['absent', 'directory symlink', 'dangling symlink', 'real directory'])(
        '%s preserves evidence and reports the correct exit status', (state) => {
            const base = path.join(root, 'logs/mcp-boundary-probe');
            const latest = path.join(base, 'latest');
            const previous = path.join(base, 'previous');
            if (state === 'directory symlink') {
                fs.mkdirSync(previous);
                fs.writeFileSync(path.join(previous, 'evidence.txt'), 'preserve', 'utf8');
                fs.symlinkSync(previous, latest);
            } else if (state === 'dangling symlink') fs.symlinkSync(previous, latest);
            else if (state === 'real directory') fs.mkdirSync(latest);
            const result = spawnSync(process.execPath, [path.join(root, 'scripts/probe.js')], {
                encoding: 'utf8', timeout: 25000,
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(state === 'real directory' ? 1 : 0);
            const run = fs.readdirSync(base).find(name => /^\d{4}-/.test(name));
            const report = JSON.parse(fs.readFileSync(path.join(base, run, 'report.json'), 'utf8'));
            expect(report.checks).toHaveLength(11);
            expect(report.checks.every(check => check.pass)).toBe(true);
            if (state === 'real directory') {
                expect(fs.lstatSync(latest).isDirectory()).toBe(true);
                expect(result.stderr).toContain('PROBE ERROR');
            } else {
                expect(fs.readlinkSync(latest)).toBe(path.join(base, run));
                expect(result.stdout).toContain('11/11 checks passed');
            }
            if (state === 'directory symlink') {
                expect(fs.readFileSync(path.join(previous, 'evidence.txt'), 'utf8')).toBe('preserve');
            }
        }, 30000,
    );
});
