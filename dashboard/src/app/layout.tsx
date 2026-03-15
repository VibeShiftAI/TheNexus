import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CortexProvider } from "@/components/cortex-provider";

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
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          <CortexProvider>
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
          </CortexProvider>
        </div>
      </body>
    </html>
  );
}
