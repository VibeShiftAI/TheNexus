import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { DisplayScaleProvider } from "@/components/display-scale";
import { BridgeActivityProvider } from "@/components/bridge/activity-provider";
import { CortexProvider } from "@/components/cortex-provider";
import { GlobalVoiceDock } from "@/components/global-voice-dock";
import { EventTicker } from "@/components/bridge/event-ticker";
import { LiveBoardStateProvider } from "@/components/live-board-state";
import { MobileShellBridge } from "@/components/mobile-shell-bridge";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  title: "The Nexus - VibeShift AI",
  description: "AI-powered project management dashboard by VibeShift AI",
  openGraph: {
    images: ['/opengraph-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/twitter-image.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: '7rem' }}>
          <DisplayScaleProvider>
          <CortexProvider>
            <LiveBoardStateProvider>
            <BridgeActivityProvider>
            <main style={{ flex: 1 }}>
              {children}
            </main>
            <footer style={{
              textAlign: 'center',
              padding: '1rem',
              borderTop: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.5)',
              fontSize: '0.875rem'
            }}>
              © {new Date().getFullYear()} VibeShift AI. All rights reserved.
            </footer>
            {/* Live Praxis event strip — pinned to the bottom on every page */}
            <EventTicker />
            {/* Android shell seam — renders nothing in a browser (docs/mobile-shell.md) */}
            <MobileShellBridge />
            <GlobalVoiceDock />
            </BridgeActivityProvider>
            </LiveBoardStateProvider>
          </CortexProvider>
          </DisplayScaleProvider>
        </div>
      </body>
    </html>
  );
}
