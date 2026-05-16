describe('project workflow YouTube approval plumbing', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('starts youtube-production through the YouTube LangGraph API and stores pending approval', async () => {
    const { handleYoutubeWorkflowStart, WORKFLOW_STATUS } = require('../services/project-workflow-supervisor');
    const db = {
      updateProjectWorkflow: jest.fn().mockResolvedValue({}),
    };
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        run_id: 'yt-123',
        pending_approval: { gate: 'concept', message: 'Approve concept' },
        state: { concept: { title: 'Praxis Introduction' } },
      }),
    });

    const result = await handleYoutubeWorkflowStart({
      db,
      workflow: {
        id: 'wf-1',
        project_id: 'project-1',
        project: { name: 'The Nexus', path: '/Volumes/Projects/TheNexus' },
        configuration: {},
      },
      context: 'Create an introduction video about Praxis',
      langGraphUrl: 'http://python.test',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      mode: 'youtube-langgraph',
      runId: 'yt-123',
    }));
    expect(global.fetch).toHaveBeenCalledWith('http://python.test/api/youtube/runs', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('Create an introduction video about Praxis'),
    }));
    expect(db.updateProjectWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
      status: 'review',
      current_stage: 'concept',
      supervisor_status: WORKFLOW_STATUS.AWAITING_APPROVAL,
      supervisor_details: expect.objectContaining({
        youtube_run_id: 'yt-123',
        pending_approval: { gate: 'concept', message: 'Approve concept' },
      }),
    }));
  });

  it('resumes a youtube workflow and advances to the next approval gate', async () => {
    const { resumeYoutubeWorkflowApproval, WORKFLOW_STATUS } = require('../services/project-workflow-supervisor');
    const db = {
      updateProjectWorkflow: jest.fn().mockResolvedValue({}),
    };
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        run_id: 'yt-123',
        pending_approval: { gate: 'script', message: 'Approve script' },
        state: { script: { title: 'Praxis Introduction', scenes: [] } },
      }),
    });

    const result = await resumeYoutubeWorkflowApproval({
      db,
      workflow: {
        id: 'wf-1',
        supervisor_details: { youtube_run_id: 'yt-123' },
      },
      decision: 'approve',
      notes: 'Looks good',
      langGraphUrl: 'http://python.test',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      runId: 'yt-123',
      pendingApproval: { gate: 'script', message: 'Approve script' },
    }));
    expect(global.fetch).toHaveBeenCalledWith('http://python.test/api/youtube/runs/yt-123/resume', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ review_decision: 'approve', review_notes: 'Looks good' }),
    }));
    expect(db.updateProjectWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({
      status: 'review',
      current_stage: 'script',
      supervisor_status: WORKFLOW_STATUS.AWAITING_APPROVAL,
    }));
  });
});
