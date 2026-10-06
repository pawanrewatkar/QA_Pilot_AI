import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native SQLite driver must stay a runtime dependency, never bundled.
  serverExternalPackages: ["better-sqlite3", "playwright", "playwright-core"],
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Reference-document uploads (MAX_UPLOAD_MB defaults to 10) plus multipart overhead.
      // Note: Vercel functions cap request bodies at 4.5 MB; use direct-to-storage uploads there.
      bodySizeLimit: "11mb",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
