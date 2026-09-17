const fs = require('fs');
const os = require('os');
const path = require('path');

describe('authoritative board attention counts', () => {
  let directory, db, raw;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-attention-'));
    process.env.NEXUS_DB_PATH = path.join(directory, 'test.db');
    jest.resetModules();
    db = require('../../db');
    raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
    raw.prepare("INSERT INTO projects (id,name,path,status) VALUES ('p','Praxis','/praxis','active')").run();
  });
  afterAll(() => {
    raw.close();
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('counts only available work while preserving terminal history and dependency truth', async () => {
    for (const status of ['idea', 'planning', 'todo', 'scheduled', 'dispatched', 'in_progress', 'needs_input', 'blocked', 'ready_for_review', 'review', 'completed', 'failed', 'cancelled', 'archived', 'suspended']) {
      await db.createTask({ id: status, project_id: 'p', name: status, status, dependencies: [] });
    }
    await db.createTask({ id: 'needs-completed', project_id: 'p', name: 'has completed predecessor', status: 'todo', dependencies: ['completed'] });
    await db.createTask({ id: 'needs-archived', project_id: 'p', name: 'has archived predecessor', status: 'todo', dependencies: ['archived'] });
    await db.createTask({ id: 'archived-via-field', project_id: 'p', name: 'legacy archive field', status: 'idea', archived_at: '2026-09-07T00:00:00Z' });
    const [project] = await db.getBoardState();
    expect(project.task_summary.unblocked).toBe(4);
    expect(project.task_summary.total).toBe(18);
    expect(project.task_summary.complete).toBe(1);
    expect(project.tasks.find(task => task.id === 'needs-completed').is_unblocked).toBe(true);
    expect(project.tasks.find(task => task.id === 'needs-archived').is_unblocked).toBe(false);
    expect(project.tasks.find(task => task.id === 'archived').status).toBe('archived');
  });
});
