/**
 * Project Hub — THE LAB tab of the travel shell, and a space for every
 * project that has no dedicated web UI of its own.
 *
 * Server-rendered, zero-JS pages straight off the task board:
 *   GET /          the LAB index — full project roster, experiments front door
 *   GET /p/:slug   a project's space — card, end state, needs, tasks, README
 *
 * Mounted twice by server.js: under /hub on every hostname (local dev), and
 * at the root of lab.vibeshiftai.com through the tunnel (the shell tab).
 * Access gates the hostname at the edge; like /api/updates we do no auth
 * here ourselves. READMEs are read from the project's workspace path as
 * recorded on the board — display only, never executed.
 *
 * This is the landing spot of the New Project Process: problem intake
 * scaffolds a project on the board, and it shows up here (and gets a
 * /p/<slug> space) with no extra wiring. Promoting a project to its own
 * tab later = one TabDef in desktop/src-tauri/src/main.rs + one ingress.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

/** "Impossible Worlds Field Guide" → "impossible-worlds-field-guide" */
function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Tiny display-grade Markdown: headings, fences, lists, bold/italic/code,
 * links. Everything is HTML-escaped first; this is for our own READMEs,
 * not arbitrary input fidelity.
 */
function renderMarkdown(md) {
    const out = [];
    let inCode = false;
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const raw of String(md).split(/\r?\n/)) {
        if (/^```/.test(raw)) {
            closeList();
            out.push(inCode ? '</code></pre>' : '<pre><code>');
            inCode = !inCode;
            continue;
        }
        if (inCode) { out.push(esc(raw)); continue; }
        let line = esc(raw)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            const level = Math.min(heading[1].length + 1, 5); // h1 → h2, keep page h1 unique
            out.push(`<h${level}>${heading[2]}</h${level}>`);
            continue;
        }
        const item = line.match(/^\s*[-*]\s+(.*)$/);
        if (item) {
            if (!inList) { out.push('<ul>'); inList = true; }
            out.push(`<li>${item[1]}</li>`);
            continue;
        }
        closeList();
        if (line.trim() === '') continue;
        out.push(`<p>${line}</p>`);
    }
    if (inCode) out.push('</code></pre>');
    closeList();
    return out.join('\n');
}

const STATUS_COLORS = {
    active: '#4ade80', parked: '#64748b', paused: '#fbbf24', archived: '#334155',
};

function page(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — The Lab</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #020617; color: #94a3b8;
    font-family: "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
  a { color: #22d3ee; text-decoration: none; }
  a:hover { text-decoration: underline; }
  header.masthead { display: flex; align-items: baseline; gap: 14px;
    border-bottom: 1px solid #0f1e33; padding-bottom: 14px; margin-bottom: 22px; }
  .masthead h1 { margin: 0; color: #e2e8f0; font-size: 20px; letter-spacing: 0.18em; }
  .masthead .sub { font-size: 12px; color: #475569; letter-spacing: 0.08em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
  .card { border: 1px solid #0f1e33; border-radius: 10px; padding: 14px 16px;
    background: rgba(148, 163, 184, 0.03); }
  .card h2 { margin: 0 0 6px; font-size: 14px; letter-spacing: 0.06em; }
  .card p { margin: 0; font-size: 12px; color: #64748b; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
    border: 1px solid #1e293b; border-radius: 999px; padding: 2px 9px; color: #64748b; }
  .chip.status { border-color: currentColor; }
  .section { margin-top: 30px; }
  .section > h2 { color: #e2e8f0; font-size: 13px; letter-spacing: 0.2em;
    text-transform: uppercase; border-bottom: 1px solid #0f1e33; padding-bottom: 8px; }
  .prose { font-size: 13px; line-height: 1.65; }
  .prose h2, .prose h3, .prose h4, .prose h5 { color: #e2e8f0; margin: 1.4em 0 0.4em; }
  .prose pre { background: #0b1220; border: 1px solid #0f1e33; border-radius: 8px;
    padding: 12px; overflow-x: auto; font-size: 12px; }
  .prose code { color: #a5f3fc; }
  .prose li { margin: 3px 0; }
  table.tasks { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.tasks td { border-top: 1px solid #0f1e33; padding: 7px 8px; vertical-align: top; }
  table.tasks td.status { white-space: nowrap; color: #64748b; text-transform: uppercase;
    font-size: 10px; letter-spacing: 0.1em; }
  .note { font-size: 12px; color: #475569; border: 1px dashed #1e293b; border-radius: 10px;
    padding: 12px 14px; }
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

function masthead(sub) {
    return `<header class="masthead"><h1>THE LAB</h1><span class="sub">${esc(sub)}</span></header>`;
}

function statusChip(status) {
    const color = STATUS_COLORS[status] || '#64748b';
    return `<span class="chip status" style="color:${color}">${esc(status || 'active')}</span>`;
}

function createProjectHubRouter({ db }) {
    const router = express.Router();

    router.get('/', async (_req, res) => {
        const projects = await db.getProjects();
        const bySlug = (p) => `p/${slugify(p.name)}`;
        const card = (p) => `
<div class="card">
  <h2><a href="${bySlug(p)}">${esc(p.name)}</a></h2>
  <p>${esc((p.description || '').slice(0, 160))}</p>
  <div class="chips">${statusChip(p.status)}${p.priority ? `<span class="chip">P${esc(p.priority)}</span>` : ''}</div>
</div>`;
        const active = projects.filter((p) => p.status !== 'parked' && p.status !== 'archived');
        const parked = projects.filter((p) => p.status === 'parked');
        res.send(page('Project spaces', `
${masthead('project spaces · experiments · the new-project front door')}
<div class="note">Every project on the board gets a space here automatically — the New Project
Process (problem intake → charter → scaffolded project) lands new experiments on this page with
no extra wiring. Give one its own tab in the shell once it grows a real UI.</div>
<div class="section"><h2>Active — ${active.length}</h2><div class="grid">${active.map(card).join('')}</div></div>
${parked.length ? `<div class="section"><h2>Parked — ${parked.length}</h2><div class="grid">${parked.map(card).join('')}</div></div>` : ''}
`));
    });

    router.get('/p/:slug', async (req, res) => {
        const projects = await db.getProjects({ includeArchived: true });
        const project = projects.find((p) => slugify(p.name) === req.params.slug);
        if (!project) {
            return res.status(404).send(page('Not found',
                `${masthead('unknown project')}<p class="prose">No project matches
                <code>${esc(req.params.slug)}</code>. <a href="../">Back to the roster.</a></p>`));
        }

        const tasks = (await db.getTasks(project.id)).slice(0, 12);
        const needs = Array.isArray(project.needs) ? project.needs.filter((n) => n.status === 'open') : [];

        // README straight from the workspace, display-only.
        let readmeHtml = '';
        const workspace = project.path && fs.existsSync(project.path) ? project.path : null;
        if (workspace) {
            const readme = ['README.md', 'readme.md'].map((f) => path.join(workspace, f)).find(fs.existsSync);
            if (readme) {
                try { readmeHtml = renderMarkdown(fs.readFileSync(readme, 'utf8').slice(0, 60000)); } catch { /* display-only */ }
            }
        }

        const taskRow = (t) => `<tr><td class="status">${esc(t.status)}</td><td>${esc(t.name)}</td></tr>`;
        res.send(page(project.name, `
${masthead('project space')}
<h2 style="color:#e2e8f0; letter-spacing:0.06em; margin:6px 0 4px">${esc(project.name)}</h2>
<div class="chips">${statusChip(project.status)}
  ${project.priority ? `<span class="chip">priority ${esc(project.priority)}</span>` : ''}
  ${project.upgrade_posture ? `<span class="chip">posture ${esc(project.upgrade_posture)}</span>` : ''}
  ${workspace ? `<span class="chip">${esc(workspace)}</span>` : ''}
</div>
${project.description ? `<p class="prose">${esc(project.description)}</p>` : ''}
${project.end_state ? `<div class="section"><h2>End state</h2><div class="prose">${renderMarkdown(project.end_state)}</div></div>` : ''}
${needs.length ? `<div class="section"><h2>Open needs</h2><ul class="prose">${needs.map((n) =>
        `<li><strong>${esc(n.kind)}</strong> — ${esc(n.summary || n.description || '')}</li>`).join('')}</ul></div>` : ''}
${tasks.length ? `<div class="section"><h2>Recent tasks</h2><table class="tasks">${tasks.map(taskRow).join('')}</table></div>` : ''}
${readmeHtml ? `<div class="section"><h2>README</h2><div class="prose">${readmeHtml}</div></div>` : ''}
<div class="section"><p><a href="../">← All projects</a></p></div>
`));
    });

    return router;
}

module.exports = createProjectHubRouter;
