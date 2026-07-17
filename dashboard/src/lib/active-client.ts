/**
 * Last-active-location client — pairs with TheNexus /api/presence routes.
 *
 * Each dashboard instance (web tab, Tauri window, any machine) carries a
 * persistent client id and reports a throttled heartbeat whenever it sees
 * real user input. Voice announcements auto-play only on the client whose
 * heartbeat is most recent — the device Robert is actually working on.
 *
 * Fail-open: if the presence endpoint can't answer (server restart, offline),
 * fall back to "am I visible and focused?" so a lone client still speaks.
 */

const CLIENT_ID_KEY = "praxis-active-client-id";
const REPORT_THROTTLE_MS = 15_000;

let cachedClientId: string | null = null;
let lastReportAt = 0;

export function getClientId(): string {
  if (cachedClientId) return cachedClientId;
  try {
    let id = window.localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(CLIENT_ID_KEY, id);
    }
    cachedClientId = id;
    return id;
  } catch {
    // localStorage unavailable — session-scoped id is fine (worst case this
    // client re-registers as "new" after a reload).
    cachedClientId = `session-${Math.random().toString(36).slice(2)}`;
    return cachedClientId;
  }
}

/** Throttled activity heartbeat. Call freely from input listeners. */
export function reportClientActivity(): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_THROTTLE_MS) return;
  lastReportAt = now;
  try {
    void fetch("/api/presence/client-activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: getClientId(),
        label: typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown",
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* presence is best-effort */
  }
}

function visibleAndFocused(): boolean {
  try {
    return document.visibilityState === "visible" && document.hasFocus();
  } catch {
    return true;
  }
}

/**
 * True when THIS client is the operator's last active device (and should
 * therefore auto-play voice announcements).
 */
export async function isThisClientActive(): Promise<boolean> {
  try {
    const res = await fetch("/api/presence/active-client", {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return visibleAndFocused();
    const data = (await res.json()) as { active?: { clientId?: string } | null };
    if (!data?.active?.clientId) return visibleAndFocused();
    return data.active.clientId === getClientId();
  } catch {
    return visibleAndFocused();
  }
}
