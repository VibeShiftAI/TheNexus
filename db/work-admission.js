const { createHash } = require('crypto');
const path = require('path');
const { canonicalPath } = require('./write-leases');

const DECISIONS = new Set(['new_work', 'covered_by_open', 'already_delivered', 'partial_overlap', 'needs_evidence']);
const RESOLUTION_WINDOW_MS = 15 * 60 * 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const normalized = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return typeof value === 'string' ? normalized(value) : value ?? null;
}
const fail = (message, status = 409) => Object.assign(new Error(message), { status, code: 'work_admission_conflict' });

function initializeWorkAdmission(db) {
    // The unique key and receipt commit with the task row; no reservation can
    // outlive a rolled-back insert, and a lost response is safe to retry.
    db.exec(`CREATE TABLE IF NOT EXISTS work_admissions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        identity_key TEXT UNIQUE,
        document TEXT NOT NULL
    );`);
}

function createWorkAdmission(db, { now = Date.now, lookup } = {}) {
    const snapshotCache = new Map();
    let cacheDataVersion;
    const readTask = id => {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row) throw fail('Task not found', 404);
        const metadata = object(row.metadata), receipt = readReceipt(id);
        if (receipt) metadata.work_admission = receipt;
        else delete metadata.work_admission;
        return { ...row, metadata, antigravity_payload: object(row.antigravity_payload) };
    };
    const readReceipt = id => {
        const row = db.prepare('SELECT document FROM work_admissions WHERE task_id = ?').get(id);
        return row ? JSON.parse(row.document) : null;
    };
    function contract(task, projectPath) {
        const metadata = object(task.metadata), identity = object(metadata.work_identity), payload = object(task.antigravity_payload);
        const workspacePath = projectPath === undefined ? db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id)?.path : projectPath;
        const requestedWorkspace = identity.workspace || payload.workspace || workspacePath || '';
        let workspace = requestedWorkspace;
        if (path.isAbsolute(requestedWorkspace)) workspace = canonicalPath(requestedWorkspace);
        // Executor repair/session/routing state is operational context, not a
        // changed request. Bind only executable scope and acceptance fields.
        const scopePayload = Object.fromEntries(['prompt', 'workspace', 'acceptance_criteria', 'context_files', 'target_files',
            'scope', 'commands', 'constraints'].filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
        return stable({ project_id: task.project_id, workspace, proposal_id: identity.proposal_id || null,
            name: task.name || task.title || '', description: task.description || '',
            scope: identity.scope || '', acceptance: identity.acceptance || payload.acceptance_criteria || [],
            payload: scopePayload, dispatch_instructions: task.dispatch_instructions || '',
            recurrence: identity.recurrence || null });
    }
    function identityKey(task, repeat) {
        const c = contract(task);
        // A title is a retrieval signal, never exact-identity authority. A
        // declared identity is still bound to scope/acceptance/workspace/run.
        if (!c.proposal_id && !c.description && !c.scope && !Object.keys(c.payload).length) return null;
        return digest({ ...c, ...(c.proposal_id ? { name: null } : {}), repeat_id: repeat?.repeat_id || null });
    }
    const tokens = text => new Set(normalized(text).toLowerCase().match(/[a-z0-9]{3,}/g)?.map(w => w.replace(/(?:ing|ions|ion|ed|s)$/, '')).filter(w => !['the', 'and', 'for', 'with', 'task', 'work', 'before', 'after', 'from', 'that', 'thi'].includes(w)) || []);
    const overlap = (a, b) => [...a].filter(word => b.has(word)).length;
    const scopeText = c => [c.description, JSON.stringify(c.scope), JSON.stringify(c.acceptance), c.payload.prompt || ''].join(' ');
    function score(left, right) {
        const a = left.scopeTokens, b = right.scopeTokens;
        const common = overlap(a, b), fraction = common / Math.max(1, Math.min(a.size, b.size));
        const titleA = left.titleTokens, titleB = right.titleTokens;
        const titleScore = overlap(titleA, titleB) / Math.max(1, Math.max(titleA.size, titleB.size));
        if (common >= 3 && fraction >= 0.45 || common >= 2 && fraction >= 0.3 && titleScore >= 0.65) return fraction + titleScore * 0.2;
        // Legacy title-only items remain review candidates, never merges.
        if ((!a.size || !b.size) && titleScore === 1) return 0.4;
        return 0;
    }
    function distinctRuns(a, b) {
        const left = object(a.recurrence), right = object(b.recurrence);
        return left.run_id && right.run_id && left.observation_window && right.observation_window &&
            left.run_id !== right.run_id && JSON.stringify(left.observation_window) !== JSON.stringify(right.observation_window);
    }
    function inspect(task, concerns = []) {
        const c = contract(task), fingerprint = digest(c);
        try {
            const dataVersion = db.pragma('data_version', { simple: true });
            if (cacheDataVersion !== dataVersion || snapshotCache.size > 5000) snapshotCache.clear();
            cacheDataVersion = dataVersion;
            const projectPath = db.prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id)?.path || '';
            const snapshot = row => {
                const cached = snapshotCache.get(row.id);
                if (cached?.task.version === row.version && cached.projectPath === projectPath) return cached;
                const full = lookup ? row : db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
                const scope = contract(full, projectPath);
                const result = { task: full, contract: scope, projectPath, fingerprint: digest(scope),
                    evidence_hash: digest([full.walkthrough, full.research_output, full.plan_output]),
                    scopeTokens: tokens(scopeText(scope)), titleTokens: tokens(scope.name) };
                snapshotCache.set(row.id, result);
                return result;
            };
            // Cheap version scan covers retained history. Reuse lexical/hash
            // snapshots until the database revision or project workspace changes.
            const rows = lookup ? lookup(task.project_id) : db.prepare('SELECT id, version FROM tasks WHERE project_id = ? AND id != ?').all(task.project_id, task.id || '');
            if (!Array.isArray(rows)) throw new Error('Invalid lookup response');
            const candidates = rows.filter(t => t.id !== task.id).map(snapshot)
                .filter(t => t.contract.workspace === c.workspace);
            // Receipt refreshes, sort order and activity stamps do not change
            // the compared work. Including the row revision here would make
            // two related receipts invalidate one another forever.
            const coverage_hash = digest(candidates.map(({ task: t, fingerprint: fp, evidence_hash }) => [t.id, fp, t.status, t.archived_at,
                evidence_hash]).sort((a, b) => a[0].localeCompare(b[0])));
            const explicit = new Set(concerns.map(x => x.existing_task_id).filter(Boolean));
            const wanted = { scopeTokens: tokens(scopeText(c)), titleTokens: tokens(c.name) };
            const matches = candidates.filter(t => !distinctRuns(c, t.contract)).map(candidate => {
                const t = candidate.task;
                return { task_id: t.id, task_version: t.version, status: t.status, title: t.name,
                    fingerprint: candidate.fingerprint, score: explicit.has(t.id) ? 2 : score(wanted, candidate),
                    evidence_hash: candidate.evidence_hash };
            }).filter(t => t.score > 0).sort((a, b) => b.score - a.score || a.task_id.localeCompare(b.task_id)).slice(0, 3);
            return { fingerprint, matches, coverage_hash, coverage: { project_id: task.project_id, workspace: c.workspace,
                searched_count: candidates.length, retained_history: true, shortlist_limit: 3 }, lookup_failed: false };
        } catch (error) {
            return { fingerprint, matches: [], coverage_hash: null, coverage: { project_id: task.project_id, workspace: c.workspace,
                retained_history: true, shortlist_limit: 3, error: 'lookup_unavailable' }, lookup_failed: true };
        }
    }
    function baseReceipt(task, concerns = [], previous) {
        const inspected = inspect(task, concerns);
        const decision = inspected.lookup_failed || inspected.matches.length || concerns.length ? 'needs_evidence' : 'new_work';
        return { schema_version: 1, ...inspected, decision, checked_at: new Date(now()).toISOString(), owner: 'work-admission', concerns,
            reason: inspected.lookup_failed ? 'Project lookup unavailable; evidence review is required.' :
                concerns.length ? 'A duplicate concern requires a bounded evidence comparison.' :
                    inspected.matches.length ? 'Possible scope overlap requires a bounded evidence comparison.' : 'No relevant overlap found within recorded project/workspace coverage.',
            ...(previous ? { previous_decision: previous.decision } : {}) };
    }
    function save(task, receipt, { mutation = false } = {}) {
        db.prepare('INSERT INTO work_admissions (task_id, document) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document').run(task.id, JSON.stringify(receipt));
        // Ordinary reads refresh the authoritative receipt projection without
        // manufacturing a task edit. Explicit decisions/concerns remain CAS
        // protected task mutations and bump the normal task version.
        if (mutation) {
            const metadata = { ...object(task.metadata), work_admission: receipt };
            db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), task.id);
        }
        return readTask(task.id);
    }
    function admit(input, insert, options = {}) {
        return db.transaction(() => {
            const repeat = options.repeat;
            if (repeat && options.authority !== 'operator_credential') throw fail('Trusted operator repeat authority required', 403);
            if (repeat && (!normalized(repeat.repeat_id) || !normalized(repeat.reason))) throw fail('Repeat requires repeat_id and reason', 400);
            const task = { ...input, metadata: { ...object(input.metadata) } };
            delete task.metadata.work_admission;
            const identity = identityKey(task, repeat);
            const reserved = identity && db.prepare('SELECT task_id FROM work_admissions WHERE identity_key = ?').get(identity);
            if (reserved) return readTask(reserved.task_id);
            const existing = task.id && db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id);
            if (existing) {
                if (digest(contract(readTask(task.id))) !== digest(contract(task))) throw fail('Task id already owns a different proposal contract');
                return readTask(task.id);
            }
            const receipt = baseReceipt(task);
            if (repeat && !receipt.lookup_failed) Object.assign(receipt, { decision: 'new_work', reason: repeat.reason,
                authority: options.authority, repeat_id: repeat.repeat_id });
            task.metadata.work_admission = receipt;
            insert(task);
            // Creation already includes metadata; avoid an artificial task version.
            db.prepare('INSERT INTO work_admissions (task_id, identity_key, document) VALUES (?, ?, ?)').run(task.id, identity, JSON.stringify(receipt));
            return readTask(task.id);
        }).immediate();
    }
    function current(id) {
        return db.transaction(() => {
            const task = readTask(id), previous = readReceipt(id);
            const inspected = inspect(task, previous?.concerns || []);
            if (previous && previous.fingerprint === inspected.fingerprint && previous.coverage_hash === inspected.coverage_hash && !inspected.lookup_failed) {
                const expired = !previous.resolved_at && now() - Date.parse(previous.checked_at) > RESOLUTION_WINDOW_MS;
                if (!expired && JSON.stringify(previous.matches) === JSON.stringify(inspected.matches)) return task;
                return save(task, { ...previous, matches: inspected.matches,
                    ...(expired ? { checked_at: new Date(now()).toISOString() } : {}) });
            }
            return save(task, baseReceipt(task, previous?.concerns || [], previous));
        }).immediate();
    }
    function guardUpdate(task, updates) {
        const previous = readReceipt(task.id);
        if (!previous) {
            if (updates.metadata !== undefined) {
                updates.metadata = { ...object(updates.metadata) }; delete updates.metadata.work_admission;
            }
            return updates;
        }
        // Generic metadata writers may neither clear a hold nor swap the
        // proposal identity. Scope edits invalidate the server-owned decision.
        const metadata = { ...object(updates.metadata === undefined ? task.metadata : updates.metadata) };
        const priorMetadata = object(task.metadata);
        if (priorMetadata.work_identity) metadata.work_identity = priorMetadata.work_identity;
        if (digest(contract({ ...task, ...updates, metadata })) !== previous.fingerprint) {
            const next = baseReceipt({ ...task, ...updates, metadata }, previous.concerns || [], previous);
            next.decision = 'needs_evidence'; next.reason = 'Proposal contract changed; review the current scope before execution.';
            metadata.work_admission = next;
            db.prepare('UPDATE work_admissions SET document = ? WHERE task_id = ?').run(JSON.stringify(next), task.id);
        } else metadata.work_admission = previous;
        return { ...updates, metadata };
    }
    function requireVersion(task, input) {
        if (!Number.isSafeInteger(input.expected_task_version) || input.expected_task_version !== task.version) throw fail('Task changed since admission was read');
    }
    function concerns(id, input, authority) {
        if (authority !== 'runtime_credential') throw fail('Trusted runtime credential required', 403);
        return db.transaction(() => {
            const task = current(id); requireVersion(task, input);
            if (!Array.isArray(input.concerns) || input.concerns.length < 1 || input.concerns.length > 3 ||
                input.concerns.some(c => !normalized(c.reason))) throw fail('Provide one to three reasoned duplicate concerns', 400);
            const previous = readReceipt(id), merged = [...(previous.concerns || [])];
            for (const concern of input.concerns) {
                const value = { reason: normalized(concern.reason), ...(concern.existing_task_id ? { existing_task_id: String(concern.existing_task_id) } : {}),
                    ...(concern.seat_id ? { seat_id: String(concern.seat_id) } : {}) };
                value.key = digest({ reason: value.reason, existing_task_id: value.existing_task_id });
                if (!merged.some(c => c.key === value.key)) merged.push(value);
            }
            if (merged.length === (previous.concerns || []).length) return task;
            const receipt = baseReceipt(task, merged, previous);
            return save(task, receipt, { mutation: true });
        }).immediate();
    }
    function resolve(id, input, authority) {
        if (authority !== 'runtime_credential' && authority !== 'operator_credential') throw fail('Trusted admission credential required', 403);
        return db.transaction(() => {
            const task = current(id); requireVersion(task, input);
            const previous = readReceipt(id);
            if (input.fingerprint !== previous.fingerprint || input.checked_at !== previous.checked_at ||
                now() - Date.parse(input.checked_at) > RESOLUTION_WINDOW_MS || Date.parse(input.checked_at) > now()) throw fail('Admission comparison expired or changed; refresh before resolving');
            if (!DECISIONS.has(input.decision) || !normalized(input.reason)) throw fail('Valid admission decision and reason required', 400);
            if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 10 ||
                input.evidence.some(e => !normalized(e.ref) || !/^[a-f0-9]{64}$/i.test(e.hash))) throw fail('Resolution requires referenced SHA-256 evidence', 400);
            const expectedMatches = previous.matches.map(m => [m.task_id, m.task_version]).sort();
            const providedMatches = Array.isArray(input.matched_tasks) ? input.matched_tasks.map(m => [m.task_id, m.task_version]).sort() : [];
            if (JSON.stringify(expectedMatches) !== JSON.stringify(providedMatches)) throw fail('Compared task versions do not match current admission');
            if (['covered_by_open', 'already_delivered'].includes(input.decision) && !expectedMatches.length) throw fail('Coverage decision requires a matched owner/delivery', 400);
            if (input.decision === 'covered_by_open' && previous.matches.every(m => ['completed', 'cancelled', 'failed', 'archived'].includes(m.status))) throw fail('No current open owner in the compared tasks', 400);
            if (input.decision === 'partial_overlap' && (!Array.isArray(input.remaining_scope) || !input.remaining_scope.length || input.remaining_scope.some(s => !normalized(s)))) throw fail('Partial overlap requires concrete remaining scope clauses', 400);
            if (previous.lookup_failed) throw fail('Cannot resolve while comparison lookup is unavailable');
            const receipt = { ...previous, decision: input.decision, reason: normalized(input.reason), authority,
                resolved_at: new Date(now()).toISOString(), evidence: input.evidence.map(e => ({ ref: e.ref, hash: e.hash })),
                ...(input.decision === 'partial_overlap' ? { remaining_scope: input.remaining_scope } : {}) };
            return save(task, receipt, { mutation: true });
        }).immediate();
    }
    return { admit, current, resolve, concerns, guardUpdate, contract, readReceipt, forget: id => snapshotCache.delete(id) };
}

module.exports = { initializeWorkAdmission, createWorkAdmission, RESOLUTION_WINDOW_MS };
