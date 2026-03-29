import { getAuthHeader } from './auth';

const CODEX_API_URL = '/api/codex';

export interface CodexDoc {
    id: string;
    slug: string;
    title: string;
    content: string;
    category: 'Protocol' | 'Pattern' | 'Workflow' | 'Guide' | 'API';
    tags: string[];
    created_at: string;
    updated_at: string;
}

export interface CodexListResponse {
    docs: Pick<CodexDoc, 'id' | 'slug' | 'title' | 'category' | 'tags' | 'created_at' | 'updated_at'>[];
}

async function codexFetch(url: string, options: RequestInit = {}) {
    // We might not need auth for Codex yet as per migration policy, but good to have
    const headers = await getAuthHeader().catch(() => ({}));

    return fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...headers,
            ...options.headers,
        }
    });
}

export async function getCodexDocs(category?: string): Promise<CodexDoc[]> {
    const url = category
        ? `${CODEX_API_URL}/docs?category=${encodeURIComponent(category)}`
        : `${CODEX_API_URL}/docs`;

    try {
        const res = await codexFetch(url);
        if (!res.ok) {
            // Fallback or empty if offline
            console.warn(`Failed to fetch codex docs: ${res.statusText}`);
            return [];
        }
        const data = await res.json();
        return data.docs;
    } catch (error) {
        console.error("Error fetching Codex docs:", error);
        return [];
    }
}

export async function getCodexDoc(slug: string): Promise<CodexDoc | null> {
    const url = `${CODEX_API_URL}/docs/${encodeURIComponent(slug)}`;

    try {
        const res = await codexFetch(url);
        if (!res.ok) {
            if (res.status === 404) return null;
            throw new Error(`Failed to fetch doc: ${res.statusText}`);
        }
        return res.json();
    } catch (error) {
        console.error(`Error fetching Codex doc ${slug}:`, error);
        return null;
    }
}
