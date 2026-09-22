const { canonicalPath } = require('../../db/write-leases');

function requireLeases(db) {
    if (!db.writeLeases) throw Object.assign(new Error('Write lease database unavailable'), { status: 503, code: 'write_leases_unavailable' });
    return db.writeLeases;
}

function sendLeaseError(res, error) {
    if (!error.code?.startsWith('write_lease') && error.code !== 'invalid_write_lease') return false;
    res.status(error.status || 409).json({ error: error.message, code: error.code, ...(error.holders?.length ? { holders: error.holders } : {}) });
    return true;
}

function requestLease(db, resolveResource) {
    return async (req, res, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        try {
            const resource = await resolveResource(req);
            if (res.destroyed || res.writableEnded) return;
            if (!resource) return next();
            const leases = requireLeases(db);
            await leases.run(resource, () => new Promise(resolve => {
                // Closing an aborted request revokes its automatic lease. A
                // handler resuming later retains the old token and fails closed.
                res.once('finish', resolve);
                res.once('close', resolve);
                next();
            }), { token: req.get(`x-nexus-${resource.scope}-lease`), owner: `http:${req.method}:${req.path}`.slice(0, 200) });
        } catch (error) {
            if (!res.headersSent && !sendLeaseError(res, error)) next(error);
        }
    };
}

function boardRequestLease(db) {
    // Route unit tests use deliberately narrow injected DB doubles. The real
    // facade always exports writeLeases, including null when startup failed.
    if (!('writeLeases' in db)) return (_req, _res, next) => next();
    return requestLease(db, () => ({ scope: 'board' }));
}

// Foreground commands cannot be fenced after they have started. Hold SQLite's
// writer transaction until the child terminates, so expiry or an HTTP disconnect
// cannot admit another writer while git/the shell is still changing files.
function workspaceCommand(leases, cwd, command, args, options = {}) {
    const { timeout = 30000, maxBuffer = 1024 * 1024, shell = false, token, leasePath = cwd } = options;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000 ||
        !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 1024 * 1024) {
        throw Object.assign(new Error('Invalid command timeout or output limit'), { status: 400, code: 'invalid_write_lease' });
    }
    return leases.runSync({ scope: 'workspace', path: leasePath }, () => {
        const output = require('child_process').execFileSync(process.execPath,
            [require.resolve('./workspace-command-runner'), JSON.stringify({ command, args, cwd, shell, timeout, maxBuffer, parentPid: process.pid })],
            { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        const result = JSON.parse(output);
        if (result.failure || result.status !== 0) {
            throw Object.assign(new Error(result.failure?.message || result.stderr || `Command exited with status ${result.status}`),
                { code: result.failure?.code || 'COMMAND_FAILED', exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
        }
        return options.includeStderr && result.stderr ? `${result.stdout}\nSTDERR:\n${result.stderr}` : result.stdout;
    }, { token });
}

module.exports = { workspaceCommand, requireLeases, sendLeaseError, requestLease, boardRequestLease, canonicalPath };
