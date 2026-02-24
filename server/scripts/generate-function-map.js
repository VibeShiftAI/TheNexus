const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'supervisor', 'function_map.md');

const EXCLUDE_DIRS = ['node_modules', '.git', '.next', 'dist', 'coverage', 'venv', 'db/migrations'];
const INCLUDE_EXTS = ['.js', '.ts', '.tsx', '.py'];

function scanDir(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (!EXCLUDE_DIRS.includes(file)) {
                scanDir(filePath, fileList);
            }
        } else {
            if (INCLUDE_EXTS.includes(path.extname(file))) {
                fileList.push(filePath);
            }
        }
    });
    return fileList;
}

function extractFunctions(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const functions = [];
    const lines = content.split('\n');
    const ext = path.extname(filePath);

    lines.forEach((line, index) => {
        let match;
        // JS/TS: function foo() or const foo = () =>
        if (ext === '.js' || ext.startsWith('.ts')) {
            // function decl
            if ((match = line.match(/function\s+(\w+)\s*\(/))) {
                functions.push({ name: match[1], line: index + 1, type: 'function' });
            }
            // arrow func or const func assignment
            else if ((match = line.match(/const\s+(\w+)\s*=\s*(async\s*)?(\([^)]*\)|[^=]*)\s*=>/))) {
                functions.push({ name: match[1], line: index + 1, type: 'arrow' });
            }
            // class method (simplified)
            else if ((match = line.match(/^\s*(async\s+)?(\w+)\s*\([^)]*\)\s*\{/))) {
                if (!['if', 'for', 'while', 'switch', 'catch'].includes(match[2])) {
                    functions.push({ name: match[2], line: index + 1, type: 'method' });
                }
            }
        }
        // Python: def foo():
        else if (ext === '.py') {
            if ((match = line.match(/^\s*def\s+(\w+)\s*\(/))) {
                functions.push({ name: match[1], line: index + 1, type: 'def' });
            }
        }
    });
    return functions;
}

(async () => {
    console.log('Generating Function Map...');
    const allFiles = scanDir(PROJECT_ROOT);

    // Generate Mermaid Class Diagram
    let mermaid = 'classDiagram\n    direction LR\n';

    // Helper to sanitize names for Mermaid
    const sanitize = (name) => name.replace(/[^a-zA-Z0-9_]/g, '_');

    // Group by directory for better organization
    const grouped = {};

    allFiles.forEach(file => {
        const fns = extractFunctions(file);
        if (fns.length > 0) {
            const relPath = path.relative(PROJECT_ROOT, file);
            const dir = path.dirname(relPath);
            if (!grouped[dir]) grouped[dir] = [];
            grouped[dir].push({ file: path.basename(file), relPath, functions: fns });
        }
    });

    // Add classes and methods
    const sortedDirs = Object.keys(grouped).sort();

    sortedDirs.forEach(dir => {
        if (dir === '.') return;

        const namespace = sanitize(dir);
        mermaid += `    namespace ${namespace} {\n`;

        grouped[dir].forEach(fileData => {
            // Use full relative path for unique ID to avoid collisions (e.g. multiple page.tsx)
            const classId = sanitize(fileData.relPath);
            const label = fileData.file;

            // Mermaid class syntax with label: class uniqueId["label"]
            // Methods must be attached to the ID
            mermaid += `        class ${classId}["${label}"] {\n`;

            // Limit to top 20 functions per file to prevent massive diagrams
            const funcs = fileData.functions.slice(0, 20);
            funcs.forEach(fn => {
                mermaid += `            +${fn.name}()\n`;
            });
            if (fileData.functions.length > 20) {
                mermaid += `            +... ${fileData.functions.length - 20} more()\n`;
            }

            mermaid += `        }\n`;
        });

        mermaid += `    }\n`;
    });

    fs.writeFileSync(OUTPUT_FILE, mermaid);
    console.log(`Map generated at: ${OUTPUT_FILE} (${mermaid.length} chars)`);
})();
