/** Compact board projection. History stays in SQLite and the full-task endpoint. */
const { normalizeTaskBoardStatus, isTaskDone } = require('@praxis/contract');

const SORT = 'priority DESC, created_at ASC, id ASC';

function invalid(message) {
    const error = new Error(message);
    error.code = 'invalid_board_summary_query';
    return error;
}

function parseSummaryQuery(query) {
    for (const key of ['project_id', 'status', 'limit', 'cursor']) {
        if (query[key] !== undefined && (typeof query[key] !== 'string' || !query[key].trim())) {
            throw invalid(`${key} must be a nonempty string`);
        }
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if ((query.limit !== undefined && !/^\d+$/.test(query.limit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw invalid('limit must be an integer between 1 and 100');
    }
    const statuses = query.status === undefined ? [] : [...new Set(query.status.split(',').map(s => s.trim()))].sort();
    if (statuses.some(s => !s || normalizeTaskBoardStatus(s) !== s)) {
        throw invalid('status must contain only canonical task statuses');
    }
    const filters = { project_id: query.project_id ?? null, status: statuses };
    let after = null;
    if (query.cursor !== undefined) {
        try {
            if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
            const bytes = Buffer.from(query.cursor, 'base64url');
            if (bytes.toString('base64url') !== query.cursor) throw new Error();
            const cursor = JSON.parse(bytes.toString('utf8'));
            if (cursor?.v !== 1 || cursor.sort !== SORT || JSON.stringify(cursor.filters) !== JSON.stringify(filters)) throw new Error();
            const key = cursor.after;
            if (!key || !(key.priority === null || (typeof key.priority === 'number' && Number.isFinite(key.priority)))
                || !(key.created_at === null || typeof key.created_at === 'string')
                || typeof key.id !== 'string' || !key.id) throw new Error();
            after = key;
        } catch {
            throw invalid('cursor is malformed or does not match the project/status filters');
        }
    }
    return { limit, filters, after };
}

function getBoardSummary(db, { limit, filters, after }) {
    if (!db) throw new Error('Database unavailable');
    // Count, page and dependency statuses share one read snapshot. Subsequent
    // HTTP pages are live reads, not a snapshot across concurrent task edits.
    return db.transaction(() => {
        const clauses = [filters.project_id === null ? "p.status != 'archived'" : 'p.id = ?'];
        const params = filters.project_id === null ? [] : [filters.project_id];
        if (filters.status.length) {
            clauses.push(`t.status IN (${filters.status.map(() => '?').join(',')})`);
            params.push(...filters.status);
        }
        const where = clauses.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS total FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where}`).get(...params).total;
        let seek = '';
        const seekParams = [];
        if (after) {
            // SQLite sorts NULL priority last (DESC), NULL timestamps first
            // (ASC). IS provides null-safe equality for tied ordering keys.
            seek = ` AND (t.priority < ? OR (t.priority IS NULL AND ? IS NOT NULL)
                OR (t.priority IS ? AND (t.created_at > ? OR (? IS NULL AND t.created_at IS NOT NULL)
                    OR (t.created_at IS ? AND t.id > ?))))`;
            seekParams.push(after.priority, after.priority, after.priority, after.created_at, after.created_at, after.created_at, after.id);
        }
        // QA availability is a conservative hint, never a verdict. Only existing
        // review artifacts and the QA writer's status prefixes count; descriptions
        // may contain additional evidence available through detail.href.
        const rows = db.prepare(`SELECT t.id, t.project_id, p.name AS project_name,
                t.name AS title, t.status, t.priority, t.dependencies, t.updated_at, t.version, t.created_at,
                COALESCE(length(t.description) > 0, 0) AS has_description,
                COALESCE(length(t.antigravity_payload) > 0 AND t.antigravity_payload != 'null', 0) AS has_payload,
                (COALESCE(length(t.walkthrough) > 0, 0) OR COALESCE(length(t.critic_feedback) > 0, 0)
                    OR CASE WHEN json_valid(t.metadata) THEN COALESCE(lower(substr(json_extract(t.metadata, '$.status_message'), 1, 9)) IN ('qa passed', 'qa failed'), 0) ELSE 0 END
                ) AS has_qa_evidence
            FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE ${where}${seek}
            ORDER BY t.priority DESC, t.created_at ASC, t.id ASC LIMIT ?`).all(...params, ...seekParams, limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        for (const row of pageRows) {
            row.dependencies = row.dependencies === null ? [] : JSON.parse(row.dependencies);
            if (!Array.isArray(row.dependencies) || row.dependencies.some(id => typeof id !== 'string' || !id)) {
                throw new Error(`Invalid dependencies for task ${row.id}`);
            }
        }
        const dependencyIds = [...new Set(pageRows.flatMap(row => row.dependencies))];
        const statuses = new Map();
        // Referenced IDs only, including tasks hidden by project/status filters.
        for (let offset = 0; offset < dependencyIds.length; offset += 500) {
            const ids = dependencyIds.slice(offset, offset + 500);
            const dependencies = db.prepare(`SELECT id, status FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
            for (const dependency of dependencies) statuses.set(dependency.id, dependency.status);
        }
        const tasks = pageRows.map(row => ({
            id: row.id, project_id: row.project_id, project_name: row.project_name,
            title: row.title, status: row.status, priority: row.priority ?? 0,
            dependencies: row.dependencies,
            is_unblocked: row.dependencies.every(id => isTaskDone(statuses.get(id))),
            updated_at: row.updated_at, version: row.version,
            detail: {
                href: `/api/tasks/${encodeURIComponent(row.id)}`,
                has_description: Boolean(row.has_description),
                has_payload: Boolean(row.has_payload),
                has_qa_evidence: Boolean(row.has_qa_evidence),
            },
        }));
        const last = pageRows[pageRows.length - 1];
        const nextCursor = hasMore ? Buffer.from(JSON.stringify({
            v: 1, sort: SORT, filters,
            after: { priority: last.priority, created_at: last.created_at, id: last.id },
        })).toString('base64url') : null;
        return {
            view: 'summary', tasks,
            page: { limit, returned: tasks.length, total, has_more: hasMore, next_cursor: nextCursor, sort: SORT },
        };
    })();
}

module.exports = { parseSummaryQuery, getBoardSummary };
