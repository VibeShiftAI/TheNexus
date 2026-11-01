const fs = require('fs');
const path = require('path');

/** Resolve a readable workspace without following a changed project binding.
 * Return the validated canonical path so a later Git call does not follow the
 * supplied alias again. The stored/displayed project path remains unchanged.
 */
function projectWorkspacePath(project) {
    if (!project?.path?.trim() || !path.isAbsolute(project.path)) return null;
    const binding = project.intake?.workspace;
    if (binding && binding.state !== 'attached') return null;
    try {
        const canonical = fs.realpathSync(project.path);
        if (binding?.canonical_path && canonical !== binding.canonical_path) return null;
        return fs.statSync(canonical).isDirectory() ? canonical : null;
    } catch { return null; }
}

module.exports = { projectWorkspacePath };
