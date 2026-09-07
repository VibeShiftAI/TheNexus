/**
 * Mobile shell seam.
 *
 * The Nexus Android app is a thin WebView shell around this dashboard
 * (Nexus-Mobile-Android/docs/dashboard-shell.md). Before the page runs, the
 * shell defines a frozen `window.__NEXUS_MOBILE_SHELL__` — only on the origin
 * it was configured with — and accepts JSON messages posted through
 * `window.ReactNativeWebView.postMessage`. Everything here is optional: in an
 * ordinary browser `getMobileShell()` is null and every send is a no-op, so
 * the desktop dashboard is unaffected. Nothing secret ever crosses this seam;
 * the shell holds the Cloudflare Access token natively and the page only
 * ever sees its own cookies.
 */
import { useSyncExternalStore } from "react";

/** CustomEvent the shell dispatches to route the running dashboard client-side. */
export const SHELL_NAVIGATE_EVENT = "nexus-mobile-navigate";

export type MobileShellInfo = {
  platform: string;
  appVersion: string;
  origin: string;
  capabilities: readonly string[];
  navigateEvent?: string;
};

/** Everything the dashboard may ask the shell to do. Mirrors lib/shell/bridge.ts in the app. */
export type ShellMessage =
  | { type: "ready"; path: string }
  | { type: "navigated"; path: string }
  | { type: "open-external"; url: string }
  | { type: "open-settings" }
  | { type: "badge"; count: number }
  | { type: "haptic"; style: "light" | "medium" | "heavy" | "success" | "warning" | "error" }
  | { type: "reload" };

declare global {
  interface Window {
    __NEXUS_MOBILE_SHELL__?: MobileShellInfo;
    ReactNativeWebView?: { postMessage: (data: string) => void };
  }
}

/** The shell descriptor when this page runs inside the Android app on its trusted origin; otherwise null. */
export function getMobileShell(): MobileShellInfo | null {
  if (typeof window === "undefined") return null;
  const shell = window.__NEXUS_MOBILE_SHELL__;
  if (!shell || typeof shell !== "object" || typeof shell.origin !== "string") return null;
  if (shell.origin !== window.location.origin) return null;
  if (typeof window.ReactNativeWebView?.postMessage !== "function") return null;
  return shell;
}

/** Send a message to the shell. Returns false (and does nothing) outside the shell. */
export function postToShell(message: ShellMessage): boolean {
  const shell = getMobileShell();
  if (!shell) return false;
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** The current location as the same-origin path the shell understands. */
export function currentShellPath(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Mirror of the shell's sanitizeDashboardPath: an absolute same-origin path
 * ("/task/abc?x=1#y") or null. Schemes, protocol-relative "//host", backslash
 * tricks, control characters and over-long input are all rejected.
 */
export function sanitizeShellPath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const path = input.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (CONTROL_CHARS.test(path) || path.length > 2048) return null;
  if (path.split(/[?#]/, 1)[0].includes(":")) return null;
  return path;
}

const subscribe = () => () => {};
const getServerSnapshot = () => null;

/**
 * The shell descriptor for React trees. It is defined before the page runs and
 * never changes, so the store never notifies; the server snapshot is null and
 * React swaps in the client value after hydration without a mismatch.
 */
export function useMobileShell(): MobileShellInfo | null {
  return useSyncExternalStore(subscribe, getMobileShell, getServerSnapshot);
}
