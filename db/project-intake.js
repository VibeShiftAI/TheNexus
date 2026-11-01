/** Record-only intake. All mutations and immutable replay receipts share one SQLite transaction. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual: equal } = require('util');
const { CreateProjectIntakeSchema, ProjectIntakeOperationSchema, ProjectIntakeSchema } = require('@praxis/contract');
const { prepareProjectPatch, invalid, timestamp } = require('./project-data');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (message, code = 'INTAKE_CONFLICT', status = 409) => Object.assign(invalid(message, status), { code });
function parse(schema, input) {
    const result = schema.safeParse(input);
    if (!result.success) throw fail(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), 'INVALID_INTAKE', 400);
    return result.data;
}
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function workspace(location) {
    if (!location) return { state: 'unassigned' };
    if (!path.isAbsolute(location)) throw fail('existing_path must be an absolute folder path', 'INVALID_WORKSPACE', 400);
    try {
        if (!fs.statSync(location).isDirectory()) throw fail('existing_path must identify a folder', 'INVALID_WORKSPACE', 400);
        return { state: 'attached', path: location, canonical_path: fs.realpathSync(location) };
    } catch (error) {
        if (error.status) throw error;
        if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO', 'ENODEV', 'ESTALE'].includes(error.code)) throw error;
        return { state: 'unavailable', path: location };
    }
}
function initializeProjectIntake(db) {
    const columns = db.prepare('PRAGMA table_info(projects)').all();
    if (!columns.some(c => c.name === 'status')) db.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
    for (const name of ['phase', 'intake']) if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} TEXT`);
    db.exec(`CREATE TABLE IF NOT EXISTS project_intake_operations (
        operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
}
function invalidateReview(intake) {
    const resume = intake.review?.mode === 'preparation' ? intake.review.resume_state : null;
    if (intake.review) intake.review_history.push(intake.review);
    intake.review = null; intake.acceptance = null;
    if (['council_review', 'ready_for_decision'].includes(intake.state)) intake.state = resume || 'interviewing';
}
function rememberBrief(intake, needs, at) {
    intake.brief_history.push({ brief_revision: intake.brief_revision, brief: structuredClone(intake.brief), sources: structuredClone(intake.sources),
        need_revisions: Object.fromEntries((needs || []).filter(n => intake.need_ids.includes(n.id) && n.knowledge).map(n => [n.id, n.knowledge.revision || 0])), at });
}
/** Ordinary need edits participate in intake concurrency and invalidate prior review. */
function fenceExternalIntakeChange(current, patch) {
    if (['intake', 'phase'].some(key => own(patch, key))) throw fail('Intake state and phase are owned by intake operations', 'INTAKE_STATE_GUARD');
    if (!current.intake) return;
    if (own(patch, 'path') && patch.path !== current.path) throw fail('Attach workspaces through an explicit intake operation; generic path edits cannot rebind intake', 'INTAKE_WORKSPACE_GUARD');
    if (current.intake.state === 'handed_off') return;
    if (['end_state', 'endpoint', 'end_state_criteria'].some(key => own(patch, key))) throw fail('Accept the reviewed intake brief before adopting an endpoint', 'INTAKE_HANDOFF_REQUIRED');
    if (own(patch, 'needs') && !equal(current.needs, patch.needs)) {
        const intake = structuredClone(current.intake);
        rememberBrief(intake, current.needs, patch.updated_at);
        intake.revision++; intake.brief_revision++; invalidateReview(intake);
        if (intake.pending_need_id && !patch.needs.some(n => n.id === intake.pending_need_id && n.status === 'open')) intake.pending_need_id = null;
        patch.intake = intake;
    }
}
function createProjectIntakeStore(db, { deserialize }) {
    const read = id => deserialize(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
    function save(id, patch) {
        const entries = Object.entries(patch).filter(([key]) => key !== 'id');
        db.prepare(`UPDATE projects SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value ?? null), id);
        return read(id);
    }
    function replay(input, projectId) {
        const record = db.prepare('SELECT * FROM project_intake_operations WHERE operation_id=?').get(input.operation_id);
        if (!record) return null;
        if (record.fingerprint !== fingerprint({ project_id: projectId || null, input })) throw fail('operation_id was already used with a different payload', 'INTAKE_OPERATION_COLLISION');
        return JSON.parse(record.result);
    }
    function receipt(input, project, projectId) {
        const result = { project, intake: project.intake };
        db.prepare('INSERT INTO project_intake_operations(operation_id,project_id,fingerprint,result,created_at) VALUES (?,?,?,?,?)')
            .run(input.operation_id, project.id, fingerprint({ project_id: projectId || null, input }), JSON.stringify(result), project.updated_at);
        return result;
    }
    function attach(location, current) {
        const candidate = workspace(location);
        if (current?.path) {
            const existing = workspace(current.path);
            if ((candidate.canonical_path || path.resolve(candidate.path)) !== (existing.canonical_path || path.resolve(existing.path))) throw fail('Existing workspace identity cannot be replaced during intake', 'PROJECT_IDENTITY_CONFLICT');
        }
        for (const other of db.prepare("SELECT id,path FROM projects WHERE path <> ''").all()) {
            if (other.id === current?.id) continue;
            let canonical; try { canonical = fs.realpathSync(other.path); } catch { canonical = path.resolve(other.path); }
            if (canonical === (candidate.canonical_path || path.resolve(candidate.path))) throw fail('Folder is already bound to another project; use its exact project_id', 'PROJECT_PATH_CONFLICT');
        }
        return candidate;
    }
    function get(projectId) {
        const project = read(projectId);
        if (!project) throw fail('Project not found', 'PROJECT_NOT_FOUND', 404);
        if (!project.intake) throw fail('Project has no intake', 'INTAKE_NOT_FOUND', 404);
        parse(ProjectIntakeSchema, project.intake);
        return { project, intake: project.intake };
    }
    function create(raw) {
        const input = parse(CreateProjectIntakeSchema, raw);
        return db.transaction(() => {
            const prior = replay(input); if (prior) return prior;
            const current = input.project_id ? read(input.project_id) : null;
            if (input.project_id && !current) throw fail('Exact project_id not found', 'PROJECT_NOT_FOUND', 404);
            if (current?.intake) throw fail('Project already has intake; resume it by its exact id', 'INTAKE_EXISTS');
            const sameName = db.prepare('SELECT id FROM projects WHERE name=?').get(input.name);
            if (sameName && sameName.id !== current?.id) throw fail('A project with this name already exists; provide its exact project_id or choose another name', 'PROJECT_NAME_CONFLICT');
            if (current && input.name !== current.name) throw fail('Explicit project binding name does not match', 'PROJECT_IDENTITY_CONFLICT');
            if (current?.path && input.existing_path && path.resolve(current.path) !== path.resolve(input.existing_path)) throw fail('Existing project workspace does not match supplied folder', 'PROJECT_IDENTITY_CONFLICT');
            const location = workspace(input.existing_path || current?.path);
            if (location.path) {
                for (const other of db.prepare("SELECT id,path FROM projects WHERE path <> ''").all()) {
                    if (other.id === current?.id) continue;
                    let canonical; try { canonical = fs.realpathSync(other.path); } catch { canonical = path.resolve(other.path); }
                    if (canonical === (location.canonical_path || path.resolve(location.path))) throw fail('Folder is already bound to another project; use its exact project_id', 'PROJECT_PATH_CONFLICT');
                }
            }
            const at = timestamp(current?.updated_at), id = current?.id || crypto.randomUUID();
            const intake = parse(ProjectIntakeSchema, { revision: 0, brief_revision: 0, state: 'preparing', original: { problem: input.problem, source_ref: input.source_ref, at },
                brief: {}, sources: input.sources || [], brief_history: [], need_ids: (current?.needs || []).filter(n => n.kind === 'information' && n.knowledge).map(n => n.id), pending_need_id: (current?.needs || []).find(n => n.kind === 'information' && n.knowledge && n.status === 'open')?.id || null, workspace: location, review: null, review_history: [], acceptance: null,
                operations: [{ operation_id: input.operation_id, action: 'create', revision: 0, at }] });
            if (current) save(id, { phase: 'intake', intake, path: location.path || '', updated_at: at });
            else db.prepare('INSERT INTO projects(id,name,path,description,status,phase,intake,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
                .run(id, input.name, location.path || '', input.problem, 'active', 'intake', JSON.stringify(intake), at, at);
            return receipt(input, read(id));
        }).immediate();
    }
    function operate(projectId, raw) {
        const input = parse(ProjectIntakeOperationSchema, raw);
        return db.transaction(() => {
            const prior = replay(input, projectId); if (prior) return prior;
            let { project, intake } = get(projectId);
            if (intake.revision !== input.expected_revision) throw fail('Intake revision changed; reload before saving', 'INTAKE_REVISION_STALE');
            if (intake.state === 'handed_off' && input.action !== 'attach_workspace') throw fail('Intake was already handed off', 'INTAKE_HANDED_OFF');
            if (!Array.isArray(project.needs ?? [])) throw fail('Stored needs are invalid', 'INVALID_STORED_NEEDS', 500);
            intake = structuredClone(intake);
            const at = timestamp(project.updated_at);
            const frozenBrief = structuredClone(intake), frozenNeeds = structuredClone(project.needs || []);
            let patch = {}, material = false;
            const allowed = states => { if (!states.includes(intake.state)) throw fail(`${input.action} is unavailable while intake is ${intake.state}`, 'INTAKE_STATE_CONFLICT'); };
            const mergeNeeds = additions => {
                if (!additions) return;
                const ids = new Set();
                for (const addition of additions) {
                    if (ids.has(addition.id)) throw fail('Duplicate need ids in one operation', 'INVALID_INTAKE', 400);
                    ids.add(addition.id);
                    const needs = [...(project.needs || [])], index = needs.findIndex(n => n.id === addition.id);
                    if (index >= 0 && (needs[index].kind !== 'information' || !needs[index].knowledge)) throw fail('Need id belongs to an unrelated project need', 'INTAKE_NEED_CONFLICT');
                    if (index >= 0 && addition.expected_knowledge_revision === undefined) throw fail('Existing information need definitions require expected_knowledge_revision', 'INTAKE_NEED_REVISION_REQUIRED', 428);
                    const { expected_knowledge_revision, ...definition } = addition;
                    if (index >= 0) needs[index] = { ...needs[index], ...definition, knowledge: { ...needs[index].knowledge, ...definition.knowledge } };
                    else needs.push({ ...definition, status: 'open' });
                    const prepared = prepareProjectPatch(project, { needs }, { needMutation: { id: addition.id, input: addition, source: addition.source || 'intake' } });
                    project = { ...project, ...prepared }; Object.assign(patch, prepared);
                    if (!intake.need_ids.includes(addition.id)) intake.need_ids.push(addition.id);
                }
            };
            const mergeMaterial = () => {
                const before = { brief: intake.brief, sources: intake.sources, needs: project.needs };
                if (input.brief) intake.brief = { ...intake.brief, ...input.brief };
                if (input.sources) {
                    const refs = new Set();
                    for (const source of input.sources) { if (refs.has(source.ref)) throw fail('Duplicate source references', 'INVALID_INTAKE', 400); refs.add(source.ref); }
                    const sources = new Map(intake.sources.map(s => [s.ref, s]));
                    for (const source of input.sources) sources.set(source.ref, { ...sources.get(source.ref), ...source });
                    intake.sources = [...sources.values()];
                }
                mergeNeeds(input.needs);
                material = !equal(before, { brief: intake.brief, sources: intake.sources, needs: project.needs });
            };
            switch (input.action) {
                case 'attach_workspace':
                    intake.workspace = attach(input.existing_path, project); patch.path = intake.workspace.path; break;
                case 'prepare':
                    allowed(['preparing']); mergeMaterial();
                    if (!(intake.brief.outcome?.trim() || intake.brief.purpose?.trim()) || !intake.need_ids.some(id => project.needs?.some(n => n.id === id && n.kind === 'information' && n.knowledge))) throw fail('Preparation requires an initial outcome or purpose and at least one saved information need; answered needs count as coverage.', 'INTAKE_PREPARATION_INCOMPLETE', 400);
                    intake.state = 'awaiting_choice'; break;
                case 'revise':
                    mergeMaterial(); break;
                case 'start':
                    allowed(['awaiting_choice', 'deferred', 'interviewing', 'ready_for_decision']); intake.state = 'interviewing'; break;
                case 'defer':
                    allowed(['awaiting_choice', 'interviewing', 'ready_for_decision', 'deferred']); intake.state = 'deferred'; break;
                case 'answer': {
                    allowed(['interviewing']);
                    if (!intake.need_ids.includes(input.need_id)) throw fail('Question is not part of this intake', 'INTAKE_NEED_NOT_FOUND', 404);
                    const index = project.needs.findIndex(n => n.id === input.need_id), previous = project.needs[index];
                    if (!previous?.knowledge || previous.kind !== 'information') throw fail('Question must be a structured information need', 'INVALID_INTAKE', 400);
                    const evidence = [...(input.evidence || []), { ref: input.source_ref }];
                    const change = { expected_knowledge_revision: input.expected_knowledge_revision, knowledge: { answer: input.answer }, append_evidence: evidence, source: input.source_ref };
                    const needs = [...project.needs]; needs[index] = { ...previous, knowledge: { ...previous.knowledge, answer: input.answer } };
                    const prepared = prepareProjectPatch(project, { needs }, { needMutation: { id: input.need_id, input: change, source: input.source_ref } });
                    project = { ...project, ...prepared }; Object.assign(patch, prepared);
                    if (input.verification) {
                        const current = project.needs[index];
                        const human = ['human', 'decision', 'acceptance'].includes(current.knowledge.resolution?.method);
                        if (!human && !input.verification.evidence_refs.some(ref => ref !== input.source_ref && current.knowledge.evidence.some(e => e.ref === ref))) throw fail('Empirical claims require independent satisfaction evidence, not only the answer message', 'INTAKE_EVIDENCE_REQUIRED', 400);
                        const verification = { status: 'met', expected_knowledge_revision: current.knowledge.revision, knowledge: { verification: input.verification }, source: input.source_ref };
                        const verifiedNeeds = [...project.needs]; verifiedNeeds[index] = { ...current, status: 'met', knowledge: { ...current.knowledge, verification: input.verification } };
                        const verified = prepareProjectPatch(project, { needs: verifiedNeeds }, { needMutation: { id: input.need_id, input: verification, source: input.source_ref } });
                        project = { ...project, ...verified }; Object.assign(patch, verified);
                    }
                    material = true; break;
                }
                case 'request_review': {
                    const preparation = input.mode === 'preparation';
                    const retry = intake.state === 'council_review' && ['failed', 'partial'].includes(intake.review?.status);
                    if (!retry) allowed(preparation ? ['preparing', 'awaiting_choice', 'deferred', 'interviewing'] : ['interviewing', 'awaiting_choice', 'ready_for_decision']);
                    if (retry && (intake.review.mode || 'review') !== input.mode) throw fail('A council retry must preserve its mode', 'INTAKE_STATE_CONFLICT');
                    if (preparation && !input.source_ref) throw fail('Preparation councils require the explicit request source_ref', 'INVALID_INTAKE', 400);
                    if (input.brief_revision !== intake.brief_revision) throw fail('Review must use current brief_revision', 'INTAKE_REVIEW_STALE');
                    const resume = retry ? intake.review.resume_state : intake.state;
                    if (intake.review) intake.review_history.push(intake.review);
                    intake.review = { session_id: input.session_id, mode: input.mode, resume_state: resume, brief_revision: input.brief_revision, requested_at: at, status: 'pending', findings: [],
                        ...(input.source_ref ? { source_ref: input.source_ref, request_source_ref: input.source_ref } : {}) };
                    intake.state = 'council_review'; break;
                }
                case 'record_review': {
                    allowed(['council_review']);
                    if (!intake.review || intake.review.session_id !== input.session_id || intake.review.brief_revision !== input.brief_revision || intake.brief_revision !== input.brief_revision) throw fail('Council result does not match the current requested review', 'INTAKE_REVIEW_STALE');
                    const preparation = intake.review.mode === 'preparation';
                    if (!preparation && (input.brief || input.sources)) throw fail('Only preparation councils may supply brief/source changes; revise and review the changed brief separately', 'INVALID_INTAKE', 400);
                    const status = input.status || 'completed';
                    if (status !== 'completed' && (input.brief || input.sources || input.needs?.length)) throw fail('Failed or partial council results cannot apply preparation changes', 'INVALID_INTAKE', 400);
                    intake.review = { ...intake.review, status, source_ref: input.source_ref, findings: input.findings, completed_at: at };
                    if (status !== 'completed') break;
                    if (preparation) {
                        mergeMaterial();
                        const resume = intake.review.resume_state || 'preparing';
                        intake.review_history.push(intake.review); intake.review = null; intake.state = resume;
                    } else {
                        const beforeNeeds = project.needs;
                        mergeNeeds(input.needs);
                        material = !equal(beforeNeeds, project.needs);
                        intake.state = material || input.findings.some(f => ['ask_robert', 'revise_proposal'].includes(f.disposition)) ? 'interviewing' : 'ready_for_decision';
                    }
                    break;
                }
                case 'accept': {
                    allowed(['ready_for_decision']);
                    if (input.brief_revision !== intake.brief_revision || intake.review?.brief_revision !== intake.brief_revision || intake.review.status !== 'completed' || (intake.review.mode || 'review') !== 'review') throw fail('Acceptance requires a completed review of the current brief', 'INTAKE_REVIEW_STALE');
                    const b = intake.brief;
                    if (!['purpose', 'outcome', 'beneficiary', 'scope', 'decision_owner'].every(k => b[k]?.trim()) || !b.success_criteria?.length) throw fail('Acceptance requires purpose, outcome, beneficiary, scope, success criteria and decision owner', 'INTAKE_BRIEF_INCOMPLETE', 400);
                    for (const n of project.needs.filter(n => n.status === 'open' && n.knowledge && (n.knowledge.blocking || intake.need_ids.includes(n.id)))) {
                        if (!n.knowledge.resolution?.method?.trim() || !n.knowledge.resolution.owner?.trim() || !n.knowledge.resolution.next_action?.trim()) throw fail(`Open need ${n.id} requires a resolution method, owner and next action`, 'INTAKE_NEED_UNPLANNED', 400);
                    }
                    const adopted = prepareProjectPatch(project, { expected_updated_at: project.updated_at, end_state: b.outcome,
                        endpoint: { beneficiary: b.beneficiary, scope: b.scope, exclusions: b.exclusions || '', proposed_next: input.next_step },
                        end_state_criteria: b.success_criteria.map((description, index) => ({ id: `intake-${index + 1}`, kind: 'manual', description, source: input.source_ref })),
                        end_state_source: input.source_ref, end_state_reason: 'Accepted intake brief' });
                    Object.assign(patch, adopted, { phase: 'planning' });
                    intake.acceptance = { brief_revision: intake.brief_revision, source_ref: input.source_ref, next_step: input.next_step, at };
                    intake.state = 'handed_off'; break;
                }
            }
            if (material) { rememberBrief(frozenBrief, frozenNeeds, at); intake.brief_history = frozenBrief.brief_history; intake.brief_revision++; invalidateReview(intake); }
            if (own(input, 'pending_need_id')) intake.pending_need_id = input.pending_need_id;
            if (intake.pending_need_id && !(project.needs || []).some(n => n.id === intake.pending_need_id && n.status === 'open')) intake.pending_need_id = null;
            if (input.pending_need_id && !intake.need_ids.includes(input.pending_need_id)) throw fail('pending_need_id must reference this intake registry', 'INVALID_INTAKE', 400);
            if (!intake.pending_need_id) intake.pending_need_id = intake.need_ids.find(id => project.needs?.some(n => n.id === id && n.status === 'open')) || null;
            intake.revision++;
            intake.operations.push({ operation_id: input.operation_id, action: input.action, revision: intake.revision, at });
            patch.intake = parse(ProjectIntakeSchema, intake); patch.updated_at = at;
            return receipt(input, save(projectId, patch), projectId);
        }).immediate();
    }
    return { create, get, operate };
}
module.exports = { initializeProjectIntake, createProjectIntakeStore, fenceExternalIntakeChange };
