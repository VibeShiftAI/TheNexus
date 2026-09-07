"use client";
/**
 * MobileShellBridge — mounted once in the root layout; renders nothing and
 * does nothing in a browser. Inside the Android shell it announces readiness,
 * reports client-side route changes, applies navigation requests from the
 * native side (push-notification taps, deep links) through the Next router,
 * and keeps the launcher badge equal to the pending HITL count.
 */
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import {
  currentShellPath,
  postToShell,
  sanitizeShellPath,
  SHELL_NAVIGATE_EVENT,
  useMobileShell,
} from "@/lib/mobile-shell";

export function MobileShellBridge() {
  const shell = useMobileShell();
  if (!shell) return null;
  return <BadgeSource navigateEvent={shell.navigateEvent || SHELL_NAVIGATE_EVENT} />;
}

/** Only mounted inside the shell, so the HITL poll runs nowhere else. */
function BadgeSource({ navigateEvent }: { navigateEvent: string }) {
  const { pendingRequests } = useHitlInbox();
  return <ShellBridgeCore navigateEvent={navigateEvent} badgeCount={pendingRequests.length} />;
}

/** The bridge behaviour with its inputs made explicit (exported for tests). */
export function ShellBridgeCore({
  navigateEvent,
  badgeCount,
  onNavigate,
}: {
  navigateEvent: string;
  badgeCount: number;
  /** Defaults to the Next router's push. */
  onNavigate?: (path: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    postToShell({ type: "ready", path: currentShellPath() });
  }, []);

  useEffect(() => {
    postToShell({ type: "navigated", path: currentShellPath() });
  }, [pathname]);

  useEffect(() => {
    postToShell({ type: "badge", count: Math.min(999, Math.max(0, badgeCount)) });
  }, [badgeCount]);

  useEffect(() => {
    const handler = (event: Event) => {
      const path = sanitizeShellPath((event as CustomEvent<unknown>).detail);
      if (!path) return;
      const hashIndex = path.indexOf("#");
      const beforeHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
      const here = `${window.location.pathname}${window.location.search}`;
      if (hashIndex >= 0 && beforeHash === here) {
        // Same page, new hash (inbox#<hitlId>): routers treat that as a no-op,
        // the page's own hashchange listener does not.
        window.location.hash = path.slice(hashIndex);
        return;
      }
      if (onNavigate) onNavigate(path);
      else router.push(path);
    };
    window.addEventListener(navigateEvent, handler);
    return () => window.removeEventListener(navigateEvent, handler);
  }, [navigateEvent, router, onNavigate]);

  return null;
}
