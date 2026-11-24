const { Worker } = require('node:worker_threads');
const path = require('node:path');

// One reader, bounded work, no stale cache. Identical concurrent reads share
// their snapshot; subsequent calls see committed updates in a new transaction.
function createBoardReader(dbPath, { idleMs = 1000, timeoutMs = 60_000, maxPending = 16 } = {}) {
    let worker = null, idleTimer = null, sequence = 0;
    const pending = new Map();
    const inflight = new Map();

    function stop(target, error = new Error('Board reader closed')) {
        if (worker !== target) return;
        worker = null;
        clearTimeout(idleTimer);
        for (const job of pending.values()) {
            clearTimeout(job.timer);
            job.reject(error);
        }
        pending.clear();
        inflight.clear();
        void target.terminate();
    }

    function start() {
        if (worker) return worker;
        const target = new Worker(path.join(__dirname, 'board-reader-worker.js'), { workerData: { dbPath } });
        worker = target;
        target.on('message', ({ id, result, error }) => {
            if (worker !== target) return;
            const job = pending.get(id);
            if (!job) return;
            pending.delete(id);
            inflight.delete(job.key);
            clearTimeout(job.timer);
            if (error) job.reject(new Error(error));
            else job.resolve(result);
            if (!pending.size) {
                target.unref();
                idleTimer = setTimeout(() => stop(target), idleMs);
                idleTimer.unref();
            }
        });
        target.on('error', error => stop(target, new Error(error.message)));
        target.on('exit', code => stop(target, new Error(`Board reader exited (${code})`)));
        return target;
    }

    function request(projectId, response) {
        const key = JSON.stringify([projectId || null, response || null]);
        if (inflight.has(key)) return inflight.get(key);
        if (pending.size >= maxPending) return Promise.reject(new Error('Board reader is busy; retry shortly'));
        clearTimeout(idleTimer);
        const target = start();
        target.ref();
        const id = ++sequence;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => stop(target, new Error('Board read timed out')), timeoutMs);
            timer.unref();
            pending.set(id, { key, resolve, reject, timer });
        });
        inflight.set(key, promise);
        try { target.postMessage({ id, projectId: projectId || null, response }); }
        catch (error) { stop(target, error); }
        return promise;
    }
    return {
        read: projectId => request(projectId),
        readResponse: (projectId, { compat = false, gzip = false } = {}) => request(projectId, { compat, gzip }),
        close: () => { if (worker) stop(worker); },
    };
}

module.exports = { createBoardReader };
