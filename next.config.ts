import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  /* SSE must not sit in a gzip buffer; Cloudflare compresses at the edge anyway */
  compress: false,
  images: { unoptimized: true },
  /* the SDK spawns the claude binary from its own package dir; bundling it would break that lookup */
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  experimental: { optimizePackageImports: ["iconoir-react"] },
  async headers() {
    const common = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      /* file bytes set their own, stricter policy (sandboxed, no script) in the route */
      { source: "/api/files/raw", headers: common },
      {
        source: "/((?!api/files/raw).*)",
        headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" }],
      },
    ];
  },
};

export default nextConfig;
