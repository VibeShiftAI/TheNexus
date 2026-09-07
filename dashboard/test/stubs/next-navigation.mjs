// Minimal, controllable Next navigation context for component lifecycle tests.
import { useSyncExternalStore } from 'react';
let pathname = '/';
const listeners = new Set();
export function setPathname(next) { pathname = next; for (const listener of listeners) listener(); }
const router = { push: setPathname, replace: setPathname, back() {}, prefetch() {} };
export function useParams() { return {}; }
export function useRouter() { return router; }
export function usePathname() {
    return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => pathname, () => '/');
}
