/**
 * /api/token-usage — daily token throughput across every engine on the box.
 *
 * Praxis logs tokens=null for CLI dispatches (subscription seats aren't
 * token-billed), so the real numbers come from each CLI's own session logs
 * (claude-code, codex), the Praxis cost ledger (local + cloud API) and, for
 * antigravity, a char/4 estimate kept in its own field and out of every
 * DayRow.total. The accounting, caching and scan rules live in
 * ./token-usage-service.ts; this file is only the HTTP seam.
 *
 * Every bridge widget polls this route (five per page), so it must stay cheap
 * under concurrency: all requests share one refresh, a stale body answers
 * immediately while that refresh runs, and the scan never holds a whole
 * session log in memory. Incident 2026-11-20: overlapping full scans took
 * the dashboard's root route down.
 */
import { sharedTokenUsageService } from "./token-usage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await sharedTokenUsageService().getUsage());
  } catch {
    // refresh() already logged the cause; the next request retries.
    return Response.json({ error: "token usage refresh failed" }, { status: 500 });
  }
}
