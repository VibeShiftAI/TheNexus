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

const nextConfig: NextConfig = {
  env: {
    // No Supabase env vars needed — auth removed
  },
  async rewrites() {
    // API proxy configuration
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
    const pythonUrl = process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

    return [
      // Route agents API to Python (unified node registry)
      {
        source: "/api/agents/:path*",
        destination: `${pythonUrl}/agents/:path*`,
      },
      {
        source: "/api/agents",
        destination: `${pythonUrl}/agents`,
      },
      // Route LangGraph API to Python
      {
        source: "/api/langgraph/:path*",
        destination: `${apiUrl}/api/langgraph/:path*`,
      },
      // Everything else to Node.js
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
