import { authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// CONTACTS — shared stakeholder directory (@praxis/contract shapes)
// ═══════════════════════════════════════════════════════════════

import type {
    Contact as _Contact,
    ProjectContact as _ProjectContact,
    CommsFeed as _CommsFeed,
} from '@praxis/contract';

export type Contact = _Contact & { projects?: Array<{ project_id: string; project_name: string; role?: string | null }> };
export type ProjectContact = _ProjectContact;
export type CommsFeed = _CommsFeed;
/** Unified directory naming (2026-07-16): a Member IS a Contact row. */
export type Member = Contact;
export type ProjectMember = ProjectContact;

const CONTACTS_URL = '/api/contacts';

export async function listContacts(search?: string): Promise<Contact[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await authFetch(`${CONTACTS_URL}${qs}`);
    if (!res.ok) throw new Error('Failed to list contacts');
    return (await res.json()).contacts;
}

export async function getContact(id: string): Promise<Contact> {
    const res = await authFetch(`${CONTACTS_URL}/${id}`);
    if (!res.ok) throw new Error('Failed to fetch contact');
    return res.json();
}

export async function createContact(input: Partial<Contact> & { name: string }): Promise<Contact> {
    const res = await authFetch(CONTACTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to create contact');
    return data.contact;
}

export async function updateContact(id: string, updates: Partial<Contact>): Promise<Contact> {
    const res = await authFetch(`${CONTACTS_URL}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to update contact');
    return data.contact;
}

export async function deleteContact(id: string): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete contact');
}

export async function getProjectContacts(projectId: string): Promise<ProjectContact[]> {
    const res = await authFetch(`${CONTACTS_URL}?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error('Failed to fetch project contacts');
    return (await res.json()).contacts;
}

export async function linkContactToProject(contactId: string, projectId: string, role?: string, notes?: string): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, role, notes }),
    });
    if (!res.ok) throw new Error('Failed to link contact');
}

/**
 * Update a member's link to a project. Only the provided fields change on the
 * server; `extra.decision_maker` flags/unflags the member as a Primary
 * Decision Maker (see the STAKEHOLDERS section).
 */
export async function updateContactLink(
    contactId: string,
    projectId: string,
    role?: string | null,
    notes?: string | null,
    extra?: { decision_maker?: boolean },
): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, notes, ...(extra ?? {}) }),
    });
    if (!res.ok) throw new Error('Failed to update contact link');
}

/** Flag / unflag a project member as Primary Decision Maker (PATCHes only `decision_maker`). */
export async function setProjectDecisionMaker(contactId: string, projectId: string, on: boolean): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision_maker: on }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update decision-maker flag');
    }
}

export async function unlinkContactFromProject(contactId: string, projectId: string): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects/${projectId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to unlink contact');
}

/** External-comms feed (Praxis feedback gateway), via the praxis relay. */
export async function getCommsFeed(since?: string): Promise<CommsFeed> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await authFetch(`/api/praxis/comms${qs}`);
    if (!res.ok) throw new Error('Comms feed unavailable');
    return res.json();
}

