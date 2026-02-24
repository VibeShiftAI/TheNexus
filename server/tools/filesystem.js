const fs = require('fs');
const path = require('path');
const { z } = require("zod");

// Helper to ensure paths are within the project root
function validatePath(projectPath, targetPath) {
    if (!targetPath) {
        throw new Error('Path is required');
    }
    const resolvedPath = path.resolve(projectPath, targetPath);
    if (!resolvedPath.startsWith(path.resolve(projectPath))) {
        throw new Error(`Access denied: Path ${targetPath} is outside the project root.`);
    }
    return resolvedPath;
}

// Helper to normalize path parameters (accept both 'path' and 'file_path')
function normalizeFilePath(args) {
    return args.file_path || args.path;
}

const tools = [
    {
        name: "read_file",
        description: "Read the contents of a file. Use offset and limit to read specific sections of large files.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the file (e.g., 'src/index.js')"),
            offset: z.number().optional().describe("Character offset to start reading from (default: 0)"),
            limit: z.number().optional().describe("Maximum characters to read (default: 4000)")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name, offset = 0, limit = 4000 } = args;
                const file_path = normalizeFilePath(args);

                if (!file_path) {
                    return { isError: true, content: "Missing required parameter: path" };
                }

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, file_path);

                if (!fs.existsSync(fullPath)) {
                    return { isError: true, content: `File not found: ${file_path}` };
                }

                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                    return { isError: true, content: `Path is a directory, not a file: ${file_path}` };
                }

                // Read file with offset and limit support
                const MAX_CONTENT_SIZE = Math.min(limit, 8000); // Cap at 8000 chars max
                const fullContent = fs.readFileSync(fullPath, 'utf8');
                const totalSize = fullContent.length;

                // Apply offset and limit
                const startOffset = Math.min(offset, totalSize);
                const endOffset = Math.min(startOffset + MAX_CONTENT_SIZE, totalSize);
                let content = fullContent.substring(startOffset, endOffset);

                // Add metadata about what we're showing
                let header = `[File: ${file_path} | Total: ${totalSize} chars | Showing: ${startOffset}-${endOffset}]\n\n`;

                if (endOffset < totalSize) {
                    content += `\n\n... [TRUNCATED - ${totalSize - endOffset} more chars. Use offset=${endOffset} to continue]`;
                }

                return { content: header + content };
            } catch (error) {
                return { isError: true, content: `Failed to read file: ${error.message}` };
            }
        }
    },
    {
        name: "write_file",
        description: "Create or overwrite a file with new content. Code is reviewed by the Critic before writing.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the file"),
            content: z.string().describe("The content to write to the file")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name, content } = args;
                const file_path = normalizeFilePath(args);

                if (!file_path) {
                    return { isError: true, content: "Missing required parameter: path" };
                }

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, file_path);

                // Critic Review (Reflection Loop)
                // Only review code files, not configs or data
                const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.go', '.rs'];
                const ext = path.extname(file_path).toLowerCase();

                if (codeExtensions.includes(ext)) {
                    try {
                        const { reviewCode, isCriticEnabled } = require('../services/critic');

                        if (isCriticEnabled()) {
                            const review = await reviewCode(fullPath, content);

                            if (!review.approved && review.issues?.length > 0) {
                                // Return issues to agent for revision
                                return {
                                    isError: true,
                                    content: `CRITIC REVIEW FAILED - Please revise and retry:\n\nIssues:\n${review.issues.map(i => '- ' + i).join('\n')}${review.suggestions?.length > 0 ? '\n\nSuggestions:\n' + review.suggestions.map(s => '- ' + s).join('\n') : ''}`
                                };
                            }
                        }
                    } catch (criticError) {
                        // Critic errors should not block writes
                        console.warn('[write_file] Critic error (proceeding anyway):', criticError.message);
                    }
                }

                // Ensure directory exists
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.writeFileSync(fullPath, content, 'utf8');
                return { content: `Successfully wrote to ${file_path}` };
            } catch (error) {
                return { isError: true, content: `Failed to write file: ${error.message}` };
            }
        }
    },
    {
        name: "patch_file",
        description: "Replace specific text in a file. More efficient than read+write for targeted changes. Supports multiple replacements in one call.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the file"),
            replacements: z.array(z.object({
                find: z.string().describe("The exact text to find"),
                replace: z.string().describe("The text to replace it with")
            })).describe("Array of find/replace pairs to apply")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name, replacements } = args;
                const file_path = normalizeFilePath(args);

                if (!file_path) {
                    return { isError: true, content: "Missing required parameter: path" };
                }

                if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
                    return { isError: true, content: "At least one replacement is required" };
                }

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, file_path);

                if (!fs.existsSync(fullPath)) {
                    return { isError: true, content: `File not found: ${file_path}` };
                }

                let content = fs.readFileSync(fullPath, 'utf8');
                const results = [];

                for (const { find, replace } of replacements) {
                    if (!find) {
                        results.push({ find: '(empty)', status: 'skipped - empty find string' });
                        continue;
                    }

                    if (content.includes(find)) {
                        content = content.replace(find, replace);
                        results.push({ find: find.slice(0, 50) + (find.length > 50 ? '...' : ''), status: 'replaced' });
                    } else {
                        results.push({ find: find.slice(0, 50) + (find.length > 50 ? '...' : ''), status: 'not found' });
                    }
                }

                fs.writeFileSync(fullPath, content, 'utf8');

                const summary = results.map(r => `${r.status}: "${r.find}"`).join('\n');
                return { content: `Patched ${file_path}:\n${summary}` };
            } catch (error) {
                return { isError: true, content: `Failed to patch file: ${error.message}` };
            }
        }
    },
    {
        name: "append_file",
        description: "Append content to the end of a file. Creates the file if it doesn't exist.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the file"),
            content: z.string().describe("The content to append")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name, content } = args;
                const file_path = normalizeFilePath(args);

                if (!file_path) {
                    return { isError: true, content: "Missing required parameter: path" };
                }

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, file_path);

                // Ensure directory exists
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.appendFileSync(fullPath, content, 'utf8');
                return { content: `Successfully appended to ${file_path}` };
            } catch (error) {
                return { isError: true, content: `Failed to append to file: ${error.message}` };
            }
        }
    },
    {
        name: "list_directory",
        description: "List files and directories in a path",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the directory (use '.' for root)").default(".")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name } = args;
                const dir_path = args.path || args.dir_path || '.';

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, dir_path);

                if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
                    return { isError: true, content: `Directory not found: ${dir_path}` };
                }

                const items = fs.readdirSync(fullPath, { withFileTypes: true });
                const listing = items.map(item => {
                    return `${item.isDirectory() ? '[DIR]' : '[FILE]'} ${item.name}`;
                }).join('\n');

                return { content: listing || "(Empty directory)" };
            } catch (error) {
                return { isError: true, content: `Failed to list directory: ${error.message}` };
            }
        }
    },
    {
        name: "apply_diff",
        description: "Apply a unified diff to a file. More efficient than write_file for targeted edits - only sends changed lines. Use this for editing code files.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the file"),
            diff: z.string().describe("The diff to apply in search/replace format. Each block: <<<<<<< SEARCH\\n[original text]\\n=======\\n[replacement text]\\n>>>>>>> REPLACE")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name, diff } = args;
                const file_path = normalizeFilePath(args);

                if (!file_path) {
                    return { isError: true, content: "Missing required parameter: path" };
                }

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, file_path);

                if (!fs.existsSync(fullPath)) {
                    return { isError: true, content: `File not found: ${file_path}` };
                }

                let content = fs.readFileSync(fullPath, 'utf8');
                const originalLength = content.length;

                // Parse diff blocks in <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format
                const blockRegex = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
                let match;
                let appliedCount = 0;
                let failedBlocks = [];

                while ((match = blockRegex.exec(diff)) !== null) {
                    const searchText = match[1];
                    const replaceText = match[2];

                    if (content.includes(searchText)) {
                        content = content.replace(searchText, replaceText);
                        appliedCount++;
                    } else {
                        // Try fuzzy match - trim whitespace
                        const trimmedSearch = searchText.trim();
                        if (trimmedSearch && content.includes(trimmedSearch)) {
                            content = content.replace(trimmedSearch, replaceText.trim());
                            appliedCount++;
                        } else {
                            failedBlocks.push(searchText.substring(0, 50) + '...');
                        }
                    }
                }

                if (appliedCount === 0) {
                    return {
                        isError: true,
                        content: `No diff blocks matched. Ensure SEARCH text exactly matches the file. Failed blocks: ${failedBlocks.join(', ')}`
                    };
                }

                fs.writeFileSync(fullPath, content, 'utf8');

                const tokensSaved = Math.round((originalLength - (content.length - originalLength)) * 0.25);
                return {
                    content: `Applied ${appliedCount} diff block(s) to ${file_path}. ~${tokensSaved} tokens saved vs full rewrite.${failedBlocks.length > 0 ? ` Warning: ${failedBlocks.length} block(s) did not match.` : ''}`
                };
            } catch (error) {
                return { isError: true, content: `Failed to apply diff: ${error.message}` };
            }
        }
    },
    {
        name: "edit_lines",
        description: "Edit specific lines in a file by line number. Most efficient for single-location edits. Reads current content at lines first.",
        schema: z.object({
            project_name: z.string().describe("The name of the project"),
            path: z.string().describe("Relative path to the file"),
            start_line: z.number().describe("Starting line number (1-indexed)"),
            end_line: z.number().describe("Ending line number (1-indexed, inclusive)"),
            new_content: z.string().describe("The new content to replace lines start_line through end_line")
        }),
        execute: async (args, { getProjectPath }) => {
            try {
                const { project_name, start_line, end_line, new_content } = args;
                const file_path = normalizeFilePath(args);

                if (!file_path) {
                    return { isError: true, content: "Missing required parameter: path" };
                }

                if (start_line < 1 || end_line < start_line) {
                    return { isError: true, content: "Invalid line range. start_line must be >= 1 and end_line >= start_line" };
                }

                const projectRoot = getProjectPath(project_name);
                if (!projectRoot) throw new Error(`Project '${project_name}' not found`);

                const fullPath = validatePath(projectRoot, file_path);

                if (!fs.existsSync(fullPath)) {
                    return { isError: true, content: `File not found: ${file_path}` };
                }

                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');

                if (start_line > lines.length) {
                    return { isError: true, content: `start_line ${start_line} exceeds file length (${lines.length} lines)` };
                }

                const actualEndLine = Math.min(end_line, lines.length);
                const oldLines = lines.slice(start_line - 1, actualEndLine);

                // Replace lines
                const newLines = new_content.split('\n');
                lines.splice(start_line - 1, actualEndLine - start_line + 1, ...newLines);

                fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');

                return {
                    content: `Replaced lines ${start_line}-${actualEndLine} (${oldLines.length} lines) with ${newLines.length} new lines in ${file_path}`
                };
            } catch (error) {
                return { isError: true, content: `Failed to edit lines: ${error.message}` };
            }
        }
    }
];

module.exports = tools;

