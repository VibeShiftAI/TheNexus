// Synthetic document registry for the Reviews / Deliverables / home tests:
// answers GET /api/documents and /api/documents/counts with the contract's
// filtering (status, q, project_id, task_id, kind), newest-first paging and
// truthful totals (docs/contracts/document-review-deliverables.md §4). Every
// document here is synthetic; nothing touches a real registry.

export const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

const STATUSES = ['needs_review', 'changes_requested', 'approved', 'reference'];

/** A synthetic registry entry shaped like the list endpoint's rows. */
export function entry(n, overrides = {}) {
  const id = `doc-${String(n).padStart(3, '0')}`;
  const review_status = overrides.review_status ?? 'needs_review';
  return {
    id,
    title: `Synthetic report ${String(n).padStart(3, '0')}`,
    path: `/private/tmp/synthetic/docs/${id}.md`,
    kind: 'report',
    task_id: 'task-1',
    project_id: 'p1',
    root_project_id: 'p1',
    metadata: {},
    purpose: `Synthetic purpose ${n}`,
    requires_review: review_status !== 'reference',
    intended_action: 'none',
    current_revision_id: `rev-${id}`,
    current_revision: { id: `rev-${id}`, document_id: id, content_hash: `${(n % 16).toString(16)}`.repeat(64), byte_length: 10, line_count: 1, captured_at: '2026-10-01T10:00:00Z' },
    created_at: new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString(),
    updated_at: new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString(),
    review_url: `https://nexus.example.test/documents/${id}`,
    review_path: `/documents/${id}`,
    review_status,
    review_state: null,
    ...overrides,
  };
}

/** 130 documents: 104 need review, 10 have changes requested, 6 approved, 10 reference; two projects, three kinds. */
export function syntheticRegistry(count = 130) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const review_status = n <= 104 ? 'needs_review' : n <= 114 ? 'changes_requested' : n <= 120 ? 'approved' : 'reference';
    return entry(n, {
      review_status,
      requires_review: review_status !== 'reference',
      project_id: n % 2 ? 'p1' : 'p2',
      root_project_id: n % 2 ? 'p1' : 'p2',
      task_id: n % 2 ? 'task-1' : 'task-2',
      kind: n % 3 === 0 ? 'spec' : n % 3 === 1 ? 'report' : 'plan',
    });
  });
}

function matches(doc, q) {
  const status = q.get('status') || 'all';
  if (status !== 'all' && doc.review_status !== status) return false;
  if (q.get('project_id') && doc.project_id !== q.get('project_id')) return false;
  if (q.get('task_id') && doc.task_id !== q.get('task_id')) return false;
  if (q.get('kind') && doc.kind !== q.get('kind')) return false;
  const text = (q.get('q') || '').toLowerCase();
  if (text && ![doc.title, doc.purpose, doc.path].some(v => String(v || '').toLowerCase().includes(text))) return false;
  return true;
}

/**
 * A fetch handler over `docs`. Options: `legacy` answers like the
 * pre-contract API (no total, no counts route); `fail` / `failCounts` return
 * 500s; `extra(url, init)` handles any other route first.
 */
export function registryHandler(docs, options = {}) {
  return async (url, init = {}) => {
    if (options.extra) {
      const handled = await options.extra(url, init);
      if (handled) return handled;
    }
    const p = url.pathname;
    if (p === '/api/documents/counts') {
      if (options.legacy) return response({ error: 'Document not found' }, 404);
      if (options.failCounts) return response({ error: 'counts unavailable' }, 500);
      const scope = new URLSearchParams(url.searchParams);
      scope.delete('status');
      const scoped = docs.filter(d => matches(d, scope));
      const counts = Object.fromEntries(STATUSES.map(s => [s, scoped.filter(d => d.review_status === s).length]));
      return response({ counts: { ...counts, all: scoped.length } });
    }
    if (p === '/api/documents') {
      if (options.fail) return response({ error: options.fail }, 500);
      const sorted = [...docs].sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (options.legacy) return response({ documents: sorted.filter(d => !url.searchParams.get('task_id') || d.task_id === url.searchParams.get('task_id')) });
      const filtered = sorted.filter(d => matches(d, url.searchParams));
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const pageDocs = filtered.slice(offset, offset + limit);
      return response({ documents: pageDocs, total: filtered.length, limit, offset, has_more: offset + pageDocs.length < filtered.length, status: url.searchParams.get('status') || 'all' });
    }
    if (p === '/api/projects') return response([{ id: 'p1', name: 'Synthetic One' }, { id: 'p2', name: 'Synthetic Two' }]);
    const tasks = p.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (tasks) return response({ tasks: [{ id: tasks[1] === 'p1' ? 'task-1' : 'task-2', title: `Synthetic task for ${tasks[1]}` }] });
    return response({ error: `unexpected ${init.method ?? 'GET'} ${p}` }, 404);
  };
}

/** Installs a fetch stub that records every call; returns the call log and a restore function. */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), 'http://localhost');
    calls.push({ path: parsed.pathname, method: init.method ?? 'GET', query: parsed.searchParams, body: init.body ? JSON.parse(init.body) : null });
    return handler(parsed, init);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}
