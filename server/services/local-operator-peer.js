/**
 * macOS-only bootstrap evidence. HTTP headers never identify the application.
 * Inspect the client end of this exact live TCP connection, then validate the
 * running code (numeric PID), console UID, executable path and interactive launch.
 * Only the pinned native app or Google Chrome's ordinary profile qualifies.
 * See docs/contracts/local-operator-session.md for provisioning and limits.
 */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESKTOP = '/Applications/The Nexus.app/Contents/MacOS/nexus-desktop';
// Chrome accepts both '-' and '--' switches. A blacklist is insufficient.
// Permit only ordinary launch/restore options observed in the operator profile.
function interactiveChrome(commandLine) {
    if (commandLine !== CHROME && !commandLine.startsWith(CHROME + ' ')) return false;
    return commandLine.slice(CHROME.length).trim().split(/\s+/).filter(Boolean).every(arg =>
        /^--(?:no-startup-window|restore-last-session|no-first-run|flag-switches-begin|flag-switches-end)$/.test(arg)
        || /^--origin-trial-disabled-features=[A-Za-z0-9|,_.-]+$/.test(arg)
        || /^https?:\/\//.test(arg));
}

function localPeerPolicy() {
    const uid = process.env.NEXUS_LOCAL_OPERATOR_UID || '';
    const desktop = process.env.NEXUS_LOCAL_OPERATOR_DESKTOP_CDHASH || '';
    const chrome = process.env.NEXUS_LOCAL_OPERATOR_CHROME === '1';
    if (!/^[1-9]\d{0,9}$/.test(uid) || (desktop && !/^[a-f0-9]{40}$/.test(desktop)) || (!desktop && !chrome)) {
        throw Object.assign(new Error('Local application pins are not configured'), { status: 503 });
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ uid, desktop, chrome })).digest('hex');
    return { uid: Number(uid), desktop, chrome, fingerprint };
}

function connectionOwner(output, socket) {
    const address = value => value.replace(/^::ffff:/, '');
    const endpoint = (ip, port) => `${address(ip).includes(':') ? `[${address(ip)}]` : address(ip)}:${port}`;
    const wanted = `${endpoint(socket.remoteAddress, socket.remotePort)}->${endpoint(socket.localAddress, socket.localPort)}`;
    let pid;
    const owners = new Set();
    for (const line of output.split('\n')) {
        if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
        if (line === `n${wanted}` && pid) owners.add(pid);
    }
    return owners.size === 1 ? [...owners][0] : null;
}

function processInfo(output) {
    const match = output.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return match ? { ppid: Number(match[1]), uid: Number(match[2]), started: match[3], command: match[4] } : null;
}

async function command(file, args) {
    return exec(file, args, {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
        // Do not inherit executor-controlled loader or tool-search settings.
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
    });
}

function createLocalOperatorPeerVerifier({ run = command, platform = process.platform,
    consoleUid = () => statSync('/dev/console').uid } = {}) {
    return async function verifyPeer(req) {
        try {
            const policy = localPeerPolicy();
            const socket = req.socket;
            if (platform !== 'darwin' || consoleUid() !== policy.uid || socket?.destroyed
                || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket?.remoteAddress)
                || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket?.localAddress)
                || !Number.isInteger(socket?.remotePort) || !Number.isInteger(socket?.localPort)) return null;
            const owner = async () => connectionOwner((await run('/usr/sbin/lsof',
                ['-nP', '-a', `-iTCP:${socket.localPort}`, '-sTCP:ESTABLISHED', '-Fpn'])).stdout, socket);
            const info = async pid => processInfo((await run('/bin/ps',
                ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'uid=', '-o', 'lstart=', '-o', 'args='])).stdout);
            const code = async pid => {
                const output = (await run('/usr/bin/codesign', ['--display', '--verbose=4', String(pid)])).stderr;
                return { ...Object.fromEntries(output.split('\n').filter(line => line.includes('='))
                    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])),
                    CodeDirectory: output.split('\n').find(line => line.startsWith('CodeDirectory ')) };
            };
            // Numeric PID requests dynamic validation; verbosity additionally
            // requires a full static check (codesign(1), OPERATION). The +PID
            // spelling fails for this hardened app on current macOS.
            const validate = (pid, requirement, strict = '--strict') => run('/usr/bin/codesign',
                ['--verify', '--verbose=1', strict, '-R', `=${requirement}`, String(pid)]);
            const pid = await owner();
            if (!pid) return null;
            const before = await info(pid);
            if (!before || before.uid !== policy.uid) return null;
            const signing = await code(pid);
            let device, parent, parentBefore;
            if (policy.desktop && signing.Executable === DESKTOP && before.ppid === 1) {
                if (!/\bruntime\b/.test(signing.CodeDirectory || '')) return null;
                await validate(pid, `cdhash H"${policy.desktop}"`);
                device = 'mac-desktop';
            } else if (policy.chrome && signing.Identifier === 'com.google.Chrome.helper'
                && signing.Executable?.startsWith('/Applications/Google Chrome.app/Contents/Frameworks/')
                && before.command.includes('--utility-sub-type=network.mojom.NetworkService')) {
                const google = 'anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"';
                // Keep dynamic identity, full static resource validation and
                // sealed symlink checks. Chrome's FinderInfo/ResourceFork
                // sideband metadata is not identity proof (codesign(1), --strict).
                // This is a fixed Chrome policy, never a signature-error fallback.
                await validate(pid, `identifier "com.google.Chrome.helper" and ${google}`, '--strict=symlinks');
                parent = before.ppid;
                parentBefore = await info(parent);
                if (!parentBefore || parentBefore.ppid !== 1 || parentBefore.uid !== policy.uid
                    || !interactiveChrome(parentBefore.command) || (await code(parent)).Executable !== CHROME) return null;
                await validate(parent, `identifier "com.google.Chrome" and ${google}`, '--strict=symlinks');
                device = 'mac-chrome';
            } else return null;
            // Recheck the live tuple and process generation after signing checks.
            // A closed/reused socket or exited/replaced process never earns proof.
            if (socket.destroyed || await owner() !== pid
                || JSON.stringify(await info(pid)) !== JSON.stringify(before)
                || (parent && JSON.stringify(await info(parent)) !== JSON.stringify(parentBefore))
                || consoleUid() !== policy.uid) return null;
            return device;
        } catch { return null; } // fixed refusal, never command/claim material
    };
}

module.exports = { createLocalOperatorPeerVerifier, localPeerPolicy, connectionOwner, processInfo };
