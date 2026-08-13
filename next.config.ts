import type { NextConfig } from "next";
import path from "path";
import { securityHeaderEntries } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Prevents "generate is not a function" when __NEXT_PRIVATE_STANDALONE_CONFIG
  // is leaked from a parent GSD Next.js process.
  generateBuildId: () => null,

  // Turbopack root: fixes "distDirRoot should not navigate out of projectPath"
  // when the project is invoked from a parent directory (cwd != project root).
  // Required for `next dev` (Turbopack default) in the GSD worktree layout.
  turbopack: {
    root: path.resolve(__dirname),
  },

  // Don't advertise the framework (and therefore its version) on every response.
  poweredByHeader: false,

  experimental: {
    // When a proxy is in use Next buffers a clone of every request body in
    // memory so both the proxy and the route handler can read it. An over-limit
    // body is NOT rejected — it is SILENTLY TRUNCATED and the handler sees a
    // partial body (see
    // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md),
    // so this number must sit comfortably above the largest legitimate payload
    // rather than snugly against it.
    //
    // Largest legitimate body in this app: the bulk-delete `{ ids: [...] }` at
    // POST /api/admin/files, capped by the handler at 100 numeric ids — under
    // 2KB. Everything else is smaller: upload prepare/complete carry file
    // METADATA only (the bytes go straight to GCS on a signed URL and never
    // traverse Cloud Run), and the login server action is a two-field form.
    //
    // 1MB is therefore ~500x headroom over anything the app actually sends,
    // while cutting the buffered-per-request ceiling 10x from Next's 10MB
    // default — worthwhile on a single-instance service where concurrent
    // requests share one heap.
    proxyClientMaxBodySize: '1mb',
  },

  // Static security-header baseline. Next checks configured headers BEFORE the
  // filesystem, so unlike the proxy this also covers /public assets and every
  // other path the proxy matcher excludes. The proxy applies the same list to
  // the responses it generates itself; both read it from
  // src/lib/security-headers.ts so they cannot drift.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaderEntries(),
      },
    ];
  },
};

export default nextConfig;
