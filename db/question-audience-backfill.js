const { createHash } = require('node:crypto');
const { inferKnowledgeClientFacing } = require('@praxis/contract');
const { normalizeKnowledgeLifecycle } = require('./knowledge-lifecycle');
const { projectQuestionRespondents, timestamp } = require('./project-data');

// Reviewed legacy definitions with no resolution field. Bind the decision to the
// exact evidence reviewed, so a later edit can never inherit this classification.
const reviewed = new Map([
    ['9b243130dc5958bc690358c16ac878d78f419ba0fba3282378d4b35be9b75fd8', [true, 'The question explicitly requests content from JP.']],
    ['203dc440de5abc53f18a4dabe99a7e71e652b59c7d9368d41d6c7cfca5846680', [false, 'The question calls for research into published verification methods.']],
    ['4caeef3ad687771788fcc190d6c7e2d5e384762c1b644b0ec7265a2cc2d556d1', [false, 'The question calls for an inspection of the existing Praxis implementation.']],
    ['268e3fa8dcbc4a655b963dd6cd8b8aba84e431e77874f8955981f3c6bc5356f6', [false, 'The satisfaction test requires a measured retrieval experiment.']],
    ['5c36ed9bb97c8c83adfed11262df981acfe6b22ffbc232d7291ac86bf3b2c2fc', [false, 'The satisfaction test names Robert as the person providing the jurisdiction facts.']],
    ['93e2d33a4f630813d6b600b5c9d9cc846a59c9f4b433d49660f7892b64285412', [false, 'The satisfaction test names Robert as the person supplying the financial facts.']],
]);

function classify(need, respondents) {
    const k = need.knowledge;
    if (!k) return [null, 'Legacy information need without a tracked question definition.'];
    if (typeof k.client_facing === 'boolean') return [k.client_facing, 'Preserved the recorded indicator.'];
    if (k.resolution) {
        const { method, owner } = k.resolution;
        const indicator = inferKnowledgeClientFacing(k.resolution, respondents);
        return [indicator ?? null, [method, owner].filter(Boolean).join(' / ')];
    }
    const definition = [k.question, k.satisfaction_test, k.purpose ?? '', need.notes ?? ''];
    const key = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    return reviewed.get(key) ?? [null, 'No recorded respondent or resolution method.'];
}

/** Migrate once in a single transaction. The inventory also includes archived
 * projects, unanswered ambiguous rows, and open needs that already have answers. */
function backfillQuestionAudience(db) {
    return db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS project_need_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
        const migration = 'client-facing-v1';
        if (db.prepare('SELECT 1 FROM project_need_migrations WHERE name = ?').get(migration)) return [];
        const update = db.prepare('UPDATE projects SET needs = ?, updated_at = ? WHERE id = ?');
        const rows = [];
        for (const project of db.prepare('SELECT id, name, status, needs, updated_at FROM projects ORDER BY name, id').all()) {
            const needs = JSON.parse(project.needs ?? '[]') ?? [];
            if (!needs.some(n => n.kind === 'information' && n.status === 'open')) continue;
            const respondents = projectQuestionRespondents(db, project.id);
            const at = timestamp(project.updated_at);
            let changed = false;
            for (const need of needs) {
                if (need.kind !== 'information' || need.status !== 'open') continue;
                const [indicator, reason] = classify(need, respondents);
                const k = need.knowledge;
                rows.push({ project: project.name, project_id: project.id, project_status: project.status, id: need.id,
                    question: k?.question ?? need.description, client_facing: indicator, reason });
                if (indicator === null || k.client_facing === indicator) continue;
                const input = { knowledge: { client_facing: indicator }, expected_knowledge_revision: k.revision ?? 0 };
                const updated = normalizeKnowledgeLifecycle({ ...need, knowledge: { ...k, ...input.knowledge } }, need, input,
                    { at, actor: 'client-facing-backfill', scoped: true }).knowledge;
                // Migrate the audience and its history only. Older knowledge rows
                // can contain fields outside the current schema.
                k.client_facing = updated.client_facing;
                k.history = updated.history;
                changed = true;
            }
            if (changed) update.run(JSON.stringify(needs), at, project.id);
        }
        db.prepare('INSERT INTO project_need_migrations (name, applied_at) VALUES (?, ?)').run(migration, new Date().toISOString());
        return rows;
    }).immediate();
}

module.exports = { backfillQuestionAudience };
