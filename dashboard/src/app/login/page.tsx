'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Login page — auth removed.
 * Single-user local app, auto-redirect to dashboard.
 */
export default function LoginPage() {
    const router = useRouter()

    useEffect(() => {
        // No login needed — redirect immediately
        router.replace('/')
    }, [router])

    return (
        <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
            <p className="text-gray-400 animate-pulse">Redirecting to dashboard...</p>
        </div>
    )
}
