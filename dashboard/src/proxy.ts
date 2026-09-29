import { NextResponse, type NextRequest } from 'next/server'
import { createTraceState, pinsFromEnv, traceRequest } from '@/lib/session-trace'

/**
 * Middleware proxy — auth removed.
 * Single-user local app, no login required.
 * Just pass all requests through.
 *
 * Redacted session trace (2026-09-25, task 5fbeff4a): one fixed line per
 * distinct reading per ten minutes naming the kind of Access session the
 * tunnel forwards to this dashboard (service token, person, none) and whether
 * its claims match the operator pins. No claim value, token, address, Client
 * ID or path is logged. It exists so the travel shell's real session becomes
 * attributable in praxis.log on its next page load, without a Nexus API
 * reload and without asking Robert to sign in. Diagnostic only: it never
 * changes a request or a response, and it confers nothing.
 */
const sessionTrace = createTraceState()

export async function proxy(request: NextRequest) {
    try {
        const line = traceRequest(request.headers, pinsFromEnv(process.env), sessionTrace)
        if (line) console.log(line)
    } catch {
        // The trace must never affect a request.
    }
    return NextResponse.next({
        request: {
            headers: request.headers,
        },
    })
}

export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
}
