const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { readBoardState } = require('./board-state');
const { encodeBoardResponse } = require('../server/services/board-response');

// Never import db/index: a reader must not run migrations or mutate production.
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
db.pragma('query_only = ON');
parentPort.on('message', ({ id, projectId, response }) => {
    try {
        const board = readBoardState(db, projectId);
        if (response) {
            const result = encodeBoardResponse(board, response);
            parentPort.postMessage({ id, result }, [result.buffer]);
        } else {
            parentPort.postMessage({ id, result: board });
        }
    } catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
