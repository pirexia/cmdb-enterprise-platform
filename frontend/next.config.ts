import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployments.
  // Produces .next/standalone — a self-contained Node.js server
  // that includes only the necessary files (no node_modules needed in prod).
  output: "standalone",

  // ── Security Headers (ISO 27001 A.8.24 / A.10.1) ─────────────────────────
  // Applied to every Next.js response (HTML pages, API routes, static assets).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Prevent MIME-type sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Prevent clickjacking — only allow framing from same origin
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Enable XSS auditor in older browsers
          { key: "X-XSS-Protection", value: "1; mode=block" },
          // Strict referrer policy — don't leak URL to third parties
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Permissions policy — disable features not needed
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          // HSTS — enforce HTTPS for 1 year (activate when HTTPS is live)
          // { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

export default nextConfig;
