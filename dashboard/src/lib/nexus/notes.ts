import { API_URL, authFetch } from './shared';

export interface Note {
    id: string;
    project_id: string | null;
    content: string;
    /** Free-form in the DB; common values: general, decision, blocker, reminder, daily-log, idea, bug, archived. */
    category: string;
    source: 'praxis' | 'operator';
    pinned: boolean;
    created_at: string;
    updated_at: string;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Notes API
// ═══════════════════════════════════════════════════════════════════════════════

export async function getProjectNotes(projectId: string): Promise<Note[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/projects/${projectId}/notes`);
    if (!res.ok) throw new Error('Failed to fetch project notes');
    const data = await res.json();
    return data.notes || [];
}

export async function getGlobalNotes(): Promise<Note[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/notes`);
    if (!res.ok) throw new Error('Failed to fetch global notes');
    const data = await res.json();
    return data.notes || [];
}

export async function createNote(
    content: string,
    category: string = 'general',
    projectId?: string | null
): Promise<Note> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const url = projectId
        ? `${baseUrl}/projects/${projectId}/notes`
        : `${baseUrl}/notes`;
    const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, category, source: 'operator' }),
    });
    if (!res.ok) throw new Error('Failed to create note');
    const data = await res.json();
    return data.note;
}

export async function updateNote(
    noteId: string,
    updates: { content?: string; category?: string; pinned?: number }
): Promise<Note> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error('Failed to update note');
    const data = await res.json();
    return data.note;
}

export async function deleteNote(noteId: string): Promise<void> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/notes/${noteId}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete note');
}

// ─── Travel Shell Tabs ──────────────────────────────────────────────────────
// The Windows travel shell pulls its tab roster from /api/tabs at launch;
// editing here means no rebuild/reinstall to change the tab lineup.

export interface TravelTab {
    id: string;
    label: string;
    url: string;
    accent: string;
    hosted?: boolean;
    enabled: boolean;
}

export async function getTravelTabs(): Promise<TravelTab[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/tabs?all=1`);
    if (!res.ok) throw new Error("Failed to fetch travel tabs");
    const data = await res.json();
    return data.tabs;
}

export async function saveTravelTabs(tabs: TravelTab[]): Promise<TravelTab[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/tabs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save travel tabs");
    }
    return (await res.json()).tabs;
}

