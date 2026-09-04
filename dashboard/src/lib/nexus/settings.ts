import { API_URL, authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// SETTINGS / ENV EDITOR API
// ═══════════════════════════════════════════════════════════════

export interface EnvSettings {
    PROJECT_ROOT: string;
    GOOGLE_API_KEY: string;
    OPENAI_API_KEY: string;
    ANTHROPIC_API_KEY: string;
    XAI_API_KEY: string;
    NEXUS_SERVICE_KEY: string;
}

export async function getEnvSettings(): Promise<EnvSettings> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/env`);
    if (!res.ok) throw new Error("Failed to fetch environment settings");
    return res.json();
}

export async function saveEnvSettings(settings: Partial<EnvSettings>): Promise<{ success: boolean; updated: string[] }> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save environment settings");
    }
    return res.json();
}

// ─── Cross-project API-key rotation ────────────────────────────────────────

export interface ProjectKeyLocation {
    project: string;
    /** Path relative to the projects root, e.g. "Praxis/.env". */
    file: string;
    /** Masked preview (first 4 + last 4) — the server never sends full values. */
    masked: string;
}

export interface ProjectKeyGroup {
    name: string;
    locations: ProjectKeyLocation[];
}



export async function getProjectKeys(): Promise<{ root: string; keys: ProjectKeyGroup[] }> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/project-keys`);
    if (!res.ok) throw new Error("Failed to scan project keys");
    return res.json();
}

export async function rotateProjectKey(
    name: string,
    value: string,
    files?: string[],
): Promise<{ success: boolean; name: string; updated: string[] }> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/project-keys/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value, files }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to rotate key");
    }
    return res.json();
}

