import type { NextConfig } from "next";
import { config as dotenvConfig } from "dotenv";
import path from "path";

// ═══════════════════════════════════════════════════════════════
// ENVIRONMENT VARIABLE LOADING
// ═══════════════════════════════════════════════════════════════
// Load environment variables from parent directory's .env file
// This handles the monorepo structure where:
//   - TheNexus/.env contains all secrets (backend + frontend)
//   - TheNexus/dashboard/ is the Next.js app subdirectory
//
// In production (Netlify), env vars are set via the platform UI,
// so this only affects local development.
// ═══════════════════════════════════════════════════════════════

const parentEnvPath = path.resolve(__dirname, "..", ".env");
dotenvConfig({ path: parentEnvPath });

// No environment variable validation needed — auth removed, local SQLite only.
const praxisChatTimeoutMs = Number.parseInt(process.env.PRAXIS_CHAT_TIMEOUT_MS || "", 10) || 20 * 60 * 1000;

const nextConfig: NextConfig = {
  // Allow Cloudflare Tunnel domain to access Next.js dev server
  allowedDevOrigins: ['nexus.vibeshiftai.com'],
  // Transpile local shared package
  transpilePackages: ['@praxis/contract'],
  experimental: {
    proxyTimeout: praxisChatTimeoutMs + 60 * 1000,
  },
  env: {
    // No Supabase env vars needed — auth removed
  },
  async rewrites() {
    // API proxy configuration
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

    return [
      // Socket.IO is routed directly by Cloudflare Tunnel to port 4000
      // (path-based ingress rule in ~/.cloudflared/config.yml)
      // Everything else to Node.js
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
