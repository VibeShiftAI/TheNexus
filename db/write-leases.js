const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_TTL = 30000;

function leaseError(code, message, status = 409, holders = []) {
    return Object.assign(new Error(message), { code, status, holders });
}

// Resolve existing ancestors too, so a new file through a symlink cannot get
// a different lease from the same file through the real workspace directory.
function canonicalPath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
        throw leaseError('invalid_write_lease', 'Workspace path must be absolute', 400);
    }
    try { return fs.realpathSync.native(value); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(value);
        // realpath cannot resolve a dangling symlink, but a later write follows it.
        // Read that link explicitly so both spellings reserve the future target.
        try {
            if (fs.lstatSync(value).isSymbolicLink()) {
                return canonicalPath(path.resolve(parent, fs.readlinkSync(value)));
            }
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        if (parent === value) throw error;
        return path.join(canonicalPath(parent), path.basename(value));
    }
}

function resource(input) {
    if (input?.scope === 'board') return { scope: 'board', path: '' };
    if (input?.scope === 'workspace') return { scope: 'workspace', path: canonicalPath(input.path) };
    throw leaseError('invalid_write_lease', 'scope must be board or workspace', 400);
}

function contains(parent, child) {
    // Conservatively contend case/Unicode aliases, including nonexistent leaves
    // on case-insensitive volumes. This may serialize distinct Linux filenames.
    const folded = value => value.normalize('NFC').toLowerCase();
    const relative = path.relative(folded(parent), folded(child));
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function ttl(value = DEFAULT_TTL) {
    if (!Number.isSafeInteger(value) || value < 1000 || value > 300000) {
        throw leaseError('invalid_write_lease', 'ttl_ms must be an integer from 1000 to 300000', 400);
    }
    return value;
}

// A request id outlives its lease, or its cancellation, by this long. A POST
// that reaches the server after its caller gave up and released by request id
// is then refused instead of granting a lease nobody holds.
const REQUEST_RETENTION = 600000;

// The request id is chosen by the acquirer and can recover the token, so it
// is a bearer secret like the token: long enough not to be guessed.
function requestId(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !/^[\x21-\x7e]{16,200}$/.test(value)) {
        throw leaseError('invalid_write_lease', 'request_id must be 16 to 200 visible ASCII characters', 400);
    }
    return value;
}

function publicLease({ token, ...lease }) { return lease; }

