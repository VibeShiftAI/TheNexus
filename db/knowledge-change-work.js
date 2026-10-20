/** Route revisions of previously applied knowledge while the board lease and
 * project transaction are held. Task writes use normal CAS and admission. */
const { createHash } = require('crypto');
const { isDeepStrictEqual: equal } = require('util');
const { normalizeTaskBoardStatus } = require('@praxis/contract');
const { legacyApplication, ROUTING_RECEIPT_PREFIX } = require('./knowledge-lifecycle');

const positive = application => ['applied', 'validated', 'successful'].includes(application.status);
const pendingStatuses = new Set(['idea', 'planning', 'todo', 'scheduled', 'blocked']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 409) => Object.assign(new Error(message), { status, code: 'knowledge_change_work_failed' });

function applications(knowledge) {
    const history = [...(knowledge.applications || [])];
    if (knowledge.application) {
        const prior = legacyApplication(knowledge.application);
        if (!history.some(item => item.id === prior.id)) history.unshift(prior);
    }
    return history;
}
function changedFields(before, after) {
    return ['question', 'answer', 'satisfaction_test', 'evidence', 'criterion_ids'].filter(field => {
        const value = knowledge => field === 'criterion_ids' ? [...(knowledge[field] || [])].sort()
            : field === 'evidence' ? knowledge[field] || [] : knowledge[field];
        return !equal(value(before), value(after));
    });
}
function hasEvidence(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== null && value !== undefined && value !== '' && value !== false;
}
function neverRun(db, task) {
    if (!pendingStatuses.has(normalizeTaskBoardStatus(task.status))) return false;
    // A task moved back to planning does not become an unexecuted task. Retain
    // output and run history even when the old dispatcher cleared its status.
    if (['analysis_output', 'spec_output', 'research_output', 'plan_output', 'walkthrough', 'critic_feedback',
        'langgraph_run_id', 'langgraph_started_at', 'task_ledger'].some(field => hasEvidence(task[field]))) return false;
    const metadata = object(task.metadata), payload = object(task.antigravity_payload);
    if (['run_id', 'dispatch_id', 'started_at', 'completed_at', 'execution_started_at', 'execution_history',
        'qa_result', 'qa_history', 'verification_verdict'].some(field => hasEvidence(metadata[field]) || hasEvidence(payload[field]))) return false;
    for (const table of ['task_dispatches', 'runs', 'execution_steps', 'model_execution_snapshots', 'run_events']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        // Table names above are fixed server constants. Any retained dispatch,
        // including a QA shadow dispatch, is sufficient to preserve the task.
        if (db.prepare(`SELECT 1 FROM ${table} WHERE task_id IN (?, ?) LIMIT 1`).get(task.id, `qa--${task.id}`)) return false;
    }
    return true;
}
function replaceBlock(text, prior, block) {
    const existing = typeof text === 'string' ? text : '';
    const index = prior ? existing.indexOf(prior) : -1;
    return index >= 0 ? existing.slice(0, index) + block + existing.slice(index + prior.length)
        : [existing, block].filter(Boolean).join('\n\n');
}
function taskPatch(task, need, before, fields, priorTaskIds, at) {
    const k = need.knowledge;
    const metadata = object(task.metadata), context = object(metadata.knowledge_context);
    const change = {
        need_id: need.id, previous_revision: before.revision ?? 0, revision: k.revision,
        changed_fields: fields, question: k.question, answer: k.answer ?? '', satisfaction_test: k.satisfaction_test,
        evidence: k.evidence, criterion_ids: k.criterion_ids, previous_task_ids: priorTaskIds,
        verification_pending: true, at,
    };
    const block = [
        `[Knowledge change ${JSON.stringify(need.id)}: revision ${before.revision ?? 0} -> ${k.revision}]`,
        `Changed fields: ${fields.join(', ')}`,
        `Question: ${k.question}`,
        `Answer: ${k.answer ?? '(no answer yet)'}`,
        `Satisfaction test: ${k.satisfaction_test}`,
        `Evidence: ${JSON.stringify(k.evidence)}`,
        `Criterion links: ${k.criterion_ids.join(', ') || 'none'}`,
        `Previous task links: ${priorTaskIds.join(', ') || 'none retained'}`,
        'Required first step: re-verify this revised knowledge against its evidence and satisfaction test, and record verification for the current answer revision before implementing changes that rely on it.',
        'This is pending re-verification, not an approval or an applied result. Read the current project need before acting. Preserve prior completed work and record any new application with task evidence.',
        `[/Knowledge change ${JSON.stringify(need.id)}]`,
    ].join('\n');
    const blockKey = digest(need.id), blocks = object(metadata.knowledge_change_blocks);
    const requirement = { id: `need:${need.id}`, need_id: need.id, question: k.question, tags: k.tags,
        reason: `Previously applied knowledge changed from revision ${before.revision ?? 0} to ${k.revision}; re-verification is required before relying on it.`,
        satisfaction_test: k.satisfaction_test, source_refs: k.evidence.map(item => item.ref) };
    return {
        description: replaceBlock(task.description, blocks[blockKey], block),
        dispatch_instructions: replaceBlock(task.dispatch_instructions, blocks[blockKey], block),
        ...(['todo', 'scheduled'].includes(normalizeTaskBoardStatus(task.status)) ? { status: 'planning' } : {}),
        metadata: { ...metadata, knowledge_need_ids: unique([...list(metadata.knowledge_need_ids), need.id]),
            knowledge_context: { ...context, version: 1, lookup_status: 'available',
                requirements: [...list(context.requirements).filter(item => item?.need_id !== need.id && item?.id !== requirement.id), requirement] },
            knowledge_changes: [...list(metadata.knowledge_changes), change],
            knowledge_change_blocks: { ...blocks, [blockKey]: block },
        },
        updated_at: at,
    };
}

