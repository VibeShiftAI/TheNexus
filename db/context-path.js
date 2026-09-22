const path = require('path');
const { canonicalPath } = require('./write-leases');

// Context projections belong to the project's lease, including when .context
// or the destination file is a symlink. Validate before any directory/DB write.
module.exports = function contextPath(projectPath, type) {
    const invalid = () => Object.assign(new Error('Context type/path must stay inside its project workspace'), { status: 400, code: 'invalid_write_lease' });
    if (typeof type !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(type)) throw invalid();
    const root = canonicalPath(projectPath);
    const target = canonicalPath(path.join(root, '.context', `${type}.md`));
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw invalid();
    return target;
};
