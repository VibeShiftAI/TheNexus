const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const media = require('../services/review-media');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../../db/document-reviews');
const { repair } = require('../../scripts/repair-review-assets');

test('preview, exact-byte repair and replay on removed worktrees, including an unrelocated document and a mismatched member', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-review-assets-')));
    const project = path.join(dir, 'Project');
    const removed = path.join(dir, '.praxis-worktrees', 'run', 'Project');
    const db = new Database(':memory:');
    const previous = process.env.NEXUS_REVIEW_BLOB_DIR;
    process.env.NEXUS_REVIEW_BLOB_DIR = path.join(dir, 'blobs');
    try {
        db.exec('CREATE TABLE projects (id TEXT, path TEXT)');
        db.prepare('INSERT INTO projects VALUES (?, ?)').run('project', project);
        initializeDocumentReviews(db);
        const store = createDocumentReviewStore(db);
        function seed(name, type, content, assets, moved) {
            const doc = store.insertDocument({ title: name, path: path.join(moved ? project : removed, name), project_id: 'project' });
            const revision = store.insertRevision({ document_id: doc.id, content_hash: media.sha256(content), media_type: type,
                content, byte_length: Buffer.byteLength(content), line_count: 1 });
            store.insertRevisionAssets(revision.id, doc.id, assets.map(([key, role, file, expected]) => ({
                asset_key: key, role, path: path.join(removed, file), media_type: media.classifyPath(file), mime_type: media.mimeFor(file),
                byte_length: Buffer.byteLength(expected), content_hash: media.sha256(expected),
            })));
            store.setCurrentRevision(doc.id, revision.id);
            return doc.id;
        }
        fs.mkdirSync(project);
        const html = '<p>Exact prototype</p>';
        fs.writeFileSync(path.join(project, 'page.html'), html, 'utf8');
        const page = seed('page.html', 'html', html, [['primary', 'primary', 'page.html', html]], false);
        fs.writeFileSync(path.join(project, 'copy.html'), html, 'utf8');
        const copy = seed('copy.html', 'html', html, [['primary', 'primary', 'copy.html', html]], false);
        const brokenImage = 'no PNG header';
        fs.writeFileSync(path.join(project, 'broken.png'), brokenImage, 'utf8');
        const broken = seed('broken.png', 'image', brokenImage, [['primary', 'primary', 'broken.png', brokenImage]], false);
        const manifest = JSON.stringify({ format: 'nexus-design-package/1', title: 'Review', screens: [
            { id: 'a', title: 'A', file: 'a.svg', before: 'b.svg' },
        ] });
        fs.writeFileSync(path.join(project, 'screen.design.json'), manifest, 'utf8');
        fs.writeFileSync(path.join(project, 'a.svg'), '<svg/>', 'utf8');
        fs.writeFileSync(path.join(project, 'b.svg'), '<svg>changed</svg>', 'utf8');
        seed('screen.design.json', 'design', manifest, [
            ['primary', 'primary', 'screen.design.json', manifest],
            ['screen:a', 'screen', 'a.svg', '<svg/>'], ['before:a', 'before', 'b.svg', '<svg>old</svg>'],
        ], true);

        const preview = repair(db);
        expect(preview.assets.map(a => a.outcome).sort()).toEqual(['hash_mismatch', 'undecodable', 'would_repair', 'would_repair', 'would_repair']);
        expect(store.getDocument(page).path).toBe(path.join(removed, 'page.html'));
        expect(fs.existsSync(media.blobDirectory())).toBe(false);
        const applied = repair(db, { execute: true });
        expect(applied.assets.map(a => a.outcome).sort()).toEqual(['already_servable', 'hash_mismatch', 'repaired', 'repaired', 'undecodable']);
        expect(store.getDocument(page).path).toBe(path.join(project, 'page.html'));
        expect(store.getDocument(copy).path).toBe(path.join(project, 'copy.html'));
        expect(fs.existsSync(media.blobPath(media.sha256(brokenImage)))).toBe(false);
        expect(store.getDocument(broken).path).toBe(path.join(removed, 'broken.png'));
        expect(applied.revisions_by_media_type.html.repaired).toBe(2);
        expect(fs.readFileSync(media.blobPath(media.sha256(html)), 'utf8')).toBe(html);
        expect(fs.existsSync(media.blobPath(media.sha256('<svg>old</svg>')))).toBe(false);
        expect(repair(db, { execute: true }).assets.map(a => a.outcome).sort()).toEqual(['hash_mismatch', 'undecodable']);
        expect(store.listRelocations(page)).toHaveLength(1);
    } finally {
        if (previous === undefined) delete process.env.NEXUS_REVIEW_BLOB_DIR;
        else process.env.NEXUS_REVIEW_BLOB_DIR = previous;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
