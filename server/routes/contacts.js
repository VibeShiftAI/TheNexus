/**
 * Contacts Routes — the shared stakeholder directory.
 *
 * Contacts are people (family testers, clients, domain experts) shared
 * across projects; project_contacts links carry the per-project role.
 * Praxis's feedback pipeline reports communications via POST /observe.
 * Shapes: @praxis/contract entities/contact.ts.
 */
const express = require('express');

function createContactsRouter({ db }) {
    const router = express.Router();

    // GET /api/contacts?search=&email=&project_id=
    router.get('/', async (req, res) => {
        try {
            if (req.query.email) {
                const contact = await db.findContactByEmail(String(req.query.email));
                return res.json({ contacts: contact ? [contact] : [] });
            }
            if (req.query.project_id) {
                return res.json({ contacts: await db.listProjectContacts(String(req.query.project_id)) });
            }
            const contacts = await db.listContacts({ search: req.query.search || null });
            res.json({ contacts });
        } catch (error) {
            console.error('Error listing contacts:', error);
            res.status(500).json({ error: 'Failed to list contacts' });
        }
    });

    // POST /api/contacts — create
    router.post('/', async (req, res) => {
        try {
            const { name, email } = req.body || {};
            if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
            if (email) {
                const existing = await db.findContactByEmail(email);
                if (existing) return res.status(409).json({ error: 'A contact with this email already exists', contact: existing });
            }
            const contact = await db.createContact(req.body);
            if (!contact) return res.status(500).json({ error: 'Failed to create contact' });
            res.status(201).json({ success: true, contact });
        } catch (error) {
            console.error('Error creating contact:', error);
            res.status(500).json({ error: 'Failed to create contact' });
        }
    });

    /**
     * POST /api/contacts/observe — Praxis reports a communication with a
     * human: { email, name?, projectName?, role? }. Upsert-by-email +
     * last_contact_at stamp + optional project link. Never destructive.
     */
    router.post('/observe', async (req, res) => {
        try {
            const { email } = req.body || {};
            if (!email?.trim()) return res.status(400).json({ error: 'email required' });
            const contact = await db.observeContact(req.body);
            if (!contact) return res.status(500).json({ error: 'observe failed' });
            res.json({ success: true, contact });
        } catch (error) {
            console.error('Error observing contact:', error);
            res.status(500).json({ error: 'Failed to observe contact' });
        }
    });

    // GET /api/contacts/:id — detail (includes project links)
    router.get('/:id', async (req, res) => {
        try {
            const contact = await db.getContact(req.params.id);
            if (!contact) return res.status(404).json({ error: 'Contact not found' });
            res.json(contact);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch contact' });
        }
    });

    // PATCH /api/contacts/:id — update fields
    router.patch('/:id', async (req, res) => {
        try {
            const contact = await db.updateContact(req.params.id, req.body || {});
            if (!contact) return res.status(404).json({ error: 'Contact not found' });
            res.json({ success: true, contact });
        } catch (error) {
            res.status(500).json({ error: 'Failed to update contact' });
        }
    });

    // DELETE /api/contacts/:id
    router.delete('/:id', async (req, res) => {
        try {
            const ok = await db.deleteContact(req.params.id);
            if (!ok) return res.status(404).json({ error: 'Contact not found' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete contact' });
        }
    });

    // POST /api/contacts/:id/projects — link to a project { project_id, role?, notes? }
    router.post('/:id/projects', async (req, res) => {
        try {
            const { project_id, role, notes } = req.body || {};
            if (!project_id) return res.status(400).json({ error: 'project_id required' });
            const ok = await db.linkContactToProject(project_id, req.params.id, { role, notes });
            if (!ok) return res.status(500).json({ error: 'Failed to link contact' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to link contact' });
        }
    });

    // PATCH /api/contacts/:id/projects/:projectId — update role/notes on the link
    router.patch('/:id/projects/:projectId', async (req, res) => {
        try {
            const { role, notes } = req.body || {};
            const ok = await db.updateProjectContactLink(req.params.projectId, req.params.id, { role, notes });
            if (!ok) return res.status(404).json({ error: 'Link not found' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to update link' });
        }
    });

    // DELETE /api/contacts/:id/projects/:projectId — detach from a project
    router.delete('/:id/projects/:projectId', async (req, res) => {
        try {
            const ok = await db.unlinkContactFromProject(req.params.projectId, req.params.id);
            if (!ok) return res.status(404).json({ error: 'Link not found' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to unlink contact' });
        }
    });

    return router;
}

module.exports = createContactsRouter;