function routeKnowledgeChangeWork({ db, current, patch, readTask, createTask, updateTask }) {
    if (!patch.needs) return;
    for (const need of patch.needs) {
        const before = current.needs?.find(item => item.id === need.id)?.knowledge;
        const k = need.knowledge;
        if (!before || !k) continue;
        const fields = changedFields(before, k);
        const history = applications(before);
        if (!fields.length || !history.some(positive)) continue;
        const routed = history.filter(item => item.status === 'ready' && item.id?.startsWith(ROUTING_RECEIPT_PREFIX));
        // Task metadata is the other canonical direction of the relationship.
        // Include it even when an earlier task creator did not backfill the need.
        const linkedTaskIds = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(current.id).filter(({ id }) => {
            const metadata = object(readTask(id).metadata), context = object(metadata.knowledge_context);
            return list(metadata.knowledge_need_ids).includes(need.id) || list(context.requirements).some(item => item?.need_id === need.id);
        }).map(task => task.id);
        const ids = unique([...(before.task_ids || []), ...k.task_ids, ...history.filter(positive).map(item => item.task_id), ...routed.map(item => item.task_id), ...linkedTaskIds]);
        const pending = [], priorTaskIds = [];
        for (const id of ids) {
            const task = readTask(id);
            if (task && task.project_id !== current.id) throw fail(`Knowledge task ${id} belongs to another project`);
            if (task && neverRun(db, task)) pending.push(task);
            else priorTaskIds.push(id);
        }
        // Reuse an earlier pending follow-up after another revision. Historical
        // positive applications remain in the ledger, but must not spawn a new
        // task every time the same unexecuted follow-up is refined.
        const reusable = pending.some(task => routed.some(receipt => receipt.task_id === task.id));
        const results = [];
        for (const task of pending) {
            const updated = updateTask(task.id, taskPatch(task, need, before, fields, ids, patch.updated_at), task.version,
                { origin: { kind: 'system', requester: 'knowledge-change-work' } });
            if (!updated) throw fail(`Could not update pending knowledge task ${task.id}`, 503);
            results.push({ task: updated, action: 'updated' });
        }
        if ((!pending.length || priorTaskIds.length) && !reusable) {
            const draft = { project_id: current.id, name: `Reconcile revised knowledge: ${need.description}`, status: 'idea', source: 'knowledge-change',
                description: 'Reconcile previously applied project knowledge with the revised answer and assess the changes needed in prior work.' };
            const created = createTask({ ...draft, ...taskPatch(draft, need, before, fields, ids, patch.updated_at) });
            if (!created || created.project_id !== current.id || !neverRun(db, created)) throw fail('Could not create pending knowledge follow-up', 503);
            results.push({ task: created, action: 'created' });
        }
        k.task_ids = unique(results.map(result => result.task.id));
        k.applications = applications(k);
        for (const { task, action } of results) {
            const id = `${ROUTING_RECEIPT_PREFIX}${digest([current.id, need.id, k.revision, task.id])}`;
            if (k.applications.some(item => item.id === id)) continue;
            const receipt = { id, status: 'ready', task_id: task.id, answer_revision: k.revision, at: patch.updated_at,
                notes: `Knowledge changed from revision ${before.revision ?? 0} to ${k.revision}; ${action} task ${task.id}. Previous task links: ${ids.join(', ') || 'none retained'}. Pending re-verification; no new application is claimed.` };
            k.applications.push(receipt);
            k.application = receipt;
        }
    }
}

module.exports = { routeKnowledgeChangeWork };
