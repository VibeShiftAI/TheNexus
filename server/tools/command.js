const { exec } = require('child_process');
const path = require('path');
const { z } = require("zod");

// Helper to ensure paths are within the project root
function validatePath(projectPath, targetPath) {
    // If targetPath is not provided, return projectPath
    if (!targetPath) return projectPath;

    // If targetPath is absolute, check if it starts with projectPath
    if (path.isAbsolute(targetPath)) {
        if (!targetPath.startsWith(path.resolve(projectPath))) {
            throw new Error(`Access denied: Path ${targetPath} is outside the project root.`);
        }
        return targetPath;
    }

    // Resolve relative path
    const resolvedPath = path.resolve(projectPath, targetPath);
    if (!resolvedPath.startsWith(path.resolve(projectPath))) {
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
            cwd: z.string().optional().describe("Optional subdirectory to run the command in (relative to project root)")
        }),
        execute: async ({ project_name, command, cwd }, { getProjectPath }) => {
            try {
                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const workingDir = validatePath(projectRoot, cwd);

                // Safety check: block obviously dangerous commands
                const blockedCommands = ['rm -rf /', 'format', 'mkfs'];
                if (blockedCommands.some(c => command.includes(c))) {
                    return { isError: true, content: "Command blocked for safety reasons." };
                }

                return await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        resolve({ isError: true, content: "Command timed out after 30 seconds." });
                    }, 30000);

                    exec(command, { cwd: workingDir, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                        clearTimeout(timeout);

                        let output = "";
                        if (stdout) output += `STDOUT:\n${stdout}\n`;
                        if (stderr) output += `STDERR:\n${stderr}\n`;

                        if (error) {
                            output += `\nEXECUTION ERROR:\n${error.message}`;
                            resolve({ isError: true, content: output });
                        } else {
                            resolve({ content: output.trim() || "Command executed successfully with no output." });
                        }
                    });
                });
            } catch (error) {
                return { isError: true, content: `Failed to run command: ${error.message}` };
            }
        }
    }
];

module.exports = tools;
