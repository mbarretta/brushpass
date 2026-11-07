import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    globals: true,
    // Exclude both the root .gsd dir and the src/.gsd symlink that points to GSD worktrees.
    // Vitest follows symlinks, so duplicate test files get picked up from src/.gsd/worktrees/
    // and fail @/* resolution because tsconfig paths resolve relative to the symlink target.
    exclude: ['.gsd/**', 'src/.gsd/**', 'node_modules/**'],
  },
});
