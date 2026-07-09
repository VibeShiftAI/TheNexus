/**
 * Projects Routes
 * 
 * GET    /api/projects                          — List active projects (?archived=true → archived only)
 * POST   /api/projects                          — Create project
 * POST   /api/projects/scaffold                 — Scaffold new project
 * GET    /api/projects/:id                      — Get project details
 * PATCH  /api/projects/:id                      — Update project
 * DELETE /api/projects/:id                      — Delete project
 * POST   /api/projects/:id/archive              — Archive project + its tasks (files left intact)
 * POST   /api/projects/:id/unarchive            — Restore an archived project + its tasks
 * GET    /api/projects/:id/status               — Git status
 * POST   /api/projects/:id/git/init             — Init git
 * POST   /api/projects/:id/git/remote           — Add remote
 * GET    /api/projects/:id/ping                 — Ping production URL
 * GET    /api/projects/:id/readme               — Get README
 * GET    /api/projects/:id/commits              — Get commit history
 * POST   /api/projects/:id/commit-push          — Commit and push
 * GET    /api/projects/:id/diff                 — Get git diff
 * POST   /api/projects/:id/generate-commit-message — AI commit message
 * GET    /api/projects/:id/context              — Get project contexts
 * POST   /api/projects/:id/context              — Update project context
 * POST   /api/projects/:id/context/sync         — Sync context from git
 * GET    /api/projects/:id/context/verify        — Verify context sync
 * GET    /api/activity                           — Recent activity feed
 * GET    /api/pins                               — Get pinned projects
 * POST   /api/projects/:id/pin                   — Pin project
 * DELETE /api/projects/:id/pin                   — Unpin project
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');

// Names/emails that mark a commit trailer as belonging to an AI executor, so
// the Recent Activity Feed can attribute a commit to the model that authored it.
const AI_COAUTHOR_HINT = /claude|gpt|gemini|codex|llama|opus|sonnet|haiku|fable|mistral|anthropic|openai|copilot|devin/i;

/**
 * Best-effort per-activity attribution for the Recent Activity Feed.
 *
 * Activities are git commits, which carry no first-class model/token columns —
 * but autonomous executors stamp the model into a `Co-Authored-By:` (or explicit
 * `Model:`) trailer, and can stamp a `Tokens:` trailer. This reads those signals
 * from the commit subject + body and returns { model, tokens }, using nulls when
 * a commit has no such data (hand-authored or system commits) so the UI can show
 * a neutral placeholder instead of guessing.
 *
 * @param {{ message?: string, body?: string }} commit
 * @returns {{ model: string|null, tokens: number|null }}
 */
function deriveActivityAttribution(commit) {
    const text = `${commit?.message || ''}\n${commit?.body || ''}`;
    let model = null;
    let tokens = null;

    // Explicit "Model:" trailer wins when present.
    const modelTrailer = text.match(/^\s*Model:\s*(.+?)\s*$/im);
    if (modelTrailer) {
        model = modelTrailer[1].replace(/\s*<[^>]*>\s*$/, '').trim() || null;
    }

    // Otherwise attribute to an AI co-author trailer (skip human co-authors).
    if (!model) {
        for (const m of text.matchAll(/^\s*Co-authored-by:\s*(.+?)\s*<([^>]*)>/gim)) {
            const name = m[1].trim();
            const email = m[2].trim();
            if (AI_COAUTHOR_HINT.test(name) || AI_COAUTHOR_HINT.test(email)) {
                model = name || null;
                break;
            }
        }
    }

    // Token count trailer: "Tokens: 12345" / "Tokens-Used: 12,345" / "Token-Count: 12k".
    const tokenTrailer = text.match(/^\s*Tokens?(?:[-\s]?(?:Used|Count))?:\s*([\d.,]+)\s*([kKmM])?\s*$/im);
    if (tokenTrailer) {
        let n = parseFloat(tokenTrailer[1].replace(/,/g, ''));
        const unit = (tokenTrailer[2] || '').toLowerCase();
        if (unit === 'k') n *= 1_000;
        else if (unit === 'm') n *= 1_000_000;
        if (Number.isFinite(n) && n >= 0) tokens = Math.round(n);
    }

    return { model, tokens };
}

