import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployments.
  // Produces .next/standalone — a self-contained Node.js server
  // that includes only the necessary files (no node_modules needed in prod).
  output: "standalone",
};

export default nextConfig;
