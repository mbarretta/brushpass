import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    // Exclude both the root .gsd dir and the src/.gsd symlink that points to GSD worktrees.
    // Vitest follows symlinks, so duplicate test files get picked up from src/.gsd/worktrees/
    // and fail @/* resolution because vite-tsconfig-paths resolves relative to the symlink target.
    exclude: ['.gsd/**', 'src/.gsd/**', 'node_modules/**'],
  },
});