// When a dispatch row carries no explicit `model` (Codex/Antigravity writers
// routinely omit it), fall back to a friendly label derived from the executor
// that ran it — the executor IS the agent that performed the work, so "Codex"
// or "Gemini" is honest attribution and far better than a blank "—". Returns
// null for unknown executors so the UI still shows the neutral placeholder.
const EXECUTOR_MODEL_LABELS = {
    'claude-code': 'Claude',
    'claude': 'Claude',
    'codex': 'Codex',
    'antigravity': 'Gemini',
    'gemini': 'Gemini',
};
function executorModelLabel(executor) {
    if (!executor) return null;
    return EXECUTOR_MODEL_LABELS[String(executor).toLowerCase().trim()] || null;
}

// A commit is attributed to a dispatch only when it lands inside (or just after)
// that dispatch's execution window. Executors commit near the end of a run, and
// the dispatch's completed_at is stamped a moment later, so allow a grace period
// on the completed side. Human commits made outside any dispatch window match
// nothing and stay unattributed (a neutral "—" beats a wrong model name).
const DISPATCH_MATCH_GRACE_MS = 15 * 60 * 1000; // 15 min

/**
 * Correlate a commit to the dispatch that most plausibly produced it, using the
 * real per-run executor/model + token count the orchestrator recorded in
 * task_dispatches. Returns { model, tokens } (nulls when no dispatch matches).
 *
 * @param {Date} commitDate
 * @param {Array} dispatches — rows for the SAME project, any order
 * @returns {{ model: string|null, tokens: number|null, tokensEstimated: boolean, modelInferred: boolean }}
 */
