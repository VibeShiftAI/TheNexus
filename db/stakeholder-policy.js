/** Reserved stakeholder actions: immutable proposals, operator decisions and receipts.
 * Tasks remain the request queue; task metadata is a compatibility projection,
 * never approval authority. No invitations are sent here; explicit approved
 * description applications can be recorded atomically with their scope write.
 */
const { createHash, randomUUID } = require('crypto');
const POLICY = {
    id: 'robert-stakeholder-2026-09-16', version: 1, scope: 'general', operator: 'robert',
    source: '/Volumes/Projects/shared-mind/memories/feedback_stakeholder_autonomy_2026-09-16.md',
    independent: ['recommend_members', 'prepare_personalized_updates', 'track_commitments', 'draft_followups', 'file_enhancement_tickets'],
    requires_robert: ['invitation', 'scope_change'],
    boundaries: [
        'Preparation is allowed only within approved project scope; drafting is not sending authority.',
        'Recommendations and directory links do not establish invitations, assignments or acceptance.',
        'Robert must approve invitations and scope changes before issuance, application or promises; PDM and missing-PDM exemptions do not apply.',
        'Preserve commitment member, project, owner, source, explicit deadline and resolution; unknown deadlines stay unknown.',
        'Copy Robert on business communications using his configured verified address; copying is not approval. Keep authentication secrets separate.',
        'Enhancement tickets require evidence, benefits, acceptance criteria and dependencies; link duplicates. Tickets do not expand scope.',
        'Existing unrelated permissions remain unchanged; general defaults are not project-specific assertions.',
    ],
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const parse = value => JSON.parse(value);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const reservedKind = task => task?.metadata?.stakeholder_action?.kind || task?.metadata?.stakeholder_gate?.action_kind;
function initializeStakeholderPolicy(db) {
    db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS stakeholder_policies (id TEXT PRIMARY KEY, document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stakeholder_proposal_revisions (
            task_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
            document TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(task_id, revision)
        );
        CREATE TABLE IF NOT EXISTS stakeholder_proposal_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
            state TEXT NOT NULL, document TEXT NOT NULL,
            FOREIGN KEY(task_id, revision) REFERENCES stakeholder_proposal_revisions(task_id, revision)
        );
        CREATE INDEX IF NOT EXISTS stakeholder_revision_project ON stakeholder_proposal_revisions(project_id);
        CREATE INDEX IF NOT EXISTS stakeholder_event_task ON stakeholder_proposal_events(task_id, revision, seq);`);
        db.prepare('INSERT OR IGNORE INTO stakeholder_policies VALUES (?, ?)').run(POLICY.id, JSON.stringify(POLICY));
        for (const table of ['stakeholder_policies', 'stakeholder_proposal_revisions', 'stakeholder_proposal_events']) {
            for (const verb of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${verb.toLowerCase()}
                BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT, 'Stakeholder history is immutable'); END;`);
        }
        // Sticky invalidation: editing and then reverting a task cannot resurrect approval.
        db.exec(`CREATE TRIGGER IF NOT EXISTS stakeholder_task_invalidate AFTER UPDATE ON tasks
            WHEN NEW.name IS NOT OLD.name OR NEW.description IS NOT OLD.description
                OR NEW.project_id IS NOT OLD.project_id OR NEW.antigravity_payload IS NOT OLD.antigravity_payload
                OR NEW.dispatch_instructions IS NOT OLD.dispatch_instructions
                OR (NEW.status = 'cancelled' AND OLD.status != 'cancelled')
            BEGIN INSERT INTO stakeholder_proposal_events(task_id, revision, state, document)
                SELECT task_id, revision, CASE WHEN NEW.status = 'cancelled' THEN 'cancelled' ELSE 'invalidated' END,
                    json_object('type','invalidation','at',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'reason','Task changed')
                FROM stakeholder_proposal_revisions WHERE task_id = NEW.id ORDER BY revision DESC LIMIT 1;
            END;`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS stakeholder_member_invalidate AFTER UPDATE ON contacts
            WHEN NEW.name IS NOT OLD.name OR NEW.email IS NOT OLD.email
            BEGIN INSERT INTO stakeholder_proposal_events(task_id, revision, state, document)
                SELECT r.task_id, r.revision, 'invalidated',
                    json_object('type','invalidation','at',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'reason','Member identity changed')
                FROM stakeholder_proposal_revisions r
                WHERE json_extract(r.document, '$.member_id') = NEW.id
                AND r.revision = (SELECT MAX(revision) FROM stakeholder_proposal_revisions WHERE task_id = r.task_id);
            END;`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS stakeholder_project_invalidate AFTER UPDATE ON projects
            WHEN NEW.description IS NOT OLD.description OR NEW.end_state IS NOT OLD.end_state
            BEGIN INSERT INTO stakeholder_proposal_events(task_id, revision, state, document)
                SELECT r.task_id, r.revision, 'invalidated',
                    json_object('type','invalidation','at',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'reason','Project scope changed')
                FROM stakeholder_proposal_revisions r WHERE r.project_id = NEW.id
                AND r.revision = (SELECT MAX(revision) FROM stakeholder_proposal_revisions WHERE task_id = r.task_id);
            END;`);
    }).immediate();
}
function createStakeholderPolicy(db) {
    const policy = () => parse(db.prepare('SELECT document FROM stakeholder_policies WHERE id = ?').get(POLICY.id).document);
    const task = id => {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!row) throw fail(404, 'Task not found');
        return { ...row, metadata: parse(row.metadata || '{}') };
    };
    const project = id => {
        const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
        if (!row) throw fail(404, 'Project not found');
        return row;
    };
    function read(id) {
        const rows = db.prepare('SELECT * FROM stakeholder_proposal_revisions WHERE task_id = ? ORDER BY revision').all(id);
        if (!rows.length) return null;
        const revisions = rows.map(row => ({ ...parse(row.document), revision: row.revision, content_hash: row.content_hash }));
        const head = revisions.at(-1);
        const history = db.prepare('SELECT * FROM stakeholder_proposal_events WHERE task_id = ? ORDER BY seq').all(id)
            .map(row => ({ ...parse(row.document), revision: row.revision, state: row.state, seq: row.seq }));
        const currentHistory = history.filter(event => event.revision === head.revision);
        const last = currentHistory.at(-1);
        const terminal = currentHistory.filter(event => ['rejected', 'duplicate', 'cancelled', 'issued', 'applied', 'accepted'].includes(event.state)).at(-1);
        let state = last?.state || 'proposed';
        const liveTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
        if (!liveTask) state = 'cancelled';
        else if (liveTask.status === 'cancelled' && !['rejected', 'duplicate'].includes(state)) state = 'cancelled';
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(head.project_id)) state = 'cancelled';
        if (head.member_id) {
            const member = db.prepare('SELECT id, name, email FROM contacts WHERE id = ?').get(head.member_id);
            if (!member || hash(member) !== hash(head.member)) state = 'invalidated';
        }
        // Historical outcomes cannot be erased/reopened by a later edit.
        if (terminal) state = terminal.state;
        return { ...head, state, revisions, decisions: history.filter(e => e.type === 'decision'),
            events: history.filter(e => e.type === 'receipt'), history,
            execution_allowed: state === 'approved' };
    }
    function event(id, p, state, details) {
        db.prepare('INSERT INTO stakeholder_proposal_events(task_id, revision, state, document) VALUES (?, ?, ?, ?)')
            .run(id, p.revision, state, JSON.stringify({ id: randomUUID(), at: new Date().toISOString(),
                content_hash: p.content_hash, project_id: p.project_id, member_id: p.member_id, ...details }));
    }
    function syncGate(id, state, decision) {
        const current = task(id);
        const old = current.metadata.stakeholder_gate || {};
        const gateStatus = { proposed: 'pending', invalidated: 'pending', approved: 'approved', rejected: 'rejected', duplicate: 'duplicate', deferred: 'deferred' }[state] || old.status;
        const gate = { ...old, status: gateStatus, requested_at: old.requested_at || new Date().toISOString(), authority: 'robert',
            ...(decision ? { decided_at: decision.at, decided_by: { name: 'Robert', via: 'operator' },
                history: [...(Array.isArray(old.history) ? old.history : []), decision] } : {}) };
        const status = ['rejected', 'duplicate'].includes(state) ? 'cancelled' : 'blocked';
        // Approved reserved requests remain blocked: scheduling is not invitation delivery authority.
        db.prepare('UPDATE tasks SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
            .run(status, JSON.stringify({ ...current.metadata, stakeholder_gate: gate,
                status_message: `Reserved stakeholder action: ${state}. Robert approval is required.` }), new Date().toISOString(), id);
    }
    function propose(id, input) {
        return db.transaction(() => {
            const current = task(id), prior = read(id);
            if (current.status === 'cancelled' || (prior && ['rejected', 'cancelled', 'duplicate', 'issued', 'applied', 'accepted'].includes(prior.state))) {
                throw fail(409, 'Closed proposals cannot be revised; create a new request');
            }
            if ((prior?.revision ?? 0) !== (input.expected_revision ?? 0)) throw fail(409, 'Proposal revision changed');
            if (!['invitation', 'scope_change'].includes(input.kind)) throw fail(400, 'kind must be invitation or scope_change');
            if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) throw fail(400, 'Concrete proposal content is required');
            const content = canonical(input.content);
            const required = input.kind === 'invitation' ? ['message', 'role'] : ['before', 'after', 'reason'];
            if (required.some(key => typeof content[key] !== 'string' || !content[key].trim())) throw fail(400, `content requires ${required.join(', ')}`);
            if (JSON.stringify(content).length > 60000) throw fail(400, 'Proposal content is too large');
            const scope = project(current.project_id);
            let member = null;
            if (input.member_id !== null && input.member_id !== undefined) {
                member = db.prepare('SELECT id, name, email FROM contacts WHERE id = ?').get(input.member_id);
                if (!member) throw fail(404, 'Canonical member not found');
            }
            if (input.kind === 'invitation' && !member) throw fail(400, 'Invitation requires a canonical member_id');
            const document = { task_id: id, kind: input.kind, policy_id: POLICY.id, project_id: scope.id,
                member_id: member?.id || null, member, content,
                task_snapshot: { name: current.name, description: current.description, antigravity_payload: current.antigravity_payload, dispatch_instructions: current.dispatch_instructions },
                project_snapshot: { name: scope.name, description: scope.description, end_state: scope.end_state },
                created_at: new Date().toISOString() };
            const revision = (prior?.revision ?? 0) + 1;
            db.prepare('INSERT INTO stakeholder_proposal_revisions VALUES (?, ?, ?, ?, ?)')
                .run(id, revision, scope.id, JSON.stringify(document), hash({ ...document, revision }));
            syncGate(id, 'proposed');
            return read(id);
        }).immediate();
    }
    function bound(id, input) {
        const p = read(id);
        if (!p) throw fail(409, 'Register an immutable stakeholder proposal first');
        if (input.revision !== p.revision || input.content_hash !== p.content_hash) throw fail(409, 'Proposal revision or content hash changed');
        return p;
    }
    function decide(id, input, authority) {
        if (authority !== 'operator_credential') throw fail(403, 'Trusted Robert approval required');
        return db.transaction(() => {
            const p = bound(id, input);
            if (!['proposed', 'approved', 'deferred'].includes(p.state)) throw fail(409, `Cannot decide a ${p.state} proposal`);
            const state = { approve: 'approved', reject: 'rejected', duplicate: 'duplicate', defer: 'deferred' }[input.decision];
            if (!state) throw fail(400, 'Invalid decision');
            if (state === 'duplicate' && (!input.duplicate_of || input.duplicate_of === id || !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(input.duplicate_of))) throw fail(400, 'Valid duplicate_of required');
            const details = { type: 'decision', authority, operator: 'robert', note: String(input.note || '').slice(0, 4000),
                ...(input.duplicate_of ? { duplicate_of: input.duplicate_of } : {}) };
            syncGate(id, state, { at: new Date().toISOString(), status: state, by: { name: 'Robert', via: 'operator' }, ...details });
            event(id, p, state, details);
            return read(id);
        }).immediate();
    }
    function receipt(id, input) {
        return db.transaction(() => {
            const p = bound(id, input);
            if (typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 4000) throw fail(400, 'A delivery/application/member-response evidence reference is required');
            const previous = p.events.find(e => e.revision === p.revision && e.state === input.state && e.evidence === input.evidence);
            if (previous && p.state === input.state) return p;
            const next = p.kind === 'invitation' ? { approved: 'issued', issued: 'accepted' } : { approved: 'applied' };
            if (!next[p.state] || next[p.state] !== input.state) throw fail(409, `Cannot record ${input.state} from ${p.state}`);
            if (input.apply_to_project !== undefined && typeof input.apply_to_project !== 'boolean') throw fail(400, 'apply_to_project must be boolean');
            if (input.apply_to_project) {
                if (p.kind !== 'scope_change' || input.state !== 'applied' || p.content.field !== 'description') {
                    throw fail(400, 'Atomic scope application supports only an explicitly proposed description field');
                }
                if (project(p.project_id).description !== p.content.before) throw fail(409, 'Project scope changed since proposal');
                db.prepare('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?')
                    .run(p.content.after, new Date().toISOString(), p.project_id);
            }
            event(id, p, input.state, { type: 'receipt', evidence: input.evidence, authority: 'runtime_credential',
                applied_to_project: input.apply_to_project === true });
            return read(id);
        }).immediate();
    }
    function list(projectId) {
        return db.prepare('SELECT DISTINCT task_id FROM stakeholder_proposal_revisions WHERE project_id = ?').all(projectId)
            .map(row => read(row.task_id)).filter(proposal => proposal.project_id === projectId);
    }
    return { policy, read, propose, decide, receipt, list };
}
module.exports = { initializeStakeholderPolicy, createStakeholderPolicy, reservedKind };
