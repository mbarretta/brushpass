import type { NextConfig } from "next";
import path from "path";

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
};

export default nextConfig;
