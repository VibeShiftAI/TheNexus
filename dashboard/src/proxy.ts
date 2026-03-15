import { NextResponse, type NextRequest } from 'next/server'

/**
 * Middleware proxy — auth removed.
 * Single-user local app, no login required.
 * Just pass all requests through.
 */
export async function proxy(request: NextRequest) {
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
