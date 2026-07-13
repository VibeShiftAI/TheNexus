/**
 * Append-only audit log and compensation payloads for praxis-mind writes.
 * The log contains full before-images, so keep it private to the local user.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

function appendTransition(record, logPath = cfg.TRANSITION_LOG) {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort for existing dirs */ }

  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(logPath, 0o600); } catch (_) { /* unsupported filesystem */ }
}

function readTransitions(logPath = cfg.TRANSITION_LOG) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid transition log JSON at line ${index + 1}: ${error.message}`);
      }
    });
}

function findTransition(transactionId, logPath = cfg.TRANSITION_LOG) {
  return readTransitions(logPath).find((record) => record.transaction_id === transactionId) || null;
}

function pickBefore(before, keys) {
  const result = {};
  for (const key of keys) {
    if (before && Object.prototype.hasOwnProperty.call(before, key)) result[key] = before[key];
  }
  return result;
}

function buildCompensation(record) {
  if (!record || !record.transaction_id || !record.tool) {
    throw new Error('A transition record with transaction_id and tool is required.');
  }

  let compensation;
  switch (record.tool) {
    case 'nexus_task_update': {
      const keys = Object.keys(record.intent?.patch || {});
      compensation = {
        kind: 'mcp_tool',
        tool: 'nexus_task_update',
        arguments: {
          task_id: record.target?.task_id,
          ...pickBefore(record.before, keys),
        },
      };
      break;
    }
    case 'nexus_project_update': {
      const mutableKeys = Object.keys(record.intent?.patch || {})
        .filter((key) => !['end_state_source', 'end_state_reason'].includes(key));
      const body = pickBefore(record.before, mutableKeys);
      if (record.intent?.add_need || record.intent?.resolve_need) {
        body.needs = Array.isArray(record.before?.needs) ? record.before.needs : [];
      }
      compensation = {
        kind: 'api_request',
        method: 'PATCH',
        path: `/api/projects/${encodeURIComponent(record.target?.project_id || '')}`,
        body,
      };
      break;
    }
    case 'nexus_task_create': {
      const taskId = record.after?.id || record.target?.task_id;
      compensation = {
        kind: 'api_request',
        method: 'DELETE',
        path: `/api/tasks/${encodeURIComponent(record.target?.project_id || record.after?.project_id || '')}/tasks/${encodeURIComponent(taskId || '')}`,
      };
      break;
    }
    case 'vault_write':
      compensation = record.before?.exists
        ? {
            kind: 'mcp_tool',
            tool: 'vault_write',
            arguments: {
              path: record.target?.path,
              content: record.before.content,
              mode: 'replace',
            },
          }
        : {
            kind: 'filesystem_delete',
            path: path.join(cfg.VAULT, record.target?.path || ''),
          };
      break;
    case 'memory_write': {
      const episodeUuid = record.target?.episode_uuid || record.after?.name;
      const namespace = record.target?.namespace;
      compensation = {
        kind: 'cortex_cleanup',
        episode_uuid: episodeUuid,
        namespace,
        operations: [
          {
            method: 'POST',
            path: '/api/graph/cypher',
            body: {
              query: 'MATCH (episode:Episodic {name: $episode_uuid}) DETACH DELETE episode',
              params: { episode_uuid: episodeUuid },
            },
          },
          {
            method: 'DELETE',
            path: '/api/memory/vectors',
            body: { ids: [episodeUuid], namespace },
          },
        ],
      };
      break;
    }
    default:
      throw new Error(`Unsupported transaction tool: ${record.tool}`);
  }

  return {
    source_transaction_id: record.transaction_id,
    source_verdict: record.verdict,
    generated_at: new Date().toISOString(),
    auto_apply: false,
    compensation,
  };
}

module.exports = {
  appendTransition,
  readTransitions,
  findTransition,
  buildCompensation,
};
