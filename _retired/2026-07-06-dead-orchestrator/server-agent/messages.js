/**
 * Human-readable messages for tool actions
 * Used to display "thinking" style output in the UI
 */

/**
 * Generate a human-readable message for a tool action
 * @param {string} toolName - The tool being executed
 * @param {Object} args - The tool arguments
 * @returns {string} Human-readable description
 */
function getToolMessage(toolName, args = {}) {
    const path = args.path || args.file_path || args.directory || args.project_name || '';
    const shortPath = path.split(/[/\\]/).slice(-2).join('/'); // Last 2 path segments

    const messages = {
        // File operations
        'read_file': `📖 Reading ${shortPath || 'file'}...`,
        'write_file': `✏️ Writing ${shortPath || 'file'}...`,
        'patch_file': `🔧 Patching ${shortPath || 'file'}...`,
        'list_directory': `📂 Exploring ${shortPath || 'directory'}...`,
        'search_files': `🔍 Searching for "${args.pattern || 'files'}"...`,
        'grep_search': `🔍 Searching for "${args.query || 'pattern'}"...`,

        // Project operations
        'scaffold_new_vibe': `🚀 Creating project "${args.name}"...`,
        'init_git': `📦 Initializing git in ${args.project_name}...`,
        'add_remote': `🔗 Adding remote to ${args.project_name}...`,
        'commit_and_push': `📤 Committing and pushing changes...`,

        // Shell operations
        'run_command': `⚙️ Running: ${(args.command || '').slice(0, 50)}${(args.command || '').length > 50 ? '...' : ''}`,

        // Memory/checkpoint
        'checkpoint_memory': `💾 Saving progress checkpoint...`,

        // Default
        'default': `⚡ ${toolName.replace(/_/g, ' ')}...`
    };

    return messages[toolName] || messages.default;
}

module.exports = {
    getToolMessage
};