function correlateDispatch(commitDate, dispatches) {
    const t = commitDate.getTime();
    if (!Number.isFinite(t) || !Array.isArray(dispatches)) return { model: null, tokens: null, tokensEstimated: false, modelInferred: false };
    let best = null;
    let bestDist = Infinity;
    for (const d of dispatches) {
        const start = new Date(d.started_at).getTime();
        if (!Number.isFinite(start) || start > t + 1000) continue; // dispatch began after the commit
        const end = d.completed_at ? new Date(d.completed_at).getTime() : t;
        const endWithGrace = (Number.isFinite(end) ? end : start) + DISPATCH_MATCH_GRACE_MS;
        if (t > endWithGrace) continue; // commit lands well after the run finished
        // Prefer the dispatch whose completion is closest to the commit time.
        const ref = Number.isFinite(end) ? end : start;
        const dist = Math.abs(t - ref);
        if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (!best) return { model: null, tokens: null, tokensEstimated: false, modelInferred: false };
    const hasTokens = typeof best.tokens === 'number' && Number.isFinite(best.tokens);
    // Explicit model on the dispatch row wins; otherwise derive one from the
    // executor so the row still names the agent that did the work.
    const explicitModel = best.model || null;
    const model = explicitModel || executorModelLabel(best.executor);
    return {
        model,
        tokens: hasTokens ? best.tokens : null,
        tokensEstimated: hasTokens ? !!best.tokens_estimated : false,
        modelInferred: !explicitModel && !!model,
    };
}

function createProjectsRouter({ db, PROJECT_ROOT, getProjectById, getAllProjects, scanProjects, callAI, contextSync, getRecentDispatches }) {
    const router = express.Router();

    // Scan cache to prevent redundant filesystem scans
    let scanCache = null;
    let scanCacheTime = 0;
    let scanInProgress = null;
    const SCAN_CACHE_TTL = 5000;

    // Pinned projects storage
    const PINS_FILE = path.join(__dirname, '..', '..', 'pinned.json');

    function getPinnedProjects() {
        try {
            if (fs.existsSync(PINS_FILE)) {
                return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
            }
        } catch (e) {
            console.warn('Could not read pins file:', e);
        }
        return [];
    }

    function savePinnedProjects(pins) {
        fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2));
    }

    // Helper: build project context for AI (also used in task research)
    function getDirectoryTree(dirPath, maxDepth = 3, currentDepth = 0, prefix = '') {
        if (currentDepth >= maxDepth) return '';
        const ignoreDirs = ['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache'];
        const ignoreFiles = ['.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
        let tree = '';
        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            const filtered = items.filter(item => {
                if (item.isDirectory() && ignoreDirs.includes(item.name)) return false;
                if (item.isFile() && ignoreFiles.includes(item.name)) return false;
                return !item.name.startsWith('.');
            });
            filtered.forEach((item, index) => {
                const isLast = index === filtered.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const extension = isLast ? '    ' : '│   ';
                tree += `${prefix}${connector}${item.name}${item.isDirectory() ? '/' : ''}\n`;
                if (item.isDirectory()) {
                    tree += getDirectoryTree(path.join(dirPath, item.name), maxDepth, currentDepth + 1, prefix + extension);
                }
            });
        } catch (e) { /* ignore permission errors */ }
        return tree;
    }

    function readKeyFiles(projectPath) {
        const keyFiles = [
            'README.md', 'readme.md', 'project.json', 'package.json', 'tsconfig.json',
            'next.config.js', 'next.config.ts', 'vite.config.js', 'vite.config.ts',
            'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts',
            'src/app.js', 'src/app.ts', 'src/server.js', 'src/server.ts',
            'app/page.tsx', 'app/layout.tsx', 'pages/index.tsx', 'pages/_app.tsx'
        ];
        const contents = {};
        const maxFileSize = 10000;
        for (const file of keyFiles) {
            const filePath = path.join(projectPath, file);
            if (fs.existsSync(filePath)) {
                try {
                    let content = fs.readFileSync(filePath, 'utf8');
                    if (content.length > maxFileSize) content = content.substring(0, maxFileSize) + '\n... [truncated]';
                    contents[file] = content;
                } catch (e) { /* ignore */ }
            }
        }
        return contents;
    }

    // Exported so tasks module can use it
    router.buildProjectContext = function(projectPath, projectData) {
        const tree = getDirectoryTree(projectPath, 4);
        const keyFiles = readKeyFiles(projectPath);
        let context = `# PROJECT CONTEXT\n\n`;
        context += `## Project Metadata (project.json)\n\`\`\`json\n${JSON.stringify(projectData, null, 2)}\n\`\`\`\n\n`;
        context += `## File Structure\n\`\`\`\n${tree}\n\`\`\`\n\n`;
        context += `## Key Files\n`;
        for (const [filename, content] of Object.entries(keyFiles)) {
            if (filename !== 'project.json') {
                const lang = filename.endsWith('.json') ? 'json' :
                    filename.endsWith('.md') ? 'markdown' :
                    filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'typescript' : 'javascript';
                context += `### ${filename}\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
            }
        }
        return context;
    };

    // ─── Projects List ───────────────────────────────────────────────────
    router.get('/', async (req, res) => {
        try {
            // Archive-management view: return only archived projects (no scan needed).
            if (req.query.archived === 'true') {
                const all = await db.getProjects({ includeArchived: true });
                return res.json(all.filter(p => p.status === 'archived'));
            }
            const now = Date.now();
            if (!scanCache || (now - scanCacheTime) > SCAN_CACHE_TTL) {
                if (scanInProgress) {
                    await scanInProgress;
                } else {
                    scanInProgress = (async () => {
                        console.log(`[Projects] Scanning for new projects (Root: ${PROJECT_ROOT})...`);
                        await scanProjects(PROJECT_ROOT);
                        scanCacheTime = Date.now();
                        scanCache = true;
                    })();
                    try { await scanInProgress; } finally { scanInProgress = null; }
                }
            }
            const projects = await getAllProjects(PROJECT_ROOT);
            res.json(projects);
        } catch (error) {
            console.error('[Projects] Error getting projects:', error);
            res.status(500).json({ error: 'Failed to get projects' });
        }
    });

    // ─── Create Project ──────────────────────────────────────────────────
    router.post('/', async (req, res) => {
        const { name, description, type, goal } = req.body;
        if (!name) return res.status(400).json({ error: 'Project name is required' });
        try {
            const newProject = {
                name, description: description || goal || '', type: type || 'tool',
                path: path.join(PROJECT_ROOT, name), tasks_list: []
            };
            const result = await db.upsertProject(newProject);
            const projectPath = path.join(PROJECT_ROOT, name);
            if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
            res.status(201).json(result);
        } catch (error) {
            console.error('Error creating project:', error);
            res.status(500).json({ error: 'Failed to create project: ' + error.message });
        }
    });

    // ─── Scaffold new project ────────────────────────────────────────────
    router.post('/scaffold', async (req, res) => {
        const { name, type, description, supervisor } = req.body;
        if (!name || !name.match(/^[a-zA-Z0-9-_\s]+$/)) {
            return res.status(400).json({ error: 'Invalid project name. Use only letters, numbers, dashes, underscores, and spaces.' });
        }
        const projectPath = path.join(PROJECT_ROOT, name);
        if (fs.existsSync(projectPath)) {
            return res.status(400).json({ error: `Project '${name}' already exists.` });
        }
        try {
            fs.mkdirSync(projectPath, { recursive: true });
            const projectMeta = {
                name, type: type || 'web-app', description: description || '',
                created: new Date().toISOString(), vibe: supervisor ? 'immaculate' : 'default',
                tasks: supervisor?.tasks || [], stack: {}, urls: { production: '', repo: '' }
            };
            fs.writeFileSync(path.join(projectPath, 'project.json'), JSON.stringify(projectMeta, null, 4));
            const git = simpleGit(projectPath);
            await git.init();

            if (supervisor) {
                const supervisorPath = path.join(projectPath, 'supervisor');
                fs.mkdirSync(supervisorPath, { recursive: true });
                fs.writeFileSync(path.join(supervisorPath, 'product.md'), `# Product Guide: ${name}\n\n## 1. Initial Concept\n${supervisor.concept}\n\n## 2. Target Audience\n${supervisor.audience.map(a => `*   **${a}**`).join('\n')}\n\n## 3. Core Value Proposition\n*   **Primary Goal:** ${supervisor.goals.join(', ')}\n*   **Type:** ${type}\n\n## 4. Key Tasks & Capabilities\n${supervisor.tasks.map(f => `*   **${f}**`).join('\n')}\n\n## 5. Design Philosophy\n*   **Aesthetic:** ${supervisor.aesthetic}\n*   **Tone:** ${supervisor.tone}\n*   **Interaction:** ${supervisor.aiInteraction}\n`);
                fs.writeFileSync(path.join(supervisorPath, 'product-guidelines.md'), `# Product Guidelines: ${name}\n\n## 1. Brand Identity & Voice\n*   **Tone:** ${supervisor.tone}\n*   **AI Persona:** ${supervisor.aiInteraction}\n\n## 2. Visual Design System\n*   **Aesthetic:** ${supervisor.aesthetic}\n\n## 3. User Experience (UX) Principles\n*   **Interaction Model:** ${supervisor.aiInteraction}\n`);
                fs.writeFileSync(path.join(supervisorPath, 'tech-stack.md'), `# Technology Stack: ${name}\n\n## 1. Project Type\n${type}\n\n## 2. Core Technologies (Default)\n*   **Frontend:** Next.js, Tailwind CSS (inferred from defaults)\n*   **Backend:** Node.js / Python (inferred from defaults)\n*   **Database:** SQLite (local)\n`);
                fs.writeFileSync(path.join(supervisorPath, 'workflow.md'), `# Project Workflow\n\n## Guiding Principles\n1. **The Plan is the Source of Truth**\n2. **Test-Driven Development**\n3. **High Code Coverage (>90%)**\n\n## Workflow\n1. Select Task\n2. Write Failing Tests\n3. Implement\n4. Refactor\n5. Verify\n6. Commit\n`);
                fs.writeFileSync(path.join(supervisorPath, 'tracks.md'), '# Project Tracks\n\n## [ ] Track: Initial Setup\n');
                fs.writeFileSync(path.join(supervisorPath, 'setup_state.json'), JSON.stringify({ last_successful_step: "scaffold_complete", created_at: new Date().toISOString() }, null, 2));
            }

            let projectId = null;
            if (db.isDatabaseEnabled()) {
                const result = await db.upsertProject({
                    name: projectMeta.name, path: projectPath, type: projectMeta.type,
                    description: projectMeta.description, tasks_list: [],
                    vibe: projectMeta.vibe, stack: projectMeta.stack, urls: projectMeta.urls
                });
                projectId = result?.id;
            }

            res.json({
                success: true,
                message: `Project '${name}' initialized${supervisor ? ' with Supervisor setup' : ''}.`,
                path: projectPath, id: projectId
            });
        } catch (error) {
            console.error(`Error scaffolding project:`, error);
            res.status(500).json({ error: 'Failed to scaffold project: ' + error.message });
        }
    });

    // ─── Get single project ──────────────────────────────────────────────
    router.get('/:id', async (req, res) => {
        try {
            const project = await getProjectById(PROJECT_ROOT, req.params.id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            res.json(project);
        } catch (e) {
            console.error(`Error getting project ${req.params.id}:`, e);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // ─── Update project ──────────────────────────────────────────────────
    router.patch('/:id', async (req, res) => {
        const { id } = req.params;
        const allowedFields = ['name', 'description', 'type', 'vibe', 'stack', 'urls', 'path', 'status', 'priority', 'end_state'];
        const filteredUpdates = {};
        for (const key of Object.keys(req.body)) {
            if (allowedFields.includes(key)) filteredUpdates[key] = req.body[key];
        }
        if (Object.keys(filteredUpdates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        try {
            const updated = await db.updateProject(id, filteredUpdates);
            if (!updated) return res.status(404).json({ error: 'Project not found or update failed' });
            res.json(updated);
        } catch (error) {
            console.error(`Error updating project ${id}:`, error);
            res.status(500).json({ error: 'Failed to update project' });
        }
    });

    // ─── Delete project ──────────────────────────────────────────────────
    router.delete('/:id', async (req, res) => {
        const { id } = req.params;
        const { deleteFiles } = req.query;
        try {
            const project = await getProjectById(PROJECT_ROOT, id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            const dbDeleted = await db.deleteProject(id);
            if (!dbDeleted) return res.status(500).json({ error: 'Failed to delete project from database' });
            let filesDeleted = false;
            if (deleteFiles === 'true' && project.path && fs.existsSync(project.path)) {
                try {
                    fs.rmSync(project.path, { recursive: true, force: true });
                    filesDeleted = true;
                } catch (fsError) {
                    return res.json({ success: true, dbDeleted: true, filesDeleted: false, error: 'Database entry deleted but failed to remove files: ' + fsError.message });
                }
            }
            res.json({ success: true, dbDeleted: true, filesDeleted, message: filesDeleted ? 'Project and files deleted' : 'Project removed from database' });
        } catch (error) {
            console.error(`Error deleting project ${id}:`, error);
            res.status(500).json({ error: 'Failed to delete project: ' + error.message });
        }
    });

    // ─── Archive project ─────────────────────────────────────────────────
    // Soft, reversible: marks the project + all its tasks as 'archived' so they
    // drop off the dashboard and out of context-retrieval. Project files on disk
    // are intentionally left untouched (unlike DELETE with deleteFiles).
    router.post('/:id/archive', async (req, res) => {
        const { id } = req.params;
        try {
            const project = await getProjectById(PROJECT_ROOT, id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            const result = await db.archiveProject(project.id);
            if (!result) return res.status(500).json({ error: 'Failed to archive project' });
            res.json({
                success: true,
                project: result.project,
                tasksArchived: result.tasksArchived,
                message: `Project archived (${result.tasksArchived} task(s) archived). Files left intact.`
            });
        } catch (error) {
            console.error(`Error archiving project ${id}:`, error);
            res.status(500).json({ error: 'Failed to archive project: ' + error.message });
        }
    });

    // ─── Unarchive project ───────────────────────────────────────────────
    router.post('/:id/unarchive', async (req, res) => {
        const { id } = req.params;
        try {
            const project = await getProjectById(PROJECT_ROOT, id);
            if (!project) return res.status(404).json({ error: 'Project not found' });
            const result = await db.unarchiveProject(project.id);
            if (!result) return res.status(500).json({ error: 'Failed to unarchive project' });
            res.json({
                success: true,
                project: result.project,
                tasksRestored: result.tasksRestored,
                message: `Project restored (${result.tasksRestored} task(s) restored).`
            });
        } catch (error) {
            console.error(`Error unarchiving project ${id}:`, error);
            res.status(500).json({ error: 'Failed to unarchive project: ' + error.message });
        }
    });

    // ─── Git status ──────────────────────────────────────────────────────
    router.get('/:id/status', async (req, res) => {
        const { id } = req.params;
        const project = await getProjectById(PROJECT_ROOT, id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const gitPath = path.join(project.path, '.git');
        if (!fs.existsSync(gitPath)) {
            return res.json({ hasGit: false, hasRemote: false, remoteUrl: null, current: null, latest_commit: null, files: [], error: null });
        }
        try {
            const git = simpleGit(project.path);
            const status = await git.status();
            let remoteUrl = null, hasRemote = false;
            try {
                const remotes = await git.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (origin?.refs?.push) {
                    hasRemote = true;
                    let url = origin.refs.push;
                    if (url.startsWith('git@github.com:')) url = url.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
                    remoteUrl = url;
                }
            } catch (e) { console.warn(`Could not get remotes for ${id}:`, e); }
            let latest_commit = null, daysSinceCommit = null, hasCommits = false;
            try {
                const log = await git.log({ maxCount: 1 });
                latest_commit = log.latest; hasCommits = !!latest_commit;
                if (latest_commit?.date) {
                    daysSinceCommit = Math.floor((new Date() - new Date(latest_commit.date)) / (1000 * 60 * 60 * 24));
                }
            } catch (e) {
                if (!e.message?.includes('does not have any commits')) console.warn(`[Git] Could not get log for ${id}: ${e.message}`);
            }
            res.json({
                hasGit: true, hasRemote, hasCommits, remoteUrl, current: status.current,
                tracking: status.tracking, ahead: status.ahead, behind: status.behind,
                files: status.files, modified: status.modified, not_added: status.not_added,
                created: status.created, deleted: status.deleted, staged: status.staged,
                latest_commit, daysSinceCommit, uncommittedCount: status.files?.length || 0, error: null
            });
        } catch (error) {
            console.error(`Error getting git status for ${id}:`, error);
            res.json({ hasGit: true, hasRemote: false, remoteUrl: null, current: null, latest_commit: null, files: [], error: error.message });
        }
    });

    // ─── Git init ────────────────────────────────────────────────────────
    router.post('/:id/git/init', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (fs.existsSync(path.join(project.path, '.git'))) return res.status(400).json({ error: 'Git already initialized' });
        try {
            await simpleGit(project.path).init();
            res.json({ success: true, message: 'Git initialized successfully' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to initialize git' });
        }
    });

    // ─── Git remote ──────────────────────────────────────────────────────
    router.post('/:id/git/remote', async (req, res) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Remote URL is required' });
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            await simpleGit(project.path).addRemote('origin', url);
            res.json({ success: true, message: 'Remote added successfully' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to add remote: ' + error.message });
        }
    });

    // ─── Ping production URL ─────────────────────────────────────────────
    router.get('/:id/ping', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const productionUrl = project.urls?.production;
        if (!productionUrl) return res.json({ hasUrl: false, isUp: null, url: null });
        try {
            const parsed = new URL(productionUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are allowed' });
            if (/^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/i.test(parsed.hostname)) {
                return res.status(400).json({ error: 'Internal URLs are not allowed' });
            }
        } catch { return res.status(400).json({ error: 'Invalid URL format' }); }
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(productionUrl, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
            clearTimeout(timeout);
            res.json({ hasUrl: true, isUp: response.ok || response.status === 301 || response.status === 302, url: productionUrl, status: response.status });
        } catch (error) {
            res.json({ hasUrl: true, isUp: false, url: productionUrl, error: error.message });
        }
    });

    // ─── README ──────────────────────────────────────────────────────────
    router.get('/:id/readme', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const readmeNames = ['README.md', 'readme.md', 'Readme.md'];
        let content = null, foundPath = null;
        for (const name of readmeNames) {
            const readmePath = path.join(project.path, name);
            if (fs.existsSync(readmePath)) { try { content = fs.readFileSync(readmePath, 'utf-8'); foundPath = name; break; } catch (e) {} }
        }
        if (!content) return res.json({ exists: false, content: null });
        res.json({ exists: true, content, filename: foundPath });
    });

    // ─── Commits ─────────────────────────────────────────────────────────
    router.get('/:id/commits', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!fs.existsSync(path.join(project.path, '.git'))) return res.json({ commits: [], hasGit: false });
        try {
            const log = await simpleGit(project.path).log({ maxCount: 50 });
            res.json({ commits: log.all.map(c => ({ hash: c.hash, message: c.message, author: c.author_name, email: c.author_email, date: c.date })), hasGit: true });
        } catch (error) {
            if (error.message.includes('does not have any commits') || error.message.includes('fatal: bad default revision')) return res.json({ commits: [], hasGit: true });
            res.status(500).json({ error: 'Failed to get commit history' });
        }
    });

    // ─── Commit and Push ─────────────────────────────────────────────────
    router.post('/:id/commit-push', async (req, res) => {
        const { id } = req.params;
        const { message } = req.body;
        if (!message?.trim()) return res.status(400).json({ error: 'Commit message is required' });
        const project = await getProjectById(PROJECT_ROOT, id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!fs.existsSync(path.join(project.path, '.git'))) return res.status(400).json({ error: 'No git repository in this project' });
        try {
            const git = simpleGit(project.path);
            await git.add('.');
            const status = await git.status();
            if (status.files.length === 0) return res.json({ success: true, message: 'No changes to commit', filesCommitted: 0 });
            await git.commit(message.trim());
            const remotes = await git.getRemotes();
            if (remotes.length === 0) return res.json({ success: true, message: `Committed ${status.files.length} file(s). No remote configured, push skipped.`, filesCommitted: status.files.length, pushed: false });
            await git.push('origin', status.current);
            res.json({ success: true, message: `Committed and pushed ${status.files.length} file(s)`, filesCommitted: status.files.length, pushed: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to commit/push: ' + error.message });
        }
    });

    // ─── Diff ────────────────────────────────────────────────────────────
    router.get('/:id/diff', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!fs.existsSync(path.join(project.path, '.git'))) return res.status(400).json({ error: 'No git repository' });
        try {
            const git = simpleGit(project.path);
            const [diffSummary, diff] = await Promise.all([git.diffSummary(), git.diff()]);
            const status = await git.status();
            res.json({ summary: diffSummary, diff: diff.substring(0, 5000), files: status.files.map(f => ({ path: f.path, status: f.index || f.working_dir })), truncated: diff.length > 5000 });
        } catch (error) {
            if (error.message.includes('bad default revision') || error.message.includes('unknown revision')) {
                return res.json({ summary: { changed: 0, insertions: 0, deletions: 0, files: [] }, diff: '', files: [], truncated: false, note: 'No commits yet' });
            }
            res.status(500).json({ error: 'Failed to get diff: ' + error.message });
        }
    });

    // ─── Generate AI commit message ──────────────────────────────────────
    router.post('/:id/generate-commit-message', async (req, res) => {
        const { taskId } = req.body;
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        try {
            const git = simpleGit(project.path);
            const status = await git.status();
            let diff = '';
            try { diff = await git.diff(); } catch (e) { /* ignore */ }
            if (status.files.length === 0) return res.json({ message: 'No changes to commit' });
            const fileChanges = status.files.map(f => `${f.index || f.working_dir} ${f.path}`).join('\n');
            const diffPreview = diff.substring(0, 2000);
            let walkthroughContent = '';
            if (taskId) {
                try {
                    const task = await db.getTask(taskId);
                    if (task?.walkthrough) {
                        const wt = typeof task.walkthrough === 'string' ? task.walkthrough : task.walkthrough.content || JSON.stringify(task.walkthrough);
                        walkthroughContent = wt.substring(0, 3000);
                    }
                } catch (e) { /* ignore */ }
            }
            const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
            if (!apiKey) {
                const types = new Set();
                status.files.forEach(f => {
                    if (f.path.includes('component') || f.path.endsWith('.tsx')) types.add('component');
                    if (f.path.includes('server') || f.path.endsWith('.js')) types.add('server');
                    if (f.path.endsWith('.css')) types.add('style');
                    if (f.path.endsWith('.md')) types.add('docs');
                });
                return res.json({ message: `Update ${types.size > 0 ? Array.from(types).join(', ') : 'code'}: ${status.files.length} file(s) changed`, generated: false, note: 'Add an AI API key for smarter commit messages' });
            }
            const prompt = `Generate a concise git commit message (max 72 chars for first line) for these changes:\n\nFiles changed:\n${fileChanges}\n${walkthroughContent ? `\nImplementation Summary (from walkthrough):\n${walkthroughContent}\n` : ''}Diff preview:\n${diffPreview}\n\nFollow conventional commits format (feat:, fix:, docs:, refactor:, etc). Return ONLY the commit message, nothing else.`;
            try {
                const aiMessage = await callAI('quick', prompt, 'You are a git commit message generator.');
                if (aiMessage) return res.json({ message: aiMessage.trim(), generated: true });
            } catch (e) { /* fall through */ }
            res.json({ message: `Update: ${status.files.length} file(s) changed`, generated: false });
        } catch (error) {
            res.status(500).json({ error: 'Failed to generate commit message' });
        }
    });

    // ─── Context routes ──────────────────────────────────────────────────
    router.get('/:id/context', async (req, res) => {
        if (!db.isDatabaseEnabled()) return res.json({ contexts: [] });
        try { res.json({ contexts: await db.getProjectContexts(req.params.id) || [] }); }
        catch (error) { res.status(500).json({ error: 'Failed to get project context' }); }
    });

    router.post('/:id/context', async (req, res) => {
        const { type, content, status } = req.body;
        if (!type || !content) return res.status(400).json({ error: 'type and content are required' });
        if (!db.isDatabaseEnabled()) return res.status(501).json({ error: 'Database not enabled' });
        try {
            const result = await db.updateProjectContext(req.params.id, type, content, status);
            if (!result) return res.status(500).json({ error: 'Failed to update context' });
            res.json({ success: true, context: result });
        } catch (error) { res.status(500).json({ error: 'Failed to update context' }); }
    });

    router.post('/:id/context/sync', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!db.isDatabaseEnabled()) return res.status(501).json({ error: 'Database not enabled' });
        try {
            const result = await contextSync.pullAndSyncFromGit(req.params.id, project.path, db);
            res.json({ success: result.success, synced: result.synced, pulled: result.pulled, errors: result.errors });
        } catch (error) { res.status(500).json({ error: 'Failed to sync context: ' + error.message }); }
    });

    router.get('/:id/context/verify', async (req, res) => {
        const project = await getProjectById(PROJECT_ROOT, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!db.isDatabaseEnabled()) return res.status(501).json({ error: 'Database not enabled' });
        try { res.json(await contextSync.verifyContextSync(req.params.id, project.path, db)); }
        catch (error) { res.status(500).json({ error: 'Failed to verify context sync: ' + error.message }); }
    });

    // ─── Activity feed ───────────────────────────────────────────────────
    // Note: mounted at /api/activity, not under /api/projects
    router.getActivityHandler = async (req, res) => {
        const projects = await getAllProjects(PROJECT_ROOT);

        // Pull recent dispatch rows once and bucket them by project so each
        // commit can be attributed to the real executor/model + token count the
        // orchestrator recorded, rather than trailer text executors rarely write.
        const dispatchesByProject = new Map();
        try {
            const rows = typeof getRecentDispatches === 'function' ? (getRecentDispatches(300) || []) : [];
            for (const row of rows) {
                if (!row.project_id) continue;
                if (!dispatchesByProject.has(row.project_id)) dispatchesByProject.set(row.project_id, []);
                dispatchesByProject.get(row.project_id).push(row);
            }
        } catch (e) {
            console.warn('[Activity] Could not load dispatch attribution:', e.message);
        }

        const activities = [];
        for (const project of projects) {
            if (!fs.existsSync(path.join(project.path, '.git'))) continue;
            try {
                const log = await simpleGit(project.path).log({ maxCount: 5 });
                const projectDispatches = dispatchesByProject.get(project.id) || [];
                for (const commit of log.all) {
                    // Explicit commit trailers (Model:/Tokens:) are precise when present;
                    // otherwise fall back to correlating the commit with its dispatch.
                    const trailer = deriveActivityAttribution(commit);
                    const matched = correlateDispatch(new Date(commit.date), projectDispatches);
                    const model = trailer.model ?? matched.model;
                    // An explicit commit trailer is a precise model name; a
                    // dispatch-sourced model may be an executor-derived label.
                    const modelInferred = trailer.model != null ? false : matched.modelInferred;
                    // Explicit Tokens: trailers are exact; dispatch-sourced counts may be estimated.
                    const tokens = trailer.tokens ?? matched.tokens;
                    const tokensEstimated = trailer.tokens != null ? false : matched.tokensEstimated;
                    activities.push({ projectId: project.id, projectName: project.name, type: 'commit', hash: commit.hash, message: commit.message, author: commit.author_name, date: commit.date, model, modelInferred, tokens, tokensEstimated });
                }
            } catch (error) {
                if (!error.message?.includes('does not have any commits')) console.warn(`[Activity] Could not get log for ${project.name}: ${error.message}`);
            }
        }
        activities.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        res.json(activities.slice(0, 20));
    };

    // ─── Pins ────────────────────────────────────────────────────────────
    router.getPinsHandler = (req, res) => res.json(getPinnedProjects());

    router.post('/:id/pin', (req, res) => {
        const pins = getPinnedProjects();
        if (!pins.includes(req.params.id)) { pins.push(req.params.id); savePinnedProjects(pins); }
        res.json({ success: true, pinned: true });
    });

    router.delete('/:id/pin', (req, res) => {
        let pins = getPinnedProjects().filter(p => p !== req.params.id);
        savePinnedProjects(pins);
        res.json({ success: true, pinned: false });
    });

    // ─── Project Notes ───────────────────────────────────────────────────
    router.get('/:id/notes', async (req, res) => {
        try { res.json({ notes: await db.getNotes(req.params.id) }); }
        catch (error) { res.status(500).json({ error: 'Failed to fetch notes' }); }
    });

    router.post('/:id/notes', async (req, res) => {
        try {
            const { content, category, source } = req.body;
            if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
            const note = await db.createNote({ project_id: req.params.id, content: content.trim(), category: category || 'general', source: source || 'operator' });
            if (!note) return res.status(500).json({ error: 'Failed to create note' });
            res.status(201).json({ success: true, note });
        } catch (error) { res.status(500).json({ error: 'Failed to create note' }); }
    });

    return router;
}

module.exports = createProjectsRouter;
module.exports.deriveActivityAttribution = deriveActivityAttribution;
module.exports.correlateDispatch = correlateDispatch;
module.exports.executorModelLabel = executorModelLabel;
