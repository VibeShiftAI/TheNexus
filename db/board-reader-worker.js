const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { readBoardState } = require('./board-state');

// Never import db/index: a reader must not run migrations or mutate production.
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
db.pragma('query_only = ON');
parentPort.on('message', ({ id, projectId }) => {
    try {
        parentPort.postMessage({ id, result: readBoardState(db, projectId) });
    } catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
