import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * Proxy all backend API calls through the Next.js server.
   * This means only ONE public URL (the frontend) is needed — the Next.js
   * server forwards API requests to the backend internally.
   *
   * In local dev: BACKEND_URL defaults to http://localhost:8000
   * In Docker:    BACKEND_URL=http://backend:8000  (docker-compose service name)
   * In ngrok:     expose port 3000 only — everything goes through Next.js
   */
  async rewrites() {
    const backend = process.env.BACKEND_URL ?? "http://localhost:8000";
    return [
      { source: "/stocks/:path*",    destination: `${backend}/stocks/:path*` },
      { source: "/news/:path*",      destination: `${backend}/news/:path*` },
      { source: "/rag/:path*",       destination: `${backend}/rag/:path*` },
      { source: "/watchlist/:path*", destination: `${backend}/watchlist/:path*` },
      { source: "/health",           destination: `${backend}/health` },
    ];
  },
  // Allow cross-origin requests during local dev
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
