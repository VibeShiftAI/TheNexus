const { gzipSync, constants } = require('node:zlib');
const { guardDispatchPayload } = require('../lib/provenance');

// Full-board provenance, JSON encoding and compression can consume seconds
// under memory pressure. The reader worker owns all of this CPU/memory work.
function encodeBoardResponse(board, { compat = false, gzip = false } = {}) {
    const payload = board.map(project => ({
        ...project,
        tasks: (project.tasks || []).map(task => ({
            ...task,
            ...(compat ? { title: task.name, createdAt: task.created_at, updatedAt: task.updated_at } : {}),
            ...(task.antigravity_payload ? { antigravity_payload: guardDispatchPayload(task) } : {}),
        })),
    }));
    const json = JSON.stringify(payload);
    // Own the ArrayBuffer: transfer bytes without structured-cloning a 30MB
    // object graph back onto the HTTP thread. No pooled Buffer is transferred.
    return gzip
        ? Uint8Array.from(gzipSync(json, { level: constants.Z_BEST_SPEED }))
        : new TextEncoder().encode(json);
}

module.exports = { encodeBoardResponse };
