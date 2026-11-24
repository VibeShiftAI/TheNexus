// Read-only full-board projection. Run inside the worker, never on the HTTP thread.
const { normalizeTaskBoardStatus, isTaskDone } = require('@praxis/contract');
const { deserializeRow } = require('./row-serialization');
const deserializeRows = rows => rows.map(deserializeRow);

function readBoardState(db, projectId) {
    return db.transaction(() => {
        // Get projects
        let projects;
        if (projectId) {
            const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
            projects = p ? [deserializeRow(p)] : [];
        } else {
            projects = deserializeRows(
                db.prepare("SELECT * FROM projects WHERE status IS NULL OR status != 'archived' ORDER BY updated_at DESC").all()
            );
        }

        // Get all tasks for these projects in one query
        const projectIds = projects.map(p => p.id);
        if (projectIds.length === 0) return [];

        const placeholders = projectIds.map(() => '?').join(',');
        const allTasks = db.prepare(`SELECT t.*, a.document AS admission_document
            FROM tasks t LEFT JOIN work_admissions a ON a.task_id = t.id
            WHERE t.project_id IN (${placeholders}) ORDER BY t.priority DESC, t.created_at ASC`).all(...projectIds)
            .map(({ admission_document, ...row }) => {
                const task = deserializeRow(row);
                task.metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
                if (admission_document) task.metadata.work_admission = JSON.parse(admission_document);
                else delete task.metadata.work_admission;
                return task;
            });

        // Build a status lookup map for dependency resolution
        const taskStatusMap = new Map();
        for (const task of allTasks) {
            taskStatusMap.set(task.id, task.status);
        }

        // Display filtering must not change dependency truth. Resolve only the
        // missing referenced IDs, in bounded batches (including archived projects).
        const missingIds = [...new Set(allTasks.flatMap(task => task.dependencies || []))]
            .filter(id => !taskStatusMap.has(id));
        for (let offset = 0; offset < missingIds.length; offset += 500) {
            const ids = missingIds.slice(offset, offset + 500);
            const rows = db.prepare(`SELECT id, status FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
            for (const row of rows) taskStatusMap.set(row.id, row.status);
        }

        // Annotate each task with is_unblocked
        for (const task of allTasks) {
            const deps = task.dependencies || [];
            if (deps.length === 0) {
                task.is_unblocked = true;
            } else {
                task.is_unblocked = deps.every(depId => isTaskDone(taskStatusMap.get(depId)));
            }
        }

        // Group tasks by project
        const tasksByProject = new Map();
        for (const task of allTasks) {
            if (!tasksByProject.has(task.project_id)) {
                tasksByProject.set(task.project_id, []);
            }
            tasksByProject.get(task.project_id).push(task);
        }

        // Assemble result
        return projects.map(project => ({
            ...project,
            tasks: tasksByProject.get(project.id) || [],
            task_summary: {
                total: (tasksByProject.get(project.id) || []).length,
                unblocked: (tasksByProject.get(project.id) || []).filter(t =>
                    t.is_unblocked && !t.archived_at &&
                    ['idea', 'planning', 'todo'].includes(normalizeTaskBoardStatus(t.status))
                ).length,
                complete: (tasksByProject.get(project.id) || []).filter(t => t.status === 'complete' || t.status === 'completed' || t.status === 'done').length,
                suspended: (tasksByProject.get(project.id) || []).filter(t => t.status === 'suspended').length,
            }
        }));
    })();
}
module.exports = { readBoardState };
