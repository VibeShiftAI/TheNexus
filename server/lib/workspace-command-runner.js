// Private child of workspaceCommand. The caller holds the SQLite write fence
// while this runner owns timeout/output limits and the foreground process group.
const { spawn, spawnSync } = require('child_process');

const input = JSON.parse(process.argv[2]);
const chunks = { stdout: [], stderr: [] };
let bytes = 0, failure, timer, finished = false;
const child = spawn(input.command, input.args, {
    cwd: input.cwd, shell: input.shell, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
});

function terminateGroup() {
    if (!child.pid) return;
    try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') failure ||= { code: error.code, message: error.message }; }
}

function stop(code, message) {
    failure ||= { code, message };
    terminateGroup();
}

function finish(status, signal) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearInterval(parentWatch);
    process.stdout.write(JSON.stringify({ status, signal, failure,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8') }));
}

for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    const remaining = input.maxBuffer - bytes;
    if (remaining > 0) chunks[stream].push(chunk.subarray(0, remaining));
    bytes += chunk.length;
    if (bytes > input.maxBuffer) stop('ENOBUFS', 'Command exceeded its output limit');
});
child.on('error', error => { failure = { code: error.code, message: error.message }; terminateGroup(); });
// A shell may exit with a descendant still holding its pipes. Kill the whole
// group on leader exit as well as on timeout, then wait for the close event.
child.on('exit', terminateGroup);
child.on('close', finish);
timer = setTimeout(() => stop('ETIMEDOUT', `Command timed out after ${input.timeout} ms`), input.timeout);
// Best-effort crash cleanup. Arbitrary external/detached writers still require
// cooperation; no userspace lease can sandbox them or survive every OS failure.
const parentWatch = setInterval(() => {
    if (process.ppid !== input.parentPid) stop('EOWNERLOST', 'Command owner exited');
}, 100);
process.on('SIGTERM', () => stop('EOWNERLOST', 'Command runner terminated'));
process.on('SIGINT', () => stop('EOWNERLOST', 'Command runner interrupted'));
