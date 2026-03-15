/**
 * Auth helper — auth removed.
 * Single-user local app. Always returns a mock session token
 * so API calls from the dashboard continue to work.
 */
export async function getAuthToken(): Promise<string | null> {
    // Return the NEXUS_SERVICE_KEY if available, else a placeholder
    return process.env.NEXUS_SERVICE_KEY || 'local-dev-token';
}

/**
 * Returns an auth header object for API calls.
 * Includes Content-Type for JSON body parsing by express.json().
 * Used by nexus.ts, codex.ts, ai-terminal.tsx
 */
export async function getAuthHeader(): Promise<Record<string, string>> {
    const token = await getAuthToken();
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}
