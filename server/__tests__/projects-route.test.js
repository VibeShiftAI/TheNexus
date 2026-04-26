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
