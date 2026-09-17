const fs = require('fs');
const os = require('os');
const path = require('path');
const { listProjectRoots, resolveDocumentPath, readDocumentFile, MAX_DOCUMENT_BYTES } = require('../services/document-registry');

let base;
let projectRoot;
let outsideDir;
let roots;

beforeEach(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doc-registry-')));
    projectRoot = path.join(base, 'project');
    outsideDir = path.join(base, 'outside');
    fs.mkdirSync(path.join(projectRoot, 'docs', 'reports'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'docs', 'reports', 'report.md'), '# Report\r\n\r\nBody line.\r\n');
    fs.writeFileSync(path.join(projectRoot, 'docs', 'secret.env'), 'TOKEN=abc');
    fs.writeFileSync(path.join(projectRoot, '.git', 'HEAD.md'), '# not for review');
    fs.writeFileSync(path.join(projectRoot, 'node_modules', 'pkg', 'README.md'), '# vendored');
    fs.writeFileSync(path.join(outsideDir, 'private.md'), '# private');
    fs.symlinkSync(path.join(outsideDir, 'private.md'), path.join(projectRoot, 'docs', 'escape.md'));
    fs.symlinkSync(path.join(projectRoot, 'docs', 'secret.env'), path.join(projectRoot, 'docs', 'masked.md'));
    fs.symlinkSync(path.join(projectRoot, 'docs', 'reports', 'report.md'), path.join(projectRoot, 'docs', 'alias.md'));
    fs.symlinkSync(outsideDir, path.join(projectRoot, 'docs', 'linked-dir'));
    const db = { getProjects: async () => [
        { id: 'p1', name: 'Project', path: projectRoot },
        { id: 'gone', name: 'Missing', path: path.join(base, 'does-not-exist') },
        { id: 'relative', name: 'Relative', path: 'relative/path' },
    ] };
    roots = await listProjectRoots(db);
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

test('only existing absolute project directories become roots', () => {
    expect(roots).toEqual([{ projectId: 'p1', name: 'Project', root: projectRoot }]);
});

test('a Markdown file inside a project root resolves to its canonical path', () => {
    const result = resolveDocumentPath(path.join(projectRoot, 'docs', 'reports', 'report.md'), roots);
    expect(result.ok).toBe(true);
    expect(result.canonicalPath).toBe(path.join(projectRoot, 'docs', 'reports', 'report.md'));
    expect(result.root.projectId).toBe('p1');
});

test('traversal out of the root is refused before touching the filesystem', () => {
    const traversal = resolveDocumentPath(path.join(projectRoot, 'docs', '..', '..', 'outside', 'private.md'), roots);
    expect(traversal).toMatchObject({ ok: false, status: 403, code: 'outside_roots' });
    expect(resolveDocumentPath(path.join(outsideDir, 'private.md'), roots)).toMatchObject({ ok: false, status: 403, code: 'outside_roots' });
    expect(resolveDocumentPath('docs/report.md', roots)).toMatchObject({ ok: false, status: 400, code: 'invalid_path' });
    expect(resolveDocumentPath('', roots)).toMatchObject({ ok: false, status: 400 });
    expect(resolveDocumentPath(`${projectRoot}/docs/re\0port.md`, roots)).toMatchObject({ ok: false, status: 400 });
    expect(resolveDocumentPath(42, roots)).toMatchObject({ ok: false, status: 400 });
});

test('symlinks that escape the root or hide a non-Markdown file are refused; in-root aliases canonicalize', () => {
    expect(resolveDocumentPath(path.join(projectRoot, 'docs', 'escape.md'), roots)).toMatchObject({ ok: false, status: 403, code: 'symlink_escape' });
    expect(resolveDocumentPath(path.join(projectRoot, 'docs', 'linked-dir', 'private.md'), roots)).toMatchObject({ ok: false, status: 403, code: 'symlink_escape' });
    expect(resolveDocumentPath(path.join(projectRoot, 'docs', 'masked.md'), roots)).toMatchObject({ ok: false, status: 415, code: 'not_markdown' });
    const alias = resolveDocumentPath(path.join(projectRoot, 'docs', 'alias.md'), roots);
    expect(alias.ok).toBe(true);
    expect(alias.canonicalPath).toBe(path.join(projectRoot, 'docs', 'reports', 'report.md'));
});

test('non-Markdown, vendored, missing and oversized files are refused with distinct codes', () => {
    expect(resolveDocumentPath(path.join(projectRoot, 'docs', 'secret.env'), roots)).toMatchObject({ ok: false, status: 415, code: 'not_markdown' });
    expect(resolveDocumentPath(path.join(projectRoot, '.git', 'HEAD.md'), roots)).toMatchObject({ ok: false, status: 403, code: 'forbidden_path' });
    expect(resolveDocumentPath(path.join(projectRoot, 'node_modules', 'pkg', 'README.md'), roots)).toMatchObject({ ok: false, status: 403, code: 'forbidden_path' });
    expect(resolveDocumentPath(path.join(projectRoot, 'docs', 'nope.md'), roots)).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(resolveDocumentPath(path.join(projectRoot, 'docs'), roots)).toMatchObject({ ok: false, status: 415 });
    const big = path.join(projectRoot, 'docs', 'big.md');
    fs.writeFileSync(big, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61));
    expect(resolveDocumentPath(big, roots)).toMatchObject({ ok: false, status: 413, code: 'too_large' });
});

test('reading normalizes line endings, hashes the normalized text and refuses invalid UTF-8', () => {
    const read = readDocumentFile(path.join(projectRoot, 'docs', 'reports', 'report.md'));
    expect(read.ok).toBe(true);
    expect(read.content).toBe('# Report\n\nBody line.\n');
    expect(read.lineCount).toBe(4);
    expect(read.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const bad = path.join(projectRoot, 'docs', 'bad.md');
    fs.writeFileSync(bad, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    expect(readDocumentFile(bad)).toMatchObject({ ok: false, status: 422, code: 'invalid_encoding' });
    expect(readDocumentFile(path.join(projectRoot, 'docs', 'missing.md'))).toMatchObject({ ok: false, status: 404 });
});
