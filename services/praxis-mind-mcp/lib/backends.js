/**
 * HTTP clients for Cortex, Praxis, and Nexus. Uses native fetch (Node 18+).
 * Sets reasonable timeouts and surfaces structured errors.
 */
const cfg = require('./config');
const { log } = require('./log');

async function httpJSON(url, { method = 'GET', body = null, headers = {}, timeout = cfg.HTTP_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────── Cortex ───────────────────

const cortexHeaders = () => (cfg.CORTEX_GATEWAY_KEY ? { 'X-Gateway-Key': cfg.CORTEX_GATEWAY_KEY } : {});

async function cortexSearch({ query, k = 10, namespace = 'ai-research' }) {
  // Cortex semantic search lives behind a few possible endpoints — try the
  // canonical recent-nodes search shape first; fall back gracefully.
  return httpJSON(`${cfg.CORTEX_GATEWAY}/api/memory/search`, {
    method: 'POST',
    headers: cortexHeaders(),
    body: { query, k, namespace },
  });
}

async function cortexRecent({ hours = 24, limit = 50, types = null }) {
  return httpJSON(`${cfg.CORTEX_GATEWAY}/api/graph/recent-nodes`, {
    method: 'POST',
    headers: cortexHeaders(),
    body: { hours, limit, types },
  });
}

async function cortexCypher({ query, params = {} }) {
  // Read-only check happens at the tool layer; this is the raw wire call.
  return httpJSON(`${cfg.CORTEX_GATEWAY}/api/graph/cypher`, {
    method: 'POST',
    headers: cortexHeaders(),
    body: { query, params },
  });
}

async function cortexVaultSearch({ query, k = 8, rerank = false }) {
  // Hybrid vault retrieval (BM25 + vector + RRF, backlink-boosted) over the
  // watcher-built index at shared-mind/.index/vault-search.json.
  return httpJSON(`${cfg.CORTEX_GATEWAY}/api/vault/search`, {
    method: 'POST',
    headers: cortexHeaders(),
    body: { query, k, rerank },
  });
}

async function cortexIngestAtoms(payload) {
  // Direct wrap of /api/memory/ingest_atoms — same shape Praxis Path B uses.
  return httpJSON(`${cfg.CORTEX_GATEWAY}/api/memory/ingest_atoms`, {
    method: 'POST',
    headers: cortexHeaders(),
    body: payload,
    timeout: 60000,
  });
}

// ─────────────────── Praxis ───────────────────

async function praxisChat({ messages, system = null, max_tokens = 2048, depth = 1, caller = 'unknown' }) {
  // /v1/brain/chat is the external-caller endpoint added in Wave 5.
  // Praxis strips tools server-side and forces tier=reasoning — three layers
  // of loop prevention (client-side, server-side, depth header).
  // X-MCP-Caller attributes the downstream LLM call in the usage log.
  const body = {
    messages,
    system: system || undefined,
    max_tokens,
  };
  return httpJSON(`${cfg.PRAXIS}/v1/brain/chat`, {
    method: 'POST',
    headers: { 'X-Brain-Depth': String(depth), 'X-MCP-Caller': caller },
    body,
    timeout: cfg.BRAIN_TIMEOUT_MS,
  });
}

// ─────────────────── Nexus ───────────────────

async function nexusProjects() {
  return httpJSON(`${cfg.NEXUS}/api/projects`);
}

async function nexusTasksByProject(projectId) {
  return httpJSON(`${cfg.NEXUS}/api/tasks?project_id=${encodeURIComponent(projectId)}`);
}

async function nexusTaskById(taskId) {
  return httpJSON(`${cfg.NEXUS}/api/tasks/${encodeURIComponent(taskId)}`);
}

async function nexusTaskCreate({ project_id, name, description = '', status = 'idea', priority = 1, antigravity_payload = null, dependencies = [], source = 'praxis-mind-mcp' }) {
  // Use the batch endpoint because it supports antigravity_payload + dependencies.
  return httpJSON(`${cfg.NEXUS}/api/tasks/batch`, {
    method: 'POST',
    body: {
      project_id,
      tasks: [
        {
          name,
          description,
          status,
          priority,
          antigravity_payload: antigravity_payload || undefined,
          dependencies,
          stable_id: 'task-1',
        },
      ],
    },
  });
}

async function nexusTaskUpdate(taskId, patch) {
  // PATCH /api/tasks/:taskId — partial update. Only the keys present in `patch`
  // are changed (status, priority, description, dependencies).
  return httpJSON(`${cfg.NEXUS}/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

module.exports = {
  httpJSON,
  cortexSearch,
  cortexRecent,
  cortexCypher,
  cortexVaultSearch,
  cortexIngestAtoms,
  praxisChat,
  nexusProjects,
  nexusTasksByProject,
  nexusTaskById,
  nexusTaskCreate,
  nexusTaskUpdate,
};
