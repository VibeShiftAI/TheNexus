const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createWriteLeases } = require('../../db/write-leases');
const { workspaceCommand } = require('../lib/write-leases');

test('timeout terminates a foreground descendant before releasing its workspace fence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-command-group-'));
    const db = new Database(path.join(dir, 'leases.db'));
    const leases = createWriteLeases(db);
    const pidFile = path.join(dir, 'child.pid');
    const lateFile = path.join(dir, 'late.txt');
    let childPid;
    try {
        const script = `require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => require('fs').writeFileSync(process.argv[3], 'late'), 1500)`;
        fs.writeFileSync(path.join(dir, 'child.js'), script, 'utf8');
        const executable = "'" + process.execPath.replace(/'/g, "'\\''") + "'";
        expect(() => workspaceCommand(leases, dir, `${executable} child.js child.pid late.txt; echo finished`, [],
            { shell: true, timeout: 300 })).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }));
        childPid = Number(fs.readFileSync(pidFile, 'utf8'));
        expect(() => process.kill(childPid, 0)).toThrow();
        expect(fs.existsSync(lateFile)).toBe(false);
        expect(leases.inspect({ scope: 'workspace', path: dir })).toEqual([]);
    } finally {
        if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
        db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('output-limit termination releases the lease and reports a bounded error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-command-output-'));
    const db = new Database(path.join(dir, 'leases.db'));
    const leases = createWriteLeases(db);
    try {
        expect(() => workspaceCommand(leases, dir, process.execPath,
            ['-e', 'setInterval(() => process.stdout.write("x".repeat(1024)), 1)'], { maxBuffer: 1024 })).toThrow(expect.objectContaining({ code: 'ENOBUFS' }));
        expect(leases.inspect({ scope: 'workspace', path: dir })).toEqual([]);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('command tools retain stderr diagnostics on success and stdout on failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-command-diagnostics-'));
    const db = new Database(path.join(dir, 'leases.db'));
    const leases = createWriteLeases(db);
    try {
        expect(workspaceCommand(leases, dir, process.execPath, ['-e', 'console.error("diagnostic")'], { includeStderr: true })).toContain('diagnostic');
        try { workspaceCommand(leases, dir, process.execPath, ['-e', 'console.log("progress"); process.exit(3)']); }
        catch (error) { expect(error.stdout).toContain('progress'); expect(error.exitCode).toBe(3); }
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
