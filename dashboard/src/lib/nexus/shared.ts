// Shared plumbing for the nexus API client modules (split out of lib/nexus.ts, P2-25).

// Use relative URL to allow Next.js rewrites to proxy requests to localhost:4000
// This is critical for production where the browser can't access localhost directly
import { getAuthHeader } from '../auth';

export const API_URL = '/api/projects';

// Helper for authenticated fetch
export async function authFetch(url: string, options: RequestInit = {}) {
    const headers = await getAuthHeader();
    // credentials: 'include' ensures Cloudflare Access cookies are sent
    // when accessing via the Cloudflare Tunnel (nexus.vibeshiftai.com)
    // Add a cache-buster query param to bypass stuck 308 Permanent Redirects cached by the browser
    const urlWithCacheBuster = url.includes('?') ? `${url}&_cb=${Date.now()}` : `${url}?_cb=${Date.now()}`;
    return fetch(urlWithCacheBuster, {
        ...options,
        credentials: 'include',
        headers: {
            ...headers,
            ...options.headers,
        }
    });
}
