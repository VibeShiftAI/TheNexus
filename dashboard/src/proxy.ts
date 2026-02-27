import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
    let response = NextResponse.next({
        request: {
            headers: request.headers,
        },
    })

    try {
        const supabase = createServerClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                cookies: {
                    getAll() {
                        return request.cookies.getAll()
                    },
                    setAll(cookiesToSet) {
                        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
                        response = NextResponse.next({
                            request,
                        })
                        cookiesToSet.forEach(({ name, value, options }) =>
                            response.cookies.set(name, value, options)
                        )
                    },
                },
            }
        )

        // Skip auth refresh for login page — avoids race condition with
        // client-side auth that causes "refresh_token_already_used" errors
        if (request.nextUrl.pathname.startsWith('/login')) {
            return response
        }

        // Refresh session if expired
        const {
            data: { user },
        } = await supabase.auth.getUser()

        // Protected routes pattern
        // If user is NOT logged in and trying to access a protected route, redirect to login
        if (!user && (request.nextUrl.pathname.startsWith('/dashboard') || request.nextUrl.pathname === '/')) {
            return NextResponse.redirect(new URL('/login', request.url))
        }

        // If user IS logged in and trying to access login, redirect to dashboard
        if (user && request.nextUrl.pathname.startsWith('/login')) {
            return NextResponse.redirect(new URL('/', request.url))
        }

        return response
    } catch (e) {
        // If you are here, there is a Supabase client connection error
        // or invalid environment variables
        console.error('Middleware Supabase Error:', e);
        return NextResponse.next({
            request: {
                headers: request.headers,
            },
        })
    }
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - auth/callback (auth callback route)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
}
