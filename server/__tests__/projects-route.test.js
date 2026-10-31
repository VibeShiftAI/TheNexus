const express = require('express');
const http = require('http');

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, sockets, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(handle) {
  for (const socket of handle.sockets) socket.destroy();
  return new Promise((resolve) => handle.server.close(resolve));
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  return {
    status: res.status,
    body: await res.json(),
  };
}

describe('projects route', () => {
  let handle;

  afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
  });

  it.each(['', '/scaffold'])('creates a Git baseline through project route %s', async (route) => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { execFileSync } = require('child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-tracking-'));
    const db = { isDatabaseEnabled: () => true, upsertProject: jest.fn(async p => ({...p,id:'p'})), writeLeases: {runSync: (_r, fn) => fn(), run: (_r, fn) => fn()} };
    const app = express(); app.use(express.json());
    app.use('/api/projects', require('../routes/projects')({db, PROJECT_ROOT:root, getAllProjects:jest.fn(), scanProjects:jest.fn(), contextSync:{}}));
    handle = await listen(app);
    try {
      const result = await requestJson(`${handle.baseUrl}/api/projects${route}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'New Project'})});
      expect(result.status).toBe(route ? 200 : 201);
      const cwd = path.join(root,'New Project');
      expect(execFileSync('git',['rev-parse','--verify','HEAD'],{cwd,encoding:'utf8',stdio:'pipe'}).trim()).toMatch(/^[a-f0-9]{40}$/);
      expect(execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'})).toBe('');
      expect(fs.readFileSync(path.join(cwd,'.gitignore'),'utf8')).toContain('.env');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });

  it('rejects stale conditional need projections at the HTTP boundary', async () => {
    const expected = { status: 'open', notes: '', description: 'Choose policy', kind: 'decision' };
    const db = { updateProjectNeed: jest.fn(() => ({ conflict: true })) };
    const app = express(); app.use(express.json());
    app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: '/tmp', getProjectById: async () => ({ id: 'p' }), getAllProjects: jest.fn(), scanProjects: jest.fn(), callAI: jest.fn(), contextSync: {} }));
    handle = await listen(app);
    const result = await requestJson(`${handle.baseUrl}/api/projects/p/needs/n`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'Saved answer', expected }) });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('NEED_CONFLICT');
    expect(db.updateProjectNeed).toHaveBeenCalledWith('p', 'n', { notes: 'Saved answer', expected, status: undefined });
    const malformed = await requestJson(`${handle.baseUrl}/api/projects/p/needs/n`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'Saved answer', expected: {} }) });
    expect(malformed.status).toBe(400);
    expect(db.updateProjectNeed).toHaveBeenCalledTimes(1);
  });

  describe('generate-commit-message', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { execFileSync } = require('child_process');
    let repo; let callAI; let contextWindowFor; let savedKey;
    const walkthrough = `Walkthrough start. ${'Why the change was made. '.repeat(300)}WALKTHROUGH END`;

    beforeEach(async () => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-commit-message-'));
      const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      git('init', '-q');
      git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
      fs.writeFileSync(path.join(repo, 'big.txt'), 'old\n');
      git('add', 'big.txt');
      git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'add big');
      // A diff far past the old 2,000-character preview, with a marker at its end.
      fs.writeFileSync(path.join(repo, 'big.txt'), `${Array.from({ length: 600 }, (_, i) => `changed line ${i} of a large change`).join('\n')}\nDIFF END MARKER\n`);
      savedKey = process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_API_KEY = 'present-for-the-route-check';
      callAI = jest.fn(async () => ({ text: 'feat: change big.txt', finishReason: 'stop', truncated: false }));
      contextWindowFor = jest.fn(async () => null);
      const db = { getTask: jest.fn(async () => ({ walkthrough })) };
      const app = express(); app.use(express.json());
      app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: os.tmpdir(), getProjectById: async () => ({ id: 'p', path: repo }), getAllProjects: jest.fn(), scanProjects: jest.fn(), callAI, contextWindowFor, contextSync: {} }));
      handle = await listen(app);
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = savedKey;
      fs.rmSync(repo, { recursive: true, force: true });
    });

    const generate = () => requestJson(`${handle.baseUrl}/api/projects/p/generate-commit-message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 't1' }) });

    it('writes the message from the whole diff and walkthrough when they fit, or the window is unknown', async () => {
      const unknown = await generate();
      contextWindowFor.mockResolvedValueOnce({ tokens: 200000, source: 'claude-code claude-sonnet-4-6 run report', charsPerToken: 3 });
      const fits = await generate();
      for (const result of [unknown, fits]) {
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ message: 'feat: change big.txt', generated: true });
      }
      expect(contextWindowFor).toHaveBeenCalledWith('quick');
      for (const [task, prompt] of callAI.mock.calls) {
        expect(task).toBe('quick');
        expect(prompt).toContain('DIFF END MARKER');
        expect(prompt).toContain(walkthrough);
        expect(prompt).toMatch(/Files changed:\n.*big\.txt\n/);
        expect(prompt).not.toMatch(/too large for this model's context window/);
      }
    });

    it('cuts a diff past its share with a note in the prompt and says so in the response', async () => {
      // 4,000 tokens x 3 characters: the diff may take 0.6 (7,200), the walkthrough 0.2 (2,400).
      contextWindowFor.mockResolvedValue({ tokens: 4000, source: 'claude-code claude-haiku run report', charsPerToken: 3 });
      const result = await generate();
      expect(result.status).toBe(200);
      const prompt = callAI.mock.calls[0][1];
      expect(prompt).not.toContain('DIFF END MARKER');
      expect(prompt).not.toContain('WALKTHROUGH END');
      const diffNote = prompt.match(/\[Diff: ([\d,]+) characters, too large for this model's context window \(4,000 tokens, claude-code claude-haiku run report\) alongside the rest of the request\. The first ([\d,]+) are above; the whole text is in (\S+)\.\]/);
      expect(diffNote).not.toBeNull();
      expect(fs.readFileSync(diffNote[3], 'utf8')).toContain('DIFF END MARKER');
      expect(prompt).toMatch(/\[Task walkthrough: [\d,]+ characters, too large/);

      expect(result.body).toEqual(expect.objectContaining({ message: 'feat: change big.txt', generated: true }));
      expect(result.body.partialInput).toEqual(expect.arrayContaining([
        expect.objectContaining({ what: 'diff', fullTextPath: diffNote[3] }),
        expect.objectContaining({ what: 'walkthrough' }),
      ]));
      expect(result.body.note).toMatch(/^This message was written from part of the change: the first [\d,]+ of [\d,]+ characters of the diff; .*4,000 tokens/);
      expect(result.body.note).toContain(diffNote[3]);
    });
  });

  it('accepts planning rotation metadata updates', async () => {
    const db = {
      updateProject: jest.fn().mockImplementation(async (id, updates) => ({
        id,
        name: 'Praxis',
        path: '/Volumes/Projects/Praxis',
        ...updates,
      })),
    };
    const createProjectsRouter = require('../routes/projects');
    const app = express();
    app.use(express.json());
    app.use('/api/projects', createProjectsRouter({
      db,
      PROJECT_ROOT: '/Volumes/Projects',
      getProjectById: jest.fn(),
      getAllProjects: jest.fn(),
      scanProjects: jest.fn(),
      callAI: jest.fn(),
      contextSync: {},
    }));
    handle = await listen(app);

    await expect(requestJson(`${handle.baseUrl}/api/projects/project-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'active',
        priority: 75,
        end_state: 'Project has a reliable daily scheduling routine.',
      }),
    })).resolves.toEqual({
      status: 200,
      body: expect.objectContaining({
        id: 'project-1',
        status: 'active',
        priority: 75,
        end_state: 'Project has a reliable daily scheduling routine.',
      }),
    });

    expect(db.updateProject).toHaveBeenCalledWith('project-1', {
      status: 'active',
      priority: 75,
      end_state: 'Project has a reliable daily scheduling routine.',
    });
  });
});
