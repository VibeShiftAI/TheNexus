const { canonicalPath, requireLeases, workspaceCommand } = require('../lib/write-leases');
const path = require('path');
const { z } = require("zod");

// Helper to ensure paths are within the project root
function validatePath(projectPath, targetPath) {
    const root = canonicalPath(projectPath);
    const resolvedPath = canonicalPath(path.resolve(root, targetPath || '.'));
    const relative = path.relative(root, resolvedPath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error(`Access denied: Path ${targetPath} is outside the project root.`);
    }
    return resolvedPath;
}

const tools = [
    {
        name: "run_command",
        description: "Run a shell command in the project directory. Use this for git, npm, or other system tools.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            command: z.string().describe("The command to run (e.g., 'npm install', 'git status')"),
            lease_token: z.string().optional().describe('Workspace write lease acquired before reading'),
            cwd: z.string().optional().describe("Optional subdirectory to run the command in (relative to project root)")
        }),
        execute: async ({ project_name, command, cwd, lease_token }, { getProjectPath, writeLeases }) => {
            try {
                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const workingDir = validatePath(projectRoot, cwd);

                // Safety check: block obviously dangerous commands
                const blockedCommands = ['rm -rf /', 'format', 'mkfs'];
                if (blockedCommands.some(c => command.includes(c))) {
                    return { isError: true, content: "Command blocked for safety reasons." };
                }

                const leases = writeLeases || requireLeases(require('../../db'));
                const output = workspaceCommand(leases, workingDir, command, [], { shell: true, token: lease_token, leasePath: projectRoot, includeStderr: true });
                return { content: output.trim() || 'Command executed successfully with no output.' };
            } catch (error) {
                return { isError: true, code: error.code, content: `Failed to run command: ${error.message}${error.stdout ? `\nSTDOUT:\n${error.stdout}` : ''}${error.stderr ? `\nSTDERR:\n${error.stderr}` : ''}` };
            }
        }
    }
];

module.exports = tools;
