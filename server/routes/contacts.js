/**
 * Members Routes — the ONE shared people directory (canonical mount
 * /api/members; /api/contacts remains as a legacy alias).
 *
 * Members are people (family testers, clients, domain experts) AND AI
 * council seats, shared across projects; project_contacts links carry the
 * per-project role, `claims`/`seat_id` carry council membership, and
 * `interaction_log` accumulates Praxis's notes on every exchange.
 * Praxis's feedback pipeline reports communications via POST /observe.
 * Shapes: @praxis/contract entities/contact.ts (Member = Contact).
 */
const express = require('express');
const { MemberMemoryInputSchema } = require('@praxis/contract');

function createContactsRouter({ db }) {
    const router = express.Router();

    // GET /api/members?search=&email=&seat_id=&project_id=
    router.get('/', async (req, res) => {
        try {
            if (req.query.email) {
                const contact = await db.findContactByEmail(String(req.query.email));
                return res.json({ contacts: contact ? [contact] : [], members: contact ? [contact] : [] });
            }
            if (req.query.seat_id) {
                const contact = await db.findContactBySeat(String(req.query.seat_id));
                return res.json({ contacts: contact ? [contact] : [], members: contact ? [contact] : [] });
            }
            if (req.query.project_id) {
                const linked = await db.listProjectContacts(String(req.query.project_id));
                return res.json({ contacts: linked, members: linked });
            }
            const contacts = await db.listContacts({ search: req.query.search || null });
            res.json({ contacts, members: contacts });
        } catch (error) {
            console.error('Error listing members:', error);
            res.status(500).json({ error: 'Failed to list members' });
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

    /**
     * POST /api/members/:id/log — append a Praxis interaction note:
     * { note, source?, touch_contact? }. touch_contact also stamps
     * last_contact_at (use when the note records an actual exchange).
     */
    router.post('/:id/log', async (req, res) => {
        try {
            const { note, source, touch_contact, source_ref, idempotency_key } = req.body || {};
            if (typeof note !== 'string' || !note.trim()) return res.status(400).json({ error: 'note required' });
            const contact = await db.appendContactLog(req.params.id, {
                note,
                source,
                source_ref,
                idempotency_key,
                touchContact: Boolean(touch_contact),
            });
            if (!contact) return res.status(404).json({ error: 'Member not found' });
            res.json({ success: true, contact, member: contact });
        } catch (error) {
            console.error('Error appending member log:', error);
            res.status([400, 404, 409].includes(error.status) ? error.status : 500)
                .json({ error: error.status ? error.message : 'Failed to append log' });
        }
    });

    // Exact memory scope: omitted/empty project_id means general only.
    router.get('/:id/memory', async (req, res) => {
        try {
            const allowed = new Set(['project_id', 'before_seq', 'limit', '_cb']);
            if (Object.entries(req.query).some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) {
                return res.status(400).json({ error: 'Invalid memory query fields' });
            }
            const options = { project_id: req.query.project_id || null };
            for (const key of ['before_seq', 'limit']) {
                if (req.query[key] !== undefined) {
                    if (!/^[1-9]\d*$/.test(req.query[key])) return res.status(400).json({ error: `${key} must be a positive integer` });
                    options[key] = Number(req.query[key]);
                }
            }
            res.json(await db.getMemberMemory(req.params.id, options));
        } catch (error) {
            res.status([400, 404, 409].includes(error.status) ? error.status : 500)
                .json({ error: error.status ? error.message : 'Failed to fetch member memory' });
        }
    });

    router.post('/:id/memory', async (req, res) => {
        const parsed = MemberMemoryInputSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
        try {
            const event = await db.appendMemberMemory(req.params.id, parsed.data);
            res.status(201).json({ event });
        } catch (error) {
            res.status([400, 404, 409].includes(error.status) ? error.status : 500)
                .json({ error: error.status ? error.message : 'Failed to append member memory' });
        }
    });

    // Evidence lookup: one canonical member UUID, an explicit scope (general, or
    // exactly one project) and a question type. Sources come back separately
    // labelled so a global directory setting is never an implicit project answer.
    router.get('/:id/evidence', async (req, res) => {
        try {
            const allowed = new Set(['scope', 'project_id', 'question', 'fact_key', 'limit', '_cb']);
            if (Object.entries(req.query).some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) {
                return res.status(400).json({ error: 'Invalid evidence query fields' });
            }
            const options = {};
            for (const key of ['scope', 'project_id', 'question', 'fact_key']) if (req.query[key]) options[key] = req.query[key];
            if (req.query.limit !== undefined) {
                if (!/^[1-9]\d*$/.test(req.query.limit)) return res.status(400).json({ error: 'limit must be a positive integer' });
                options.limit = Number(req.query.limit);
            }
            res.json(await db.getMemberEvidence(req.params.id, options));
        } catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Failed to look up member evidence' : error.message });
        }
    });

    // Profile proposal source/scope and all writes are independently validated in the store.
    router.post('/:id/profile-proposals', async (req, res) => {
        try {
            res.status(201).json(await db.submitMemberProfileProposals(req.params.id, req.body));
        } catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Failed to submit profile proposals' : error.message });
        }
    });

    router.get('/:id/profile-proposals', async (req, res) => {
        try {
            const allowed = new Set(['project_id', 'status', 'before_created_seq', 'limit', '_cb']);
            if (Object.entries(req.query).some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) {
                return res.status(400).json({ error: 'Invalid profile proposal query fields' });
            }
            const options = {};
            for (const key of ['project_id', 'status']) if (req.query[key] !== undefined) options[key] = req.query[key];
            for (const key of ['before_created_seq', 'limit']) {
                if (req.query[key] !== undefined) {
                    if (!/^[1-9]\d*$/.test(req.query[key])) return res.status(400).json({ error: `${key} must be a positive integer` });
                    options[key] = Number(req.query[key]);
                }
            }
            res.json(await db.listMemberProfileProposals(req.params.id, options));
        } catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Failed to list profile proposals' : error.message });
        }
    });

    router.post('/:id/profile-proposals/:proposalId/review', async (req, res) => {
        try {
            res.json(await db.reviewMemberProfileProposal(req.params.id, req.params.proposalId, req.body));
        } catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Failed to review profile proposal' : error.message });
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

    // POST /api/contacts/:id/projects — link to a project { project_id, role?, notes?, decision_maker? }
    router.post('/:id/projects', async (req, res) => {
        try {
            const { project_id, role, notes, decision_maker } = req.body || {};
            if (!project_id) return res.status(400).json({ error: 'project_id required' });
            const ok = await db.linkContactToProject(project_id, req.params.id, { role, notes, decision_maker: decision_maker === true });
            if (!ok) return res.status(500).json({ error: 'Failed to link contact' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to link contact' });
        }
    });

    // PATCH /api/contacts/:id/projects/:projectId — update role / notes /
    // decision_maker (Primary Decision Maker flag) on the link. Partial: only
    // the keys present in the body change.
    router.patch('/:id/projects/:projectId', async (req, res) => {
        try {
            const body = req.body || {};
            const updates = {};
            if (Object.prototype.hasOwnProperty.call(body, 'role')) updates.role = body.role;
            if (Object.prototype.hasOwnProperty.call(body, 'notes')) updates.notes = body.notes;
            if (Object.prototype.hasOwnProperty.call(body, 'decision_maker')) updates.decision_maker = body.decision_maker === true;
            const ok = await db.updateProjectContactLink(req.params.projectId, req.params.id, updates);
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
