'use client'

import { createClient } from '@/lib/supabaseClient'
import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { NexusLogo } from '@/components/nexus-logo'

export default function LoginPage() {
    const supabase = createClient()
    const router = useRouter()
    const [mounted, setMounted] = useState(false)
    const [checkingAuth, setCheckingAuth] = useState(true)

    useEffect(() => {
        setMounted(true)

        // onAuthStateChange fires INITIAL_SESSION on mount, handling both
        // the initial auth check and ongoing state changes in one listener.
        // Avoids the race condition with middleware token refresh that caused
        // "refresh_token_already_used" errors.
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (session) {
                router.push('/')
            } else {
                setCheckingAuth(false)
            }
        })

        return () => subscription.unsubscribe()
    }, [supabase, router])

    // Don't render anything while checking auth or before mount
    if (!mounted || checkingAuth) return null

    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-[#0a0a0a] p-4">
            <div className="w-full max-w-md space-y-8">
                <div className="text-center flex flex-col items-center">
                    <NexusLogo size={180} className="mb-4" />
                    <h1 className="text-4xl font-bold tracking-tight text-white sm:text-6xl bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
                        The Nexus
                    </h1>
                    <p className="mt-2 text-sm text-gray-400">
                        Enter the incubator.
                    </p>
                </div>

                <div className="bg-[#111] border border-gray-800 rounded-lg p-8 shadow-2xl backdrop-blur-sm bg-opacity-90">
                    <Auth
                        supabaseClient={supabase}
                        appearance={{
                            theme: ThemeSupa,
                            variables: {
                                default: {
                                    colors: {
                                        brand: '#10b981',
                                        brandAccent: '#059669',
                                        brandButtonText: 'white',
                                        defaultButtonBackground: '#262626',
                                        defaultButtonBackgroundHover: '#404040',
                                        inputBackground: '#171717',
                                        inputBorder: '#404040',
                                        inputBorderHover: '#10b981',
                                        inputPlaceholder: '#737373',
                                    },
                                    space: {
                                        spaceSmall: '4px',
                                        spaceMedium: '8px',
                                        spaceLarge: '16px',
                                        labelBottomMargin: '8px',
                                        anchorBottomMargin: '4px',
                                        emailInputSpacing: '4px',
                                        socialAuthSpacing: '4px',
                                        buttonPadding: '10px 15px',
                                        inputPadding: '10px 15px',
                                    },
                                    fontSizes: {
                                        baseBodySize: '13px',
                                        baseInputSize: '14px',
                                        baseLabelSize: '14px',
                                        baseButtonSize: '14px',
                                    },
                                    fonts: {
                                        bodyFontFamily: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`,
                                        buttonFontFamily: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`,
                                    },
                                    borderWidths: {
                                        buttonBorderWidth: '1px',
                                        inputBorderWidth: '1px',
                                    },
                                    radii: {
                                        borderRadiusButton: '6px',
                                        inputBorderRadius: '6px',
                                    },
                                },
                            },
                            className: {
                                container: 'w-full',
                                button: 'w-full px-4 py-2 rounded-md font-medium transition-colors duration-200',
                                input: 'w-full px-4 py-2 rounded-md border bg-neutral-900 border-neutral-700 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all',
                                label: 'text-sm text-neutral-400 mb-1 block',
                            },
                        }}
                        providers={['github']}
                        redirectTo={`${typeof window !== 'undefined' ? window.location.origin : ''}/auth/callback`}
                        onlyThirdPartyProviders={false}
                        view="sign_in"
                        theme="dark"
                        showLinks={false}
                    />
                </div>
            </div>
        </div>
    )
}
