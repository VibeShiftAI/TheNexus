// Suppress dotenv verbose logging to stdout which breaks MCP protocol (JSON-RPC)
// dotenv 17.x logs to stdout directly, so we must set DOTENV_CONFIG_QUIET before requiring
process.env.DOTENV_CONFIG_QUIET = 'true';
const path = require('path');
// Use explicit path to .env so it loads correctly regardless of working directory
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require('fs');
const db = require('../db');

// Initialize MCP Server
const server = new McpServer({
    name: "Local Nexus",
    version: "1.0.0"
});

// Default project root (same as server.js)
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');

// --- RESOURCES ---

// List all projects
server.resource(
    "projects",
    "projects://list",
    async (uri) => {
        const projects = await db.getProjects();
        return {
            contents: [{
                uri: uri.href,
                text: JSON.stringify(projects, null, 2),
                mimeType: "application/json"
            }]
        };
    }
);

// --- TOOLS ---

// Scaffold a new project
server.tool(
    "scaffold_new_vibe",
    {
        name: z.string().describe("The name of the project (e.g. 'SpaceHopper')"),
        type: z.enum(["web-app", "game", "tool"]).describe("The type of project to create")
    },
    async ({ name, type }) => {
        // 1. Validate inputs
        if (!name || !name.match(/^[a-zA-Z0-9-_]+$/)) {
            return {
                content: [{ type: "text", text: "Error: Invalid project name. Use only letters, numbers, dashes, and underscores." }],
                isError: true
            };
        }

        const projectPath = path.join(PROJECT_ROOT, name);

        // 2. Check if exists
        if (fs.existsSync(projectPath)) {
            return {
                content: [{ type: "text", text: `Error: Project '${name}' already exists at ${projectPath}` }],
                isError: true
            };
        }

        // 3. Create directory
        try {
            fs.mkdirSync(projectPath, { recursive: true });

            // 4. Initialize Metadata (Sync to DB)
            if (db.isDatabaseEnabled()) {
                await db.upsertProject({
                    name: name,
                    path: projectPath,
                    type: type,
                    description: "",
                    vibe: "immaculate"
                });
            }

            // 5. Initialize npm and git
            const { execSync } = require('child_process');
            execSync('npm init -y', { cwd: projectPath, stdio: 'ignore' });

            const simpleGit = require('simple-git');
            const git = simpleGit(projectPath);
            await git.init();

            return {
                content: [{
                    type: "text",
                    text: `Successfully created project '${name}' (${type}) at ${projectPath}.\nInitialized git and npm.`
                }]
            };

        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to create project: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Initialize git in an existing project
server.tool(
    "init_git",
    {
        project_name: z.string().describe("The name or ID of the existing project to initialize git in")
    },
    async ({ project_name }) => {
        const project = await db.getProject(project_name);

        if (!project) {
            return {
                content: [{ type: "text", text: `Error: Project '${project_name}' not found.` }],
                isError: true
            };
        }

        const gitPath = path.join(project.path, '.git');
        if (fs.existsSync(gitPath)) {
            return {
                content: [{ type: "text", text: `Git already initialized in '${project.name}'.` }],
                isError: false
            };
        }

        try {
            const simpleGit = require('simple-git');
            const git = simpleGit(project.path);
            await git.init();

            return {
                content: [{
                    type: "text",
                    text: `Successfully initialized git in '${project.name}' at ${project.path}.`
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to initialize git: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Add remote to an existing project
server.tool(
    "add_remote",
    {
        project_name: z.string().describe("The name or ID of the project to add a remote to"),
        remote_url: z.string().describe("The git remote URL (e.g., git@github.com:user/repo.git)")
    },
    async ({ project_name, remote_url }) => {
        // Validate URL format
        const validUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)/;
        if (!validUrlPattern.test(remote_url)) {
            return {
                content: [{ type: "text", text: `Error: Invalid remote URL. Must start with https://, git@, or ssh://.` }],
                isError: true
            };
        }

        const project = await db.getProject(project_name);

        if (!project) {
            return {
                content: [{ type: "text", text: `Error: Project '${project_name}' not found.` }],
                isError: true
            };
        }

        const gitPath = path.join(project.path, '.git');
        if (!fs.existsSync(gitPath)) {
            return {
                content: [{ type: "text", text: `Error: Git is not initialized in '${project.name}'. Run init_git first.` }],
                isError: true
            };
        }

        try {
            const simpleGit = require('simple-git');
            const git = simpleGit(project.path);

            // Check if 'origin' remote already exists
            const remotes = await git.getRemotes(true);
            const existingOrigin = remotes.find(r => r.name === 'origin');

            if (existingOrigin) {
                // Update the existing remote URL instead of failing
                await git.remote(['set-url', 'origin', remote_url]);
                return {
                    content: [{
                        type: "text",
                        text: `Remote 'origin' already existed in '${project.name}'. Updated URL from '${existingOrigin.refs.push}' to '${remote_url}'.`
                    }]
                };
            }

            await git.addRemote('origin', remote_url);

            return {
                content: [{
                    type: "text",
                    text: `Successfully added remote 'origin' (${remote_url}) to '${project.name}'.`
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to add remote: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Commit and push changes
server.tool(
    "commit_and_push",
    {
        project_name: z.string().describe("The name or ID of the project to commit and push"),
        message: z.string().describe("The commit message").default("Auto-commit from Nexus dashboard")
    },
    async ({ project_name, message }) => {
        const project = await db.getProject(project_name);

        if (!project) {
            return {
                content: [{ type: "text", text: `Error: Project '${project_name}' not found.` }],
                isError: true
            };
        }

        const gitPath = path.join(project.path, '.git');
        if (!fs.existsSync(gitPath)) {
            return {
                content: [{ type: "text", text: `Error: No git repository in '${project.name}'.` }],
                isError: true
            };
        }

        try {
            const simpleGit = require('simple-git');
            const git = simpleGit(project.path);

            // Stage all changes
            await git.add('.');

            // Get status to see what's being committed
            const status = await git.status();
            if (status.files.length === 0) {
                return {
                    content: [{ type: "text", text: `No changes to commit in '${project.name}'.` }],
                    isError: false
                };
            }

            // Commit
            await git.commit(message);

            // Check if remote exists
            const remotes = await git.getRemotes();
            if (remotes.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Committed ${status.files.length} file(s) in '${project.name}', but no remote configured. Push skipped.`
                    }],
                    isError: false
                };
            }

            // Push
            await git.push('origin', status.current);

            return {
                content: [{
                    type: "text",
                    text: `Successfully committed and pushed ${status.files.length} file(s) in '${project.name}'.\nMessage: "${message}"`
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Failed to commit/push: ${error.message}` }],
                isError: true
            };
        }
    }
);

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Local Nexus MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});