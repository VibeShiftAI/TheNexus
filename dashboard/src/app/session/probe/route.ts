import { compareAssertion } from "@/lib/session-check";
import { pinsFromEnv } from "@/lib/session-trace";

export const dynamic = "force-dynamic";

/**
 * GET /session/probe: the shape of the caller's own Access session as the
 * dashboard server sees it. Through the tunnel every root-path request
 * carries the same Cf-Access-Jwt-Assertion header the API receives on
 * /api/*, so this names the session kind (service token, person, none)
 * without a Nexus reload and from inside the travel shell. Unverified and
 * diagnostic only: it confers nothing, returns fixed kinds and booleans plus
 * the session's own Client ID, compares the claims with this process's pins
 * in fixed words (2026-09-26: including the form of the audience claim), and
 * logs one fixed line with no value in it so the real session's reading
 * becomes attributable in the supervisor log.
 */
export async function GET(request: Request): Promise<Response> {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (request.headers.get("sec-fetch-site") === "cross-site") {
        return new Response(JSON.stringify({ error: "Same-origin requests only" }), { status: 403, headers });
    }
    const summary = compareAssertion(request.headers.get("cf-access-jwt-assertion"), pinsFromEnv(process.env));
    console.log(summary.assertionPresent
        ? `[SessionCheck] assertion=present kind=${summary.kind} audience=${summary.audience} audShape=${summary.audienceShape} issuer=${summary.issuer} type=${summary.tokenType} sub=${summary.subject} nbf=${summary.nbf}`
        : "[SessionCheck] assertion=absent kind=none");
    return new Response(JSON.stringify(summary), { status: 200, headers });
}