function createWriteLeases(db, { now = Date.now } = {}) {
    const context = new AsyncLocalStorage();
    db.exec(`CREATE TABLE IF NOT EXISTS write_leases (
        token TEXT PRIMARY KEY, scope TEXT NOT NULL, path TEXT NOT NULL,
        owner TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS write_leases_scope ON write_leases(scope, expires_at);
    CREATE TABLE IF NOT EXISTS write_lease_requests (
        request_id TEXT PRIMARY KEY, owner TEXT, token TEXT, retain_until INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS write_lease_requests_token ON write_lease_requests(token);`);
    const atomic = fn => {
        try { return db.transaction(fn).immediate(); }
        catch (error) {
            if (error.code === 'SQLITE_BUSY') throw leaseError('write_lease_busy', 'Another writer is committing; retry after it finishes');
            throw error;
        }
    };
    const byToken = token => {
        if (typeof token !== 'string' || !token) throw leaseError('invalid_write_lease', 'Lease token is required', 400);
        return db.prepare('SELECT * FROM write_leases WHERE token = ?').get(token);
    };
    const live = r => db.prepare('SELECT * FROM write_leases WHERE scope = ? AND expires_at > ?').all(r.scope, now())
        .filter(row => r.scope === 'board' || contains(row.path, r.path) || contains(r.path, row.path));

    const requestById = id => {
        db.prepare('DELETE FROM write_lease_requests WHERE retain_until <= ?').run(now());
        return db.prepare('SELECT * FROM write_lease_requests WHERE request_id = ?').get(id);
    };

    function acquire(input, { owner = 'nexus', ttl_ms, request_id } = {}) {
        const r = resource(input), duration = ttl(ttl_ms), id = requestId(request_id);
        if (typeof owner !== 'string' || !owner.trim() || owner.length > 200) {
            throw leaseError('invalid_write_lease', 'owner must be a nonempty string of at most 200 characters', 400);
        }
        return atomic(() => {
            // A repeated request id replays its own live grant, so a caller that
            // lost the first answer can still learn the token. Any other reuse
            // (released, expired, cancelled, other owner or resource) is refused.
            const request = id === undefined ? undefined : requestById(id);
            if (request) {
                const lease = request.token ? byToken(request.token) : undefined;
                if (lease && lease.expires_at > now() && lease.owner === owner && lease.scope === r.scope && lease.path === r.path) {
                    return { ...lease, request_id: id };
                }
                throw leaseError('write_lease_lost', 'request_id was already used and its lease was released, expired or cancelled, or belongs to another owner or resource; acquire with a new request_id');
            }
            const holders = live(r).map(publicLease);
            if (holders.length) throw leaseError('write_lease_conflict', 'Resource has an active writer; retry after its lease is released', 409, holders);
            db.prepare('DELETE FROM write_leases WHERE expires_at <= ?').run(now());
            const lease = { token: randomUUID(), ...r, owner, acquired_at: now(), expires_at: now() + duration };
            db.prepare('INSERT INTO write_leases (token, scope, path, owner, acquired_at, expires_at) VALUES (@token, @scope, @path, @owner, @acquired_at, @expires_at)').run(lease);
            if (id === undefined) return lease;
            db.prepare('INSERT INTO write_lease_requests (request_id, owner, token, retain_until) VALUES (?, ?, ?, ?)')
                .run(id, owner, lease.token, lease.expires_at + REQUEST_RETENTION);
            return { ...lease, request_id: id };
        });
    }

    function assertHeld(input, token) {
        const r = resource(input), lease = byToken(token);
        if (!lease || lease.expires_at <= now() || lease.scope !== r.scope ||
            (r.scope === 'workspace' && !contains(lease.path, r.path))) {
            throw leaseError('write_lease_lost', 'Lease expired, was released, or does not cover this write; reacquire and reread before retrying');
        }
        return lease;
    }

    function renew(token, ttl_ms) {
        const duration = ttl(ttl_ms);
        return atomic(() => {
            const lease = byToken(token);
            if (!lease || lease.expires_at <= now()) throw leaseError('write_lease_lost', 'Cannot renew an expired or released lease');
            lease.expires_at = now() + duration;
            db.prepare('UPDATE write_leases SET expires_at = ? WHERE token = ?').run(lease.expires_at, token);
            db.prepare('UPDATE write_lease_requests SET retain_until = MAX(retain_until, ?) WHERE token = ?')
                .run(lease.expires_at + REQUEST_RETENTION, token);
            return lease;
        });
    }

    function release(token) {
        return atomic(() => {
            if (!db.prepare('DELETE FROM write_leases WHERE token = ?').run(byToken(token)?.token || '').changes) {
                throw leaseError('write_lease_lost', 'Lease no longer exists');
            }
            return true;
        });
    }

    // Release for a caller that never saw the acquisition's answer. Idempotent:
    // it returns whether a live lease was removed. If the POST has not been
    // processed yet, the id is remembered so that late POST is refused.
    function releaseRequest(request_id) {
        const id = requestId(request_id);
        if (id === undefined) throw leaseError('invalid_write_lease', 'request_id is required', 400);
        return atomic(() => {
            const request = requestById(id);
            const retainUntil = now() + REQUEST_RETENTION;
            if (!request) {
                db.prepare('INSERT INTO write_lease_requests (request_id, owner, token, retain_until) VALUES (?, NULL, NULL, ?)').run(id, retainUntil);
                return false;
            }
            db.prepare('UPDATE write_lease_requests SET retain_until = MAX(retain_until, ?) WHERE request_id = ?').run(retainUntil, id);
            const lease = request.token ? byToken(request.token) : undefined;
            if (!lease) return false;
            db.prepare('DELETE FROM write_leases WHERE token = ?').run(lease.token);
            return lease.expires_at > now();
        });
    }

    function choose(input, options) {
        const r = resource(input);
        const token = options.token ?? context.getStore()?.[r.scope];
        // A stale context must fail, never turn into a fresh auto-acquisition.
        return token !== undefined
            ? { lease: assertHeld(r, token), automatic: false }
            : { lease: acquire(r, options), automatic: true };
    }

    function enter(lease, fn) {
        return context.run({ ...context.getStore(), [lease.scope]: lease.token }, fn);
    }

    function releaseOwned(token) {
        // A late finally can only remove its own token, never its successor's.
        db.prepare('DELETE FROM write_leases WHERE token = ?').run(token);
    }

    function runSync(input, fn, options = {}) {
        // Validation and the actual write share a SQLite write transaction.
        // A second connection cannot take over between the check and commit.
        return atomic(() => {
            const { lease, automatic } = choose(input, options);
            try {
                return enter(lease, () => {
                    const result = fn();
                    if (result?.then) throw new Error('runSync requires a synchronous mutation');
                    return result;
                });
            } finally { if (automatic) releaseOwned(lease.token); }
        });
    }

    async function run(input, fn, options = {}) {
        const { lease, automatic } = choose(input, options);
        let timer;
        if (automatic) {
            timer = setInterval(() => {
                try { renew(lease.token, options.ttl_ms); }
                catch { clearInterval(timer); } // subsequent writes are fenced
            }, ttl(options.ttl_ms) / 3);
            timer.unref();
        }
        try { return await enter(lease, fn); }
        finally {
            clearInterval(timer);
            if (automatic) releaseOwned(lease.token);
        }
    }

    return { acquire, renew, release, releaseRequest, assertHeld, run, runSync,
        inspect: input => live(resource(input)).map(publicLease) };
}

module.exports = { createWriteLeases, canonicalPath };
